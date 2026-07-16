import pkg from "@slack/bolt";
const { App } = pkg;
import { config } from "./config.js";
import { handleReviewRequest, maybeApprove } from "./pipeline.js";

const app = new App({
  token: config.slack.token,
  signingSecret: config.slack.signingSecret,
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
    const isThreadReply = m.thread_ts && m.thread_ts !== m.ts;
    if (isThreadReply) {
      // Approve follow-up: need the parent (the original PR request) text.
      const parent = await client.conversations.replies({
        channel: config.slack.channelId,
        ts: m.thread_ts!,
        limit: 1,
      });
      const parentText = parent.messages?.[0]?.text ?? "";
      await maybeApprove(client, m.thread_ts!, parentText, m.user ?? "", me);
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
  console.log(
    `[pr-review-bot] listening on :${config.port}  channel=${config.slack.channelId}  as=${me}  model=${config.anthropic.model}`
  );
  console.log(`[pr-review-bot] point your Slack app Event Subscriptions Request URL at  <public-host>/slack/events`);
})();
