import type { Finding } from "./review.js";

// GUARD against fabricated diff statistics.
//
// The lenses are good at FINDING issues and unreliable at QUANTIFYING them. On PathwaysAI #116 a
// finding stated AGENTS.md was "−206/+111" when the real churn was +92/−187, and called three files
// "rewrites" that were +29/−1, +5/−5 and +0/−1. The substance was right; the numbers were invented.
// An author who checks the first number and finds it wrong stops reading — so a wrong statistic
// costs the whole comment, including the parts that were correct.
//
// This is a deterministic pass (no model call): every "+N/-M" style claim in a finding is checked
// against the PR's real per-file stats and REWRITTEN to the truth, or dropped when the file isn't
// in the PR at all. It never changes prose, only numbers it can verify.

export interface FileStat {
  additions: number;
  deletions: number;
}

// "+92/-187", "-206/+111", "−206/+111" (unicode minus), with optional spaces/parens around the pair.
const STAT_RE = /([+−-])\s*(\d+)\s*\/\s*([+−-])\s*(\d+)/g;
// A backticked path mentioned in the text, e.g. `apps/client/src/lib/mongo.ts`.
const PATH_RE = /`([\w./-]+\.[\w]+)`/g;

const isMinus = (sign: string): boolean => sign === "-" || sign === "−";

/** The file a statistic refers to: the last backticked path BEFORE it, else the finding's own path. */
function targetPath(body: string, statIndex: number, fallback: string): string {
  let best = fallback;
  for (const m of body.slice(0, statIndex).matchAll(PATH_RE)) best = m[1];
  return best;
}

/**
 * Rewrite every diff statistic in each finding to the PR's real numbers. Returns the corrected
 * findings plus a log of what changed, so a wrong claim is visible rather than silently patched.
 */
export function correctDiffStats(
  findings: Finding[],
  stats: Map<string, FileStat>
): { findings: Finding[]; corrections: string[] } {
  const corrections: string[] = [];
  const out = findings.map((f) => {
    const body = f.body.replace(STAT_RE, (whole, s1: string, n1: string, s2: string, n2: string, idx: number) => {
      const path = targetPath(f.body, idx, f.path);
      const real = stats.get(path);
      if (!real) return whole; // unknown file — leave the prose alone rather than guess
      // The claim may be written additions-first or deletions-first; compare against both readings.
      const claimedAdd = isMinus(s1) ? Number(n2) : Number(n1);
      const claimedDel = isMinus(s1) ? Number(n1) : Number(n2);
      if (claimedAdd === real.additions && claimedDel === real.deletions) return whole; // accurate
      corrections.push(
        `${path}: claimed +${claimedAdd}/-${claimedDel}, actual +${real.additions}/-${real.deletions}`
      );
      return `+${real.additions}/-${real.deletions}`;
    });
    return body === f.body ? f : { ...f, body };
  });
  return { findings: out, corrections };
}
