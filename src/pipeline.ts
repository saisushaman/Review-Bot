import type { WebClient } from "@slack/web-api";
import { config, parsePrUrl, tagsRequiredUser } from "./config.js";
import * as gh from "./github.js";
import { reviewPr, type Severity } from "./review.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sevOrder: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };

async function reactionNames(client: WebClient, ts: string): Promise<string[]> {
  const res = await client.reactions.get({ channel: config.slack.channelId, timestamp: ts });
  const reactions = (res.message as { reactions?: Array<{ name: string }> } | undefined)?.reactions ?? [];
  return reactions.map((r) => r.name);
}

async function threadReply(client: WebClient, threadTs: string, text: string): Promise<void> {
  await client.chat.postMessage({ channel: config.slack.channelId, thread_ts: threadTs, text });
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
  const repoKey = `${owner}/${repo}`.toLowerCase();
  if (config.github.repoAllowlist.length && !config.github.repoAllowlist.includes(repoKey)) {
    await threadReply(client, ts, `Skipping — ${owner}/${repo} isn't on the review allowlist.`);
    return;
  }

  const meta = await gh.getPr(owner, repo, number);

  // Already merged/closed before we got to it → nothing to review. Leave :eyes: so it isn't
  // re-picked, note why in-thread, and stop (no GitHub review on a settled PR).
  if (meta.merged || meta.state !== "open") {
    const how = meta.merged ? "already merged" : `already ${meta.state}`;
    await threadReply(client, ts, `Skipping — PR #${number} is ${how}; nothing to review.`);
    return;
  }

  const me = await gh.authUserLogin();
  if (config.skipOwnPrs && meta.authorLogin === me) {
    await threadReply(client, ts, "Skipping — the bot doesn't review its owner's PRs.");
    return; // leave :eyes: so it isn't re-picked
  }

  const diff = await gh.getPrDiff(owner, repo, number);
  const result = await reviewPr(meta, diff);

  // Split findings into those that anchor to a real diff line (posted inline) and those that
  // don't (folded into the body). A comment on a non-diff line 422s the WHOLE review, which is how
  // #31 ended up with a summary claiming findings but zero inline comments — never silently drop.
  const anchor = gh.anchorableLines(diff);
  const ordered = [...result.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  const inline = ordered.filter((f) => anchor.get(f.path)?.has(f.line));
  const overflow = ordered.filter((f) => !anchor.get(f.path)?.has(f.line));
  const comments = inline.map((f) => ({
    path: f.path,
    line: f.line,
    body: `**[${f.severity}]** ${f.body}`,
  }));

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
  await threadReply(client, ts, `👀 Automated review done — see comments in the reply thread: ${url}`);
  // Deliberately leave ONLY :eyes:. Approval happens in maybeApprove after the author responds.
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

  // Parent must be a PR the bot reviewed (carries :eyes:).
  if (!(await reactionNames(client, parentTs)).includes(config.claimEmoji)) return;

  // Only an "addressed"-style reply is an approval signal — ignore ordinary thread chatter so the
  // bot never approves on an unrelated message.
  const isAddressed = /\b(address(ed)?|done|fixed|resolved|updated|ready|pushed)\b/i.test(
    replyText ?? ""
  );
  if (!isAddressed) return;

  // Acknowledge it with :eyes: on the reply itself so it's visible the bot caught the signal (even
  // if it then holds, e.g. CI not green). Idempotent; swallow any error.
  if (replyTs) {
    await client.reactions
      .add({ channel: config.slack.channelId, timestamp: replyTs, name: config.claimEmoji })
      .catch(() => undefined);
  }

  const { owner, repo, number } = pr;
  const me = await gh.authUserLogin();
  if (await gh.hasApprovedBy(owner, repo, number, me)) return; // already approved

  const meta = await gh.getPr(owner, repo, number);
  if (meta.state !== "open" || meta.merged) return; // nothing to approve

  // Gate 1 (team pref): approve on verified-fix + GREEN CI — do NOT wait for GitHub review threads
  // to be marked resolved. CI pending/failing ⇒ hold silently (no chat noise); re-checks next reply.
  if (!(await gh.ciGreen(owner, repo, meta.headOid))) return;

  // Never approve over ANOTHER reviewer's open feedback: hold silently if the PR is
  // CHANGES_REQUESTED or has unresolved review threads from someone other than the bot (human or
  // codex/copilot/gemini/charlie). The bot's approval clears only its OWN findings (user-set
  // 2026-07-17: it approved #98 while copilot/charlie feedback was still unaddressed).
  if (await gh.othersBlockApproval(owner, repo, number, me)) return;

  // Duplicate guard — never approve when a competing OPEN PR touches the same SOURCE files. Ignore
  // incidental shared files (the append-only SOW ledger, docs, markdown, changelogs) — nearly every
  // PR touches those, so counting them made the guard fire on essentially everything (e.g. #98 held
  // only because it shares docs/sow/ledger.md with an unrelated docs PR). Only a shared code file
  // signals a real competing implementation.
  const codeFile = (f: string) =>
    !/\.(md|mdx|txt|rst)$/i.test(f) && !/(^|\/)docs\//i.test(f) && !/ledger|changelog/i.test(f);
  const files = (await gh.changedFilePaths(owner, repo, number)).filter(codeFile);
  const dupes = files.length ? await gh.openPrsTouchingFiles(owner, repo, number, files) : [];
  if (dupes.length) {
    // Post the "competing PR" note AT MOST ONCE per thread, then hold silently on later replies —
    // maybeApprove runs on every reply, so re-posting it each time spams the thread (user-set
    // 2026-07-17). The marker is a stable substring of the note itself.
    const MARK = "holding approval: this competes with";
    if (!(await threadHasNote(client, parentTs, MARK))) {
      await threadReply(
        client,
        parentTs,
        `Fix looks addressed & CI is green, but ${MARK} #${dupes.join(", #")} (same file(s)). A human should pick one — I don't close/merge PRs.`
      );
    }
    return;
  }

  // The author said "addressed" and CI is green → approve on their word (user-set 2026-07-17).
  // We deliberately DON'T gate on verifyFix here: it false-negatived and blocked legitimately
  // addressed PRs. Approval is not merge (a human still merges), so an explicit "addressed" signal
  // + green CI is the right bar.
  await gh.approvePr(owner, repo, number);
  await client.reactions.add({
    channel: config.slack.channelId,
    timestamp: parentTs,
    name: config.approvedEmoji,
  });
  await threadReply(client, parentTs, "✅ Approved — CI green.");
}

/**
 * Periodic self-heal: scan recent channel messages for reviewed-but-not-yet-approved PRs
 * (`:eyes:` and no `:white_check_mark:`) and, if their thread already carries an "addressed"-style
 * reply from someone other than the bot, run the same approve path. This catches "addressed"
 * replies that arrived while the bot was down/restarting (Socket Mode does NOT replay missed
 * events), so approvals aren't silently dropped. Idempotent — maybeApprove re-checks everything.
 */
export async function reconcileApprovals(client: WebClient, botUserId: string): Promise<void> {
  const hist = await client.conversations.history({ channel: config.slack.channelId, limit: 30 });
  const ADDRESSED = /\b(address(ed)?|done|fixed|resolved|updated|ready|pushed)\b/i;
  for (const msg of hist.messages ?? []) {
    const m = msg as { ts?: string; text?: string; reactions?: Array<{ name: string }> };
    if (!m.ts || !m.text) continue;
    if (!parsePrUrl(m.text) || !tagsRequiredUser(m.text)) continue;
    const reacts = (m.reactions ?? []).map((r) => r.name);
    if (!reacts.includes(config.claimEmoji)) continue; // not reviewed by us
    if (reacts.includes(config.approvedEmoji)) continue; // already approved
    const thread = await client.conversations.replies({
      channel: config.slack.channelId,
      ts: m.ts,
      limit: 50,
    });
    // newest first: the latest non-bot "addressed" reply is the signal to act on
    const replies = (thread.messages ?? []).slice(1).reverse();
    const signal = replies.find((r) => {
      const rm = r as { user?: string; text?: string };
      return rm.user !== botUserId && ADDRESSED.test(rm.text ?? "");
    }) as { user?: string; text?: string; ts?: string } | undefined;
    if (!signal) continue;
    await maybeApprove(client, m.ts, m.text, signal.user ?? "", botUserId, signal.ts, signal.text);
  }
}
