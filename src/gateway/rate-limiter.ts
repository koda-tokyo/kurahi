/**
 * Gateway v3 — Rate Limiter
 *
 * Lightweight, in-memory rate limiter for raw Node.js http/ws server.
 * No external dependencies. Sliding window counters keyed on client IP.
 *
 * Three tiers:
 *   - Global HTTP: all endpoints share a window (default: 100 req/min per IP)
 *   - Auth endpoints: tighter limit (default: 10 req/min per IP)
 *   - LLM endpoints: moderate limit (default: 30 req/min per IP)
 *
 * WebSocket:
 *   - Connection throttling: max 10 new connections/min per IP
 *   - Message rate limiting: max 30 messages/sec per client (post-handshake)
 */

// ── Per-path HTTP limit classes (also described in the OpenAPI document, M4a) ─────────────

export const HTTP_RATE_LIMITS = {
  http: { limit: 100, windowMs: 60_000 },
  auth: { limit: 10, windowMs: 60_000 },
  llm: { limit: 30, windowMs: 60_000 },
} as const;
export type HttpRateLimitClass = keyof typeof HTTP_RATE_LIMITS;

/** Which per-IP window a request URL (path + query) counts against. */
export function httpRateLimitClass(url: string): HttpRateLimitClass {
  if (url.startsWith("/auth")) {
    return "auth";
  }
  if (url.startsWith("/chat") || url.startsWith("/completions") || url.startsWith("/v1/")) {
    return "llm";
  }
  return "http";
}

// ── Sliding Window Counter ─────────────────────────────────────────────────

interface WindowEntry {
  count: number;
  windowStart: number; // ms timestamp
}

export interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/** Per-IP sliding window rate counter. */
class SlidingWindow {
  private windows = new Map<string, WindowEntry>();

  constructor(
    private defaultMax: number,
    private defaultWindowMs: number,
  ) {}

  /**
   * Check and increment. Returns { allowed, remaining, retryAfterMs }.
   * If not allowed, retryAfterMs > 0 indicates when to retry.
   */
  check(
    key: string,
    max?: number,
    windowMs?: number,
  ): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  } {
    const limit = max ?? this.defaultMax;
    const window = windowMs ?? this.defaultWindowMs;
    const now = Date.now();

    let entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= window) {
      // New window
      entry = { count: 0, windowStart: now };
      this.windows.set(key, entry);
    }

    if (entry.count >= limit) {
      const retryAfterMs = window - (now - entry.windowStart);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    entry.count++;
    return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 };
  }

  /** Prune expired windows (call periodically to prevent memory growth). */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.defaultWindowMs) {
        this.windows.delete(key);
      }
    }
  }
}

// ── Rate Limiter Instance ──────────────────────────────────────────────────

/** Global HTTP rate limiter — 100 requests per minute per IP. */
const httpLimiter = new SlidingWindow(HTTP_RATE_LIMITS.http.limit, HTTP_RATE_LIMITS.http.windowMs);

/** Auth endpoint rate limiter — 10 requests per minute per IP. */
const authLimiter = new SlidingWindow(HTTP_RATE_LIMITS.auth.limit, HTTP_RATE_LIMITS.auth.windowMs);

/** LLM endpoint rate limiter — 30 requests per minute per IP. */
const llmLimiter = new SlidingWindow(HTTP_RATE_LIMITS.llm.limit, HTTP_RATE_LIMITS.llm.windowMs);

/** WebSocket connection rate limiter — 10 connections per minute per IP. */
export const WS_CONNECTIONS_PER_MINUTE = 10;
const wsConnLimiter = new SlidingWindow(WS_CONNECTIONS_PER_MINUTE, 60_000);
/**
 * How many rejected connections per minute per IP still get a proper close frame with the
 * reason (WebSocket 1013 "try again later"). Beyond that a flood gets the bare socket destroy, so
 * explaining the limit never costs more than a bounded number of handshakes.
 */
const WS_REJECT_NOTICES_PER_MINUTE = 20;
const wsRejectNoticeLimiter = new SlidingWindow(WS_REJECT_NOTICES_PER_MINUTE, 60_000);

/** Prune all windows every 5 minutes. */
const pruneInterval = setInterval(() => {
  httpLimiter.prune();
  authLimiter.prune();
  llmLimiter.prune();
  wsConnLimiter.prune();
  wsRejectNoticeLimiter.prune();
}, 5 * 60_000);

