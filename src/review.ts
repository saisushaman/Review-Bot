import { spawn } from "node:child_process";
import { config } from "./config.js";
import type { PrMeta } from "./github.js";

// This bot reviews via HEADLESS CLAUDE CODE (`claude -p`) running on your Claude Code
// subscription — NOT the metered Anthropic API. No API key / credits needed; the `claude`
// CLI must be installed and logged in (run `claude setup-token` or `claude` → `/login` once).

export type Severity = "High" | "Medium" | "Low";
export interface Finding {
  path: string;
  line: number; // line in the PR head (RIGHT side of the diff)
  severity: Severity;
  body: string; // the concrete finding + failure scenario / fix
}
export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

const SYSTEM = `You are an autonomous DevOps + security code reviewer. Review a GitHub PR diff across FIVE vectors, weighting security and architecture heavily:
1. Code base — syntax, clean-code, dead code, obvious optimizations.
2. Security — hardcoded secrets, overly-permissive access, injection/SSRF, missing validation, unbounded input, fail-open logic, unpinned deps.
3. Architecture — alignment with the codebase's established patterns; flag drift, not personal preference.
4. Tests — added/updated/accounted for? Untested new logic, deleted tests, tautological assertions. On a test-only PR, enumerate the target code's branches and flag any the added tests don't cover.
5. Spec matching — cross-reference the PR title/description against the actual diff; flag work described-but-not-done, done-but-not-described, or scope creep.

RELIABILITY GUARDRAIL — this is critical:
- Do NOT emit low-confidence or filler comments. For each finding ask "would this survive a skeptical senior engineer, and can I cite the concrete failure or violation?" Emit it ONLY if yes.
- Prefer FEWER, high-signal findings. If a suggested fix is uncertain, phrase it as a question. Never invent a line-anchored fix you can't stand behind.
- Zero findings is a valid, common result — return an empty findings array and say the PR is clean in the summary.
- Anchor each finding to a real line that EXISTS in the added/changed (RIGHT) side of the diff, using the file's line number at the PR head.

OUTPUT CONTRACT — non-negotiable, this is what makes the review usable:
- EVERY issue/concern/question you raise MUST be a separate object in the "findings" array (with path, line, severity, body). This is the ONLY place findings are read from — text elsewhere is discarded.
- "summary" is a ONE-SENTENCE overall read ONLY. Do NOT describe specific issues, concerns, or a per-file critique in it. If you catch yourself writing "one concern is…", "the issue is…", "note that…", or a severity breakdown in the summary, STOP — move it into a findings[] object instead.
- The number of findings you mention anywhere MUST equal findings.length. A summary that references a concern while findings is empty is a BUG and an invalid response.
- If and only if the PR is genuinely clean, findings=[] and the summary says so plainly.`;

/**
 * Run headless Claude Code one-shot. The prompt is piped via STDIN (never a shell arg), so
 * untrusted diff content can never inject into the command line. Returns the assistant's final
 * text (the `result` field of `--output-format json`).
 */
function runClaude(prompt: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json"], {
      shell: process.platform === "win32", // resolve claude.cmd on Windows
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude -p timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${err.slice(0, 500)}`));
      try {
        const env = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (env.is_error) return reject(new Error(`claude -p error: ${env.result ?? "unknown"}`));
        resolve(typeof env.result === "string" ? env.result : out);
      } catch {
        resolve(out); // not the JSON envelope — return raw and let the caller parse
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Extract the first JSON object from model text (tolerate ```json fences / surrounding prose). */
function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in claude output");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

