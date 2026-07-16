import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

const octokit = new Octokit({ auth: config.github.token });

export interface PrMeta {
  title: string;
  authorLogin: string;
  state: string;
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

/** Post ONE review (event=COMMENT) with all inline comments anchored to `commitId`. */
export async function postReview(
  owner: string,
  repo: string,
  number: number,
  commitId: string,
  body: string,
  comments: ReviewComment[]
): Promise<string> {
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
}

export async function approvePr(
  owner: string,
  repo: string,
  number: number,
  body = "Findings addressed & verified — approving."
): Promise<void> {
  await octokit.pulls.createReview({ owner, repo, pull_number: number, event: "APPROVE", body });
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
