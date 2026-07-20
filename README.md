# pr-review-bot (standalone service)

A Slack-triggered, **Claude-powered** PR code-review bot that posts to GitHub. It
runs on its own (no open Claude Code session needed): the deterministic glue
(Slack / GitHub) is scripted, and the actual review + fix-verification run through
**headless Claude Code** (`claude -p`) on your Claude subscription — **no Anthropic
API key or credits required.**

## What it does

**Review (new PR request):** a message in the configured channel that **@-tags the
reviewer** and contains a **GitHub PR URL**, with no `:eyes:` yet →
1. **Claim:** waits `CLAIM_DEBOUNCE_MS`, re-checks for `:eyes:`, then adds `:eyes:`
   (the idempotency lock — a PR is never reviewed twice).
2. **Skip guards:** skips the bot's own PRs (`SKIP_OWN_PRS`), PRs outside
   `REPO_ALLOWLIST`, and PRs that are already **merged/closed** (nothing to review).
3. **Review:** fetches the PR diff and sends it to `claude -p` with the five-vector
   rubric (code / security / architecture / tests / spec) + a high-signal-only
   guardrail. Findings must land in a structured array (not prose).
4. **Post:** one GitHub `COMMENT` review with severity-tagged inline comments.
   Comments are split into **anchorable** (mapped to a real RIGHT-side diff line →
   posted inline) vs. the rest (**folded into the review body**), so a review is
   never silently dropped when a line doesn't map. Then a short **in-thread** Slack
   pointer. Leaves only `:eyes:`.

**Approve (follow-up):** when someone replies in the thread with an **"addressed"
signal** (the message *leads with* `addressed`/`done`/`fixed`/`resolved`/`updated`/
`ready`/`pushed`), the bot reacts `:eyes:` on that reply and approves **only when
all** hold:
- **CI is green** (`ciGreen`),
- **no reviewer has `CHANGES_REQUESTED`** (human or codex/copilot/gemini/charlie),
- **not a code-file duplicate** — another OPEN PR touching the same *source* files
  (incidental shared files — docs, markdown, the SOW ledger — are ignored),
- **verified:** `claude -p` confirms the **current diff actually addresses every
  review comment** — the bot's own AND every other reviewer's inline comments
  (per-finding verdict). "Addressed" means the fix is in the commits, not just the word.

On success → `gh` **approve** + `:white_check_mark:` on the Slack message +
`✅ Approved — CI green.` in-thread. Otherwise it **holds silently** (no nag) and
re-checks later.

**Self-heal sweep:** every 2 minutes (and once on boot) the bot re-scans reviewed-
but-unapproved PRs and runs the same approve check — so an "addressed" reply that
arrived while the bot was down/restarting (Socket Mode doesn't replay missed events)
is still picked up.

**Scope boundary (hard):** the bot only reacts, comments, and **approves**. It never
closes, merges, or requests-changes.

## Setup

### 1. Slack app
At <https://api.slack.com/apps> → create an app, then:
- **OAuth & Permissions → Bot Token Scopes:** `channels:history`, `chat:write`,
  `reactions:read`, `reactions:write` (+ `groups:history` for a private channel).
  Install to the workspace → copy the **Bot User OAuth Token** (`xoxb-…`) →
  `SLACK_TOKEN`. *(A user token `xoxp-…` also works if you want it to act as you.)*
- **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`.
- **Recommended — Socket Mode (no public URL / no tunnel):**
  **Basic Information → App-Level Tokens** → generate a token with
  `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`), then enable **Socket Mode**
  and subscribe to bot event **`message.channels`**. With `SLACK_APP_TOKEN` set the
  bot connects over an outbound WebSocket — nothing to expose or re-verify.
- **HTTP fallback (only if you leave `SLACK_APP_TOKEN` empty):** **Event
  Subscriptions** → Request URL `https://<public-host>/slack/events`, subscribe
  `message.channels`. Needs a public HTTPS endpoint (tunnel/host) and re-verifies
  whenever that URL changes.

### 2. Claude Code (the review engine)
The review + verify run via `claude -p`, so the **`claude` CLI must be installed and
logged in** on the host (`claude` → `/login`, or `claude setup-token`). No Anthropic
API key is used.

### 3. Config
```
cp .env.example .env
# required: SLACK_SIGNING_SECRET, SLACK_TOKEN, SLACK_CHANNEL_ID, REQUIRE_TAG_USER_ID, GITHUB_TOKEN
# recommended: SLACK_APP_TOKEN (xapp-…) → Socket Mode
```
`GITHUB_TOKEN` = a PAT with `repo` scope. `ANTHROPIC_API_KEY` is **not needed**
(the engine is `claude -p`). Secrets live only in `.env` (gitignored) — never commit.

### 4. Run
```
npm install
npm start          # tsx src/index.ts   (dev watch: npm run dev)
```
In Socket Mode there's nothing to expose. In HTTP mode it listens on `PORT`
(default 3000) at `/slack/events`, which you point Slack's Request URL at (tunnel
for local dev: `cloudflared tunnel --url http://localhost:3000`).

