import type { WebClient } from "@slack/web-api";
import { config, parsePrUrl, tagsRequiredUser } from "./config.js";
import * as gh from "./github.js";
import { reviewPr, reviewPrWithRepo, cleanCommentLabel, SEVERITIES, type Severity } from "./review.js";
import { prepareRepoCheckout } from "./repoClone.js";
import type { CiEvent } from "./webhook.js";
import * as reviewState from "./reviewState.js";
import * as inflight from "./inflight.js";
import * as mentions from "./mentions.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Sort key: most-severe first (Blocking → High → Medium → Low), derived from the canonical list.
const sevOrder = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

// A PR is routed to the DEEP whole-repo review (vs. the fast text path) whenever its diff touches
// something security-sensitive, where cross-layer / rules / auth reasoning across the whole codebase
// is exactly what catches the bugs (the Firestore/storage-rules bypass class the bot has missed).
// Matched against the raw unified diff, so it fires on both file PATHS (+++ b/…) and telltale code.
// Deliberately broad — a false "deep" only costs time; a false "fast" could miss an auth bug.
const SENSITIVE_RE =
  /\.rules\b|firestore\.rules|storage\.rules|firestore\.indexes|\brules_version\b|\ballow\s+(read|write|create|update|delete)\b|security[-_]?rules|\bIAM\b|\.iam\b|request\.auth|auth[-_]?(guard|middleware|check)|authoriz|permission|\brole[s]?\b|\brbac\b|\bacl\b|middleware|\.env\b|secret|credential|token|password|\bjwt\b|session|login|oauth|cors\b|csrf|sanitiz|upload|content[-_]?type|dockerfile|\.ya?ml$|webhook/i;

// Safety net for the "concern hidden in the summary" failure: the model sometimes gestures at a real
// problem in prose ("…but appears to drop the notification the docs guarantee") while filing ZERO
// findings, so the review posts as clean and auto-approves — the exact way a defect ships green. When
// a 0-finding review's summary carries this deficiency phrasing, we DON'T auto-approve; we hold and
// point a human at it. Conservative (fires only on strong concern language) to avoid blocking real
// clean approvals. The prompt already forbids this; this is defense-in-depth, not the primary fix.
const SUMMARY_CONCERN_RE =
  /\bappears? to (drop|miss|lack|omit|break|fail|skip)|\bfails? to\b|does(n'?t| not) (handle|guard|validate|check|cover|account|enforce)|the only (real )?(issue|concern|gap|problem)|\bbut (the|it|this|there|appears|seems|does|is|isn'?t|may|might|could|no )|however[,\s]|\bmissing\b|seems? to (drop|miss|lack|omit)|isn'?t (handled|guarded|validated|covered|enforced)/i;

// Cache of the newest "addressed" signal per PR-request message, validated against Slack's
// `latest_reply` timestamp. The self-heal sweep runs every 2 min; re-fetching a thread's replies
// when nothing new was posted is the dominant wasted call (a reviewed PR always has the bot's own
// "review done" reply, so it always has a thread). If `latest_reply` is unchanged since we last
// looked, the newest addressed signal cannot have changed, so we reuse the cached result and skip
// the conversations.replies fetch. maybeApprove still runs each tick when a signal is cached, so CI
// turning green on an otherwise-unchanged thread is still picked up.
type CachedSignal = { user?: string; text?: string; ts?: string } | null;
const signalCache = new Map<string, { latestReply: string; signal: CachedSignal }>();

// After a review FAILS, cool off before the 2-min sweep retries it. Without this a PERSISTENT failure
// (e.g. claude -p auth down) re-reviews every sweep — churning the :eyes: claim and re-spawning
// claude -p endlessly. In-memory (cleared on restart); a fresh commit or an explicit @-mention
// re-tag still triggers an immediate review (those paths don't consult this).
const failedCooldown = new Map<string, number>(); // prKey -> epoch ms of last failure
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;

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

/** True when a review comment is a FOLLOW-UP / acknowledgement rather than a genuine finding —
 *  e.g. baz's "Commit abc123 **addressed** this comment by…", "Thanks for the context…", or a bot's
 *  automation marker. These are normally REPLIES (so thread-root filtering already excludes them),
 *  but a reviewer occasionally posts one as a new root; it must never gate approval. */
