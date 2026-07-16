# Launching the bot on Slack — what actually tripped us up

A field log of every snag hit taking this bot from "code compiles" to
"reviews a PR the instant it's posted in Slack," and how each was fixed.
Read this before wiring up a fresh workspace — it will save an hour.

The end-to-end chain that has to be true for a tag to trigger a review:

```
teammate posts (@reviewer + PR URL) in the channel
        │  Slack Events API
        ▼
public HTTPS Request URL  ──►  tunnel  ──►  bot on localhost:PORT
        │
        ▼
bot must be a MEMBER of that channel  +  subscribed to message.channels
        │
        ▼
5s debounce → :eyes: claim → Claude review → GitHub review → thread reply
```

Every failure below was one broken link in that chain.

---

## 1. "Where do I put the Signing Secret?"

**Confusion:** several secret-looking values on the app's *Basic Information*
page — Client ID, Client Secret, **Signing Secret**, Verification Token.

**Answer:** only the **Signing Secret** matters here, and it goes in `.env` as
`SLACK_SIGNING_SECRET` — never in code, never committed (`.env` is gitignored).
It is a *shared secret*, not a token: the bot uses it to verify each inbound
webhook really came from Slack. Client ID/Secret and the (legacy) Verification
Token are not used by this bot.

If it leaks: **Basic Information → Regenerate**, then update `.env`.

## 2. Signing secret vs. bot token — two different things, two different pages

- **Signing Secret** — *Basic Information*. Verifies inbound requests.
- **Bot User OAuth Token** (`xoxb-…`) — *OAuth & Permissions* / *Install App*,
  only exists **after** you install the app. Authorizes the bot's outbound calls
  (reactions, messages).

You need both. They come from different screens and are easy to mix up.

## 3. "Install to Workspace" is greyed out

**Cause:** no **Bot Token Scopes** added yet → nothing to install.

**Fix:** *OAuth & Permissions → Scopes → Bot Token Scopes → Add an OAuth Scope*
and add all four before installing:

- `channels:history`  (read messages in public channels — needed for `message.channels`)
- `chat:write`        (post the in-thread reply)
- `reactions:read`    (check for an existing `:eyes:`)
- `reactions:write`   (add `:eyes:` / `:white_check_mark:`)

Once a scope is present, the green **Install to Workspace** button activates.

## 4. Ignore the two "Opt In" boxes on OAuth & Permissions

