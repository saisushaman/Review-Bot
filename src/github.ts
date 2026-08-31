import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

const octokit = new Octokit({ auth: config.github.token });

export interface PrMeta {
  title: string;
  body: string; // the PR description — the author's stated intent (for spec-matching)
  authorLogin: string;
  state: string; // "open" | "closed"
  merged: boolean; // true once the PR has been merged
  headOid: string;
  headRefName: string; // the PR's head branch (used for ticket detection in the duplicate guard)
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string; // caller prefixes severity, e.g. "**[High]** …"
}

/** The login the token acts as — used for own-PR skip and "already approved" checks.
 *  Memoized for the process lifetime: the token's identity never changes, so re-fetching it on
 *  every review/approve (and every 2-min sweep) was a wasted API round-trip. */
let _authLogin: string | null = null;
export async function authUserLogin(): Promise<string> {
  if (_authLogin) return _authLogin;
  const { data } = await octokit.users.getAuthenticated();
  _authLogin = data.login;
  return _authLogin;
}

export async function getPr(owner: string, repo: string, number: number): Promise<PrMeta> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: number });
  return {
    title: data.title,
    body: data.body ?? "",
    authorLogin: data.user?.login ?? "",
    state: data.state,
    merged: data.merged ?? false,
    headOid: data.head.sha,
    headRefName: data.head.ref ?? "",
    changedFiles: data.changed_files,
    additions: data.additions,
    deletions: data.deletions,
  };
}

/** Unified diff text for the PR (bounded by the caller). */
export async function getPrDiff(owner: string, repo: string, number: number): Promise<string> {
  const res = await octokit.pulls.get({
    owner,
    repo,
    pull_number: number,
    mediaType: { format: "diff" },
  });
  // With the diff media type Octokit returns the raw diff as `data` (string).
  return res.data as unknown as string;
}

/**
 * Map of file path -> set of RIGHT-side (new-file) line numbers present in the unified diff
 * (added `+` and context ` ` lines). These are the ONLY lines an inline review comment can anchor
 * to; commenting on any other line makes GitHub 422 the WHOLE review. The caller uses this to keep
 * anchorable findings inline and fold the rest into the review body (so nothing is lost).
 */
export function anchorableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim().replace(/^b\//, "");
      path = p === "/dev/null" ? null : p;
      if (path && !map.has(path)) map.set(path, new Set());
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/); // @@ -a,b +c,d @@  → new-file start = c
      newLine = m ? parseInt(m[1], 10) : 0;
    } else if (path !== null && raw.startsWith("+") && !raw.startsWith("+++")) {
      map.get(path)!.add(newLine++); // added line — anchorable
    } else if (path !== null && raw.startsWith(" ")) {
      map.get(path)!.add(newLine++); // context line — anchorable
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      /* removed line — does not advance the new-file counter */
    }
  }
  return map;
}

/**
 * Post ONE review (event=COMMENT) with inline comments anchored to `commitId`. Resilient: if
 * GitHub rejects the call because a comment can't anchor to the diff (422), it retries WITHOUT
 * inline comments, folding them into the body as a markdown list — so a review is never posted
 * empty-handed and findings are never silently dropped (PR #31).
 */
export async function postReview(
  owner: string,
  repo: string,
  number: number,
  commitId: string,
  body: string,
  comments: ReviewComment[]
): Promise<string> {
  try {
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      commit_id: commitId,
      event: "COMMENT",
      body,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
    });
    return data.html_url;
  } catch (e) {
    if (comments.length === 0) throw e; // nothing to fold — a real failure
    const folded =
      `${body}\n\n---\n**Inline anchoring failed — findings listed here instead (${comments.length}):**\n` +
      comments.map((c) => `- \`${c.path}:${c.line}\` — ${c.body}`).join("\n");
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      commit_id: commitId,
      event: "COMMENT",
      body: folded,
    });
    return data.html_url;
  }
}

export async function approvePr(
  owner: string,
  repo: string,
  number: number,
  body = "Findings addressed & verified — approving."
): Promise<void> {
  await octokit.pulls.createReview({ owner, repo, pull_number: number, event: "APPROVE", body });
}

/** Green iff no CI check/status on `ref` is pending or failing. No CI at all = vacuously green. */
export async function ciGreen(owner: string, repo: string, ref: string): Promise<boolean> {
  const [checks, status] = await Promise.all([
    octokit.checks.listForRef({ owner, repo, ref, per_page: 100 }),
    octokit.repos.getCombinedStatusForRef({ owner, repo, ref }),
  ]);
  // Every check-run must be completed AND non-failing (in_progress/queued/failure ⇒ not green).
  const runsOk = checks.data.check_runs.every(
    (r) => r.status === "completed" && ["success", "neutral", "skipped"].includes(r.conclusion ?? "")
  );
  // Legacy commit statuses: "success" (or none) is green; "pending"/"failure" is not.
  const statusOk = status.data.total_count === 0 || status.data.state === "success";
  return runsOk && statusOk;
}

