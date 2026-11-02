import type { Finding } from "./review.js";
import type { ExistingComment } from "./github.js";

// DON'T REPEAT WHAT ANOTHER BOT ALREADY SAID.
//
// The review itself stays fully independent — the model is NOT told about other reviewers' comments
// and is NOT asked to report "only the residual". That instruction is what once throttled this bot
// to a single finding on a heavily-reviewed PR, so it stays out of the prompt. Instead the overlap
// is removed HERE, deterministically, after the review and before anything is posted: the bot finds
// everything it would have found, and simply doesn't post the part another bot has already covered.
//
// WHAT COUNTS AS "ALREADY SAID" — two rules found by measuring real comments (see THRESHOLD below):
//  1. ROOT COMMENTS ONLY. A threaded reply is conversation, not a finding — baz-reviewer's "one of
//     these commits addressed this comment: b23d0bd…" quotes the issue it is answering, so treating
//     replies as findings would suppress genuinely new ones. Dropping replies removed every
//     false match in the sample on its own.
//  2. BOTS ONLY, never ourselves. A human's comment may be a question, a preference or a reply to
//     someone else; a person is also entitled to hear the same concern from a reviewer. Only an
//     automated reviewer's own top-level finding suppresses ours.

/** Distinctive words of a comment body: markdown fences dropped, short/common words dropped. Same
 *  shape as the cross-lens de-duplication in review.ts, so the two behave consistently. */
const words = (b: string): Set<string> =>
  new Set(
    b
      .replace(/```[\s\S]*?```/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9\s_./-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4)
  );

const overlap = (a: string, b: string): number => {
  const A = words(a);
  const B = words(b);
  if (A.size < 5 || B.size < 5) return 0; // too little text to judge — never match on it
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
};

// THRESHOLD, measured rather than guessed. Across 28 recent PRs in this org (PathwaysAI,
// SmartCareAPI, ActualChat, customer-portal) there were 9 cross-author ROOT-comment pairs on the
// same file within 10 lines of each other. Exactly one was the same issue found twice — Copilot and
// a human reviewer both catching the missing Cohere API key on PathwaysAI #178
// (pathways-deploy:238) — and it scored 0.83. Every pair that was genuinely two different issues
// scored 0.16 or below. 0.50 sits in the middle of that gap with wide margin either side.
//
// The asymmetry matters when tuning this: posting a duplicate is a small annoyance, while dropping a
// real finding is a defect shipped. So this is set to miss duplicates rather than risk a false drop.
const SAME_ISSUE = 0.5;
// With no line to compare, position adds no evidence, so the wording has to carry the whole match.
const SAME_ISSUE_UNANCHORED = 0.6;
// How far apart two comments on one file can sit and still be the same issue. Reviewers anchor to
// slightly different lines of the same hunk (the pair above landed on the same line; the widest
// genuine-duplicate drift seen in the sample was a few lines).
const NEAR_LINES = 10;

export interface DropResult {
  findings: Finding[];
  /** One line per dropped finding, for the log — a wrong drop has to be visible, not silent. */
  dropped: string[];
}

/**
 * Remove findings another BOT has already raised on this PR. Returns the findings to post plus a
 * human-readable note for each one dropped and who had already said it.
 */
export function dropFindingsOtherBotsMade(
  findings: Finding[],
  existing: ExistingComment[],
  selfLogin: string
): DropResult {
  const self = selfLogin.toLowerCase();
  const theirs = existing.filter(
    (c) => c.isBot && !c.isReply && c.author.toLowerCase() !== self && c.body.trim().length > 0
  );
  if (!theirs.length) return { findings, dropped: [] };

  const dropped: string[] = [];
  const kept = findings.filter((f) => {
    for (const c of theirs) {
      if (c.path !== f.path) continue;
      const anchored = f.line > 0 && c.line > 0;
      if (anchored && Math.abs(c.line - f.line) > NEAR_LINES) continue;
      const score = overlap(f.body, c.body);
      if (score < (anchored ? SAME_ISSUE : SAME_ISSUE_UNANCHORED)) continue;
      dropped.push(
        `${f.path}:${f.line} (${f.severity}) — already raised by ${c.author} at line ${c.line}, overlap ${score.toFixed(2)}`
      );
      return false;
    }
    return true;
  });
  return { findings: kept, dropped };
}