function isFollowUpComment(body?: string): boolean {
  const t = (body ?? "").replace(/\s+/g, " ").trim();
  if (!t) return true; // nothing to address
  return (
    /\baddressed\b\s+this\s+comment/i.test(t) ||
    /^commit\s+[0-9a-f]{6,}\b/i.test(t.replace(/[*_`]/g, "")) ||
    /^(thanks|thank you|got it|acknowledged|noted|understood|makes sense|agreed)\b/i.test(t) ||
    /CURSOR_AUTOMATION_ID/i.test(t) ||
    /\bi'?ll save this\b/i.test(t)
  );
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
  | { kind: "posted"; url: string; findings: number; heldConcern?: string }
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
  if (meta.merged || meta.state !== "open") {
    // Record it as HANDLED so the 2-min catch-up never re-processes a merged/closed PR every sweep —
    // that re-processing is exactly what re-posted the same "Skipping — already merged" reply over and
    // over. Once recorded, handleReviewRequest's hasReviewed() gate returns silently next time.
    reviewState.markReviewed(reviewState.prKey(owner, repo, number), meta.headOid);
    return {
      kind: "skipped",
      reason: `PR #${number} is ${meta.merged ? "already merged" : `already ${meta.state}`}; nothing to review`,
    };
  }

  const me = await gh.authUserLogin();
  if (config.skipOwnPrs && meta.authorLogin === me)
    return { kind: "skipped", reason: "the bot doesn't review its owner's PRs" };

  try {
    const diff = await gh.getPrDiff(owner, repo, number);
    // Comments other reviewers (copilot/gemini/charlie/humans) already left — the reviewer is told
    // not to repeat them, so its output stays additive instead of restating known feedback.
    const priorComments = await gh.allReviewComments(owner, repo, number).catch(() => []);
    // Cross-PR context: the OTHER open PRs and the files they touch, so the review can catch merge/
    // path collisions and cutover/sequencing hazards a single-PR-in-isolation review is blind to.
    const otherPrs = await gh.otherOpenPrs(owner, repo, number).catch(() => []);
    // Deepest review: clone the repo at the PR head and let claude read the WHOLE codebase (callers,
    // types, cross-file effects). Falls back to the diff + fetched-file-content review if the clone
    // fails or the feature is off — repo context is a bonus, never a hard dependency.
    let result: Awaited<ReturnType<typeof reviewPr>>;
    // EFFICIENCY ROUTING (see config.deepReviewMax*): the whole-repo path is deep but expensive
    // (clone + agentic crawl + 10-min budget). Only spend it where it pays off — a security-sensitive
    // change (where cross-layer/rules reasoning is the whole point) or a large one. A small,
    // non-sensitive PR takes the fast text path: its changed-file contents already give full context
    // (callers, types, invariants within the touched files), no clone needed.
    const changedLines = meta.additions + meta.deletions;
    // Sensitivity is judged from the PR's TITLE + description + the diff (paths + code), not the diff
    // alone — a PR literally titled "Shared … OAuth tokens readable by every user" MUST route DEEP even
    // if the diff's own text is terse. A security-sensitive PR ALWAYS gets the whole-repo review (never
    // the diff-only FAST path), so a second leak path in an UNCHANGED file can't be missed (this is the
    // ActualChat #55 miss: a credential-exposure fix that went FAST because only its diff was scanned).
    const sensitive = SENSITIVE_RE.test(`${meta.title}\n${meta.body}\n${diff}`);
    const wantDeep =
      config.repoContextReview &&
      (sensitive ||
        changedLines > config.deepReviewMaxLines ||
        meta.changedFiles > config.deepReviewMaxFiles);
    // Log the decision WITH its inputs, so a surprising route (a security PR going FAST) is diagnosable
    // from the log instead of a mystery — the FAST/DEEP line below alone hid why.
    console.log(
      `[pr-review-bot] #${number}: routing → ${wantDeep ? "DEEP" : "FAST"} (repoContext=${config.repoContextReview} sensitive=${sensitive} lines=${changedLines}/${config.deepReviewMaxLines} files=${meta.changedFiles}/${config.deepReviewMaxFiles})`
    );
    const checkout = wantDeep ? await prepareRepoCheckout(owner, repo, number) : null;
    if (checkout) {
      console.log(
        `[pr-review-bot] #${number}: DEEP review (whole-repo) — ${
          sensitive ? "security-sensitive" : `${changedLines} lines / ${meta.changedFiles} files`
        }`
      );
      try {
        result = await reviewPrWithRepo(meta, diff, checkout.dir, priorComments, otherPrs);
      } finally {
        await checkout.cleanup();
      }
    } else {
      if (wantDeep) {
        // wantDeep was true but prepareRepoCheckout returned null → the clone/fetch FAILED and we're
        // silently degrading to a shallow review. Say so loudly (not "not sensitive") — for a sensitive
        // PR this is a real coverage loss, and the thoroughness gate below will hold approval on it.
        console.warn(
          `[pr-review-bot] #${number}: DEEP wanted but repo checkout FAILED → DEGRADED to FAST — a sensitive/large PR got a shallow review; approval will be held. Check the repo-clone auth/token.`
        );
      } else {
        console.log(
          `[pr-review-bot] #${number}: FAST review (diff+files) — ${changedLines} lines / ${meta.changedFiles} files, not sensitive`
        );
      }
      const files = await gh
        .changedFilesContent(owner, repo, number, meta.headOid)
        .catch(() => [] as Array<{ path: string; content: string; truncated: boolean }>);
      result = await reviewPr(meta, diff, files, priorComments, otherPrs);
    }

    // Split findings into those that anchor to a real diff line (posted inline) and those that
    // don't (folded into the body). A comment on a non-diff line 422s the WHOLE review, which is how
    // #31 ended up with a summary claiming findings but zero inline comments — never silently drop.
    const anchor = gh.anchorableLines(diff);
    const ordered = [...result.findings].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    const inline = ordered.filter((f) => anchor.get(f.path)?.has(f.line));
    const overflow = ordered.filter((f) => !anchor.get(f.path)?.has(f.line));
    const comments = inline.map((f) => ({ path: f.path, line: f.line, body: `**[${f.severity}]** ${f.body}` }));

    const tally = SEVERITIES.map(
      (s) => `${result.findings.filter((f) => f.severity === s).length} ${s}`
    ).join(" · ");
    let body = `Automated review — ${result.summary}\n\nSummary: ${tally}.`;
    if (overflow.length) {
      body +=
        `\n\n---\n**Findings that couldn't be anchored to the diff (${overflow.length}):**\n` +
        overflow.map((f) => `- **[${f.severity}]** \`${f.path}:${f.line}\` — ${f.body}`).join("\n");
    }
    // Audit trail: the concrete risk areas the review examined and cleared. This is what makes a
    // clean (0-finding) verdict high-signal instead of a rubber stamp — the reader can see WHAT was
    // checked, not just "looks good". Always shown when present; most valuable on a clean PR.
    if (result.checked.length) {
      body +=
        `\n\n---\n**Checked & cleared:**\n` + result.checked.map((c) => `- ${c}`).join("\n");
    }

    const url = await gh.postReview(owner, repo, number, meta.headOid, body, comments);
    // THOROUGHNESS GATE: a security-sensitive PR that only got the shallow FAST review (no whole-repo
    // pass — e.g. repoContextReview off or the clone was skipped) is NOT reviewed thoroughly enough to
    // auto-approve on. Record that, and surface it so BOTH approval paths hold ("don't approve until
    // the review is thorough"). A deep review, or a non-sensitive PR, is sufficient.
    const reviewWasDeep = !!checkout;
    const insufficient = sensitive && !reviewWasDeep;
    // Record the review in our durable state — the authoritative "we reviewed this PR" fact the
    // approve/addressed path gates on (see maybeApprove) — with whether it was thorough enough.
    reviewState.markReviewed(reviewState.prKey(owner, repo, number), meta.headOid, insufficient);
    if (insufficient)
      console.log(`[pr-review-bot] #${number}: security-sensitive PR got only a FAST review — holding approval until a deep review`);
    // A clean review whose summary still gestures at a concern (contract violation) must NOT
    // auto-approve — flag it so finalizeReview holds for a human (see SUMMARY_CONCERN_RE).
    const heldConcern =
      insufficient
        ? "the review wasn't thorough enough (security-sensitive PR reviewed on the shallow path) — needs a deep whole-repo review before approval"
        : result.findings.length === 0 && SUMMARY_CONCERN_RE.test(result.summary)
          ? result.summary
          : undefined;
    if (heldConcern && !insufficient)
      console.log(`[pr-review-bot] #${number}: clean-but-hedged summary — holding approval`);
    return { kind: "posted", url, findings: result.findings.length, heldConcern };
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
  findings: number,
  heldConcern?: string
): Promise<void> {
  const key = `${owner}/${repo}#${number}`;
  if (findings > 0) {
    await threadReply(client, replyTs, `👀 Automated review done — see comments: ${url}`);
    return; // leave :eyes:; approval waits for the author to address the comments
  }
  // Clean review (no inline comments) → approve + ✅. CI is THE only gate (user 2026-08-20).
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

/** :eyes: status on a message: is any present, and is one OURS (for stuck-claim recovery). */
async function eyesInfo(
  client: WebClient,
  ts: string,
  botUserId: string
): Promise<{ present: boolean; weOwn: boolean }> {
  const res = await client.reactions.get({ channel: config.slack.channelId, timestamp: ts });
  const eyes = (
    (res.message as { reactions?: Array<{ name: string; users?: string[] }> } | undefined)?.reactions ?? []
  ).find((r) => r.name === config.claimEmoji);
  return { present: !!eyes, weOwn: !!eyes && (eyes.users ?? []).includes(botUserId) };
}

/**
 * A PR-review request (PR URL + tags the required user). Ownership is the DURABLE record, not just
 * the :eyes: reaction:
 *   • already in our review record → done, skip.
 *   • another account's :eyes: (human / other bot) → yield, skip.
 *   • OUR :eyes: but NOT recorded → a STUCK claim (e.g. a review interrupted by a restart/crash) →
 *     recover it: review without re-claiming.
 *   • no :eyes: → debounce + claim + review.
 * The whole review is inflight-guarded so a concurrent sweep never double-reviews a mid-flight PR.
 * Leaves :eyes: on after posting; approval is a separate step (see maybeApprove / finalizeReview).
 */
export async function handleReviewRequest(
  client: WebClient,
  ts: string,
  text: string,
  botUserId: string
): Promise<void> {
  const pr = parsePrUrl(text);
  if (!pr || !tagsRequiredUser(text)) return; // not an eligible request
  const { owner, repo, number } = pr;
  const key = reviewState.prKey(owner, repo, number);

  if (reviewState.hasReviewed(key)) return; // durable record: already reviewed
  const cooling = failedCooldown.get(key);
  if (cooling && Date.now() - cooling < FAIL_COOLDOWN_MS) return; // recently failed → back off, no churn
  const eyes = await eyesInfo(client, ts, botUserId);
  // If another account already claimed it with :eyes: — a human OR another review bot (e.g. Alden's
  // Assistant) — YIELD. The user does not want us duplicating a PR another bot already reviewed.
  if (eyes.present && !eyes.weOwn) return;
  if (!eyes.present) {
    // Unclaimed → debounce (yield to a human/other bot reacting in the window), re-check, then claim.
    await sleep(config.claimDebounceMs);
    if ((await eyesInfo(client, ts, botUserId)).present) return; // claimed during the debounce
    await client.reactions.add({ channel: config.slack.channelId, timestamp: ts, name: config.claimEmoji });
  }
  // We own the claim now — fresh, or a recovered stuck one. Guard so a concurrent sweep that sees the
  // same un-recorded :eyes: doesn't double-review while this pass runs.
  if (!inflight.claim(key, "review")) return;
  try {
    const outcome = await produceReview(owner, repo, number);
    if (outcome.kind === "skipped") {
      // Post the skip note AT MOST ONCE per thread — never re-spam the same "Skipping —" reply if the
      // catch-up somehow re-processes this PR (belt-and-suspenders behind the handled-record above).
      if (!(await threadHasNote(client, ts, "Skipping —")))
        await threadReply(client, ts, `Skipping — ${outcome.reason}.`);
      return;
    }
    if (outcome.kind === "failed") {
      // Release :eyes: so a TRANSIENT failure can be retried by the next sweep. But guard the failure
      // REPLY so a PERSISTENT failure (e.g. claude -p auth down, as in the ActualChat #55 pileup) can't
      // re-post the same "⚠️ failed" message every 2-min sweep — post it AT MOST ONCE per thread.
      failedCooldown.set(key, Date.now()); // back off before the sweep retries this PR
      await client.reactions
        .remove({ channel: config.slack.channelId, timestamp: ts, name: config.claimEmoji })
        .catch(() => undefined);
      if (!(await threadHasNote(client, ts, "Automated review failed")))
        await threadReply(
          client,
          ts,
          `⚠️ Automated review failed after retries — will keep retrying. Re-post or re-tag to trigger again sooner. (${outcome.error.slice(0, 200)})`
        ).catch(() => undefined);
      console.warn(`[pr-review-bot] review failed for ${owner}/${repo}#${number}: ${outcome.error}`);
      return;
    }
    // Comments → "see comments" (wait for author). Clean → approve + ✅ (gated). See finalizeReview.
    await finalizeReview(client, ts, ts, owner, repo, number, outcome.url, outcome.findings, outcome.heldConcern);
  } finally {
    inflight.release(key);
  }
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

  // THOROUGHNESS GATE: never approve on a review that wasn't thorough enough — a security-sensitive
  // PR whose recorded review was only the shallow FAST pass, not the deep whole-repo one. The fix
  // could be perfectly addressed and CI green, but a shallow review may have MISSED a finding, so
  // "addressed" isn't enough — the review itself has to be thorough first. Hold and ask for a deep
  // re-review ("don't approve until the review is thorough"). One-time note, then hold silently.
  // THE ONLY TWO GATES (user 2026-08-20): CI green, and no reviewer explicitly blocking. On the
  // "addressed" signal we approve — no comment/reply checks, no thoroughness check, no duplicate
  // guard. Both hold SILENTLY (no chat noise) and re-check on the next reply/sweep.
  if (!(await gh.ciGreen(owner, repo, meta.headOid))) return;
  // Never approve over an EXPLICIT block: a human/bot reviewer marked CHANGES_REQUESTED.
  if (await gh.changesRequested(owner, repo, number)) return;

  // Duplicate guard — hold for a GENUINE competing duplicate: another OPEN PR for the SAME ticket,
  // or (when neither carries a ticket) one with a STRONG changed-file overlap. Sharing one incidental
  // file (router/index/config) is NOT competition. Note posted at most once, then holds silently.
  const myTicket = gh.ticketKey(meta.title, meta.headRefName);
  const myFiles = (await gh.changedFilePaths(owner, repo, number)).filter(gh.isCodeFile);
  const dupes =
    myTicket || myFiles.length ? await gh.competingOpenPrs(owner, repo, number, myTicket, myFiles) : [];
  if (dupes.length) {
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

  // UNANSWERED-FINDINGS gate (user 2026-08-20): don't approve while a GENUINE review finding — ours or
  // another reviewer's (baz/copilot/human) — sits with no reply and unresolved. That's how #159
  // self-approved 2 min after posting 2 findings. Works on thread ROOTS, so a follow-up like baz's
  // "Commit X addressed this comment…" is a REPLY and can never be mistaken for a finding; ack-style
  // roots are filtered too. A thread the PR author started is not a finding. Holds SILENTLY — no notes.
  const unanswered = (await gh.reviewThreads(owner, repo, number)).filter(
    (t) =>
      t.rootAuthor !== meta.authorLogin &&
      !isFollowUpComment(t.rootBody) &&
      !t.isResolved &&
      !t.hasReply
  );
  if (unanswered.length) {
    console.log(
      `[pr-review-bot] #${number}: holding approval — ${unanswered.length} review finding(s) unanswered (${[
        ...new Set(unanswered.map((t) => t.rootAuthor)),
      ].join(", ")})`
    );
    // Say WHY we're holding — silence left people guessing why "addressed" didn't approve. Posted at
    // most ONCE per thread (stable marker), with clean one-line titles, so it can never become spam.
    const MARK = "waiting on unresolved review comments";
    if (!(await threadHasNote(client, parentTs, MARK))) {
      const byAuthor = [...new Set(unanswered.map((t) => t.rootAuthor))].join(", ");
      const titles = unanswered
        .slice(0, 6)
        .map((t) => "• " + (cleanCommentLabel(t.rootBody) ?? "(comment)"))
        .join(`
`);
      const more = unanswered.length > 6 ? `
…and ` + (unanswered.length - 6) + " more." : "";
      await threadReply(
        client,
        parentTs,
        "Holding approval — " + MARK + " from " + byAuthor + " (" + unanswered.length +
          `). Reply to them or resolve the threads and I'll approve:
` + titles + more
      );
    }
    return;
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
 * Catch-up review sweep — review any eligible PR-request in recent channel history that isn't yet
 * claimed (no :eyes:). Socket Mode does NOT replay events missed while the host was asleep/off, so a
 * PR posted while the computer was off would otherwise never be seen and sit stale forever. Running
 * this on boot (and each interval) guarantees nothing is left unreviewed. handleReviewRequest itself
 * re-checks the :eyes: claim, so already-reviewed PRs are skipped fast (no re-review).
 */
export async function reviewCatchup(client: WebClient, botUserId: string): Promise<void> {
  const hist = await client.conversations.history({ channel: config.slack.channelId, limit: 30 });
  // Oldest-first so PRs are picked up in the order they were posted.
  for (const msg of (hist.messages ?? []).slice().reverse()) {
    const m = msg as { ts?: string; text?: string };
    if (!m.ts || !m.text) continue;
    if (!parsePrUrl(m.text) || !tagsRequiredUser(m.text)) continue; // not an eligible review request
    try {
      await handleReviewRequest(client, m.ts, m.text, botUserId); // skips if already :eyes:-claimed
    } catch (e) {
      console.warn(`[pr-review-bot] catch-up review error on ${m.ts}:`, e);
    }
  }
}

/**
 * Catch-up for @-MENTION commands missed while the socket was deaf/down — the #139 case. Socket Mode
 * doesn't replay events, so a `@Review Window review` posted while the bot was disconnected is lost.
 * Scans recent messages AND their thread replies for a mention of the bot that it hasn't acted on
 * (no bot :eyes: on the mention — handleMention acks with :eyes:) and re-dispatches the review/
 * approve/addressed commands. status/help are instant no-ops, so they're skipped (no re-flooding).
 */
export async function mentionCatchup(client: WebClient, botUserId: string): Promise<void> {
  type Msg = { ts?: string; text?: string; user?: string; reply_count?: number; reactions?: Array<{ name: string; users?: string[] }> };
  const botEyed = (m: Msg) =>
    (m.reactions ?? []).some((r) => r.name === config.claimEmoji && (r.users ?? []).includes(botUserId));
  const consider = async (m: Msg, threadTs: string | undefined) => {
    if (!m.ts || !m.text || m.user === botUserId) return;
    if (!mentions.mentionsBot(m.text, botUserId)) return; // not addressed to the bot
    if (botEyed(m)) return; // already handled (handleMention acked it with :eyes:)
    const cmd = mentions.parseMention(m.text).command;
    if (cmd !== "review" && cmd !== "re-review" && cmd !== "addressed" && cmd !== "approve") return;
    try {
      await handleMention(client, m.ts, threadTs, m.text, botUserId);
    } catch (e) {
      console.warn(`[pr-review-bot] mention catch-up error on ${m.ts}:`, e);
    }
  };
  const hist = await client.conversations.history({ channel: config.slack.channelId, limit: 20 });
  for (const msg of (hist.messages ?? []).slice().reverse()) {
    const m = msg as Msg;
    await consider(m, undefined); // a top-level mention of the bot (PR resolved from its text)
    if ((m.reply_count ?? 0) > 0 && m.ts) {
      const th = await client.conversations.replies({ channel: config.slack.channelId, ts: m.ts, limit: 50 });
      for (const r of (th.messages ?? []).slice(1)) await consider(r as Msg, m.ts); // thread mentions
    }
  }
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
      else await finalizeReview(client, threadTs ?? messageTs, replyThread, owner, repo, number, outcome.url, outcome.findings, outcome.heldConcern);
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