### 5. Keep it running (durable)
The process must stay up to receive events. On Windows, auto-start on logon via a
hidden launcher (`run-hidden.vbs` in this repo) + Task Scheduler:
```
schtasks /Create /TN "PRReviewBot" /TR "wscript.exe \"C:\dev\pr-review-bot\run-hidden.vbs\"" /SC ONLOGON /RL LIMITED /F
```
(Remove with `schtasks /Delete /TN "PRReviewBot" /F`.) For a server, run it under a
supervisor (pm2 / systemd / a container). Run **one** instance — duplicates are
safe (the `:eyes:` lock coordinates them) but wasteful.

## Config reference (`.env`)
| Var | Required | Meaning |
|-----|----------|---------|
| `SLACK_SIGNING_SECRET` | yes | Verifies inbound Slack requests |
| `SLACK_TOKEN` | yes | Bot (`xoxb-…`) or user (`xoxp-…`) token |
| `SLACK_APP_TOKEN` | recommended | `xapp-…` present → Socket Mode (no tunnel) |
| `SLACK_CHANNEL_ID` | yes | The one channel the bot watches |
| `REQUIRE_TAG_USER_ID` | yes | The Slack user a request must @-tag to be eligible |
| `GITHUB_TOKEN` | yes | PAT with `repo` scope |
| `REPO_ALLOWLIST` | no | Comma-sep `owner/repo`; empty = any linked repo |
| `CLAIM_DEBOUNCE_MS` | no (5000) | Wait, re-check `:eyes:`, then claim |
| `SKIP_OWN_PRS` | no (true) | Never review a PR authored by the token's own user |
| `APPROVE_WHEN_ADDRESSED` | no (true) | Enable the verify-then-approve follow-up |
| `MAX_DIFF_BYTES` | no (200000) | Cap on the diff sent to the reviewer |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | no | **Unused** — engine is `claude -p` |

## Layout
```
src/
  config.ts     env + PR-URL / tag parsing
  github.ts     Octokit: diff, review (+ anchorable-line fallback), approve, ciGreen,
                changesRequested, all-review-comments, duplicate check
  review.ts     headless Claude Code (claude -p): the 5-vector reviewer + fix verifier
  pipeline.ts   orchestration: eligibility → claim → review → post; and the
                addressed-signal → verify → approve follow-up + reconcile sweep
  index.ts      Slack app (Socket Mode / HTTP) → pipeline, + the 2-min reconcile timer
```

## Notes / limitations
- **Auth is prototype-grade:** reuses a personal Slack token + GitHub PAT. Harden to
  a dedicated bot identity (GitHub App + Slack bot user) before wider use.
- **Verification is stateless** — it re-reads the PR's inline comments and judges the
  current diff each time (no DB). Fair, not pedantic, and fails **closed** (holds, never
  approves) if it can't run.
- **`:eyes:` is the only dedupe** — safe across duplicate event deliveries and
  overlapping instances.
