// In-process guard so one PR is never worked by two passes at once (Alden's core/inflight).
// The live-event mention handler and the reconcile/review paths can otherwise both spawn a
// `claude -p` for the same PR — wasted tokens + a duplicate GitHub review. A plain in-memory Map;
// the whole service is one Node process, so this is shared state. `claim` returns false when the
// key is already in flight. Each claim carries a label (the verb) so `status` can report live work.

const inFlight = new Map<string, string>(); // key "owner/repo#n" -> label (verb holding the claim)

/** Try to claim `key`. Returns true if this caller now owns it (nothing else was working it),
 *  false if a pass is already in flight. Release with `release(key)` only if you got true. */
export function claim(key: string, label = "review"): boolean {
  if (inFlight.has(key)) return false;
  inFlight.set(key, label);
  return true;
}

/** Release a claim. Safe to call unconditionally; a no-op if not held. */
export function release(key: string): void {
  inFlight.delete(key);
}

/** True if a pass is currently in flight for `key` (advisory peek — `claim` is authoritative). */
export function isActive(key: string): boolean {
  return inFlight.has(key);
}

/** Snapshot of in-flight work as {key: label} — the live view the `status` command reports. */
export function snapshot(): Record<string, string> {
  return Object.fromEntries(inFlight);
}

/** Run `fn` while holding the claim; if the key is already in flight, `fn` is not run and the
 *  result is `busy`. Always releases on completion. */
export async function withClaim<T>(
  key: string,
  label: string,
  fn: () => Promise<T>
): Promise<{ owned: true; value: T } | { owned: false }> {
  if (!claim(key, label)) return { owned: false };
  try {
    return { owned: true, value: await fn() };
  } finally {
    release(key);
  }
}