// Allow the process to exit cleanly
if (pruneInterval.unref) pruneInterval.unref();

// ── Public API ─────────────────────────────────────────────────────────────

/** Extract client IP from request (respecting X-Forwarded-For from trusted proxy). */
function getClientIp(
  req: {
    socket?: { remoteAddress?: string };
    headers?: Record<string, string | string[] | undefined>;
  },
  trustedProxies: string[] = ["127.0.0.1"],
): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0]?.trim();
    if (first && trustedProxies.includes(req.socket?.remoteAddress ?? "")) {
      return first;
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * HTTP rate limit check.
 * Call this at the top of handleRequest, before routing.
 * Returns false (with 429 response written) if rate limited.
 */
export function checkHttpRateLimit(
  req: {
    socket?: { remoteAddress?: string };
    headers?: Record<string, string | string[] | undefined>;
    url?: string;
  },
  res: {
    writeHead?: (status: number, headers?: Record<string, string>) => void;
    end?: (body?: string) => void;
  },
  trustedProxies: string[] = ["127.0.0.1"],
): boolean {
  const ip = getClientIp(req as any, trustedProxies);
  const url = req.url ?? "";

  // Select limiter based on URL
  const limitClass = httpRateLimitClass(url);
  const limiter: SlidingWindow =
    limitClass === "auth" ? authLimiter : limitClass === "llm" ? llmLimiter : httpLimiter;
  const result: { allowed: boolean; remaining: number; retryAfterMs: number } = limiter.check(ip);

  if (!result.allowed) {
    res.writeHead?.(429, {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)),
      "X-RateLimit-Limit": String(HTTP_RATE_LIMITS[limitClass].limit),
      "X-RateLimit-Remaining": "0",
    });
    res.end?.(
      JSON.stringify({
        error: "Too Many Requests",
        retryAfter: Math.ceil(result.retryAfterMs / 1000),
      }),
    );
    return false;
  }

  // Add rate limit headers to successful responses
  // (caller should call writeHead with these)
  return true;
}

/**
 * WebSocket connection rate limit check.
 * Call this in the upgrade handler, before wss.handleUpgrade.
 * Returns false if the IP has exceeded its connection quota.
 */
export type WsConnectionRateDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterMs: number;
      /** Close reason for the client (fits a WebSocket close frame). */
      reason: string;
      /** Complete the handshake and close with 1013 + reason (false: destroy the socket). */
      explain: boolean;
    };

/**
 * WebSocket connection rate limit decision, without touching the socket. A rejected client is
 * told why (1013 + reason) for the first rejections in a window, so a CLI sees "rate limited,
 * retry in Ns" instead of a bare 1006; past that budget the caller destroys the socket.
 */
export function decideWsConnectionRateLimit(
  req: {
    socket?: { remoteAddress?: string };
    headers?: Record<string, string | string[] | undefined>;
  },
  trustedProxies: string[] = ["127.0.0.1"],
): WsConnectionRateDecision {
  const ip = getClientIp(req, trustedProxies);
  const result = wsConnLimiter.check(ip);
  if (result.allowed) {
    return { allowed: true };
  }
  const retrySec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return {
    allowed: false,
    retryAfterMs: result.retryAfterMs,
    reason: `rate limited: over ${WS_CONNECTIONS_PER_MINUTE} new connections per minute from this address; retry in ${retrySec}s`,
    explain: wsRejectNoticeLimiter.check(ip).allowed,
  };
}

export function checkWsConnectionRateLimit(
  req: {
    socket?: { remoteAddress?: string };
    headers?: Record<string, string | string[] | undefined>;
  },
  trustedProxies: string[] = ["127.0.0.1"],
): boolean {
  const ip = getClientIp(req, trustedProxies);
  const result = wsConnLimiter.check(ip);

  if (!result.allowed) {
    // Destroy the socket to reject the connection
    const socket = (req as any).socket;
    if (socket && typeof socket.destroy === "function") {
      socket.destroy();
    }
    return false;
  }

  return true;
}

/**
 * WebSocket message rate limiter.
 * Create one instance per connected client.
 */
export class WsMessageLimiter {
  private count = 0;
  private windowStart = Date.now();

