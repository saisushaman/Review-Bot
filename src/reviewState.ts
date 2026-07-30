import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Persistent record of what THIS bot has reviewed — the authoritative "is this PR ours?" source,
// modelled on Alden's pr-review-state.json (`reviewed[key] = headSHA`). Unlike a :eyes: reaction
// (which humans and other bots also add, and which is lost track of across restarts), this is our
// own durable log: it survives restarts and can't be spoofed by someone else's reaction. Used to
// gate the "addressed" path — we only handle a PR's thread replies if we actually reviewed it.

type State = { reviewed: Record<string, string> }; // "owner/repo#n" -> head SHA at review time

export const prKey = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;

function load(): State {
  try {
    const data = JSON.parse(fs.readFileSync(config.reviewStatePath, "utf8")) as Partial<State>;
    return { reviewed: data.reviewed ?? {} };
  } catch {
    return { reviewed: {} }; // missing/corrupt file → empty (a fresh bot has reviewed nothing)
  }
}

/** True iff the bot has recorded a review of this PR (at any commit). */
export function hasReviewed(key: string): boolean {
  return key in load().reviewed;
}

/** The head SHA the bot last reviewed this PR at, or undefined. */
export function reviewedSha(key: string): string | undefined {
  return load().reviewed[key];
}

/** Record key→headSha. Atomic (temp file + rename) so a crash can't leave a half-written file. */
export function markReviewed(key: string, headSha: string): void {
  const p = config.reviewStatePath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const state = load();
  state.reviewed[key] = headSha;
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
