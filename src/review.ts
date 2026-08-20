import { spawn } from "node:child_process";
import { config } from "./config.js";
import type { PrMeta, OpenPrSummary } from "./github.js";

// This bot reviews via HEADLESS CLAUDE CODE (`claude -p`) running on your Claude Code
// subscription — NOT the metered Anthropic API. No API key / credits needed; the `claude`
// CLI must be installed and logged in (run `claude setup-token` or `claude` → `/login` once).

export type Severity = "Blocking" | "High" | "Medium" | "Low";
// Canonical order, most-severe first — the single source of truth for sorting + the review tally.
export const SEVERITIES: Severity[] = ["Blocking", "High", "Medium", "Low"];
/** Normalize a model-emitted severity to one of the four canonical levels (case-insensitive; maps
 *  common synonyms). Returns null for anything unrecognized so the parser can drop it. */
function normSeverity(v: unknown): Severity | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "blocking" || s === "blocker" || s === "critical") return "Blocking";
  if (s === "high") return "High";
  if (s === "medium" || s === "moderate") return "Medium";
  if (s === "low" || s === "nit" || s === "minor") return "Low";
  return null;
}
export interface Finding {
  path: string;
  line: number; // line in the PR head (RIGHT side of the diff)
  severity: Severity;
  body: string; // the concrete finding + failure scenario / fix
}
export interface ReviewResult {
  summary: string;
  findings: Finding[];
  // The concrete risk areas the review EXAMINED and cleared — the audit trail that makes a
  // "clean" verdict high-signal instead of a rubber stamp. Each item is a specific mechanism/file
  // that was checked and why it's fine (not generic praise). Rendered under the review body.
  checked: string[];
}

