---
name: pr-review-bot
description: >-
  Autonomous DevOps/security PR review bot. One invocation = one polling pass:
  find eligible pull requests announced in Slack (a PR URL plus the opt-in
  review keyword, not yet claimed with an :eyes: reaction), review across five vectors
  (code, security, architecture, tests, spec-match), post severity-tagged inline
  comments to GitHub, then reply in the Slack thread that the review is done.
  Designed to be driven on an interval with /loop or a scheduled cloud agent.
  Use when asked to run, set up, or loop the automated PR review bot.
---

# PR Review Bot

An autonomous DevOps + security code-review assistant. **One invocation performs
exactly one polling pass** and is safe to run repeatedly — the `:eyes:` reaction
is the idempotency lock, so a PR is never reviewed twice. Repetition is handled
by the driver (`/loop` or a scheduled agent), not by this skill.

## How this skill is structured (read once)

The deterministic GitHub mechanics live in `scripts/` — you **run a script and
branch on its exit code**, you do NOT re-derive `gh` commands, JSON payloads, or
line-anchoring in prose each pass. That is the whole point: the only work left to
your judgment is the five-vector review itself.

Slack stays model-driven because it goes through **MCP tools that bash cannot
call**. So each pass is: *Slack (you, via MCP) → GitHub gates + fetch (script) →
review (you) → post (script) → Slack notify (you)*.

| Script | Replaces | Exit codes |
|--------|----------|------------|
| `scripts/fetch-pr.sh <owner> <repo> <n>` | Step 4 (fetch + state/own-PR/allowlist gates) | `0` reviewable · `2` merged · `3` closed · `4` own-PR · `5` repo-not-allowed · `1` error |
| `scripts/post-review.sh <findings.json> <owner> <repo> <n>` | Step 7 (build envelope + POST) | `0` posted (prints `html_url`) · `1` error |
| `scripts/check-addressed.sh <owner> <repo> <n>` | Follow-up mechanical gates | `0` approvable · `2` not-ready (prints `PRB_REASON=…`) · `1` error |
| `scripts/approve.sh <owner> <repo> <n>` | the approve call | `0` approved · `1` error |

All four accept a PR URL in place of `<owner> <repo> <n>`. `_lib.sh` is shared
(python detection, UTF-8 env, PR-URL parsing, auth guard) and is sourced by each;
don't call it directly.

**Scope of write actions (hard boundary).** The bot may only: add Slack reactions
(`:eyes:` / `:white_check_mark:`), post GitHub review comments, and **approve** a
PR (`approve.sh`). It must **NEVER close or merge a PR**, and never
`REQUEST_CHANGES`. Closing/merging (e.g. retiring a superseded duplicate) is a
human decision — the bot flags it and stops. Approval is the ceiling of its
authority (`post-review.sh` hard-wires `event=COMMENT`; only `approve.sh` approves).

---

## Configuration

Read overrides from the invocation args if provided; otherwise use the defaults.
The GitHub gates read three **environment variables** (export them before the
script, or leave unset for the default):

| Env / Key | Default | Meaning |
|-----------|---------|---------|
| `REQUIRE_TAG` | `<@U0A713UAMSA>` (Sushama) | The Slack message MUST tag this user. **Eligibility = a PR URL + this mention (no keyword required).** |
| `SLACK_CHANNEL` | `#request-pr-review` → `C0A6Z9JKKL5` | The ONE channel this bot polls. Never read or post anywhere else. |
| `CLAIM_EMOJI` | `eyes` | "claimed / in progress" marker. Presence = skip. Humans also use `:eyes:` by hand — any eyed message is treated as claimed and skipped. |
| `APPROVED_EMOJI` | `white_check_mark` | The **approval** marker. Added ONLY in Follow-up, after the author addresses findings AND the bot verifies + approves. Never at review time. |
| `PRB_REPO_ALLOWLIST` | *(empty = all Actual-Reality repos)* | Space/comma-separated `owner/repo`. Enforced inside `fetch-pr.sh` (exit 5). |
| `PRB_SKIP_OWN_PRS` | `true` | Reviews OTHERS' PRs only. `fetch-pr.sh` exits 4 on own PRs. |
| `PRB_ME_OVERRIDE` | *(unset)* | Forces the "me" identity for the own-PR gate (service account / testing). Unset = `gh api user`. |
| `SLA_MINUTES` | `15` | Per-review window: target 10 min, 15 hard ceiling. Over → post what's confirmed, flag the rest in-thread. |

---

## Prerequisites (check first, fail loudly)

1. **GitHub** — `gh auth status` must succeed (the scripts guard this and
   `prb_die` if not). Works headless.
2. **python** — the scripts need a working `python`/`python3` (JSON assembly).
   `_lib.sh` auto-detects it and forces UTF-8; nothing to do unless it's absent.
