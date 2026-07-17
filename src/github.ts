import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

const octokit = new Octokit({ auth: config.github.token });

export interface PrMeta {
  title: string;
  authorLogin: string;
  state: string; // "open" | "closed"
  merged: boolean; // true once the PR has been merged
  headOid: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string; // caller prefixes severity, e.g. "**[High]** …"
}

/** The login the token acts as — used for own-PR skip and "already approved" checks. */
export async function authUserLogin(): Promise<string> {
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

export async function getPr(owner: string, repo: string, number: number): Promise<PrMeta> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: number });
  return {
    title: data.title,
    authorLogin: data.user?.login ?? "",
    state: data.state,
    merged: data.merged ?? false,
    headOid: data.head.sha,
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

/** Other OPEN PRs in the repo touching any of `files` (duplicate-guard input). */
export async function openPrsTouchingFiles(
  owner: string,
  repo: string,
  excludeNumber: number,
  files: string[]
): Promise<number[]> {
  const { data: prs } = await octokit.pulls.list({ owner, repo, state: "open", per_page: 50 });
  const hits: number[] = [];
  for (const pr of prs) {
    if (pr.number === excludeNumber) continue;
    const { data: prFiles } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
    if (prFiles.some((f) => files.includes(f.filename))) hits.push(pr.number);
  }
  return hits;
}

export async function changedFilePaths(owner: string, repo: string, number: number): Promise<string[]> {
  const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 });
  return data.map((f) => f.filename);
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
