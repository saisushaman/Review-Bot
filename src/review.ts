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

const SYSTEM = `You are a STAFF-level engineer doing a rigorous PR review. Your PRIMARY job is to catch SUBSTANTIVE defects — real bugs, security holes, breaking changes — NOT to nitpick style. Read the change against the FULL FILE CONTEXT provided below (the changed files' actual contents — call sites, types, invariants, error paths), reason about how the code behaves at runtime, and hunt hard for genuine problems.

Review across five vectors, weighting correctness + security heavily:
1. Correctness — logic errors, wrong conditions, off-by-one, null/undefined derefs, unhandled promise rejections, wrong async/ordering, race conditions, state that can go inconsistent, breaking changes to existing callers, wrong error handling (swallowed errors; fail-OPEN where it must fail-closed).
2. Security — think like an attacker. MISSING/weak authorization or ownership checks; injection/SSRF; unvalidated or unbounded input; path traversal; IDOR; over-broad permissions; unsafe deserialization; secrets/PII in logs; and — critically — **whether server-side enforcement can be BYPASSED at another layer**. On Firebase/Firestore especially: clients can write/read DIRECTLY via the SDK, so any constraint the API route enforces (userId, status, source, role, ownership, which fields are settable) MUST also be enforced in the security RULES — a rule that only checks auth + companyId but lets the client set userId/status/source/type is a HIGH-severity forgery / impersonation / privilege-escalation gap, even if the API route does it "correctly." When the diff touches firestore.rules / IAM / any auth policy, spell out exactly what a malicious authenticated client could forge or access that the rule fails to prevent.
3. Architecture — drift from the codebase's established patterns, leaky abstractions, coupling that will break, misuse of shared modules (judge against the provided file context, not personal taste).
4. Tests — untested new logic/branches, deleted tests, tautological assertions. Name the SPECIFIC branch left uncovered.
5. Spec matching — PR title/description vs the actual diff: work described-but-not-done, done-but-not-described, scope creep.

THREAT-MODEL & CLAIM-CHECK MANDATE — run this on ANY change touching auth, access control, security rules, tenant isolation, or user-supplied data:
- Trace whether a constraint enforced in one layer is ALSO enforced where an attacker could go AROUND it. A check that lives only in an API route / server handler, with no matching enforcement in the DB security rules (so a client can hit the datastore directly), is a real — usually HIGH — vulnerability. Ask concretely: "what can a malicious but authenticated user write or read by skipping the happy path?"
- CROSS-CHECK the PR's own security claims — in its description or the docs it edits — against what the code/rules ACTUALLY enforce. If the docs say "the client cannot set status/source" but the rules don't stop the client from setting them, that contradiction is a finding (cite both the claim and the gap).
- Explicitly consider field forgery, impersonation (e.g. a forged userId), status/state tampering, and privilege escalation — not just "is there a check somewhere."

SEVERITY by real-world IMPACT — assign HONESTLY, do NOT default everything to Low:
- High — could cause a production bug, security hole, data loss, outage, or broken build/call site. INCLUDES any auth/permission BYPASS, field forgery, impersonation, privilege escalation, or tenant-isolation break (a client reading/writing data it shouldn't) — these are High even when the "happy path" is correct, because the exploit path is concrete.
- Medium — a real problem but bounded: a missing test for real logic, a plausible edge-case bug, a moderate security/perf issue, an architectural violation, a dropped error state.
- Low — style, naming, clarity, docs, micro-nits with NO behavioral impact.

DEPTH MANDATE: a non-trivial PR that you review with ONLY Low findings usually means you didn't look hard enough — dig into the actual logic and its callers in the provided files. Report EVERY substantive issue you find, not just the single most notable one — enumerate them all (correctness, error-handling, tests, and security). But NEVER invent or pad: every finding must cite a CONCRETE defect visible in the diff or the provided files, WITH a failure scenario. If the PR is genuinely clean, return 0 findings — don't manufacture issues.

RELIABILITY:
- Substantiate every finding with the specific code and how it fails. If uncertain, phrase the body as a question but still include it.
- Anchor each finding to a real line on the RIGHT (added/changed) side of the diff, at the head revision.

OUTPUT CONTRACT — non-negotiable:
- EVERY issue MUST be a separate object in "findings" (path, line, severity, body). Prose outside findings[] is DISCARDED and LOST.
- "summary" is ONE sentence, overall read only — no issue descriptions. It MUST be consistent with findings: if it hints at any issue, that issue is a findings[] entry; if findings is empty the summary plainly says the PR is clean, no hedging.`;

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ONE headless Claude Code invocation. The prompt is piped via STDIN (never a shell arg), so
 * untrusted diff content can never inject into the command line. Returns the assistant's final
 * text (the `result` field of `--output-format json`). Rejects on non-zero exit / timeout / spawn
 * error. On a non-zero exit, claude writes its diagnostic to STDOUT (the JSON envelope with
 * is_error/result), NOT stderr — so we surface stdout in the error, else failures look empty
 * (which is exactly why the 2026-07-28 drops logged `exited 1:` with nothing after).
 */
