// Pure parsing for the @-mention command surface (port of Alden's mentions.py). No I/O.
// A mention is "<@BOT> <verb> [pr-url]". The verb is keyword-matched to a small fixed set
// (unknown/empty → help); a PR ref, if present, is pulled from a github PR url in the text.
// Routing is deliberately dumb (no LLM) so behavior is predictable and cheap.

export type Command = "review" | "re-review" | "addressed" | "status" | "approve" | "fix" | "help";

const BOT_MENTION = /<@[A-Z0-9]+>/g;
const PR_URL = /github\.com\/([^/\s|>]+)\/([^/\s|>]+)\/pull\/(\d+)/;
// "addressed"/"addresses"/"addressing" = "I fixed the review feedback". Bare "address" excluded.
const ADDRESSED = /\baddress(?:ed|es|ing)\b/i;
// "approve" as a request; excludes past-tense "approved" (a statement, not a request).
const APPROVE = /\bapprove\b/i;

// Exact-match allow-lists (not prefix/substring) so "yesterday" / "yes but not that" never
// auto-kick work — when ambiguous, the offer just stands until the user is explicit.
const AFFIRMATIVES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ya", "sure", "ok", "okay", "k",
  "yes please", "please", "please do", "do it", "go ahead", "go for it",
  "sounds good", "affirmative", "yes go ahead",
]);
const NEGATIVES = new Set([
  "no", "n", "nope", "nah", "naw", "no thanks", "no thank you",
  "not now", "not yet", "later", "maybe later", "don't", "dont",
  "leave it", "negative", "cancel", "stop", "skip",
]);

const VERBS: Record<string, Command> = {
  review: "review",
  "re-review": "re-review",
  rereview: "re-review",
  status: "status",
  approve: "approve",
  help: "help",
};

const GERUNDS: Record<string, string> = {
  review: "reviewing",
  "re-review": "re-reviewing",
  verify: "verifying feedback on",
  fix: "addressing feedback on",
};
const IDLE_STATUS = "Nothing in progress — want a review or re-review? Reply *yes*.";

export interface ParsedMention {
  command: Command;
  owner: string | null;
  repo: string | null;
  number: number | null;
}

export const mentionKey = (m: ParsedMention): string | null =>
  m.owner && m.repo && m.number != null ? `${m.owner}/${m.repo}#${m.number}` : null;
export const mentionSlug = (m: ParsedMention): string | null =>
  m.owner && m.repo ? `${m.owner}/${m.repo}` : null;

function stripMentions(text: string): string {
  return text.replace(BOT_MENTION, " ");
}

/** "I addressed the review feedback" cue → verify path. Bot mentions stripped first. */
export function signalsAddressed(text: string): boolean {
  return ADDRESSED.test(stripMentions(text));
}

/** "can you approve this?" → approve path. Excludes past-tense "approved". */
export function signalsApprove(text: string): boolean {
  return APPROVE.test(stripMentions(text));
}

function normalizeReply(text: string): string {
  const t = stripMentions(text).trim().toLowerCase().replace(/\s+/g, " ");
  return t.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ""); // trim edge whitespace + punctuation
}

export const isAffirmative = (text: string): boolean => AFFIRMATIVES.has(normalizeReply(text));
export const isNegative = (text: string): boolean => NEGATIVES.has(normalizeReply(text));

/** Does the text @-mention the given bot user id? */
export const mentionsBot = (text: string, botUserId: string): boolean =>
  text.includes(`<@${botUserId}>`);

export function parseMention(text: string): ParsedMention {
  const stripped = stripMentions(text).trim();
  const first = stripped ? stripped.split(/\s+/, 1)[0].toLowerCase() : "";
  let command: Command = VERBS[first] ?? "help";
  // An unrecognized verb that reads as "addressed"/"approve" routes there, not to help.
  if (command === "help" && signalsAddressed(text)) command = "addressed";
  else if (command === "help" && signalsApprove(text)) command = "approve";
  const m = PR_URL.exec(text);
  if (m) return { command, owner: m[1], repo: m[2], number: Number(m[3]) };
  return { command, owner: null, repo: null, number: null };
}

function projectAndPr(key: string): string {
  const [slug, number] = key.split("#");
  const repo = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  return repo && number ? `PR #${number} in \`${repo}\`` : `\`${key}\``;
}

/** Render `inflight.snapshot()` for the `status` command. Empty → idle offer. */
export function formatStatus(active: Record<string, string>): string {
  const entries = Object.entries(active);
  if (entries.length === 0) return IDLE_STATUS;
  return entries
    .map(([key, label]) => `I'm currently ${GERUNDS[label] ?? "working on"} ${projectAndPr(key)}.`)
    .join("\n");
}

export const HELP_TEXT =
  "*Commands* — mention me in a thread on a PR post, or paste the PR link:\n" +
  "• *review* — full code review of the PR\n" +
  "• *re-review* — fresh pass over an already-reviewed PR\n" +
  "• *addressed* — I verify the feedback was handled, then approve\n" +
  "• *approve* — check CI, merge conflicts & unresolved comments, then approve if all clear\n" +
  "• *status* — what I'm working on right now\n" +
  "• *help* — this message";

export const NO_PR_TEXT =
  "couldn't tell which PR you mean — reply in my review thread or include the PR link.";