const SYSTEM = `You are a STAFF-level engineer doing a rigorous PR review. Your PRIMARY job is to catch SUBSTANTIVE defects — real bugs, security holes, breaking changes — NOT to nitpick style. Read the change against the FULL FILE CONTEXT provided below (the changed files' actual contents — call sites, types, invariants, error paths), reason about how the code behaves at runtime, and hunt hard for genuine problems.

Review across five vectors, weighting correctness + security heavily:
1. Correctness — logic errors, wrong conditions, off-by-one, null/undefined derefs, unhandled promise rejections, wrong async/ordering, race conditions, state that can go inconsistent, breaking changes to existing callers, wrong error handling (swallowed errors; fail-OPEN where it must fail-closed).
2. Security — think like an attacker. MISSING/weak authorization or ownership checks; injection/SSRF; unvalidated or unbounded input; path traversal; IDOR; over-broad permissions; unsafe deserialization; secrets/PII in logs; and — critically — **whether server-side enforcement can be BYPASSED at another layer**. On Firebase/Firestore especially: clients can write/read DIRECTLY via the SDK, so any constraint the API route enforces (userId, status, source, role, ownership, which fields are settable) MUST also be enforced in the security RULES — a rule that only checks auth + companyId but lets the client set userId/status/source/type is a BLOCKING (merge-stopping) forgery / impersonation / privilege-escalation gap, even if the API route does it "correctly." When the diff touches firestore.rules / IAM / any auth policy, spell out exactly what a malicious authenticated client could forge or access that the rule fails to prevent.
3. Architecture — drift from the codebase's established patterns, leaky abstractions, coupling that will break, misuse of shared modules (judge against the provided file context, not personal taste).
4. Tests — untested new logic/branches, deleted tests, tautological assertions. Name the SPECIFIC branch left uncovered.
5. Spec matching — PR title/description vs the actual diff: work described-but-not-done, done-but-not-described, scope creep.

THREAT-MODEL & CLAIM-CHECK MANDATE — run this on ANY change touching auth, access control, security rules, tenant isolation, or user-supplied data:
- Trace whether a constraint enforced in one layer is ALSO enforced where an attacker could go AROUND it. A check that lives only in an API route / server handler, with no matching enforcement in the DB security rules (so a client can hit the datastore directly), is a real — usually BLOCKING — vulnerability. Ask concretely: "what can a malicious but authenticated user write or read by skipping the happy path?"
- CROSS-CHECK the PR's own security claims — in its description or the docs it edits — against what the code/rules ACTUALLY enforce. If the docs say "the client cannot set status/source" but the rules don't stop the client from setting them, that contradiction is a finding (cite both the claim and the gap).
- Explicitly consider field forgery, impersonation (e.g. a forged userId), status/state tampering, and privilege escalation — not just "is there a check somewhere."
- When a write is ALLOWED with a DENYLIST of forbidden fields (e.g. Firestore keys().hasAny([...])), the list is only as good as it is COMPLETE — verify it blocks EVERY server-owned field a client must not set. Blocking some (projectId, sync markers) while omitting others (userId, status, source, type) still lets the client forge the omitted ones. Enumerate the fields a client could set on that write and confirm each is either validated or blocked; a partial denylist is a gap, not a fix — even (especially) when the PR is a hardening pass that "looks" thorough.

RECURRING SECURITY CHECKS — apply whenever the PR touches file uploads, storage/DB rules, or user-supplied data (these are classes the reviewer has missed before, so run them explicitly):
- Uploads / content types: a browser-EXECUTABLE upload that slips through is stored XSS. If an upload or storage rule allows a broad type (e.g. image/*), confirm it EXCLUDES or sanitizes svg (image/svg+xml) and html/xml — allowing image/* without carving out SVG is a real finding.
- Stored paths / keys / URLs: a client-supplied path, storage key, or URL stored VERBATIM with no prefix/bucket/host allow-list check enables path traversal or cross-tenant / off-site references — flag any identifier persisted without validating it points where it must.
- Identity fields: userId / createdBy / ownerId / authorId / senderId must be pinned to the authenticated principal (e.g. request.auth.uid), never taken from client input — an unpinned identity field is impersonation, and it's a real gap even when a denylist blocks other fields.
- Supply-chain / build pinning: a base image or dependency pinned by a MUTABLE reference — a floating tag (\`:latest\`, \`:v1.2\`) or a branch — is not reproducible and can be re-pushed under you. When the repo's own docs/policy call for a digest (\`@sha256:…\`) or a cosign-verified/pinned base (grep the docs — CLAUDE.md, AGENTS.md, a gap-analysis/security doc), a Dockerfile/workflow using a plain tag CONTRADICTS that policy and is a finding; cite the policy line and the mutable ref.

SEVERITY by real-world IMPACT — assign HONESTLY across FOUR levels, do NOT default everything to Low. Post EACH finding as its OWN inline comment tagged with its level; a non-trivial PR normally warrants SEVERAL:
- Blocking — MUST be fixed before this PR merges. A concrete exploit path (auth/permission BYPASS, field forgery, impersonation, privilege escalation, tenant-isolation break — a client reading/writing data it shouldn't), data loss, an outage, a broken build / failing call site, or a security hole with a real attack path. If merging as-is would ship a known defect or vulnerability, it is Blocking — even when the "happy path" is correct, because the exploit path is concrete.
- High — a serious problem very likely to bite in production (a real logic bug, a plausible security issue, a breaking change to an existing caller) that should be fixed, but is not by itself an outright merge-stopper.
- Medium — a real but bounded problem: a missing test for real logic, a plausible edge-case bug, a moderate security/perf issue, an architectural violation, a dropped error state.
- Low — style, naming, clarity, docs, micro-nits with NO behavioral impact.

DEPTH MANDATE: report EVERY substantive issue as its OWN finding at the right priority — a non-trivial PR normally surfaces SEVERAL across Blocking/High/Medium/Low, NOT one. Enumerate them across ALL these axes, not just the single most notable: correctness; error-handling; ROBUSTNESS to malformed / edge / missing inputs (does a test or parser crash or silently pass on a bad value?); TEST QUALITY (a check that only exercises the happy path, an assertion that a malformed value would slip past); DOC ACCURACY (a README/handoff that now contradicts the code — a stale "feature X is absent" line, an unverified guarantee); CONFIG correctness (a missing/misnamed env var, a value that breaks the pinned runtime); and security. BIAS TOWARD FILING: when you spot a plausible, concrete problem, FILE it (phrase it as a question if you are not certain it's real) rather than silently CLEARING it — an over-cautious pass that clears borderline issues into "Checked & cleared" reads as a rubber stamp and is exactly the "just one finding" failure. A finding you're 70% sure of, tagged Low/Medium and phrased as a question, is more useful than an unstated doubt. But NEVER invent or pad: every finding must cite CONCRETE code + a failure scenario. If the PR is genuinely, provably clean, return 0 findings — don't manufacture issues. A security-sensitive PR (auth, access control, security rules, tenant isolation, uploads, user-supplied data) that you rate 0 Blocking AND 0 High AND 0 Medium is a STRONG claim — do not make it unless you actually traced each new write/read's forgery + bypass surface and can name why each is closed; "the security model holds up" with no evidence is exactly the false all-clear that lets a real bypass ship. When in doubt on a security-sensitive write, a concrete-but-uncertain finding phrased as a question beats a silent pass.

MISSING-CODE & UNCHANGED-FILE FINDINGS — the most important bugs often are NOT on a changed line: a Firestore/security rule that fails to mirror a check the new API route enforces, an authorization the new endpoint needs but never added, a validation the new input path lacks. These live in code the diff did NOT touch (or in the ABSENCE of code), so they have no green "+" line to sit on. You MUST still report them in findings[] — do NOT drop or downgrade a real bug just because it isn't on an added line. Anchor such a finding to the CLOSEST relevant changed line (the new code whose safety depends on the missing piece — the route handler, the write call, the rules block the PR did touch); the review harness carries findings that can't anchor exactly, so never suppress one for lack of a perfect line.

EXHAUSTIVE-CLAIM CHECK — when a PR claims to handle a COMPLETE set ("delete every companyId-scoped record", "sweep all X", "cascade the whole thing", "cover all cases", "migrate every caller"), do NOT spot-check a sample: build the FULL set from the AUTHORITATIVE source (every collection in firestore.rules, every enum variant, every route/caller, every field) and reconcile it item-by-item — each is either HANDLED, a deliberate SURVIVOR (documented, with a reason), a GAP, or NOT-ACTUALLY-IN-SCOPE (e.g. keyed differently, or vestigial with no live writer). Report EVERY gap. And when the finding IS this completeness gap, put the WHOLE reconciliation in the body — the complete list of what's unaccounted for, not "several, e.g. A and B": a partial list of a completeness defect is itself incomplete, and it lets the reader fix the two you named and re-ship with the rest still orphaned. Excluding an item is a claim too — say why (vestigial/not-scoped), don't just omit it.

CROSS-PR INTERACTIONS — when OTHER OPEN PRs are listed below (with the files each touches), this change does not land alone. Reason about how it composes with them, because a single-PR-in-isolation review is blind to exactly the bugs that only appear at integration: (a) MERGE / PATH COLLISION — another open PR creates or rewrites the SAME file with different content (a shared CI workflow, config, .gitignore, a barrel/index), so a naive merge silently clobbers one side's work; name both PRs and the file. (b) SEQUENCING / CUTOVER HAZARD — this PR deletes, renames, or moves something (an env var, a config key, a file, an export) that another open PR — or a documented cutover/migration step in THIS PR's own docs (HANDOFF.md, a migration guide) — still depends on; a cutover that removes a variable whose contents another change relies on drops that behavior in production even though each PR looks fine alone. (c) DUPLICATED / CONFLICTING INFRA — two PRs add overlapping tooling (two CI files doing similar jobs, two configs for one system) that must be combined or deconflicted, not both merged. Flag these as real findings (severity by impact — a lost router or clobbered test job is High/Medium), and say which PR to coordinate with. Do NOT adjudicate the other PR's internals — you only have its file list; name the interaction and whose branch to check.

RELIABILITY:
- Substantiate every finding with the specific code and how it fails. If uncertain, phrase the body as a question but still include it.
- Prefer anchoring each finding to a real line on the RIGHT (added/changed) side of the diff at the head revision — BUT a missing-enforcement / unchanged-file finding (see above) is still required even when the best anchor is only the nearest related changed line.

OUTPUT CONTRACT — non-negotiable:
- EVERY issue MUST be a separate object in "findings" (path, line, severity, body). Prose outside findings[] is DISCARDED and LOST.
- "summary" is ONE sentence, overall read only — no issue descriptions. It MUST be consistent with findings: if it hints at any issue, that issue is a findings[] entry; if findings is empty the summary plainly says the PR is clean, no hedging. CONCRETELY: any contrastive/deficiency phrasing in the summary — "but…", "however…", "appears to drop…", "seems to miss…", "doesn't handle…", "fails to…", "the docs still guarantee…", "only issue is…" — MEANS you found a real issue. FILE IT as a findings[] object (severity by impact — a dropped documented behavior is Medium spec-matching, not a footnote) and keep the summary neutral. A summary that names or gestures at a concern while findings[] is empty is a CONTRACT VIOLATION and the concern is silently LOST — this is exactly how a real defect ships under a green review. Never do it.
- "checked": the AUDIT TRAIL — 3 to 6 CONCRETE risk areas you examined and found DEFINITIVELY safe, each naming the specific file/mechanism and WHY it holds (e.g. "app_factory is the only send-capable gateway site — poller instance is override-less, so no missed sender path"). CRITICAL: "checked" is ONLY for things you are confident are fine — it is NOT a place to park a doubt. If you examined something and there is ANY plausible concern (a malformed/edge input that might slip through, a doc line that might now be stale, an assertion that might be too weak, a config value that might break the runtime), that belongs in findings[] as a Low/Medium finding (phrased as a question if unsure), NOT in "checked". Moving a real doubt into "checked" to keep the finding count low is the exact "just one finding" failure. This is MANDATORY and most important when findings is empty: a clean PR with an empty or generic "checked" list reads as a rubber stamp. Ban generic filler ("code looks good", "tests pass", "well structured") — every item must cite a real thing you verified. If you truly examined nothing worth listing, you did not review deeply enough — go back.`;

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

