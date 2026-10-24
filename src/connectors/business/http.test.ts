import { describe, expect, it } from "vitest";
import {
  type AttemptLog,
  ensureOk,
  parseRetryAfter,
  RateLimiter,
  readCapped,
  requestWithRetry,
} from "./http.js";
import { jsonResponse, mockFetch, on, queue } from "./test-helpers.js";

const URL_A = "https://graph.microsoft.com/v1.0/me";

function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe("Retry-After", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(
      parseRetryAfter("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")),
    ).toBe(10_000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it("waits at least Retry-After on 429, then succeeds", async () => {
    const c = clock();
    const fetch = mockFetch([
      on(
        "GET",
        URL_A,
        queue(
          () => jsonResponse({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "12" }),
          () => jsonResponse({ id: "1" }),
        ),
      ),
    ]);
    const log: AttemptLog[] = [];
    const res = await requestWithRetry(URL_A, {}, { fetch, ...c, random: () => 0 }, log);
    expect(res.status).toBe(200);
    expect(c.waits).toEqual([12_000]);
    expect(log.map((l) => l.status)).toEqual([429, 200]);
  });

  it("fails fast with rate_limited when Retry-After exceeds the cap", async () => {
    const c = clock();
    const fetch = mockFetch([
      on("GET", URL_A, () => jsonResponse({}, 429, { "retry-after": "3600" })),
    ]);
    await expect(requestWithRetry(URL_A, {}, { fetch, ...c })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(c.waits).toEqual([]);
  });
});

describe("backoff", () => {
  it("backs off exponentially on 503 and gives up after maxRetries", async () => {
    const c = clock();
    const fetch = mockFetch([on("GET", URL_A, () => jsonResponse({}, 503))]);
    const res = await requestWithRetry(
      URL_A,
      {},
      { fetch, ...c, random: () => 1, maxRetries: 3, baseDelayMs: 100 },
    );
    expect(res.status).toBe(503);
    expect(fetch.calls).toHaveLength(4);
    expect(c.waits).toEqual([100, 200, 400]);
  });

  it("does not retry a POST on 500 (the provider may have processed it), but does on 429", async () => {
    const c = clock();
    const f500 = mockFetch([on("POST", URL_A, () => jsonResponse({}, 500))]);
    expect((await requestWithRetry(URL_A, { method: "POST" }, { fetch: f500, ...c })).status).toBe(
      500,
    );
    expect(f500.calls).toHaveLength(1);
    const f429 = mockFetch([
      on(
        "POST",
        URL_A,
        queue(
          () => jsonResponse({}, 429, { "retry-after": "1" }),
          () => jsonResponse({}, 202),
        ),
      ),
    ]);
    expect((await requestWithRetry(URL_A, { method: "POST" }, { fetch: f429, ...c })).status).toBe(
      202,
    );
  });

  it("retries network errors on GET and maps exhaustion to network", async () => {
    const c = clock();
    let n = 0;
    const fetch = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    await expect(requestWithRetry(URL_A, {}, { fetch, ...c, maxRetries: 2 })).rejects.toMatchObject(
      {
        code: "network",
      },
    );
    expect(n).toBe(3);
  });
});

describe("bodies and errors", () => {
  it("caps bodies by content-length and by streamed size", async () => {
    await expect(
      readCapped(new Response("x".repeat(10), { headers: { "content-length": "10" } }), 5),
    ).rejects.toMatchObject({ code: "too_large" });
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("abc"));
        ctrl.enqueue(new TextEncoder().encode("defgh"));
        ctrl.close();
      },
    });
    await expect(readCapped(new Response(stream), 5)).rejects.toMatchObject({ code: "too_large" });
    expect((await readCapped(new Response("abc"), 5)).toString()).toBe("abc");
  });

  it("turns error bodies into codes without their text", async () => {
    const err = await ensureOk(
      jsonResponse(
        { error: { code: "ErrorAccessDenied", message: "user@contoso.com secret" } },
        403,
      ),
    ).catch((e: unknown) => e as Error & { code: string });
    expect(err.code).toBe("forbidden");
    expect(err.message).not.toContain("contoso");
    const consent = await ensureOk(jsonResponse({ error: "consent_required" }, 400)).catch(
      (e: unknown) => e as { code: string },
    );
    expect(consent.code).toBe("consent_required");
  });
});

describe("rate limiter", () => {
  it("admits max per window and waits for the oldest slot", async () => {
    const c = clock();
    const limiter = new RateLimiter(2, 1000, c.now, c.sleep);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(c.waits).toEqual([1000]);
  });
});
