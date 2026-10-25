import { describe, expect, it, vi } from "vitest";
import {
  createIbmIamTokenCache,
  exchangeIbmIamToken,
  IBM_IAM_TOKEN_URL,
  IbmIamError,
} from "./ibm-iam.js";

// Recorded shape of an IAM token answer (fields per the IAM token API; values are fake).
const iamAnswer = (token: string, expiresIn = 3600, now = 1_700_000_000) => ({
  access_token: token,
  refresh_token: "not_supported",
  token_type: "Bearer",
  expires_in: expiresIn,
  expiration: now + expiresIn,
  scope: "ibm openid",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("IBM IAM token exchange", () => {
  it("posts the apikey grant as a form and reads access_token and expiration", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(iamAnswer("tok-1")),
    );
    const result = await exchangeIbmIamToken({
      apiKey: "key-abc",
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    });
    expect(result).toEqual({ token: "tok-1", expiresAt: (1_700_000_000 + 3600) * 1000 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(IBM_IAM_TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init?.body as string).toBe(
      "grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=key-abc",
    );
  });

  it("reports a refused key without the key in the message", async () => {
    const fetchFn = async () => json({ errorCode: "BXNIM0415E" }, 400);
    const err = await exchangeIbmIamToken({
      apiKey: "secret-key-value",
      fetchFn: fetchFn as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IbmIamError);
    expect((err as IbmIamError).status).toBe(400);
    expect(String(err)).not.toContain("secret-key-value");
  });

  it("refuses a non-https token URL and an answer without a token", async () => {
    await expect(
      exchangeIbmIamToken({ apiKey: "k", tokenUrl: "http://iam.example.com/token" }),
    ).rejects.toThrow(/https/);
    const fetchFn = async () => json({ token_type: "Bearer" });
    await expect(
      exchangeIbmIamToken({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/access_token/);
  });

  it("caches per key, shares one exchange, and refreshes five minutes before expiry", async () => {
    let now = 1_700_000_000_000;
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return json({ access_token: `tok-${n}`, expires_in: 3600 });
    });
    const cache = createIbmIamTokenCache({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });
    const [a, b] = await Promise.all([cache.get("key-1"), cache.get("key-1")]);
    expect([a, b]).toEqual(["tok-1", "tok-1"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 50 * 60_000;
    expect(await cache.get("key-1")).toBe("tok-1");
    now += 6 * 60_000;
    expect(await cache.get("key-1")).toBe("tok-2");
    expect(await cache.get("key-2")).toBe("tok-3");
    cache.invalidate("key-2");
    expect(await cache.get("key-2")).toBe("tok-4");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});
