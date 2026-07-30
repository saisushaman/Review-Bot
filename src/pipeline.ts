import type { WebClient } from "@slack/web-api";
import { config, parsePrUrl, tagsRequiredUser } from "./config.js";
import * as gh from "./github.js";
import { reviewPr, verifyFix, type Severity } from "./review.js";
import type { CiEvent } from "./webhook.js";
import * as reviewState from "./reviewState.js";
import * as inflight from "./inflight.js";
import * as mentions from "./mentions.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sevOrder: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };

// Cache of completed fix-verification verdicts, keyed by PR head SHA + review-comment signature.
// The verify step spawns a headless `claude -p` — the single most expensive thing the bot does.
// A held PR (CI green, not blocked, but not all findings addressed yet) is re-checked by the 2-min
// self-heal sweep indefinitely; without this it would re-run that `claude -p` every 2 minutes for
// an answer that CANNOT change until the author pushes a new commit (new head SHA) or a reviewer
// adds a comment. Both are captured in the key, so a genuine change busts the cache and re-verifies.
// Only COMPLETE verdicts are cached (VerifyResult.ok) — fail-closed/incomplete runs are retried.
const verifyMemo = new Map<string, boolean>();
const verifyKey = (owner: string, repo: string, n: number, headOid: string, commentSig: string) =>
  `${owner}/${repo}#${n}@${headOid}:${commentSig}`;

// Cache of the newest "addressed" signal per PR-request message, validated against Slack's
// `latest_reply` timestamp. The self-heal sweep runs every 2 min; re-fetching a thread's replies
// when nothing new was posted is the dominant wasted call (a reviewed PR always has the bot's own
// "review done" reply, so it always has a thread). If `latest_reply` is unchanged since we last
// looked, the newest addressed signal cannot have changed, so we reuse the cached result and skip
// the conversations.replies fetch. maybeApprove still runs each tick when a signal is cached, so CI
// turning green on an otherwise-unchanged thread is still picked up.
type CachedSignal = { user?: string; text?: string; ts?: string } | null;
const signalCache = new Map<string, { latestReply: string; signal: CachedSignal }>();

async function reactionNames(client: WebClient, ts: string): Promise<string[]> {
  const res = await client.reactions.get({ channel: config.slack.channelId, timestamp: ts });
  const reactions = (res.message as { reactions?: Array<{ name: string }> } | undefined)?.reactions ?? [];
  return reactions.map((r) => r.name);
}

/**
 * Does THIS bot own the PR request — i.e. is OUR OWN :eyes: on the parent message? This is the one
 * source of truth for "is this mine to handle." A :eyes: from a human or another bot (e.g. Alden
 * Assistant, which also claims with :eyes:) does NOT count — checking for merely *some* :eyes: is
 * what made the bot ack "addressed" on TMASA #137, a PR it never touched. Because a failed review
 * releases our :eyes: (handleReviewRequest), our :eyes: being present reliably means we reviewed it.
 */
async function botOwnsClaim(client: WebClient, parentTs: string, botUserId: string): Promise<boolean> {
  const res = await client.reactions.get({ channel: config.slack.channelId, timestamp: parentTs });
  const reactions =
    (res.message as { reactions?: Array<{ name: string; users?: string[] }> } | undefined)?.reactions ?? [];
  const eyes = reactions.find((r) => r.name === config.claimEmoji);
  return !!eyes && (eyes.users ?? []).includes(botUserId);
}

async function threadReply(client: WebClient, threadTs: string, text: string): Promise<void> {
  await client.chat.postMessage({ channel: config.slack.channelId, thread_ts: threadTs, text });
}

/** True only when a reply is an intentional "addressed" SIGNAL — it LEADS with the word (after
 *  stripping @-mentions), e.g. "addressed", "done", "fixed it", "@Sushama addressed". A sentence
 *  that merely mentions the word ("…verify if all comments are addressed", "copilot feedback has
 *  not been addressed") is NOT a signal, so the bot doesn't :eyes:/approve on meta-chatter. */