export interface ClaudeOpts {
  model?: string; // optional cheaper model (e.g. the verify pass)
  cwd?: string; // run claude IN this dir (a repo checkout) so it can read the codebase
  repoTools?: boolean; // allow read-only file tools (Read/Grep/Glob) for whole-repo review
}

function spawnClaudeOnce(prompt: string, timeoutMs: number, opts: ClaudeOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (opts.model) args.push("--model", opts.model);
    // Whole-repo review: let claude explore the checkout with READ-ONLY tools, no permission prompt
    // (which would hang headless). Restricted to Read/Grep/Glob — the review never writes or runs code.
    if (opts.repoTools)
      args.push("--permission-mode", "bypassPermissions", "--allowedTools", "Read", "Grep", "Glob");
    // Force SUBSCRIPTION auth: if ANTHROPIC_API_KEY is present in the env, `claude -p` bills the
    // metered API instead of the Claude subscription — and a stale/empty-credit key then makes every
    // review fail with "Credit balance is too low" (hit live 2026-07-30). This bot is designed to run
    // on the subscription (no API credits), so strip the key from the child env unconditionally.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn("claude", args, {
      shell: process.platform === "win32", // resolve claude.cmd on Windows
      env,
      cwd: opts.cwd,
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
      if (code !== 0) {
        let detail = err.trim();
        try {
          const env = JSON.parse(out) as { result?: string };
          if (env.result) detail = String(env.result).slice(0, 500);
        } catch {
          /* stdout wasn't JSON — fall through to raw */
        }
        if (!detail) detail = out.trim().slice(0, 500) || "(no output on stdout/stderr)";
        return reject(new Error(`claude -p exited ${code}: ${detail}`));
      }
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

/**
 * Headless Claude Code WITH retries. A single transient failure (momentary rate/usage limit, a
 * network blip, a killed child) previously dropped an entire review — the request was already
 * claimed with :eyes:, so it never came back. Retrying here rides the blip out within the same
 * event so the review still completes. Retries on ANY spawn/exit/timeout error with backoff;
 * throws the last error only after every attempt fails.
 */
async function runClaude(
  prompt: string,
  timeoutMs = 180_000,
  attempts = 3,
  opts: ClaudeOpts = {}
): Promise<string> {
  const backoffMs = [5_000, 15_000, 30_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await spawnClaudeOnce(prompt, timeoutMs, opts);
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) {
        const delay = backoffMs[attempt] ?? 30_000;
        console.warn(
          `[pr-review-bot] claude -p attempt ${attempt + 1}/${attempts} failed: ${
            (e as Error).message
          } — retrying in ${delay / 1000}s`
        );
        await sleepMs(delay);
      }
    }
  }
  throw lastErr;
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

export interface PriorComment {
  path: string;
  line: number;
  body: string;
}

/** Shared review context: the PR's stated intent (for spec-matching) and the comments OTHER
 *  reviewers already left (so the bot doesn't re-state them — it focuses on what they missed). */
function prContextBlock(pr: PrMeta, priorComments: PriorComment[]): string {
  const body = pr.body.trim()
    ? `\n\nPR description — the author's STATED INTENT; judge the change against it (spec-matching), and flag anything described-but-not-done, done-but-not-described, or scope creep:\n${pr.body.slice(0, 4000)}`
    : "";
  const prior = priorComments.length
    ? `\n\nOther reviewers ALREADY left these comments — do NOT repeat them. Only report real issues they MISSED (if they covered everything and the PR is otherwise clean, return 0 findings):\n` +
      priorComments
        .slice(0, 40)
        .map((c) => `- ${c.path}:${c.line} — ${c.body.replace(/\s+/g, " ").slice(0, 160)}`)
        .join("\n")
    : "";
  return body + prior;
}

export async function reviewPr(
  pr: PrMeta,
  diff: string,
  files: Array<{ path: string; content: string; truncated: boolean }> = [],
  priorComments: PriorComment[] = []
): Promise<ReviewResult> {
  const clipped =
    diff.length > config.maxDiffBytes
      ? diff.slice(0, config.maxDiffBytes) + "\n…[diff truncated]…"
      : diff;

  // Full changed-file contents at head — this is what lets the model reason about correctness in
  // CONTEXT (callers, types, invariants) instead of only nitpicking the +/- diff lines.
  const context = files.length
    ? "\n\nFull content of the changed files at head (CONTEXT — reason about the change against this real code, its callers and types; use it to justify High/Medium findings):\n" +
      files
        .map((f) => `\n===== ${f.path}${f.truncated ? " (truncated)" : ""} =====\n${f.content}`)
        .join("\n")
    : "";

  const prompt = `${SYSTEM}

PR: ${pr.title}
Author: ${pr.authorLogin} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files · head ${pr.headOid}${prContextBlock(pr, priorComments)}

Unified diff (the change to review):
\`\`\`diff
${clipped}
\`\`\`${context}

Respond with ONLY a JSON object — no prose, no markdown fences — of this exact shape:
{"summary": "ONE sentence, overall read only — NO issue descriptions, NO severity tally", "findings": [{"path": "repo-relative path from the diff", "line": <integer, RIGHT side of the diff>, "severity": "High" | "Medium" | "Low", "body": "the concrete defect + a failure scenario or fix. Do NOT prefix severity."}]}
Assign severity by REAL IMPACT (don't default to Low). Every issue — including ones you spot from the file context — goes in findings[] as its own object, anchored to a changed line. The summary must be consistent with findings. Empty findings ONLY for a genuinely clean PR.`;

  // Generous timeout: the full-file context makes a deep review take longer than the 180s default.
  return parseReviewResult(await runClaude(prompt, 360_000));
}