export async function reviewPr(pr: PrMeta, diff: string): Promise<ReviewResult> {
  const clipped =
    diff.length > config.maxDiffBytes
      ? diff.slice(0, config.maxDiffBytes) + "\n…[diff truncated]…"
      : diff;

  const prompt = `${SYSTEM}

PR: ${pr.title}
Author: ${pr.authorLogin} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files · head ${pr.headOid}

Unified diff:
\`\`\`diff
${clipped}
\`\`\`

Respond with ONLY a JSON object — no prose, no markdown fences — of this exact shape:
{"summary": "ONE sentence, overall read only — NO issue descriptions, NO severity tally", "findings": [{"path": "repo-relative path from the diff", "line": <integer, RIGHT side of the diff>, "severity": "High" | "Medium" | "Low", "body": "one concrete finding: the defect + a failure scenario or fix. Do NOT prefix severity."}]}
Every concern goes in findings[]; the summary never describes a specific issue. Zero findings is valid — return an empty findings array and a summary that plainly says the PR is clean.`;

  const text = await runClaude(prompt);
  let parsed: { summary?: string; findings?: Finding[] };
  try {
    parsed = extractJson<{ summary?: string; findings?: Finding[] }>(text);
  } catch {
    return { summary: "Review produced no parseable output.", findings: [] };
  }
  return {
    summary: parsed.summary ?? "",
    // Coerce `line` before validating: models frequently emit it as a string ("138") or float
    // (138.0). The old `Number.isInteger(f.line)` check dropped every such finding SILENTLY, so a
    // review would claim findings in its summary but post zero inline comments (PR #31). Now we
    // parse it and keep any finding with a real positive integer line + the required fields.
    findings: (parsed.findings ?? [])
      .map((f) => ({ ...f, line: Math.trunc(Number((f as { line?: unknown }).line)) }))
      .filter(
        (f) => f && f.path && Number.isInteger(f.line) && f.line > 0 && f.severity && f.body
      ),
  };
}

export interface VerifyResult {
  allAddressed: boolean;
  unaddressed: string[]; // human-readable list of findings NOT yet addressed
}

/**
 * Verify the CURRENT PR diff actually addresses each review finding (the bot's own + every other
 * reviewer's). Per-finding verdict with a strict structured contract so the model can't hide the
 * answer in prose. Fair, not pedantic: a finding counts as addressed if the diff plausibly resolves
 * it (a fix/guard, the requested doc/clarification, or the flagged code is gone) — false only when
 * there is no sign it was handled. Fails CLOSED (allAddressed=false) if verification can't run, so
 * the bot never approves on an unverified fix.
 */
export async function verifyFix(findings: Finding[], prDiff: string): Promise<VerifyResult> {
  if (findings.length === 0) return { allAddressed: true, unaddressed: [] };
  const list = findings.map((f, i) => `${i}. ${f.path}:${f.line} — ${f.body}`).join("\n");
  const prompt = `You are checking whether prior code-review findings were ADDRESSED in the CURRENT state of a pull request. For EACH finding, decide if the diff below resolves it.

Findings (index. path:line — concern):
${list}

Current PR diff (final state, includes any fix commits):
\`\`\`diff
${prDiff.slice(0, config.maxDiffBytes)}
\`\`\`

Judge fairly, not pedantically: mark addressed=true if the diff plausibly resolves the concern — a real fix or guard, the doc/clarification the finding asked for, or the flagged code no longer exists. Mark addressed=false ONLY when there is no sign the concern was handled. A finding about code untouched by the diff and still exhibiting the problem is NOT addressed.

Respond with ONLY a JSON object — no prose, no markdown fences — of exactly this shape, with ONE verdict per finding:
{"verdicts": [{"i": <finding index int>, "addressed": true|false, "why": "<=12 words"}]}`;
  try {
    const text = await runClaude(prompt, 150_000);
    const parsed = extractJson<{ verdicts?: Array<{ i?: number; addressed?: boolean; why?: string }> }>(
      text
    );
    const verdicts = parsed.verdicts ?? [];
    // Incomplete coverage → treat as not-verified (fail closed).
    if (verdicts.length < findings.length) return { allAddressed: false, unaddressed: ["(verification incomplete)"] };
    const unaddressed = verdicts
      .filter((v) => v.addressed !== true)
      .map((v) => findings[v.i ?? -1]?.body?.slice(0, 60) ?? `finding ${v.i}`);
    return { allAddressed: unaddressed.length === 0, unaddressed };
  } catch {
    return { allAddressed: false, unaddressed: ["(verification failed to run)"] };
  }
}
