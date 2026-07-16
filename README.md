# pr-review-bot (standalone service)

A standalone port of the `pr-review-bot` Claude Code skill: a Slack-triggered,
**Claude-powered** code-review bot that posts to GitHub. It runs on its own (no
Claude Code session needed) — the deterministic glue (Slack/GitHub) is scripted,
and the actual review is a Claude API call.

## What it does
1. **Trigger (Slack Events):** a message in `#request-pr-review` that **@-tags the
   configured user** and contains a **GitHub PR URL**, with **no `:eyes:`** yet.
2. **Claim:** waits `CLAIM_DEBOUNCE_MS`, re-checks for `:eyes:`, then adds `:eyes:`
   (the idempotency lock — a PR is never reviewed twice).
3. **Review:** fetches the PR diff (GitHub), sends it to **Claude** with the
   five-vector rubric (code / security / architecture / tests / spec) + a
   "high-signal findings only" guardrail.
4. **Post:** one GitHub review (`COMMENT`) with severity-tagged inline comments,
   then a short **in-thread** Slack reply pointing to it. Leaves only `:eyes:`.
5. **Approve (follow-up):** when the author **replies in the thread** ("addressed")
   *and* every bot review thread is resolved, it **verifies** the fix, then
   **approves** on GitHub and marks the Slack message `:white_check_mark:`.

**Scope boundary:** the bot only reacts, comments, and **approves**. It never
closes, merges, or requests-changes. It skips your own PRs, and it will **not**
auto-approve when a competing open PR touches the same files (duplicate guard).

## Setup

### 1. Slack app (required for the Events webhook)
At <https://api.slack.com/apps> → Create New App:
- **OAuth & Permissions** → Bot Token Scopes: `channels:history`, `reactions:read`,
  `reactions:write`, `chat:write` (add `groups:history` if the channel is private).
  Install to the workspace; copy the **Bot User OAuth Token** (`xoxb-…`).
  *(To act as you instead of a bot, a user token `xoxp-…` with equivalent scopes also works — set it as `SLACK_TOKEN`.)*
- **Basic Information** → copy the **Signing Secret**.
- **Event Subscriptions** → enable, set **Request URL** to `https://<public-host>/slack/events`
  (Slack will verify it — the bot must be running and reachable), and subscribe to
  bot event **`message.channels`** (and `message.groups` for a private channel).

### 2. Config
```
cp .env.example .env
# fill: SLACK_SIGNING_SECRET, SLACK_TOKEN, SLACK_CHANNEL_ID, REQUIRE_TAG_USER_ID,
#       GITHUB_TOKEN, ANTHROPIC_API_KEY
```
Secrets live only in `.env` (gitignored) — never commit them.

### 3. Run
```
npm install
npm start          # tsx src/index.ts  (dev: npm run dev — watch mode)
# or build: npm run build && npm run serve
```
The service listens on `PORT` (default 3000) at `/slack/events`.

### 4. Expose the endpoint
Slack needs a public HTTPS URL. For local dev, tunnel it:
```
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```
Put that public URL (+ `/slack/events`) into the app's Event Subscriptions Request
URL. For real deployment, run it behind a stable HTTPS host (a small VM/container).

## Notes / current limitations
- **Prototype auth:** wired to reuse your GitHub PAT + a Slack token + your
  Anthropic key. Harden to a dedicated bot identity (GitHub App + Slack bot user)
  before anything shared.
- **Line anchoring:** the model returns `path` + head `line`; GitHub 422s a review
  whose comment doesn't map to the diff. If that happens the whole review is
  rejected — a future hardening is to drop/repair unanchorable comments and retry.
- **Verify step** reconstructs prior findings from the bot's own review comments
  (stateless — no DB). Good enough for the prototype; a persisted findings store
  would make verification exact.
- **Long reviews vs Slack's 3s ack:** Bolt acks the event immediately and processes
  asynchronously, and the `:eyes:` claim makes duplicate deliveries safe.

## Layout
```
src/
  config.ts     env + PR-URL / tag parsing
  github.ts     Octokit: diff, review, approve, thread-resolution, duplicate check
  review.ts     Claude API — the 5-vector reviewer + fix verifier
  pipeline.ts   orchestration: eligibility → claim → review → post → approve
  index.ts      Bolt app: Slack Events → pipeline
```