/** Shared review context: the PR's stated intent (for spec-matching). We deliberately do NOT feed
 *  other reviewers' comments and do NOT tell the bot to de-dup against them — that "report only the
 *  net-new residual beyond everyone else" behavior is what throttled the bot to one finding on a
 *  heavily-reviewed PR. The bot does its OWN full independent review of the current code and reports
 *  EVERY real issue it finds; overlap with another reviewer is fine (they're independent reviews),
 *  and because it reviews the CURRENT code, anything already fixed simply won't be a finding. */
function prContextBlock(pr: PrMeta, _priorComments: PriorComment[]): string {
  return pr.body.trim()
    ? `\n\nPR description — the author's STATED INTENT; judge the change against it (spec-matching), and flag anything described-but-not-done, done-but-not-described, or scope creep:\n${pr.body.slice(0, 4000)}`
    : "";
}

/** The other open PRs and the files they touch — context for the CROSS-PR INTERACTIONS mandate
 *  (path collisions, cutover/sequencing hazards, duplicated infra). Empty string when there are none. */
function crossPrBlock(otherPrs: OpenPrSummary[]): string {
  if (!otherPrs.length) return "";
  return (
    `\n\nOTHER OPEN PRs in this repo — this change will merge alongside them, so apply the CROSS-PR INTERACTIONS mandate (path/merge collisions on a shared file, cutover/sequencing hazards where this PR removes something another depends on, duplicated or conflicting infra). You have only their file lists, not their diffs — name the interaction and which PR to coordinate with, don't adjudicate their internals:\n` +
    otherPrs
      .map(
        (p) =>
          `- #${p.number} "${p.title}" (by ${p.author}) touches: ${p.files.join(", ") || "(no files listed)"}`
      )
      .join("\n")
  );
}