function isAddressedSignal(text?: string): boolean {
  const stripped = (text ?? "").replace(/<@[^>]+>/g, " ").trim();
  return /^(address(ed|ing)?|done|fixed|resolved|updated|ready|pushed|good to go)\b/i.test(stripped);
}

/** True if any message already in this thread contains `marker` — used to post a note AT MOST ONCE
 *  (maybeApprove runs on every thread reply, so an un-guarded note would repeat each time). */
async function threadHasNote(client: WebClient, threadTs: string, marker: string): Promise<boolean> {
  const res = await client.conversations.replies({
    channel: config.slack.channelId,
    ts: threadTs,
    limit: 100,
  });
  return (res.messages ?? []).some((m) => ((m as { text?: string }).text ?? "").includes(marker));
}

/** What a review attempt produced. No Slack side effects — the caller owns reactions/replies. */
type ReviewOutcome =
  | { kind: "skipped"; reason: string } // merged/closed/own-PR/not-allowed — nothing posted
  | { kind: "posted"; url: string; findings: number }
  | { kind: "failed"; error: string }; // transient (claude -p etc.) — caller should allow a retry

/**
 * Gates + review + post + record for ONE PR, with NO Slack reactions/replies (the caller drives
 * those, because the inbound-request path and the @-mention path signal differently). Shared by
 * handleReviewRequest and the mention `review`/`re-review` commands so the review itself is
 * identical everywhere.
 */
