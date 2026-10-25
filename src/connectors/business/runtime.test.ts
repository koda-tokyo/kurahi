import { describe, expect, it } from "vitest";
import { ConnectorRuntime, staticTokenCredential } from "./runtime.js";
import { sanitizeScopeNames } from "./scopes.js";
import { jsonResponse, MemorySecretStore, mockFetch, noSleep, on } from "./test-helpers.js";

// Non-OAuth credentials (API tokens, assertion grants) on the shared request path.

function runtimeWith(
  credential = staticTokenCredential((t) => ({ "x-api-token": t.accessToken })),
) {
  const secrets = new MemorySecretStore();
  const fetch = mockFetch([on("GET", "https://api.example.test/", () => jsonResponse({ ok: 1 }))]);
  const runtime = new ConnectorRuntime(
    { id: "example", credential },
    { secrets: () => secrets, fetch, sleep: noSleep },
  );
  return { runtime, fetch };
}

describe("connector runtime with a non-OAuth credential", () => {
  it("is configured without an OAuth client and sends the token in the credential's header", async () => {
    const { runtime, fetch } = runtimeWith();
    expect(runtime.configured).toBe(true);
    runtime.tokens.save({
      accessToken: "tok-123",
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["example.read"],
      tokenType: "api-token",
      obtainedAt: 0,
    });
    await runtime.json({ url: "https://api.example.test/x", scopes: ["example.read"] });
    expect(fetch.calls[0].headers["x-api-token"]).toBe("tok-123");
    expect(fetch.calls[0].headers.authorization).toBeUndefined();
  });

  it("refuses before any request without a stored token or the needed scope", async () => {
    const { runtime, fetch } = runtimeWith();
    await expect(
      runtime.json({ url: "https://api.example.test/x", scopes: ["example.read"] }),
    ).rejects.toMatchObject({ code: "not_authenticated" });
    runtime.tokens.save({
      accessToken: "tok",
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ["example.read"],
      tokenType: "api-token",
      obtainedAt: 0,
    });
    await expect(
      runtime.json({ url: "https://api.example.test/x", scopes: ["example.write"] }),
    ).rejects.toMatchObject({ code: "scope_missing" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("defaults to a bearer header", async () => {
    const { runtime, fetch } = runtimeWith(staticTokenCredential());
    runtime.tokens.save({
      accessToken: "tok",
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: [],
      tokenType: "Bearer",
      obtainedAt: 0,
    });
    await runtime.json({ url: "https://api.example.test/x", scopes: [] });
    expect(fetch.calls[0].headers.authorization).toBe("Bearer tok");
  });
});

describe("scope names in status", () => {
  it("keeps provider names with : and / but never URLs", () => {
    expect(
      sanitizeScopeNames([
        "k:app_record:read",
        "mfc/invoice/data.read",
        "https://evil.example/x",
        "a//b",
      ]),
    ).toEqual(["k:app_record:read", "mfc/invoice/data.read"]);
  });
});
