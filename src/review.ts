import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { PrMeta } from "./github.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export type Severity = "High" | "Medium" | "Low";
export interface Finding {
  path: string;
  line: number; // line in the PR head (RIGHT side of the diff)
  severity: Severity;
  body: string; // the concrete finding + failure scenario / fix
}
export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

const SYSTEM = `You are an autonomous DevOps + security code reviewer. Review a GitHub PR diff across FIVE vectors, weighting security and architecture heavily:
1. Code base — syntax, clean-code, dead code, obvious optimizations.
2. Security — hardcoded secrets, overly-permissive access, injection/SSRF, missing validation, unbounded input, fail-open logic, unpinned deps.
3. Architecture — alignment with the codebase's established patterns; flag drift, not personal preference.
4. Tests — added/updated/accounted for? Untested new logic, deleted tests, tautological assertions. On a test-only PR, enumerate the target code's branches and flag any the added tests don't cover.
5. Spec matching — cross-reference the PR title/description against the actual diff; flag work described-but-not-done, done-but-not-described, or scope creep.

RELIABILITY GUARDRAIL — this is critical:
- Do NOT emit low-confidence or filler comments. For each finding ask "would this survive a skeptical senior engineer, and can I cite the concrete failure or violation?" Emit it ONLY if yes.
- Prefer FEWER, high-signal findings. If a suggested fix is uncertain, phrase it as a question. Never invent a line-anchored fix you can't stand behind.
- Zero findings is a valid, common result — return an empty findings array and say the PR is clean in the summary.
- Anchor each finding to a real line that EXISTS in the added/changed (RIGHT) side of the diff, using the file's line number at the PR head.

Return your result ONLY by calling the report_review tool.`;

const TOOL: Anthropic.Tool = {
  name: "report_review",
  description: "Report the review: a short overall summary and zero or more high-signal findings.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "1-3 sentence overall read + severity tally." },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "repo-relative file path from the diff" },
            line: { type: "integer", description: "line number in the PR head (RIGHT side)" },
            severity: { type: "string", enum: ["High", "Medium", "Low"] },
            body: {
              type: "string",
              description: "one concrete finding: the defect + a failure scenario or fix. Do NOT prefix severity; the poster adds it.",
            },
          },
          required: ["path", "line", "severity", "body"],
        },
      },
    },
    required: ["summary", "findings"],
  },
};

export async function reviewPr(pr: PrMeta, diff: string): Promise<ReviewResult> {
  const clipped = diff.length > config.maxDiffBytes ? diff.slice(0, config.maxDiffBytes) + "\n…[diff truncated]…" : diff;

  const msg = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "report_review" },
    messages: [
      {
        role: "user",
        content:
          `PR: ${pr.title}\n` +
          `Author: ${pr.authorLogin} · +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files · head ${pr.headOid}\n\n` +
          "Unified diff:\n```diff\n" +
          clipped +
          "\n```",
      },
    ],
  });

  const call = msg.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === "report_review"
  );
  if (!call) return { summary: "Review produced no structured output.", findings: [] };
  const input = call.input as { summary?: string; findings?: Finding[] };
  return {
    summary: input.summary ?? "",
    findings: (input.findings ?? []).filter(
      (f) => f && f.path && Number.isInteger(f.line) && f.severity && f.body
    ),
  };
}

/** Lightweight verify: does `fixCommitDiff` plausibly address the earlier findings? */
export async function verifyFix(findings: Finding[], fixDiff: string): Promise<boolean> {
  if (findings.length === 0) return true;
  const msg = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    system:
      "You verify whether a follow-up diff actually addresses prior review findings. Answer strictly by calling the tool. Be skeptical: only 'true' if each finding is genuinely handled by the diff, not merely touched.",
    tools: [
      {
        name: "verdict",
        description: "Report whether the findings are addressed by the diff.",
        input_schema: {
          type: "object",
          properties: { addressed: { type: "boolean" }, note: { type: "string" } },
          required: ["addressed"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "verdict" },
    messages: [
      {
        role: "user",
        content:
          "Prior findings:\n" +
          findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.path}:${f.line} — ${f.body}`).join("\n") +
          "\n\nFollow-up diff:\n```diff\n" +
          fixDiff.slice(0, config.maxDiffBytes) +
          "\n```",
      },
    ],
  });
  const call = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
  return Boolean((call?.input as { addressed?: boolean } | undefined)?.addressed);
}