/**
 * True when another reviewer is EXPLICITLY blocking — the PR's reviewDecision is CHANGES_REQUESTED
 * (a human or codex/copilot/gemini/charlie requested changes that haven't been dismissed/re-approved).
 * We deliberately do NOT require review threads to be marked "resolved": the team addresses comments
 * without clicking "Resolve conversation", so the author's "addressed" signal + no CHANGES_REQUESTED
 * is the bar. Fails safe: on a query error it returns true (block).
 */
export async function changesRequested(
  owner: string,
  repo: string,
  number: number
): Promise<boolean> {
  const q = `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){
    reviewDecision
  }}}`;
  try {
    const res: any = await octokit.graphql(q, { o: owner, r: repo, n: number });
    return res.repository.pullRequest.reviewDecision === "CHANGES_REQUESTED";
  } catch {
    return true; // fail closed — don't approve if we can't confirm nothing is blocking
  }
}

export interface ReviewThread {
  isResolved: boolean;
  hasReply: boolean; // more than one comment in the thread → the root finding got a reply
  rootAuthor: string;
  rootBody: string;
}

/** Every review-comment THREAD on the PR, with whether it's resolved and whether it has a reply.
 *  Used by the light "was the review responded to?" approval gate — a thread counts as handled if
 *  it's resolved OR has at least one reply (the author engaged), regardless of a code fix. */
export async function reviewThreads(
  owner: string,
  repo: string,
  number: number
): Promise<ReviewThread[]> {
  const q = `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){
    reviewThreads(first:100){ nodes{ isResolved comments(first:1){ totalCount nodes{ author{login} body } } } }
  }}}`;
  try {
    const res: any = await octokit.graphql(q, { o: owner, r: repo, n: number });
    return (res.repository.pullRequest.reviewThreads.nodes ?? []).map((t: any) => ({
      isResolved: !!t.isResolved,
      hasReply: (t.comments?.totalCount ?? 0) > 1,
      rootAuthor: t.comments?.nodes?.[0]?.author?.login ?? "",
      rootBody: t.comments?.nodes?.[0]?.body ?? "",
    }));
  } catch {
    return [];
  }
}

export async function hasApprovedBy(
  owner: string,
  repo: string,
  number: number,
  login: string
): Promise<boolean> {
  const { data } = await octokit.pulls.listReviews({ owner, repo, pull_number: number });
  return data.some((r) => r.user?.login === login && r.state === "APPROVED");
}

/** All review threads authored by `login`, with their resolved state (GraphQL). */
export async function botReviewThreadsResolved(
  owner: string,
  repo: string,
  number: number,
  login: string
): Promise<{ any: boolean; allResolved: boolean }> {
  const q = `query($owner:String!,$repo:String!,$n:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$n){
      reviewThreads(first:50){ nodes { isResolved comments(first:1){ nodes { author { login } } } } }
    }}}`;
  const res: any = await octokit.graphql(q, { owner, repo, n: number });
  const nodes = res.repository.pullRequest.reviewThreads.nodes as Array<{
    isResolved: boolean;
    comments: { nodes: Array<{ author: { login: string } | null }> };
  }>;
  const mine = nodes.filter((t) => t.comments.nodes[0]?.author?.login === login);
  return { any: mine.length > 0, allResolved: mine.length > 0 && mine.every((t) => t.isResolved) };
}

/** A changed path that signals a real implementation (not an incidental doc/ledger/changelog). */
export function isCodeFile(f: string): boolean {
  return !/\.(md|mdx|txt|rst)$/i.test(f) && !/(^|\/)docs\//i.test(f) && !/ledger|changelog/i.test(f);
}

const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/i;

/**
 * Full content of the PR's changed CODE files at `ref` (the head), for review CONTEXT — so the model
 * reviews the change against the actual surrounding code (functions, call sites, types, invariants),
 * not just the +/- diff lines. Skips removed/binary/lock files. Capped per-file and in total to keep
 * the prompt bounded; `truncated` marks a file that hit the per-file cap.
 */
export async function changedFilesContent(
  owner: string,
  repo: string,
  number: number,
  ref: string,
  perFileBytes = 28_000,
  totalBytes = 450_000
): Promise<Array<{ path: string; content: string; truncated: boolean }>> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  const out: Array<{ path: string; content: string; truncated: boolean }> = [];
  let used = 0;
  for (const f of files) {
    if (used >= totalBytes) break;
    if (f.status === "removed" || !isCodeFile(f.filename) || LOCKFILE.test(f.filename)) continue;
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path: f.filename, ref });
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") continue;
      const full = Buffer.from(data.content, "base64").toString("utf8");
      if (full.includes(String.fromCharCode(0))) continue; // skip binary (NUL byte)
      const cap = Math.min(perFileBytes, totalBytes - used);
      const content = full.slice(0, cap);
      out.push({ path: f.filename, content, truncated: content.length < full.length });
      used += content.length;
    } catch {
      /* unreadable file — skip, the diff still covers it */
    }
  }
  return out;
}

