import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Persistent record of what THIS bot has reviewed — the authoritative "is this PR ours?" source,
// modelled on Alden's pr-review-state.json (`reviewed[key] = headSHA`). Unlike a :eyes: reaction
// (which humans and other bots also add, and which is lost track of across restarts), this is our
// own durable log: it survives restarts and can't be spoofed by someone else's reaction. Used to
// gate the "addressed" path — we only handle a PR's thread replies if we actually reviewed it.

// Each entry records the head SHA reviewed AND whether that review was thorough enough to back an
// approval: `insufficient` is true when a SECURITY-SENSITIVE PR only got the shallow FAST review
// instead of the deep whole-repo one (see produceReview). The approval paths refuse to approve while
// it's true — "don't approve until the review is thorough". Legacy entries were a bare SHA string;
// load() migrates those to { sha, insufficient: false } (an already-approved PR isn't re-approved).
type Entry = { sha: string; insufficient?: boolean };
type State = { reviewed: Record<string, Entry> }; // "owner/repo#n" -> entry

export const prKey = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;

function load(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(config.reviewStatePath, "utf8")) as {
      reviewed?: Record<string, string | Entry>;
    };
    const reviewed: Record<string, Entry> = {};
    for (const [k, v] of Object.entries(raw.reviewed ?? {})) {
      reviewed[k] = typeof v === "string" ? { sha: v, insufficient: false } : v;
    }
    return { reviewed };
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
  return load().reviewed[key]?.sha;
}

/** True iff the recorded review was NOT thorough enough to approve on (sensitive PR, shallow review). */
export function reviewInsufficient(key: string): boolean {
  return load().reviewed[key]?.insufficient === true;
}

/** Record key→{headSha, insufficient}. Atomic (temp file + rename) so a crash can't half-write. */
export function markReviewed(key: string, headSha: string, insufficient = false): void {
  const p = config.reviewStatePath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const state = load();
  state.reviewed[key] = { sha: headSha, insufficient };
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