3. **Slack** — the **`plugin:productivity:slack`** MCP connector must be
   authorized; its tools are only enumerable once authed (absent in a headless
   run). Load the four tools at the start of a pass:
   ```
   ToolSearch query "select:mcp__<SLACK>__slack_read_channel,mcp__<SLACK>__slack_get_reactions,mcp__<SLACK>__slack_add_reaction,mcp__<SLACK>__slack_send_message"
   ```
   `<SLACK>` was `3a554d0f-1bce-4c8f-9a07-f3a159a19bab`; if the `select:` load
   fails, re-discover with `ToolSearch query "slack read channel reactions add send message"`.
   Mapping: `slack_read_channel` → Step 1; `slack_get_reactions` → Step 2;
   `slack_add_reaction` → Steps 3 & 8; `slack_send_message` (with `thread_ts`) → Step 8.
   If discovery returns no Slack tools, the connector is **not connected**: report
   that it must be authorized via `/mcp` or claude.ai connector settings, then use
   **Manual / GitHub-only mode** below.

---

## One pass — the algorithm

Complete within `SLA_MINUTES` (target ~10 min, 15 ceiling) from claim to reply.

### Step 1 — Discover candidates (Slack, MCP)
- `slack_read_channel(channel_id="C0A6Z9JKKL5", limit=30, response_format="detailed")`
  (`detailed` includes reactions, which Step 2 needs). **Never read any other channel.**
- Keep a message only if it BOTH (1) contains a PR URL
  (`github.com/<owner>/<repo>/pull/<n>`) and (2) tags `REQUIRE_TAG`
  (`<@U0A713UAMSA|Sushama>` in raw text). No keyword required.
- Record each candidate's `ts` — the id for reactions and the thread reply.

### Step 2 — Filter already-handled (the loop guard)
- Skip any message already carrying the `CLAIM_EMOJI` (`eyes`) reaction — this
  reaction is the ONLY thing preventing duplicate reviews; treat it as authoritative.

### Step 3 — Claim atomically (no debounce)
- As soon as Step 2 shows no `:eyes:`, claim immediately:
  `slack_add_reaction(channel_id="C0A6Z9JKKL5", message_ts=<ts>, emoji="eyes")`.
- Duplicate reactions succeed silently, so re-check with `slack_get_reactions`;
  if `eyes` count > 1 or another user beat you, assume they own it and skip.
- Process **one PR per pass** by default.

### Step 4 — Fetch PR data + gates (script)
```
bash scripts/fetch-pr.sh <owner> <repo> <n>      # or a PR URL
```
Branch on the exit code — **do not fetch or gate by hand**:
- **`0`** — reviewable. stdout is a `PRB_*` metadata block (incl. `PRB_HEAD_OID`,
  `PRB_AUTHOR`, `PRB_TITLE`), then `--- BODY ---`, then `--- DIFF ---` and the full
  diff. Proceed to Step 5.
- **`2` / `3`** — merged / closed: nothing to review. Reply in-thread with the exact
  line the script printed (`Nothing to review — PR is already merged.` /
  `… already closed.`), **leave `:eyes:` on**, post NO GitHub review, and stop
  (also skip Follow-up).
- **`4`** — own PR: reply with the script's line ("Skipping — bot doesn't review its
  owner's PRs"), leave `:eyes:` on, stop.
- **`5`** — repo not in allowlist: reply with the script's line, stop.
- **`1`** — error (read stderr): see Failure handling.

If the diff is large and you need exact head-file line numbers, see
`references/github-review.md` (anchoring uses `PRB_HEAD_OID`).

### Step 5 — Review across the five vectors
Analyze the diff (and surrounding code where needed). This is an IaC / Entra ID
bot — weight security and architecture heavily.
1. **Code base** — syntax, clean-code, formatting, dead code, obvious optimizations.
2. **Security base** — hardcoded secrets, overly permissive IAM / Entra roles
   (wildcards, `Owner`/`Contributor` at wide scope, `Directory.ReadWrite.All`,
   consent grants), public exposure, missing encryption, injection/SSRF, unpinned deps.
3. **Architecture base** — alignment with the org's patterns (module structure,
   naming, tagging, network topology, state). Flag drift from convention, not taste.
4. **Test base** — tests added/updated? Untested new logic, deleted tests,
   assertions that don't exercise the change.
5. **Specification matching** — cross-reference the triggering **Slack message
   description** and any linked SOW/spec/ticket against the PR title + description
   and the actual diff. Flag work described-not-done, done-not-described, scope creep.

### Step 6 — Reliability guardrail (BEFORE building findings)
> ⚠️ **No low-confidence or filler comments.** For each candidate finding ask:
> *"Would this survive a skeptical senior engineer, and can I cite the concrete
> failure or violation?"* Post only if yes.
- Prefer **fewer, high-signal** comments. Uncertain fix → phrase as a question or drop.
- Severity each survivor: **High** (critical bug / vuln / major arch violation),
  **Medium** (optimization, missing tests, minor security risk), **Low** (style/docs).