async function produceReview(owner: string, repo: string, number: number): Promise<ReviewOutcome> {
  const repoKey = `${owner}/${repo}`.toLowerCase();
  if (config.github.repoAllowlist.length && !config.github.repoAllowlist.includes(repoKey))
    return { kind: "skipped", reason: `${owner}/${repo} isn't on the review allowlist` };

  const meta = await gh.getPr(owner, repo, number);
  if (meta.merged || meta.state !== "open")
    return {
      kind: "skipped",
      reason: `PR #${number} is ${meta.merged ? "already merged" : `already ${meta.state}`}; nothing to review`,
    };

  const me = await gh.authUserLogin();
  if (config.skipOwnPrs && meta.authorLogin === me)
    return { kind: "skipped", reason: "the bot doesn't review its owner's PRs" };

  try {
    const diff = await gh.getPrDiff(owner, repo, number);
    const result = await reviewPr(meta, diff);

    // Split findings into those that anchor to a real diff line (posted inline) and those that
    // don't (folded into the body). A comment on a non-diff line 422s the WHOLE review, which is how
    // #31 ended up with a summary claiming findings but zero inline comments — never silently drop.
    const anchor = gh.anchorableLines(diff);
    const ordered = [...result.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    const inline = ordered.filter((f) => anchor.get(f.path)?.has(f.line));
    const overflow = ordered.filter((f) => !anchor.get(f.path)?.has(f.line));
    const comments = inline.map((f) => ({ path: f.path, line: f.line, body: `**[${f.severity}]** ${f.body}` }));

    const tally = (["High", "Medium", "Low"] as Severity[])
      .map((s) => `${result.findings.filter((f) => f.severity === s).length} ${s}`)
      .join(" · ");
    let body = `Automated review — ${result.summary}\n\nSummary: ${tally}.`;
    if (overflow.length) {
      body +=
        `\n\n---\n**Findings that couldn't be anchored to the diff (${overflow.length}):**\n` +
        overflow.map((f) => `- **[${f.severity}]** \`${f.path}:${f.line}\` — ${f.body}`).join("\n");
    }

    const url = await gh.postReview(owner, repo, number, meta.headOid, body, comments);
    // Record the review in our durable state — the authoritative "we reviewed this PR" fact the
    // approve/addressed path gates on (see maybeApprove).
    reviewState.markReviewed(reviewState.prKey(owner, repo, number), meta.headOid);
    return { kind: "posted", url, findings: result.findings.length };
  } catch (err) {
    return { kind: "failed", error: (err as Error).message };
  }
}

/**
 * After a review posts: if it raised inline comments (findings > 0), point to them and wait for the
 * author (leave :eyes:). If it's CLEAN (0 comments), there's nothing to fix — so approve the PR and
 * ✅ the PR post, GATED on the same safety checks as any approval (still OPEN, CI green, no other
 * reviewer's CHANGES_REQUESTED). Never merges. If a gate blocks, say the review was clean but hold.
 */
async function finalizeReview(
  client: WebClient,
  prPostTs: string,
  replyTs: string,
  owner: string,
  repo: string,
  number: number,
  url: string,
  findings: number
): Promise<void> {
  const key = `${owner}/${repo}#${number}`;
  if (findings > 0) {
    await threadReply(client, replyTs, `👀 Automated review done — see comments: ${url}`);
    return; // leave :eyes:; approval waits for the author to address the comments
  }
  // Clean review (no inline comments) → approve + ✅ if the gates are clear.
  const me = await gh.authUserLogin();
  if (await gh.hasApprovedBy(owner, repo, number, me)) {
    await threadReply(client, replyTs, `✅ Clean review, no issues — already approved ${key}.`);
    return;
  }
  const meta = await gh.getPr(owner, repo, number);
  const problems: string[] = [];
  if (meta.state !== "open" || meta.merged) problems.push(`PR is ${meta.merged ? "merged" : meta.state}`);
  if (!(await gh.ciGreen(owner, repo, meta.headOid))) problems.push("CI isn't green");
  if (await gh.changesRequested(owner, repo, number)) problems.push("another reviewer requested changes");
  if (problems.length) {
    await threadReply(client, replyTs, `✅ Clean review — no issues found. Holding approval: ${problems.join("; ")}.`);
    return;
  }
  try {
    await gh.approvePr(owner, repo, number, "Automated review found no issues — approving.");
  } catch (err) {
    await threadReply(client, replyTs, `Clean review — no issues, but couldn't approve ${key}: ${(err as Error).message.slice(0, 120)}`);
    return;
  }
  // Approved reply FIRST, then the ✅ tick on the PR post (user-set order).
  await threadReply(client, replyTs, `✅ Clean review — no issues found. Approved ${key}.`);
  await client.reactions
    .add({ channel: config.slack.channelId, timestamp: prPostTs, name: config.approvedEmoji })
    .catch(() => undefined);
}

/**
 * A new PR-review request landed in the channel. Eligibility = PR URL + tags the
 * required user + no :eyes:. Debounce, claim, review, post, reply. Leaves :eyes:
 * only — approval is a separate step (see maybeApprove).
 */
export async function handleReviewRequest(
  client: WebClient,
  ts: string,
  text: string,
  botUserId: string
): Promise<void> {
  const pr = parsePrUrl(text);
  if (!pr || !tagsRequiredUser(text)) return; // not an eligible request

  // Step 2 — already handled?
  if ((await reactionNames(client, ts)).includes(config.claimEmoji)) return;

  // Step 3 — debounce, then re-check, then claim.
  await sleep(config.claimDebounceMs);
  if ((await reactionNames(client, ts)).includes(config.claimEmoji)) return; // a human/other runner took it
  await client.reactions.add({ channel: config.slack.channelId, timestamp: ts, name: config.claimEmoji });

  const { owner, repo, number } = pr;
  const outcome = await produceReview(owner, repo, number);
  if (outcome.kind === "skipped") {
    // Leave :eyes: on so a settled/own/not-allowed PR isn't re-picked; just note why.
    await threadReply(client, ts, `Skipping — ${outcome.reason}.`);
    return;
  }
  if (outcome.kind === "failed") {
    // Don't leave the PR silently claimed-but-unreviewed after a transient failure (that's how the
    // 2026-07-28 drops got stuck) — release :eyes: so a re-post/re-tag re-triggers it.
    await client.reactions
      .remove({ channel: config.slack.channelId, timestamp: ts, name: config.claimEmoji })
      .catch(() => undefined);
    await threadReply(
      client,
      ts,
      `⚠️ Automated review failed after retries — unclaimed so it can be retried. Re-post or re-tag to trigger again. (${outcome.error.slice(0, 200)})`
    ).catch(() => undefined);
    console.warn(`[pr-review-bot] review failed for ${owner}/${repo}#${number}: ${outcome.error}`);
    return;
  }
  // Comments → "see comments" (wait for author). Clean → approve + ✅ (gated). See finalizeReview.
  await finalizeReview(client, ts, ts, owner, repo, number, outcome.url, outcome.findings);
}

/**
 * A reply landed in a PR-request thread. If it's the author signalling "addressed"
 * and every bot finding is resolved + verified + not a duplicate → approve.
 * The bot NEVER closes/merges — it only approves.
 */
export async function maybeApprove(
  client: WebClient,
  parentTs: string,
  parentText: string,
  replyUserId: string,
  botUserId: string,
  replyTs?: string,
  replyText?: string
): Promise<void> {
  if (!config.approveWhenAddressed) return;
  const pr = parsePrUrl(parentText);
  if (!pr) return;
  if (replyUserId === botUserId) return; // the bot's own "see comments" reply is not a signal

  // Only a reply that LEADS with an "addressed" signal counts — ignore ordinary thread chatter
  // (incl. messages that merely mention the word) so the bot never :eyes:/approves on discussion.
  if (!isAddressedSignal(replyText)) return;

  const { owner, repo, number } = pr;

  // Ownership gate: only handle threads on a PR WE reviewed. Authoritative source is our durable
  // review record (survives restarts, can't be spoofed by another bot's :eyes:); we also accept our
  // OWN :eyes: still being on the request, so PRs reviewed before this record existed keep working.
  // A :eyes: from a human or another bot (e.g. Alden Assistant on #137) never counts.
  const owned =
    reviewState.hasReviewed(reviewState.prKey(owner, repo, number)) ||
    (await botOwnsClaim(client, parentTs, botUserId));
  if (!owned) return;

  const me = await gh.authUserLogin();

  // Acknowledge the signal with :eyes: on the reply so it's visible the bot caught it (even if it
  // then holds, e.g. CI not green). Idempotent; swallow any error.
  if (replyTs) {
    await client.reactions
      .add({ channel: config.slack.channelId, timestamp: replyTs, name: config.claimEmoji })
      .catch(() => undefined);
  }

  if (await gh.hasApprovedBy(owner, repo, number, me)) return; // already approved

  const meta = await gh.getPr(owner, repo, number);
  if (meta.state !== "open" || meta.merged) return; // nothing to approve

  // Gate 1 (team pref): approve on verified-fix + GREEN CI — do NOT wait for GitHub review threads
  // to be marked resolved. CI pending/failing ⇒ hold silently (no chat noise); re-checks next reply.
  if (!(await gh.ciGreen(owner, repo, meta.headOid))) return;

  // Don't approve over an EXPLICIT block: hold silently if a reviewer marked CHANGES_REQUESTED
  // (human / codex / copilot / gemini / charlie). We do NOT require threads to be marked "resolved"
  // — the author's "addressed" signal + no CHANGES_REQUESTED is the bar (user-set 2026-07-17).
  if (await gh.changesRequested(owner, repo, number)) return;

  // Duplicate guard — hold ONLY for a GENUINE competing duplicate: another open PR for the SAME
  // ticket, or (when neither carries a ticket) one with a STRONG changed-file overlap. Merely sharing
  // one incidental file (a router/index/config) is NOT competition — that was the #45↔#42 false
  // positive. Different tickets are never competing. See gh.competingOpenPrs.
  const myTicket = gh.ticketKey(meta.title, meta.headRefName);
  const myFiles = (await gh.changedFilePaths(owner, repo, number)).filter(gh.isCodeFile);
  const dupes =
    myTicket || myFiles.length ? await gh.competingOpenPrs(owner, repo, number, myTicket, myFiles) : [];
  if (dupes.length) {
    // Post the "competing PR" note AT MOST ONCE per thread, then hold silently on later replies.
    const MARK = "holding approval: this competes with";
    if (!(await threadHasNote(client, parentTs, MARK))) {
      await threadReply(
        client,
        parentTs,
        `Fix looks addressed & CI is green, but ${MARK} #${dupes.join(", #")} (same ticket/implementation). A human should pick one — I don't close/merge PRs.`
      );
    }
    return;
  }

  // VERIFY (opt-in via VERIFY_FIXES_BEFORE_APPROVE, default OFF): re-check via claude -p that the
  // findings are actually fixed in the commits before approving. Default trusts the author's
  // "addressed" signal + the objective gates above (CI green, no CHANGES_REQUESTED, not a real
  // duplicate) — "if they said addressed, approve it". Enable for stricter approvals.
  if (config.verifyFixesBeforeApprove) {
    const findings = await gh.allReviewComments(owner, repo, number);
    if (findings.length) {
      // Signature (count + each path:line) + head SHA fully determine the verdict → reuse the cache
      // instead of re-spawning claude -p when nothing changed since the last hold.
      const commentSig = `${findings.length}|${findings
        .map((c) => `${c.path}:${c.line}`)
        .sort()
        .join(",")}`;
      const key = verifyKey(owner, repo, number, meta.headOid, commentSig);
      let allAddressed: boolean;
      if (verifyMemo.has(key)) {
        allAddressed = verifyMemo.get(key)!;
      } else {
        const diff = await gh.getPrDiff(owner, repo, number);
        const res = await verifyFix(
          findings.map((c) => ({ path: c.path, line: c.line, severity: "Medium" as Severity, body: c.body })),
          diff
        );
        allAddressed = res.allAddressed;
        if (res.ok) verifyMemo.set(key, res.allAddressed);
      }
      if (!allAddressed) return; // not every comment addressed in the commits yet → hold
    }
  }

  await gh.approvePr(owner, repo, number);
  // Post the approved reply FIRST, THEN the ✅ tick on the PR post (user-set order).
  await threadReply(client, parentTs, "✅ Approved — CI green.");
  await client.reactions
    .add({ channel: config.slack.channelId, timestamp: parentTs, name: config.approvedEmoji })
    .catch(() => undefined);
}

/**
 * Periodic self-heal: scan recent channel messages for reviewed-but-not-yet-approved PRs
 * (`:eyes:` and no `:white_check_mark:`) and, if their thread already carries an "addressed"-style
 * reply from someone other than the bot, run the same approve path. This catches "addressed"
 * replies that arrived while the bot was down/restarting (Socket Mode does NOT replay missed
 * events), so approvals aren't silently dropped. Idempotent — maybeApprove re-checks everything.
 */
type HistMsg = {
  ts?: string;
  text?: string;
  reactions?: Array<{ name: string }>;
  latest_reply?: string;
};

/**
 * Run the approve check for ONE channel message (a PR-review request). Shared by the periodic sweep
 * and the CI webhook so both behave identically. Returns the message ts if it is a tracked
 * reviewed-but-unapproved candidate (so the caller can bound the signal cache), else null.
 */
async function tryApproveForMessage(
  client: WebClient,
  botUserId: string,
  m: HistMsg
): Promise<string | null> {
  if (!m.ts || !m.text) return null;
  if (!parsePrUrl(m.text) || !tagsRequiredUser(m.text)) return null;
  const reacts = (m.reactions ?? []).map((r) => r.name);
  if (!reacts.includes(config.claimEmoji)) return null; // not reviewed by us
  if (reacts.includes(config.approvedEmoji)) return null; // already approved
  // Tracked candidate from here on (report ts for cache bookkeeping regardless of outcome).

  if (!m.latest_reply) return m.ts; // no thread ⇒ no "addressed" reply can exist yet

  let signal: CachedSignal;
  const cached = signalCache.get(m.ts);
  if (cached && cached.latestReply === m.latest_reply) {
    signal = cached.signal; // thread unchanged since last look — reuse, skip the replies fetch
  } else {
    const thread = await client.conversations.replies({
      channel: config.slack.channelId,
      ts: m.ts,
      limit: 50,
    });
    // newest first: the latest non-bot "addressed" reply is the signal to act on
    const replies = (thread.messages ?? []).slice(1).reverse();
    signal =
      (replies.find((r) => {
        const rm = r as { user?: string; text?: string };
        return rm.user !== botUserId && isAddressedSignal(rm.text);
      }) as CachedSignal) ?? null;
    signalCache.set(m.ts, { latestReply: m.latest_reply, signal });
  }

  if (signal) {
    await maybeApprove(client, m.ts, m.text, signal.user ?? "", botUserId, signal.ts, signal.text);
  }
  return m.ts;
}

export async function reconcileApprovals(client: WebClient, botUserId: string): Promise<void> {
  const hist = await client.conversations.history({ channel: config.slack.channelId, limit: 30 });
  const seen = new Set<string>();
  for (const msg of hist.messages ?? []) {
    const ts = await tryApproveForMessage(client, botUserId, msg as HistMsg);
    if (ts) seen.add(ts);
  }
  // Keep the cache bounded: drop entries for messages no longer in the reviewed-unapproved window
  // (approved, or scrolled past the history limit).
  for (const key of signalCache.keys()) if (!seen.has(key)) signalCache.delete(key);
}

/**
 * A GitHub CI webhook fired (check_suite/workflow_run/status completed). Immediately run the approve
 * check for the affected PR(s) — the instant, event-driven counterpart to the poll. maybeApprove
 * re-checks everything (CI green, no CHANGES_REQUESTED, fix verified), so a spurious or duplicate
 * event is harmless. Matches the CI event to channel messages by PR number when present; a bare
 * `status` event (SHA only, no PR numbers) falls back to every reviewed-unapproved PR in that repo.
 */
export async function handleCiComplete(
  client: WebClient,
  botUserId: string,
  e: CiEvent
): Promise<void> {
  const hist = await client.conversations.history({ channel: config.slack.channelId, limit: 50 });
  for (const msg of hist.messages ?? []) {
    const m = msg as HistMsg;
    const pr = m.text ? parsePrUrl(m.text) : null;
    if (!pr) continue;
    if (pr.owner.toLowerCase() !== e.owner.toLowerCase() || pr.repo.toLowerCase() !== e.repo.toLowerCase())
      continue;
    if (e.prNumbers.length && !e.prNumbers.includes(pr.number)) continue; // number known → target it
    await tryApproveForMessage(client, botUserId, m);
  }
}

/** Text of a single message (for resolving the PR from a thread root). */
async function messageText(client: WebClient, ts: string): Promise<string> {
  const res = await client.conversations.replies({ channel: config.slack.channelId, ts, limit: 1 });
  return ((res.messages?.[0] as { text?: string } | undefined)?.text ?? "");
}

/**
 * The `approve` command: gate-check (OPEN, CI green, no CHANGES_REQUESTED) then post a GitHub
 * approval. This is "everything's green, sign off" — it does NOT verify findings (that's the
 * `addressed`/auto path) and it NEVER merges. Blocked → say what's wrong (offer-to-fix comes later).
 */
async function approveOnRequest(
  client: WebClient,
  replyThread: string,
  prPostTs: string,
  owner: string,
  repo: string,
  number: number
): Promise<void> {
  const key = `${owner}/${repo}#${number}`;
  const me = await gh.authUserLogin();
  if (await gh.hasApprovedBy(owner, repo, number, me)) {
    await threadReply(client, replyThread, `already approved ${key}.`);
    return;
  }
  const meta = await gh.getPr(owner, repo, number);
  if (meta.state !== "open" || meta.merged) {
    await threadReply(client, replyThread, `that PR is ${meta.merged ? "merged" : meta.state} — nothing to approve.`);
    return;
  }
  const problems: string[] = [];
  if (!(await gh.ciGreen(owner, repo, meta.headOid))) problems.push("CI isn't green");
  if (await gh.changesRequested(owner, repo, number)) problems.push("a reviewer requested changes");
  if (problems.length) {
    await threadReply(client, replyThread, `can't approve ${key} yet — ${problems.join("; ")}.`);
    return;
  }
  try {
    await gh.approvePr(owner, repo, number, "Approval gates clear: CI green, no changes requested.");
  } catch (err) {
    await threadReply(client, replyThread, `couldn't approve ${key}: ${(err as Error).message.slice(0, 150)}`);
    return;
  }
  // Approved reply FIRST, then the ✅ tick on the PR post (user-set order).
  await threadReply(client, replyThread, `✅ approved ${key} — CI green, no changes requested.`);
  await client.reactions
    .add({ channel: config.slack.channelId, timestamp: prPostTs, name: config.approvedEmoji })
    .catch(() => undefined);
}

/**
 * @-mention command surface (Alden parity, minus merge). Resolves the PR from the mention text or,
 * for a thread reply, the thread root, then dispatches: help/status (instant), review/re-review
 * (produceReview; re-review is SHA-guarded), addressed (verify-then-approve), approve (gate-check).
 */
export async function handleMention(
  client: WebClient,
  messageTs: string,
  threadTs: string | undefined,
  text: string,
  botUserId: string
): Promise<void> {
  const parsed = mentions.parseMention(text);
  const replyThread = threadTs ?? messageTs; // reply in the mention's thread (or start one on it)

  if (parsed.command === "help") {
    await threadReply(client, replyThread, mentions.HELP_TEXT);
    return;
  }
  if (parsed.command === "status") {
    await threadReply(client, replyThread, mentions.formatStatus(inflight.snapshot()));
    return;
  }

  // Resolve the PR: from the mention text, else from the thread root.
  let owner = parsed.owner;
  let repo = parsed.repo;
  let number = parsed.number;
  if (number == null && threadTs) {
    const rootPr = parsePrUrl(await messageText(client, threadTs));
    if (rootPr) ({ owner, repo, number } = rootPr);
  }
  if (owner == null || repo == null || number == null) {
    await threadReply(client, replyThread, mentions.NO_PR_TEXT);
    return;
  }
  const key = `${owner}/${repo}#${number}`;

  // Claim :eyes: on BOTH the mention AND the PR post (thread root) — the thread root is the channel
  // message everyone looks at, so that's the visible "this is mine" marker. Dedupe when the mention
  // IS the PR post (a top-level mention with the link). Idempotent; swallow errors.
  const eyesTargets = [...new Set([messageTs, threadTs].filter((t): t is string => !!t))];
  for (const t of eyesTargets) {
    await client.reactions
      .add({ channel: config.slack.channelId, timestamp: t, name: config.claimEmoji })
      .catch(() => undefined);
  }

  if (parsed.command === "review" || parsed.command === "re-review") {
    // SHA guard on BOTH review and re-review: never re-review the same commit. This is the fix for
    // "asking for too many reviews" — a repeat @bot review on an unchanged PR replies once that
    // there's nothing new, instead of running (and re-posting) another full review. Only a new
    // commit (head SHA changes) gets a fresh pass.
    const meta = await gh.getPr(owner, repo, number).catch(() => null);
    if (meta && reviewState.reviewedSha(key) === meta.headOid) {
      await threadReply(client, replyThread, `already reviewed ${key} at this commit — nothing new to look at.`);
      return;
    }
    if (!inflight.claim(key, parsed.command)) {
      await threadReply(client, replyThread, `already reviewing ${key} — hang tight.`);
      return;
    }
    try {
      const outcome = await produceReview(owner, repo, number);
      if (outcome.kind === "skipped") await threadReply(client, replyThread, `skipping — ${outcome.reason}.`);
      else if (outcome.kind === "failed")
        await threadReply(client, replyThread, `couldn't ${parsed.command} ${key}: ${outcome.error.slice(0, 200)}`);
      else await finalizeReview(client, threadTs ?? messageTs, replyThread, owner, repo, number, outcome.url, outcome.findings);
    } finally {
      inflight.release(key);
    }
    return;
  }

  if (parsed.command === "addressed") {
    // Reuse the auto "addressed" path: verify findings are handled, then approve. The mention IS the
    // signal (pass "addressed" as reply text); maybeApprove gates on ownership (hasReviewed/own-eyes).
    const rootTs = threadTs ?? messageTs;
    const rootText = (await messageText(client, rootTs)) || text;
    await maybeApprove(client, rootTs, rootText, "", botUserId, messageTs, "addressed");
    return;
  }

  if (parsed.command === "approve") {
    await approveOnRequest(client, replyThread, threadTs ?? messageTs, owner, repo, number);
    return;
  }
}
