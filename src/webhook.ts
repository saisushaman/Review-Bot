import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";

// Event-driven CI. GitHub has no outbound Socket-Mode equivalent, so this is an INBOUND webhook
// receiver: GitHub POSTs check_suite/workflow_run/status events to a public HTTPS endpoint, and we
// approve the moment CI reports green instead of waiting for the 2-min poll. Entirely optional and
// non-breaking: the server only starts when GITHUB_WEBHOOK_SECRET is set. The 2-min reconcile sweep
// remains as the fallback, so a missed/misconfigured webhook never drops an approval.

export type CiEvent = {
  owner: string;
  repo: string;
  prNumbers: number[]; // PR numbers carried by check_suite/workflow_run; empty for bare `status`
  headSha?: string;
};

/** Map a raw GitHub webhook to a normalized CI-completed event, or null if it isn't one we act on. */
export function extractCiEvent(event: string, p: unknown): CiEvent | null {
  const payload = p as {
    action?: string;
    repository?: { full_name?: string };
    check_suite?: { head_sha?: string; conclusion?: string; pull_requests?: Array<{ number: number }> };
    workflow_run?: { head_sha?: string; conclusion?: string; pull_requests?: Array<{ number: number }> };
    state?: string;
    sha?: string;
  };
  const full = payload.repository?.full_name?.split("/");
  if (!full || full.length !== 2) return null;
  const [owner, repo] = full;

  // Only terminal CI signals — mirror the poll's ciGreen() (which re-checks everything anyway, so a
  // false trigger is harmless: it just runs the same gated approve check the poll would have run).
  if (event === "check_suite" && payload.action === "completed") {
    return { owner, repo, headSha: payload.check_suite?.head_sha,
      prNumbers: (payload.check_suite?.pull_requests ?? []).map((x) => x.number) };
  }
  if (event === "workflow_run" && payload.action === "completed") {
    return { owner, repo, headSha: payload.workflow_run?.head_sha,
      prNumbers: (payload.workflow_run?.pull_requests ?? []).map((x) => x.number) };
  }
  if (event === "status") {
    // Legacy commit statuses carry only a SHA, no PR numbers. Act only on terminal states.
    if (payload.state === "success" || payload.state === "failure" || payload.state === "error") {
      return { owner, repo, headSha: payload.sha, prNumbers: [] };
    }
  }
  return null;
}

/** Constant-time verification of GitHub's X-Hub-Signature-256 (HMAC-SHA256 of the raw body). */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Start the webhook server if configured. No-op (returns false) when GITHUB_WEBHOOK_SECRET is unset,
 * so the default deployment is unchanged. `onCiComplete` gets each verified CI event.
 */
export function startGithubWebhookServer(onCiComplete: (e: CiEvent) => Promise<void>): boolean {
  const secret = config.githubWebhookSecret;
  if (!secret) return false; // disabled — default, non-breaking

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== config.githubWebhookPath) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5_000_000) req.destroy(); // cap payloads (GitHub's are well under this)
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, secret)) {
        res.writeHead(401).end("bad signature");
        return;
      }
      res.writeHead(204).end(); // ack immediately; process async
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      const ci = extractCiEvent(req.headers["x-github-event"] as string, payload);
      if (ci) {
        onCiComplete(ci).catch((e) =>
          console.error("[pr-review-bot] webhook approve error:", e)
        );
      }
    });
  });

  server.on("error", (e) => console.error("[pr-review-bot] webhook server error:", e));
  server.listen(config.githubWebhookPort, () => {
    console.log(
      `[pr-review-bot] github webhook listening on :${config.githubWebhookPort}${config.githubWebhookPath} — approves on CI-green (poll still runs as fallback)`
    );
  });
  return true;
}