**Advanced token security via token rotation** and **Proof Key for Code
Exchange (PKCE)** both show tempting green "Opt In" buttons at the top of the
page. **Skip both.** They're for distributed/marketplace apps and only add
friction (token rotation even demands a redirect URL you don't have). A simple
bot token does not need them.

## 5. Getting the token after Install

After **Install to Workspace → Allow**, the page reloads and the
**Bot User OAuth Token** (`xoxb-…`) appears under *OAuth Tokens*. Copy it into
`.env` as `SLACK_TOKEN`. Slack shows it again later, but treat it like a
password.

## 6. The other two keys — and the billing gotcha

The bot also fail-fasts without:

- `GITHUB_TOKEN` — a PAT with **repo** scope (github.com → Settings → Developer
  settings → Personal access tokens → *Tokens (classic)*). GitHub shows the
  `ghp_…` value **once** — copy it immediately or regenerate.
- `ANTHROPIC_API_KEY` — from **console.anthropic.com → API Keys** (this is the
  *developer console*, separate from claude.ai / Claude Code). **Requires API
  billing to be set up** — a freshly created key returns a credit error until a
  card / prepaid credits are added under *Settings → Billing*.

## 7. Port already in use — `EADDRINUSE :::3000`

**Symptom:** `npm start` crashes immediately with
`Error: listen EADDRINUSE: address already in use :::3000`.

**Cause:** something else already owns port 3000 — in our case the
`customer-portal` **Next.js dev server** (`next/dist/server/lib/start-server.js`),
which defaults to 3000 too.

**Diagnose (Windows):**
```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" } |
  Select-Object ProcessId, CommandLine
```

**Fix:** don't kill the other app — just move the bot. Set `PORT=3200` in `.env`
and restart. (Remember to point the tunnel at the new port.)

## 8. Slack needs a public HTTPS URL — the tunnel

A locally-run bot isn't reachable from Slack's servers. You need a public
HTTPS endpoint that forwards to `localhost:PORT`.

We used **cloudflared** (free, no account):
```powershell
winget install --id Cloudflare.cloudflared -e
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3200
```
It prints a `https://<random>.trycloudflare.com` URL. The Request URL is that
**+ `/slack/events`**.

Sanity-check the tunnel reaches the bot before touching Slack:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://<random>.trycloudflare.com/slack/events \
  -H "Content-Type: application/json" -d '{"type":"url_verification","challenge":"x"}'
```
A **401 is success here** — the request reached the bot and was rejected for a
missing Slack signature (exactly right). A 502/timeout means the tunnel isn't
reaching the bot.

## 9. "I can't find Features" — wrong page / not-a-button

Two traps:

- **The app's profile page inside the Slack client** (the *About* tab with
  "Add to VIP") is **not** the developer dashboard and has no Event
  Subscriptions. The dashboard is **api.slack.com/apps → your app**.
- On the dashboard, **"Features" is a section *heading*, not a clickable link.**
  The thing you click is **Event Subscriptions**, listed under that heading.

Fastest route — deep link straight to it:
`https://api.slack.com/apps/<APP_ID>/event-subscriptions`

## 10. Verifying the Request URL

*Event Subscriptions → Enable Events → On*, paste
`https://<tunnel>/slack/events`, wait for the green **✓ Verified**. Slack sends a
signed `url_verification` challenge; the bot's Bolt receiver answers it
automatically. **The bot and tunnel must be running** at this moment or
verification fails.

## 11. Request URL alone delivers nothing — subscribe the event

A verified URL only proves reachability. Slack sends **no** messages until you
subscribe to an event:

*Event Subscriptions → Subscribe to bot events → Add Bot User Event →*
**`message.channels`** *→ Save Changes.*

(`message.channels` = "a message was posted in a public channel the bot is in".)
If a yellow **reinstall** banner appears after saving, click it and re-authorize
— the existing `xoxb` token stays valid.

## 12. The silent killer — the bot must be *in* the channel

Even with events enabled and the URL verified, **`message.channels` is only
delivered for channels the bot is a member of.** If you skip this, everything
looks configured and nothing ever fires.

**Fix:** in the channel, `/invite @<bot>` (or *channel → Integrations → Add
apps*).

## 13. Renaming the bot — two different names

- **App name** (the page header) → *Basic Information → Display Information → App
  name*.
- **Bot display / @-handle** (what shows when it posts) → *Features → App Home →
  Your App's Presence in Slack → Display Name / Default Name*.

A rename usually prompts a **reinstall** to take effect. Purely cosmetic — the
bot triggers on **user IDs**, not display names, so renaming changes nothing
about behavior.

---

## Lifetime caveats (know before you rely on it)

- **The tunnel URL is ephemeral.** A `trycloudflare.com` quick-tunnel URL changes
  every time cloudflared restarts — and then you must re-verify the Request URL
  in Slack. For anything durable, use a **named** Cloudflare tunnel or a stable
  host.
- **The bot process is only as alive as its host.** Run under a supervisor
  (pm2 / systemd / a container) so it survives reboots and sleep — otherwise it
  goes offline silently and PR requests pile up unreviewed.

## The 60-second sanity checklist

1. `.env` has all 6 required values (`SLACK_SIGNING_SECRET`, `SLACK_TOKEN`,
   `SLACK_CHANNEL_ID`, `REQUIRE_TAG_USER_ID`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`).
2. `npm start` prints `listening on :<PORT> … as=<bot user id>`.
3. Tunnel up; `curl` to `/slack/events` returns **401** (not 502).
4. Request URL in Slack shows **✓ Verified**.
5. `message.channels` is in *Subscribe to bot events*.
6. Bot is a **member** of the channel (`/invite` done).
7. Post `@reviewer <fresh PR URL>` → within ~5s it reacts `:eyes:` and reviews.
