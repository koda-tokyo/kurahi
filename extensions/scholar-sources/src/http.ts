// One HTTP path for every provider call: the provider's limiter (shared by the whole process),
// retries with backoff on 429/5xx (Retry-After honoured, bounded), a byte cap on every body and a
// descriptive User-Agent. Nothing here sends credentials: every provider is used keyless.
import {
  ConnectorError,
  type FetchLike,
  RateLimiter,
  readCapped,
  requestWithRetry,
  type Sleep,
} from "../../../src/connectors/business/index.js";
import { RATE, type ScholarSettings, type SourceId, userAgent } from "./config.js";

export type Provider = SourceId | "doi";
export type Limiters = Record<Provider, RateLimiter>;

export type HttpDeps = {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: Sleep;
  random?: () => number;
};

export function createLimiters(now?: () => number, sleep?: Sleep): Limiters {
  const make = (p: Provider) => new RateLimiter(RATE[p].max, RATE[p].windowMs, now, sleep);
  return {
    arxiv: make("arxiv"),
    openalex: make("openalex"),
    crossref: make("crossref"),
    pubmed: make("pubmed"),
    doi: make("doi"),
  };
}

let shared: Limiters | null = null;
/** The process-wide limiters: every session and every routine share one budget per provider. */
export function sharedLimiters(): Limiters {
  shared ??= createLimiters();
  return shared;
}

export type HttpResponse = { status: number; text: string; contentType: string };

export const MAX_JSON_BYTES = 4 * 1024 * 1024;

export class ScholarHttp {
  constructor(
    readonly settings: ScholarSettings,
    private readonly limiters: Limiters,
    private readonly deps: HttpDeps = {},
  ) {}

  /** GET `url`; 2xx and 404 come back (404 = not found), anything else throws a ConnectorError. */
  async get(
    provider: Provider,
    url: string,
    accept: string,
    maxBytes = MAX_JSON_BYTES,
  ): Promise<HttpResponse> {
    const res = await requestWithRetry(
      url,
      { method: "GET", headers: { accept, "user-agent": userAgent(this.settings) } },
      {
        fetch: this.deps.fetch,
        sleep: this.deps.sleep,
        now: this.deps.now,
        random: this.deps.random,
        limiter: this.limiters[provider],
        maxRetries: 2,
        baseDelayMs: provider === "arxiv" ? 3_000 : 1_000,
        maxRetryAfterMs: 30_000,
        timeoutMs: this.settings.timeoutMs,
      },
    );
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return { status: 404, text: "", contentType: "" };
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      throw new ConnectorError(
        "rate_limited",
        `${provider} rate limit`,
        429,
        `${provider} asked us to slow down; try again later`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ConnectorError(
        res.status >= 500 ? "provider_unavailable" : "bad_request",
        `${provider} answered ${res.status}`,
        res.status,
      );
    }
    const buf = await readCapped(res, maxBytes);
    return {
      status: res.status,
      text: buf.toString("utf8"),
      contentType: res.headers.get("content-type") ?? "",
    };
  }

  async json<T>(provider: Provider, url: string, accept = "application/json"): Promise<T | null> {
    const res = await this.get(provider, url, accept);
    if (res.status === 404) {
      return null;
    }
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new ConnectorError("invalid_response", `${provider} returned malformed JSON`);
    }
  }
}