/** Parse claude's JSON review output into findings. Coerces `line` (models emit "138" / 138.0) and
 *  drops any finding missing a valid positive-integer line or a required field (PR #31 fix). */
function parseReviewResult(text: string): ReviewResult {
  let parsed: { summary?: string; findings?: Finding[] };
  try {
    parsed = extractJson<{ summary?: string; findings?: Finding[] }>(text);
  } catch {
    return { summary: "Review produced no parseable output.", findings: [] };
  }
  return {
    summary: parsed.summary ?? "",
    findings: (parsed.findings ?? [])
      .map((f) => ({ ...f, line: Math.trunc(Number((f as { line?: unknown }).line)) }))
      .filter((f) => f && f.path && Number.isInteger(f.line) && f.line > 0 && f.severity && f.body),
  };
}

/**
 * WHOLE-REPO review: run `claude -p` INSIDE the PR's checkout (repoDir) with read-only file tools,
 * so it can Read/Grep/Glob across the ENTIRE codebase to reason about the change in full context —
 * callers, types, cross-file effects, tests. The deepest review. Same output contract + parser.
 */
export async function reviewPrWithRepo(
  pr: PrMeta,
  diff: string,
  repoDir: string,
  priorComments: PriorComment[] = []
): Promise<ReviewResult> {
  const clipped =
    diff.length > config.maxDiffBytes
      ? diff.slice(0, config.maxDiffBytes) + "\n…[diff truncated]…"
      : diff;
  const prompt = `${SYSTEM}

You are running INSIDE a checkout of this repository at the PR's head commit (${pr.headOid}). Use the Read, Grep, and Glob tools to open ANY files you need — the changed files, their callers, the types/interfaces they use, related modules and tests — to review the change in full context. Do not guess about code you can open and read.

PR: ${pr.title}
Author: ${pr.authorLogin} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files · head ${pr.headOid}${prContextBlock(pr, priorComments)}

The change under review (unified diff):
\`\`\`diff
${clipped}
\`\`\`

After exploring the repo as needed, respond with ONLY a JSON object — no prose, no markdown fences — of this exact shape:
{"summary": "ONE sentence, overall read only — NO issue descriptions", "findings": [{"path": "repo-relative path", "line": <integer, RIGHT side of the diff>, "severity": "High" | "Medium" | "Low", "body": "the concrete defect + a failure scenario or fix. Do NOT prefix severity."}]}
Anchor every finding to a line on the RIGHT (added/changed) side of the diff. Assign severity by REAL IMPACT. The summary must be consistent with findings; empty findings ONLY for a genuinely clean PR.`;

  // 10-min timeout — exploring a repo is slower than a text-only pass. Read-only tools only.
  return parseReviewResult(await runClaude(prompt, 600_000, 3, { cwd: repoDir, repoTools: true }));
}

export interface VerifyResult {
  allAddressed: boolean;
  unaddressed: string[]; // human-readable list of findings NOT yet addressed
  ok: boolean; // true when verification ran to a COMPLETE verdict (safe to cache); false on
  // error/incomplete (fail-closed) — the caller must NOT cache these so a transient
  // claude -p failure is retried rather than sticking.
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
  if (findings.length === 0) return { allAddressed: true, unaddressed: [], ok: true };
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
    // Verify runs on config.verifyModel when set (e.g. Haiku) — cheaper/faster than the review pass.
    const text = await runClaude(prompt, 150_000, 3, { model: config.verifyModel || undefined });
    const parsed = extractJson<{ verdicts?: Array<{ i?: number; addressed?: boolean; why?: string }> }>(
      text
    );
    const verdicts = parsed.verdicts ?? [];
    // Incomplete coverage → treat as not-verified (fail closed, don't cache).
    if (verdicts.length < findings.length)
      return { allAddressed: false, unaddressed: ["(verification incomplete)"], ok: false };
    const unaddressed = verdicts
      .filter((v) => v.addressed !== true)
      .map((v) => findings[v.i ?? -1]?.body?.slice(0, 60) ?? `finding ${v.i}`);
    return { allAddressed: unaddressed.length === 0, unaddressed, ok: true };
  } catch {
    return { allAddressed: false, unaddressed: ["(verification failed to run)"], ok: false };
  }
}
