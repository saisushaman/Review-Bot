import "dotenv/config";
import os from "node:os";
import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}
function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || !v.trim()) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export const config = {
  slack: {
    signingSecret: req("SLACK_SIGNING_SECRET"),
    token: req("SLACK_TOKEN"),
    appToken: opt("SLACK_APP_TOKEN", ""), // xapp-… present → Socket Mode (no public URL / tunnel)
    channelId: req("SLACK_CHANNEL_ID"),
    requireTagUserId: req("REQUIRE_TAG_USER_ID"),
  },
  github: {
    token: req("GITHUB_TOKEN"),
    repoAllowlist: opt("REPO_ALLOWLIST", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
  anthropic: {
    // Unused — the bot reviews via headless Claude Code (`claude -p`) on your Claude SUBSCRIPTION,
    // not the metered API. ⚠️ An ANTHROPIC_API_KEY in the env is NOT harmless: `claude -p` would pick
    // it up and bill the metered API instead of the subscription, and a low-credit key then fails
    // every review with "Credit balance is too low" (hit live 2026-07-30). review.ts now strips the
    // key from the claude -p child env so it always uses the subscription regardless of this.
    apiKey: opt("ANTHROPIC_API_KEY", ""),
    model: opt("ANTHROPIC_MODEL", "claude-opus-4-8"),
  },
  port: Number(opt("PORT", "3000")),
  claimDebounceMs: Number(opt("CLAIM_DEBOUNCE_MS", "5000")),
  claimEmoji: opt("CLAIM_EMOJI", "eyes"),
  approvedEmoji: opt("APPROVED_EMOJI", "white_check_mark"),
  skipOwnPrs: bool("SKIP_OWN_PRS", true),
  approveWhenAddressed: bool("APPROVE_WHEN_ADDRESSED", true),
  // When true, re-verify via claude -p that findings are actually fixed in the commits before
  // approving on an "addressed" signal. Default FALSE — "if they said addressed, approve it": trust
  // the author's signal + the objective gates (CI green, no CHANGES_REQUESTED, not a real duplicate).
  verifyFixesBeforeApprove: bool("VERIFY_FIXES_BEFORE_APPROVE", false),
  maxDiffBytes: Number(opt("MAX_DIFF_BYTES", "200000")),
  // Optional cheaper/faster model for the mechanical fix-VERIFICATION step (`claude -p --model`).
  // Empty = claude's default (currently Opus). Set e.g. `claude-haiku-4-5-20251001` to cut cost and
  // latency on the verify pass. ⚠️ Verification is what gates approvals ("is the fix really in the
  // commits?"); a weaker model can mis-judge and approve an unfixed PR. Only affects verify — the
  // review pass is unchanged. Revert by clearing this var and restarting.
  verifyModel: opt("VERIFY_MODEL", ""),
  // Event-driven CI (optional). When GITHUB_WEBHOOK_SECRET is set, the bot also runs a small HTTP
  // server that GitHub posts check_suite/workflow_run/status webhooks to, so a PR held on pending
  // CI is approved the INSTANT CI reports green — no waiting for the next 2-min poll (the poll stays
  // as a fallback). Empty secret = server never starts (default, fully non-breaking). Needs a public
  // HTTPS endpoint reachable by GitHub (a tunnel or host), since GitHub has no Socket-Mode equivalent.
  githubWebhookSecret: opt("GITHUB_WEBHOOK_SECRET", ""),
  githubWebhookPort: Number(opt("GITHUB_WEBHOOK_PORT", "3100")),
  githubWebhookPath: opt("GITHUB_WEBHOOK_PATH", "/github/webhook"),
  // Persistent record of PRs this bot reviewed (owner/repo#n → head SHA). The authoritative
  // "is this PR ours?" source for the approve/addressed path — survives restarts, unlike a reaction.
  reviewStatePath: opt(
    "REVIEW_STATE_PATH",
    path.join(os.homedir(), ".pr-review-bot", "review-state.json")
  ),
  // Whole-repo review: clone the repo (blobless) at the PR head and run `claude -p` INSIDE it so it
  // can read any file across the codebase (deepest context). Default ON; falls back to the diff +
  // fetched-file-content review if the clone fails. Clones cache under repoCacheRoot.
  repoContextReview: bool("REPO_CONTEXT_REVIEW", true),
  repoCacheRoot: opt("REPO_CACHE_ROOT", path.join(os.homedir(), ".pr-review-bot", "repo-cache")),
  // EFFICIENCY ROUTING: the whole-repo path (clone + agentic crawl, 10-min budget) is the deep but
  // expensive review. It's overkill for a small, non-sensitive change whose changed-file contents
  // already give full context. So we only pay for it when it earns its keep — a PR is routed DEEP
  // when it is security-sensitive (touches rules/auth/IAM/etc. — see SENSITIVE_RE in pipeline.ts) OR
  // large (over the line/file thresholds below). Everything else takes the fast text path (diff +
  // full changed-file contents, no clone). Set both thresholds to 0 to force every PR deep (old
  // behavior); requires repoContextReview=true for any deep review at all.
  deepReviewMaxLines: Number(opt("DEEP_REVIEW_MAX_LINES", "250")),
  deepReviewMaxFiles: Number(opt("DEEP_REVIEW_MAX_FILES", "8")),
  // MULTI-LENS review: run the review once per focused lens (defects / attribution+contract /
  // test-rigor+docs) and merge, so the model can't consolidate to one finding (see review.ts LENSES).
  // Default ON — this is what gets the bot to baz-level coverage. REVIEW_LENSES=false = single pass.
  reviewLenses: bool("REVIEW_LENSES", true),
  // Optional status/updates feed — a Slack channel that mirrors what the bot is doing (startup,
  // review started/posted, approved, held, failed). Empty = disabled. The bot must be a MEMBER of
  // this channel (/invite @Review Window) since the token only has chat:write.
  statusChannelId: opt("STATUS_CHANNEL_ID", ""),
  // Cap how long the bot will HOLD approval waiting for review comments to be answered. After this
  // many hours (measured from our own review), an "addressed" signal approves anyway — the author
  // said they handled it and we don't block indefinitely. CI-red / changes-requested are NOT capped
  // (they are objective blockers and GitHub blocks the merge regardless). 0 = never release.
  holdMaxHours: Number(opt("HOLD_MAX_HOURS", "6")),
  // Optional post-lens verify pass that drops findings it judges false positives/duplicates.
  // DEFAULT OFF (2026-09-01): measured on TMA #170 it deleted real findings (merged=2 -> 1, and
  // earlier capped several PRs at exactly 2 comments). The user's problem is UNDER-reporting, not
  // false positives, and mergeResults already de-duplicates — so we keep recall and let the reader
  // judge. VERIFY_REVIEW_FINDINGS=true re-enables it.
  verifyReviewFindings: bool("VERIFY_REVIEW_FINDINGS", false),
};

/** github.com/<owner>/<repo>/pull/<n> → parts (first match in the text). */
export function parsePrUrl(text: string): { owner: string; repo: string; number: number } | null {
  const m = text.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Does the message @-mention the required user? Slack encodes it as <@U…>. */
export function tagsRequiredUser(text: string): boolean {
  return text.includes(`<@${config.slack.requireTagUserId}>`);
}
