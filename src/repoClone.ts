import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Maintain a cached BLOBLESS BARE clone per repo and hand out a throwaway WORKTREE checked out at a
// PR's head — so the reviewer's `claude -p` can read any file across the real codebase. A worktree
// (not a shared checkout) isolates concurrent reviews of different PRs in the same repo. Blobless +
// bare keeps the cache tiny and clones fast (~1.5s / few MB). All git failures are swallowed and
// surfaced as null so the caller falls back to the diff-based review — repo context is a bonus, not
// a hard dependency.

const exec = promisify(execFile);
const GIT_TIMEOUT = 240_000;

const authUrl = (owner: string, repo: string): string =>
  `https://x-access-token:${config.github.token}@github.com/${owner}/${repo}.git`;

export interface RepoCheckout {
  dir: string; // working tree at the PR head
  cleanup: () => Promise<void>; // remove the worktree
}

export async function prepareRepoCheckout(
  owner: string,
  repo: string,
  number: number
): Promise<RepoCheckout | null> {
  const bare = path.join(config.repoCacheRoot, owner, `${repo}.git`);
  try {
    if (!fs.existsSync(path.join(bare, "HEAD"))) {
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      fs.rmSync(bare, { recursive: true, force: true });
      await exec("git", ["clone", "--filter=blob:none", "--bare", authUrl(owner, repo), bare], {
        timeout: GIT_TIMEOUT,
      });
    }
    // Fetch just the PR head (blobless) → FETCH_HEAD. Fetch from the EXPLICIT authUrl (current token),
    // NOT the named `origin` remote: origin's URL was baked in at clone time with whatever token was
    // current THEN, so after a token rotation a cached bare repo fetches with a STALE token and fails
    // "Invalid username or token" — which then silently degrades a DEEP review to FAST (see pipeline).
    await exec(
      "git",
      ["-C", bare, "fetch", "--filter=blob:none", authUrl(owner, repo), `pull/${number}/head`],
      { timeout: GIT_TIMEOUT }
    );
    const wt = path.join(config.repoCacheRoot, "wt", `${owner}-${repo}-${number}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await exec("git", ["-C", bare, "worktree", "add", "--detach", "--force", wt, "FETCH_HEAD"], {
      timeout: GIT_TIMEOUT,
    });
    return {
      dir: wt,
      cleanup: async () => {
        await exec("git", ["-C", bare, "worktree", "remove", "--force", wt], { timeout: 60_000 }).catch(
          () => undefined
        );
        fs.rmSync(wt, { recursive: true, force: true });
      },
    };
  } catch (e) {
    console.warn(
      `[pr-review-bot] repo checkout failed for ${owner}/${repo}#${number}: ${(e as Error).message.slice(0, 200)}`
    );
    return null;
  }
}