- Nothing meets the bar → a clean review with no inline comments is a valid result.

### Step 7 — Post the GitHub review (script)
Write your findings to a JSON file (scratchpad dir) with exactly this shape — just
your judgment; the script injects `commit_id` + `event`:
```json
{ "body": "<severity tally + one-line overall read>",
  "comments": [ { "path": "src/x.ts", "line": 23, "side": "RIGHT",
                  "body": "**[High]** …" } ] }
```
(`comments` may be empty for a clean review.) Then:
```
bash scripts/post-review.sh <findings.json> <owner> <repo> <n>
```
Exit `0` prints the review `html_url` (use it in Step 8). Exit `1`: a bad
`path`/`line` 422s the whole review — re-verify anchors against the head file
(`references/github-review.md`) and retry once, else treat as a failure.

### Step 8 — Notify Slack + finalize the lock (MCP)
- Reply **in the triggering message's thread**:
  `slack_send_message(channel_id="C0A6Z9JKKL5", thread_ts=<candidate ts>, message=…)`.
  **⚠️ Threads via `thread_ts`, NOT `message_ts`** (`message_ts` is only for
  reactions; passing it to send posts to the channel root).
  Message = a **short pointer**, e.g.
  `"👀 Automated review done — see comments: <review html_url>"`. Do NOT paste
  findings or the severity breakdown into Slack.
- **Do NOT add `:white_check_mark:` here.** Leave ONLY `:eyes:` = "claimed &
  reviewed, awaiting fixes." `:eyes:` stays permanently (never-re-review lock).

### Step 9 — Report the pass
Compact summary: PR reviewed, findings by severity, Slack thread updated — or
"no eligible PRs this pass."

---

## Follow-up — verify & approve when findings are addressed

Run this each pass alongside Step 1. **No re-review.** For each channel message
that tags `REQUIRE_TAG` + has a PR URL and already carries the bot's `:eyes:`:

1. **Mechanical gates (script):**
   ```
   bash scripts/check-addressed.sh <owner> <repo> <n>
   ```
   - Exit `2` → not ready; read `PRB_REASON=…` (unresolved threads / clean review /
     already approved / not OPEN). Do nothing this pass (no thread reply needed).
   - Exit `0` → mechanical gates pass (OPEN, ≥1 bot thread, all resolved, not yet
     approved). Continue to the judgment checks.
   - Exit `1` → error; see Failure handling.
2. **Slack "addressed" signal (you, MCP):** `slack_read_thread` on the PR message —
   the bot's "see comments…" reply must have a reply from someone **other than the
   bot** (e.g. "addressed"/"done"). No such reply → wait.
3. **Verify the fix is real (you):** spot-check the fix commit(s) against each
   finding — a flipped-resolved thread isn't proof. If a fix doesn't hold, reply
   in-thread with what's still open and **do not approve**.
4. **Duplicate guard (you):** if another OPEN PR targets the same ticket/branch or
   edits the same files from the same base, do **not** auto-approve — post an
   in-thread note that it's a duplicate of `#<other>` and a human must pick one.
5. **Approve (script), then mark:**
   ```
   bash scripts/approve.sh <owner> <repo> <n>
   ```
   Only after exit `0`: `slack_add_reaction(..., emoji="white_check_mark")`.

**Never** approve a PR the bot never reviewed, one with unresolved/unverified
findings, or your own PR. A clean 0-finding review is never auto-approved
(`check-addressed.sh` exits 2 for it). Approval reflects only *this bot's* findings
— it does not clear another reviewer's `CHANGES_REQUESTED`.

---

## Failure handling
- **Any step fails after the claim (Step 3):** reply in-thread that the automated
  review errored and needs a human (include the stderr), and **leave `:eyes:` on**
  so the bot doesn't thrash retrying a broken PR every tick.
- **SLA exceeded on one PR:** post the confirmed findings, reply that the review
  was truncated for time, stop.
- **Slack unavailable:** see Prerequisites — stop cleanly (or use Manual mode),
  don't half-review.

## Manual / GitHub-only mode
Invoked with a PR URL directly (`/pr-review-bot <github-pr-url>`): skip Steps 1–3
and 8 (no Slack). Run `fetch-pr.sh` → review → `post-review.sh`, then print the
summary. This is the path that works without the Slack connector.

## Running it as a loop
This skill is one pass. Drive repetition with:
- **Foreground:** `/loop 5m /pr-review-bot` — a pass every 5 min.
- **Unattended (recommended):** the `schedule` skill / a cron routine running
  `/pr-review-bot` every 5 min — survives without an open terminal.
Passes are idempotent (the `:eyes:` guard), so overlapping runs are harmless.
