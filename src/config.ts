import "dotenv/config";

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
    // Unused now — the bot reviews via headless Claude Code (`claude -p`) on your subscription,
    // not the metered API. Kept optional so an old key in .env doesn't matter either way.
    apiKey: opt("ANTHROPIC_API_KEY", ""),
    model: opt("ANTHROPIC_MODEL", "claude-opus-4-8"),
  },
  port: Number(opt("PORT", "3000")),
  claimDebounceMs: Number(opt("CLAIM_DEBOUNCE_MS", "5000")),
  claimEmoji: opt("CLAIM_EMOJI", "eyes"),
  approvedEmoji: opt("APPROVED_EMOJI", "white_check_mark"),
  skipOwnPrs: bool("SKIP_OWN_PRS", true),
  approveWhenAddressed: bool("APPROVE_WHEN_ADDRESSED", true),
  maxDiffBytes: Number(opt("MAX_DIFF_BYTES", "200000")),
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