export async function reviewPr(
  pr: PrMeta,
  diff: string,
  files: Array<{ path: string; content: string; truncated: boolean }> = [],
  priorComments: PriorComment[] = [],
  otherPrs: OpenPrSummary[] = []
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
Author: ${pr.authorLogin} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files · head ${pr.headOid}${prContextBlock(pr, priorComments)}${crossPrBlock(otherPrs)}

Unified diff (the change to review):
\`\`\`diff
${clipped}
\`\`\`${context}

Respond with ONLY a JSON object — no prose, no markdown fences — of this exact shape:
{"summary": "ONE sentence, overall read only — NO issue descriptions, NO severity tally", "findings": [{"path": "repo-relative path from the diff", "line": <integer, RIGHT side of the diff>, "severity": "Blocking" | "High" | "Medium" | "Low", "body": "the concrete defect + a failure scenario or fix. Do NOT prefix severity."}], "checked": ["3-6 concrete risk areas you examined and cleared, each naming the file/mechanism and why it holds — the audit trail; no generic filler"]}
Assign severity by REAL IMPACT (don't default to Low). Every issue — including ones you spot from the file context and missing-enforcement / unchanged-file bugs — goes in findings[] as its own object; anchor to the nearest relevant changed line when the issue isn't literally on an added line. The summary must be consistent with findings. Empty findings ONLY for a genuinely clean PR — and then "checked" MUST show the concrete things you verified.`;

  // Generous timeout: the full-file context makes a deep review take longer than the 180s default.
  return parseReviewResult(await runClaude(prompt, 360_000));
}

/** Parse claude's JSON review output into findings. Coerces `line` (models emit "138" / 138.0) and
 *  drops any finding missing a valid positive-integer line or a required field (PR #31 fix). */