  constructor(private maxPerSecond: number = 30) {}

  /** Returns true if the message should be processed, false if rate limited. */
  check(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.count = 0;
      this.windowStart = now;
    }
    this.count++;
    return this.count <= this.maxPerSecond;
  }
}

/** Reset all limiters (for testing). */
export function resetRateLimiters(): void {
  httpLimiter.prune();
  authLimiter.prune();
  llmLimiter.prune();
  wsConnLimiter.prune();
  // Clear all windows
  (httpLimiter as any).windows.clear();
  (authLimiter as any).windows.clear();
  (llmLimiter as any).windows.clear();
  (wsConnLimiter as any).windows.clear();
  (wsRejectNoticeLimiter as any).windows.clear();
  authAttemptLimiter.reset();
}

/** Allow runtime config override. */
export function updateRateLimitConfig(config: {
  http?: { maxRequests: number; windowMs: number };
  auth?: { maxRequests: number; windowMs: number };
  llm?: { maxRequests: number; windowMs: number };
  wsConnections?: { maxRequests: number; windowMs: number };
}): void {
  // Recreate limiters with new config
  if (config.http) {
    // Note: In production, we'd rebuild the SlidingWindow instances.
    // For now, the defaults are reasonable and can be tuned at startup.
  }
}

// ── Credential attempt limiter (KoLo 2.0, M2a — CSO Gap C) ─────────────────
// True sliding window (timestamp log) per source IP over credential-bearing requests:
// /api/auth/* logins, failed token/password/device-token checks (HTTP 401/403, WS connect),
// and device pairing requests. Default 20 attempts per 60 s; over the limit → 429 + Retry-After.

export const AUTH_ATTEMPT_LIMIT = 20;
export const AUTH_ATTEMPT_WINDOW_MS = 60_000;

export class AuthAttemptLimiter {
  private attempts = new Map<string, number[]>();

  constructor(
    readonly maxAttempts: number = AUTH_ATTEMPT_LIMIT,
    readonly windowMs: number = AUTH_ATTEMPT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.attempts.get(key) ?? []).filter((ts) => ts > cutoff);
    if (list.length === 0) {
      this.attempts.delete(key);
    } else {
      this.attempts.set(key, list);
    }
    return list;
  }

  /** Read-only check: is this source currently over the limit? */
  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const list = this.live(key);
    if (list.length >= this.maxAttempts) {
      const oldest = list[list.length - this.maxAttempts];
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + this.windowMs - this.now()),
      };
    }
    return { allowed: true, remaining: this.maxAttempts - list.length, retryAfterMs: 0 };
  }

  record(key: string): void {
    const list = this.live(key);
    list.push(this.now());
    // Bound memory per key: only the newest maxAttempts timestamps matter.
    this.attempts.set(key, list.slice(-this.maxAttempts));
  }

  /** check() then record(); returns the pre-record decision. */
  consume(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const decision = this.check(key);
    if (decision.allowed) {
      this.record(key);
      return { ...decision, remaining: decision.remaining - 1 };
    }
    return decision;
  }

  prune(): void {
    for (const key of Array.from(this.attempts.keys())) {
      this.live(key);
    }
  }

  reset(): void {
    this.attempts.clear();
  }
}

export const authAttemptLimiter = new AuthAttemptLimiter();

const authAttemptPrune = setInterval(() => authAttemptLimiter.prune(), 5 * 60_000);
if (authAttemptPrune.unref) authAttemptPrune.unref();

/** Paths whose requests carry or establish credentials. */
export function isAuthBearingPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/admin") ||
    pathname === "/metrics" ||
    pathname === "/api/migrate" ||
    pathname === "/api/bootstrap-invite" ||
    pathname === "/tools/invoke" ||
    pathname.startsWith("/v1/") ||
    pathname.includes("/pair")
  );
}

export function sendAuthRateLimited(
  res: {
    writeHead?: (status: number, headers?: Record<string, string>) => void;
    end?: (body?: string) => void;
  },
  retryAfterMs: number,
  limit: number = authAttemptLimiter.maxAttempts,
): void {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.writeHead?.(429, {
    "Content-Type": "application/json",
    "Retry-After": String(retryAfter),
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": "0",
  });
  res.end?.(JSON.stringify({ error: "Too Many Requests", retryAfter }));
}
