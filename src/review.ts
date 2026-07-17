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
- Anchor each finding to a real line that EXISTS in the added/changed (RIGHT) side of the diff, using the file's line number at the PR head.`;

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
{"summary": "1-3 sentence overall read + severity tally", "findings": [{"path": "repo-relative path from the diff", "line": <integer, RIGHT side of the diff>, "severity": "High" | "Medium" | "Low", "body": "one concrete finding: the defect + a failure scenario or fix. Do NOT prefix severity."}]}
Zero findings is valid — return an empty findings array and say the PR is clean in the summary.`;

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

/** Lightweight verify: does `fixDiff` plausibly address the earlier findings? */
export async function verifyFix(findings: Finding[], fixDiff: string): Promise<boolean> {
  if (findings.length === 0) return true;
  const prompt = `You verify whether a follow-up diff actually addresses prior review findings. Be skeptical: only "true" if each finding is genuinely handled by the diff, not merely touched.

Prior findings:
${findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.path}:${f.line} — ${f.body}`).join("\n")}

Follow-up diff:
\`\`\`diff
${fixDiff.slice(0, config.maxDiffBytes)}
\`\`\`

Respond with ONLY JSON — no prose, no fences: {"addressed": true | false, "note": "..."}`;

  try {
    const text = await runClaude(prompt, 90_000);
    return Boolean(extractJson<{ addressed?: boolean }>(text).addressed);
  } catch {
    return false; // fail closed — don't approve if verification couldn't run
  }
}
