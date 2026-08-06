import pkg from "@slack/bolt";
const { App } = pkg;
import { config } from "./config.js";
import {
  handleReviewRequest,
  maybeApprove,
  reconcileApprovals,
  reviewCatchup,
  mentionCatchup,
  handleCiComplete,
  handleMention,
} from "./pipeline.js";
import { startGithubWebhookServer } from "./webhook.js";
import { mentionsBot } from "./mentions.js";

// Socket Mode when an app-level token (xapp-…) is set: an outbound WebSocket to Slack, so there is
// NO public Request URL / tunnel to rotate or re-verify (the quick-tunnel URL rotates on every
// cloudflared restart, which silently breaks HTTP delivery). Falls back to HTTP (signing secret +
// Events API Request URL) when SLACK_APP_TOKEN is unset, so this change is non-breaking.
const app = new App({
  token: config.slack.token,
  signingSecret: config.slack.signingSecret,
  ...(config.slack.appToken ? { socketMode: true, appToken: config.slack.appToken } : {}),
});

let botUserId = "";

// Resolve which user id our token acts as, so we never treat our own messages
// (the "see comments" reply) as an author signal.
async function resolveBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  const auth = await app.client.auth.test();
  botUserId = (auth.user_id as string) ?? "";
  return botUserId;
}

// Single message listener handles both paths: top-level PR requests and thread replies.
app.message(async ({ message, client }) => {
  const m = message as {
    channel?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    user?: string;
    subtype?: string;
    bot_id?: string;
  };
  if (m.channel !== config.slack.channelId) return; // scoped to the one channel
  if (!m.ts || !m.text) return;
  if (m.subtype && m.subtype !== "bot_message") return; // ignore edits/joins/etc.

  const me = await resolveBotUserId();

  try {
    // @-mention command surface takes precedence: if someone mentions the bot (and it's not the
    // bot's own message), route to the command dispatcher instead of the review/approve paths.
    if (m.user !== me && !m.bot_id && mentionsBot(m.text, me)) {
      await handleMention(client, m.ts, m.thread_ts, m.text, me);
      return;
    }
    const isThreadReply = m.thread_ts && m.thread_ts !== m.ts;
    if (isThreadReply) {
      // Approve follow-up: need the parent (the original PR request) text.
      const parent = await client.conversations.replies({
        channel: config.slack.channelId,
        ts: m.thread_ts!,
        limit: 1,
      });
      const parentText = parent.messages?.[0]?.text ?? "";
      await maybeApprove(client, m.thread_ts!, parentText, m.user ?? "", me, m.ts, m.text);
    } else {
      await handleReviewRequest(client, m.ts, m.text, me);
    }
  } catch (err) {
    // Fail loud in logs; leave any :eyes: claim in place so we don't thrash-retry.
    console.error(`[pr-review-bot] error handling message ${m.ts}:`, err);
  }
});

(async () => {
  await app.start(config.port);
  const me = await resolveBotUserId();

  // Self-heal sweep: every 2 min, pick up "addressed" replies the live event handler may have
  // missed (e.g. posted while the bot was restarting — Socket Mode doesn't replay) and approve.
  const RECONCILE_MS = 120_000;
  // Each sweep: (1) catch-up REVIEW any un-claimed eligible PR (Socket Mode doesn't replay events
  // missed while the computer was off, so a PR posted overnight would sit stale), then (2) reconcile
  // APPROVALS for reviewed PRs whose author replied "addressed". The boot run below means every time
  // the machine turns on, the bot re-scans the channel so nothing is left stale. Guarded so a slow
  // catch-up (multiple reviews) never stacks with the next tick.
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await reviewCatchup(app.client, me); // top-level PR requests missed while down
      await mentionCatchup(app.client, me); // @-mentions (incl. in threads) missed while down
      await reconcileApprovals(app.client, me);
    } catch (e) {
      console.error("[pr-review-bot] sweep error:", e);
    } finally {
      sweeping = false;
    }
  };
  setInterval(() => void sweep(), RECONCILE_MS);
  void sweep(); // run one now on boot — catch up on anything posted/addressed while down

  // ── Watchdog ────────────────────────────────────────────────────────────────────────────────
  // Exit (so the keepalive relaunches with a FRESH connection) if the Slack link is unhealthy too
  // long. Catches BOTH a network/DNS outage (auth.test throws — e.g. ENOTFOUND slack.com) AND a
  // socket that went deaf but never reconnected while the process stayed up (the #139 miss — Bolt
  // reported disconnected/reconnecting yet the process lived on, deaf, until a manual restart).
  const DEAF_LIMIT_MS = Number(process.env.DEAF_LIMIT_MS ?? 180_000); // 3 min
  let socketDownSince: number | null = null;
  try {
    const sm = (app as unknown as { receiver?: { client?: { on?: (e: string, cb: () => void) => void } } })
      .receiver?.client;
    if (sm?.on) {
      sm.on("connected", () => (socketDownSince = null));
      sm.on("disconnected", () => (socketDownSince ??= Date.now()));
      sm.on("reconnecting", () => (socketDownSince ??= Date.now()));
    }
  } catch {
    /* Bolt internal shape changed — the API heartbeat below still guards the network case */
  }
  let apiDownSince: number | null = null;
  setInterval(async () => {
    try {
      await app.client.auth.test();
      apiDownSince = null;
    } catch {
      apiDownSince ??= Date.now();
    }
    const now = Date.now();
    const socketDeaf = socketDownSince != null && now - socketDownSince > DEAF_LIMIT_MS;
    const apiDeaf = apiDownSince != null && now - apiDownSince > DEAF_LIMIT_MS;
    if (socketDeaf || apiDeaf) {
      console.error(
        `[pr-review-bot] watchdog: Slack connection unhealthy (socketDeaf=${socketDeaf} apiDeaf=${apiDeaf}) — exiting so the keepalive relaunches`
      );
      process.exit(1);
    }
  }, 60_000);

  // Event-driven CI (optional): approve the instant GitHub reports CI green, instead of waiting for
  // the next poll. Only starts when GITHUB_WEBHOOK_SECRET is set; the poll above stays as fallback.
  const webhookOn = startGithubWebhookServer((e) => handleCiComplete(app.client, me, e));

  const mode = config.slack.appToken ? "Socket Mode (no tunnel)" : "HTTP (Events API + tunnel)";
  console.log(
    `[pr-review-bot] listening — ${mode}  channel=${config.slack.channelId}  as=${me}  engine=headless-claude-code  ci-webhook=${webhookOn ? "on" : "off (poll only)"}`
  );
  if (!config.slack.appToken) {
    console.log(
      `[pr-review-bot] HTTP mode: point Slack Event Subscriptions Request URL at <public-host>/slack/events — NOTE it rotates on every tunnel restart. Set SLACK_APP_TOKEN=xapp-… to switch to Socket Mode and drop the tunnel for good.`
    );
  }
})();
