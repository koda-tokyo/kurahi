// Business connectors: one HTTP path for every provider call.
//
// - client-side rate limit (sliding window per connector)
// - retries with exponential backoff and jitter on 429/5xx and network errors; a `Retry-After`
//   header (seconds or HTTP date) is honoured, and one longer than `maxRetryAfterMs` is not
//   waited out (the call fails with `rate_limited` instead of blocking a turn for minutes)
// - non-GET requests are retried only on 429 (the provider did not process them)
// - response bodies are read with a byte cap
// Every wait is bounded: retries, delays and the overall deadline all have limits.
import { ConnectorError, codeForHttpStatus } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Milliseconds to wait from a Retry-After header, or undefined when absent or unparseable. */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number,
): number | undefined {
  if (!header) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - now);
}

/** Sliding-window limiter: at most `max` acquisitions per `windowMs`. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  async acquire(): Promise<void> {
    // Bounded: each pass either records a slot or waits for the oldest one to expire.
    for (let pass = 0; pass < 1000; pass++) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(Math.max(1, this.windowMs - (t - this.stamps[0])));
    }
    throw new ConnectorError("rate_limited", "client-side rate limiter did not free a slot");
  }
}

export type RetryOptions = {
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
  limiter?: RateLimiter;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A Retry-After longer than this fails fast with `rate_limited`. Default 60 s. */
  maxRetryAfterMs?: number;
  /** Per-attempt timeout. Default 20 s. */
  timeoutMs?: number;
  /** Jitter source in [0,1). Tests pass a constant. */
  random?: () => number;
};

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export type AttemptLog = { attempt: number; status?: number; waitMs: number };

/**
 * fetch with rate limit, retry and backoff. Resolves with the final Response for any status
 * that is not retried (callers turn non-2xx into errors with `ensureOk`). Rejects with a
 * ConnectorError when retries are exhausted.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
  log?: AttemptLog[],
): Promise<Response> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const maxRetries = Math.min(Math.max(opts.maxRetries ?? 3, 0), 8);
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const maxRetryAfter = opts.maxRetryAfterMs ?? 60_000;
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";

  for (let attempt = 0; ; attempt++) {
    await opts.limiter?.acquire();
    let res: Response | undefined;
    let networkError: unknown;
    try {
      res = await doFetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      networkError = err;
    }
    const status = res?.status;
    const retryable = res
      ? RETRY_STATUS.has(res.status) && (idempotent || res.status === 429)
      : idempotent;
    if (!retryable || attempt >= maxRetries) {
      log?.push({ attempt, status, waitMs: 0 });
      if (res) {
        return res;
      }
      const name = networkError instanceof Error ? networkError.name : "";
      throw new ConnectorError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
        "the service could not be reached",
      );
    }
    const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt);
    let waitMs = Math.round(backoff / 2 + (backoff / 2) * random());
    const retryAfter = parseRetryAfter(res?.headers.get("retry-after"), now());
    if (retryAfter !== undefined) {
      if (retryAfter > maxRetryAfter) {
        log?.push({ attempt, status, waitMs: 0 });
        await res?.body?.cancel().catch(() => {});
        throw new ConnectorError("rate_limited", "the service asked to wait too long", status);
      }
      waitMs = Math.max(waitMs, retryAfter);
    }
    log?.push({ attempt, status, waitMs });
    await res?.body?.cancel().catch(() => {});
    await sleep(waitMs);
  }
}

/** Read a body up to `maxBytes`; larger bodies fail with `too_large` and are not buffered. */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ConnectorError("too_large", "response exceeds the size limit");
  }
  if (!res.body) {
    return Buffer.alloc(0);
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError("too_large", "response exceeds the size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export const DEFAULT_JSON_LIMIT = 4 * 1024 * 1024;

export async function readJson<T>(res: Response, maxBytes = DEFAULT_JSON_LIMIT): Promise<T> {
  const buf = await readCapped(res, maxBytes);
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new ConnectorError("invalid_response", "the service returned malformed JSON");
  }
}

/** Provider error code from a Graph / OAuth / Google error body, when it has one. */
export function providerErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string") {
    return b.error;
  }
  if (b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    if (typeof e.code === "string") {
      return e.code;
    }
    if (typeof e.status === "string") {
      return e.status;
    }
  }
  return undefined;
}

/** Throw a ConnectorError for a non-2xx response; the body is read (capped) only for its code. */
export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) {
    return res;
  }
  let code: string | undefined;
  try {
    code = providerErrorCode(await readJson<unknown>(res, 64 * 1024));
  } catch {
    code = undefined;
  }
  throw new ConnectorError(
    codeForHttpStatus(res.status, code),
    `the service answered ${res.status}`,
    res.status,
  );
}
