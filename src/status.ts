import type { WebClient } from "@slack/web-api";
import { config } from "./config.js";

// Optional STATUS feed: mirrors the bot's lifecycle to a dedicated channel (e.g. #review-window) so
// you can watch what it's doing without reading the PR-request channel. Off unless STATUS_CHANNEL_ID
// is set. Every post is a DISTINCT event (start/posted/approved/held/failed) — never a repeat, so it
// can't spam. All failures are swallowed: the status feed must never break a review.

let client: WebClient | null = null;

export function initStatus(c: WebClient): void {
  client = c;
}

export async function status(text: string): Promise<void> {
  if (!client || !config.statusChannelId) return;
  try {
    await client.chat.postMessage({ channel: config.statusChannelId, text });
  } catch {
    /* status feed is best-effort — never let it break the bot */
  }
}
