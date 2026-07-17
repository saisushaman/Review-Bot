import type { WebClient } from "@slack/web-api";
import { config, parsePrUrl, tagsRequiredUser } from "./config.js";
import * as gh from "./github.js";
import { reviewPr, verifyFix, type Severity } from "./review.js";

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
  botUserId: string
): Promise<void> {
  if (!config.approveWhenAddressed) return;
  const pr = parsePrUrl(parentText);
  if (!pr) return;
  if (replyUserId === botUserId) return; // the bot's own "see comments" reply is not a signal

  // Parent must be a PR the bot reviewed (carries :eyes:).
  if (!(await reactionNames(client, parentTs)).includes(config.claimEmoji)) return;

  const { owner, repo, number } = pr;
  const me = await gh.authUserLogin();
  if (await gh.hasApprovedBy(owner, repo, number, me)) return; // already approved

  const meta = await gh.getPr(owner, repo, number);
  if (meta.state !== "open" || meta.merged) return; // nothing to approve

  // Gate 1 (team pref): approve on verified-fix + GREEN CI — do NOT wait for GitHub review threads
  // to be marked resolved. CI pending/failing ⇒ hold silently (no chat noise); re-checks next reply.
  if (!(await gh.ciGreen(owner, repo, meta.headOid))) return;

  // Duplicate guard — never approve when a competing OPEN PR touches the same files.
  const files = await gh.changedFilePaths(owner, repo, number);
  const dupes = await gh.openPrsTouchingFiles(owner, repo, number, files);
  if (dupes.length) {
    await threadReply(
      client,
      parentTs,
      `Fix looks addressed & CI is green, but holding approval: this competes with #${dupes.join(", #")} (same file(s)). A human should pick one — I don't close/merge PRs.`
    );
    return;
  }

  // Gate 2: verify the fix actually addresses the bot's findings (reconstructed from its comments).
  // A clean review (no findings) + green CI is already "done" → approve.
  const prior = await gh.botReviewComments(owner, repo, number, me);
  if (prior.length) {
    const diff = await gh.getPrDiff(owner, repo, number);
    const ok = await verifyFix(
      prior.map((c) => ({ path: c.path, line: c.line, severity: "Medium" as Severity, body: c.body })),
      diff
    );
    // Not yet verified-addressed → hold SILENTLY and re-check on the next reply. Do NOT post a
    // "take another look" nag (user-set 2026-07-17): the verify step false-negatives, and nagging
    // the author when they've already addressed things is noise. Approve when it passes; stay quiet
    // otherwise.
    if (!ok) return;
  }

  await gh.approvePr(owner, repo, number);
  await client.reactions.add({ channel: config.slack.channelId, timestamp: parentTs, name: config.approvedEmoji });
  await threadReply(client, parentTs, "✅ Findings addressed & CI green — approved.");
}