/** Extract a ticket key like "PORTAL-69" / "PLANE-26" from a PR title or branch, or null. */
export function ticketKey(title: string, headRef: string): string | null {
  const m = `${title} ${headRef}`.match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Other OPEN PRs that GENUINELY compete with this one — a true duplicate where only one should
 * merge — NOT merely a PR that happens to touch a shared file. Competition means:
 *   1. the SAME ticket key (both PRs are the same PROJ-NNN), or
 *   2. when NEITHER PR carries a ticket, a STRONG changed-file overlap (≥2 shared code files AND
 *      ≥60% of the smaller PR's code files), i.e. clearly the same implementation.
 * A single incidentally-shared file (a router, an index, a config) is NOT competition — that was the
 * #45↔#42 false positive. Different tickets are never treated as competing.
 */
export async function competingOpenPrs(
  owner: string,
  repo: string,
  excludeNumber: number,
  myTicket: string | null,
  myCodeFiles: string[]
): Promise<number[]> {
  const mySet = new Set(myCodeFiles);
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: "open", per_page: 50 });
  const hits: number[] = [];
  for (const pr of prs) {
    if (pr.number === excludeNumber) continue;
    const theirTicket = ticketKey(pr.title, pr.head?.ref ?? "");
    if (myTicket || theirTicket) {
      // At least one side has a ticket → competing ONLY if the tickets are the SAME.
      if (myTicket && theirTicket && myTicket === theirTicket) hits.push(pr.number);
      continue; // different (or one-sided) tickets → NOT competing
    }
    // Neither side has a ticket → fall back to a strong changed-file overlap.
    if (mySet.size === 0) continue;
    const { data: theirFiles } = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 });
    const theirCode = theirFiles.map((f) => f.filename).filter(isCodeFile);
    const shared = theirCode.filter((f) => mySet.has(f));
    const smaller = Math.min(mySet.size, theirCode.length);
    if (shared.length >= 2 && smaller > 0 && shared.length / smaller >= 0.6) hits.push(pr.number);
  }
  return hits;
}

export async function changedFilePaths(owner: string, repo: string, number: number): Promise<string[]> {
  const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 });
  return data.map((f) => f.filename);
}

export interface OpenPrSummary {
  number: number;
  title: string;
  author: string;
  files: string[];
}

/**
 * Every OTHER open PR in the repo, with the paths it changes — the context a single-PR review
 * otherwise lacks. Without it the bot can't see that a sibling PR creates the same file (a merge
 * collision), or that this PR deletes/renames something another open PR is stacked on (a sequencing
 * hazard). Titles + changed paths are enough for the model to flag the interaction and say which PR
 * to coordinate with; we deliberately don't pull their diffs (cost) — the review names the risk and
 * whose branch to check, it doesn't adjudicate the other PR. Capped so a busy repo can't blow up the
 * prompt. Best-effort: a per-PR file fetch that fails is skipped, never fails the review.
 */
export async function otherOpenPrs(
  owner: string,
  repo: string,
  excludeNumber: number,
  maxPrs = 8,
  maxFilesEach = 40
): Promise<OpenPrSummary[]> {
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: "open", per_page: 50 });
  const others = prs.filter((p) => p.number !== excludeNumber).slice(0, maxPrs);
  const out: OpenPrSummary[] = [];
  for (const pr of others) {
    try {
      const { data: files } = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      out.push({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? "",
        files: files.map((f) => f.filename).slice(0, maxFilesEach),
      });
    } catch {
      /* skip a PR whose files we can't list — cross-PR context is a bonus, never a hard dep */
    }
  }
  return out;
}

/** ALL inline review comments on the PR (every reviewer: the bot's own automated review + codex/
 *  copilot/gemini/charlie + humans) — the findings the verify step confirms are addressed in the
 *  commits before approving. */
export async function allReviewComments(
  owner: string,
  repo: string,
  number: number
): Promise<Array<{ path: string; line: number; body: string; author: string }>> {
  const { data } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return data.map((c) => ({
    path: c.path,
    line: c.line ?? c.original_line ?? 0,
    body: c.body,
    author: c.user?.login ?? "",
  }));
}

/** The bot's own inline review comments — used to reconstruct prior findings for the verify step. */
export async function botReviewComments(
  owner: string,
  repo: string,
  number: number,
  login: string
): Promise<Array<{ path: string; line: number; body: string }>> {
  const { data } = await octokit.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100 });
  return data
    .filter((c) => c.user?.login === login)
    .map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? 0, body: c.body }));
}

/** ISO timestamp of OUR most recent review on the PR (any state), or null. Used to cap how long the
 *  bot will hold approval waiting on unresolved comments — see HOLD_MAX_HOURS in pipeline.ts. */
export async function lastOwnReviewAt(
  owner: string,
  repo: string,
  number: number,
  login: string
): Promise<string | null> {
  try {
    const { data } = await octokit.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100 });
    const mine = data.filter((r) => r.user?.login === login && r.submitted_at);
    return mine.length ? (mine[mine.length - 1].submitted_at as string) : null;
  } catch {
    return null;
  }
}