function parseReviewResult(text: string): ReviewResult {
  let parsed: { summary?: string; findings?: Finding[]; checked?: unknown };
  try {
    parsed = extractJson<{ summary?: string; findings?: Finding[]; checked?: unknown }>(text);
  } catch {
    return { summary: "Review produced no parseable output.", findings: [], checked: [] };
  }
  return {
    summary: parsed.summary ?? "",
    findings: (parsed.findings ?? [])
      // Coerce line ("138"/138.0 → 138) and NORMALIZE severity to one of the four canonical levels
      // (Blocking/High/Medium/Low). A finding whose severity can't be normalized is dropped.
      .map((f) => ({
        ...f,
        line: Math.trunc(Number((f as { line?: unknown }).line)),
        severity: normSeverity((f as { severity?: unknown }).severity),
      }))
      .filter(
        (f): f is Finding =>
          !!f && !!f.path && Number.isInteger(f.line) && f.line > 0 && !!f.severity && !!f.body
      ),
    // The audit trail (strings only); drop blanks so a lazy empty list can't sneak through as one item.
    checked: (Array.isArray(parsed.checked) ? parsed.checked : [])
      .map((c) => String(c).trim())
      .filter((c) => c.length > 0),
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
  priorComments: PriorComment[] = [],
  otherPrs: OpenPrSummary[] = []
): Promise<ReviewResult> {
  const clipped =
    diff.length > config.maxDiffBytes
      ? diff.slice(0, config.maxDiffBytes) + "\n…[diff truncated]…"
      : diff;
  const prompt = `${SYSTEM}

You are running INSIDE a checkout of this repository at the PR's head commit (${pr.headOid}). Use the Read, Grep, and Glob tools to open ANY files you need — the changed files, their callers, the types/interfaces they use, related modules and tests — to review the change in full context. Do not guess about code you can open and read.

PR: ${pr.title}
Author: ${pr.authorLogin} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files · head ${pr.headOid}${prContextBlock(pr, priorComments)}${crossPrBlock(otherPrs)}

The change under review (unified diff):
\`\`\`diff
${clipped}
\`\`\`

After exploring the repo as needed, respond with ONLY a JSON object — no prose, no markdown fences — of this exact shape:
{"summary": "ONE sentence, overall read only — NO issue descriptions", "findings": [{"path": "repo-relative path", "line": <integer, RIGHT side of the diff>, "severity": "Blocking" | "High" | "Medium" | "Low", "body": "the concrete defect + a failure scenario or fix. Do NOT prefix severity."}], "checked": ["3-6 concrete risk areas you examined and cleared, each naming the file/mechanism and why it holds — the audit trail; no generic filler"]}
Anchor each finding to a line on the RIGHT (added/changed) side of the diff where possible; for a missing-enforcement / unchanged-file bug (a rule that doesn't mirror a new check, an auth the new route lacks) anchor to the nearest relevant changed line and still report it — never drop it for lack of an exact line. Assign severity by REAL IMPACT. The summary must be consistent with findings; empty findings ONLY for a genuinely clean PR — and then "checked" MUST show the concrete things you verified across the repo (the bypasses you looked for and didn't find, the callers you confirmed, the ACs the tests cover).`;

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
/** Verify ONE batch of findings against the diff. Internal — verifyFix splits into batches so each
 *  prompt's reasoning load is small enough to finish inside the timeout. Same fail-closed contract. */
async function verifyBatch(findings: Finding[], prDiff: string): Promise<VerifyResult> {
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
    const text = await runClaude(prompt, 180_000, 3, { model: config.verifyModel || undefined });
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

// One prompt over dozens of comments blows the timeout — 76 comments on ai-gateway #9 hung verify,
// which then held approval silently forever. Split into small batches so each fits the timeout.
const VERIFY_BATCH = 15;

export async function verifyFix(findings: Finding[], prDiff: string): Promise<VerifyResult> {
  if (findings.length === 0) return { allAddressed: true, unaddressed: [], ok: true };
  // Batch and verify concurrently, then aggregate. Fails CLOSED: if ANY batch couldn't complete,
  // ok=false so the caller holds (never approves on a partial verdict) — but batches that DID finish
  // still contribute their concrete unaddressed items, so the note can name real gaps.
  const batches: Finding[][] = [];
  for (let i = 0; i < findings.length; i += VERIFY_BATCH) batches.push(findings.slice(i, i + VERIFY_BATCH));
  const results = await Promise.all(batches.map((b) => verifyBatch(b, prDiff)));
  const ok = results.every((r) => r.ok);
  const failed = results.filter((r) => !r.ok).length;
  const concrete = results.flatMap((r) => r.unaddressed.filter((u) => !u.startsWith("(")));
  return {
    allAddressed: ok && concrete.length === 0,
    unaddressed: ok
      ? concrete
      : [...concrete, `(verification incomplete — ${failed}/${batches.length} batches timed out over ${findings.length} comments)`],
    ok,
  };
}
