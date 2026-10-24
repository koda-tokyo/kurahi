// Per-pair rate limit for `sibling.send` (in memory, sliding one-minute window).

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 30; // per pair per window

type RateLimitEntry = {
  timestamps: number[];
};

const rateLimitMap = new Map<string, RateLimitEntry>();

function getRateLimitKey(from: string, to: string): string {
  const a = from.toLowerCase();
  const b = to.toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function checkSiblingRateLimit(
  from: string,
  to: string,
): { ok: boolean; retryAfterMs?: number } {
  const key = getRateLimitKey(from, to);
  const now = Date.now();
  let entry = rateLimitMap.get(key);

  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(key, entry);
  }

  // Prune old timestamps
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);

  if (entry.timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfter = RATE_LIMIT_WINDOW_MS - (now - oldestInWindow);
    return { ok: false, retryAfterMs: Math.max(retryAfter, 1000) };
  }

  entry.timestamps.push(now);
  return { ok: true };
}

// Clean up rate limit entries periodically (every 5 minutes). unref: this module is imported
// transitively by CLI subcommands, and a referenced interval would keep every `kolo` process
// alive after its command finished (seen as a hang in `kurahi completion --install`).
const rateLimitPrune = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
      if (entry.timestamps.length === 0) {
        rateLimitMap.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);
rateLimitPrune.unref?.();

export function resetSiblingRateLimits(): void {
  rateLimitMap.clear();
}
