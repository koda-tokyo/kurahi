import { describe, expect, it } from "vitest";
import { ConnectorError } from "./errors.js";
import { loopbackSignIn } from "./loopback.js";
import { microsoftEndpoints } from "./microsoft.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  type OAuthClientConfig,
  pkceChallenge,
  pollDeviceToken,
  startDeviceAuthorization,
} from "./oauth.js";
import { jsonResponse, MemorySecretStore, mockFetch, noSleep, on, queue } from "./test-helpers.js";
import { ConnectorTokenStore, getValidToken } from "./token-store.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ep = microsoftEndpoints(TENANT);
const client: OAuthClientConfig = {
  clientId: CLIENT_ID,
  endpoints: ep,
  scopes: ["offline_access", "User.Read", "Mail.Read"],
};

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a 43-char verifier and an S256 authorize URL without a secret", () => {
    const pkce = createPkcePair();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(
      buildAuthorizeUrl(client, {
        redirectUri: "http://localhost:5000/callback",
        state: "s1",
        challenge: pkce.challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe(ep.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("refuses common/consumers tenants", () => {
    expect(() => microsoftEndpoints("common")).toThrow(ConnectorError);
    expect(() => microsoftEndpoints("consumers")).toThrow(ConnectorError);
  });
});

describe("loopback sign-in", () => {
  it("receives the redirect, checks state and redeems the code with the verifier", async () => {
    let challenge = "";
    const fetch = mockFetch([
      on("POST", ep.tokenUrl, (req) => {
        const form = new URLSearchParams(req.body);
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("the-code");
        expect(pkceChallenge(form.get("code_verifier") ?? "")).toBe(challenge);
        return jsonResponse({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: "User.Read Mail.Read",
          token_type: "Bearer",
        });
      }),
    ]);
    const token = await loopbackSignIn(
      client,
      {
        timeoutMs: 5000,
        openUrl: async (url) => {
          const u = new URL(url);
          challenge = u.searchParams.get("code_challenge") ?? "";
          const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
          const local = `http://127.0.0.1:${redirect.port}${redirect.pathname}`;
          // A forged redirect without our state is ignored ...
          const forged = await globalThis.fetch(`${local}?code=evil&state=wrong`);
          expect(forged.status).toBe(400);
          // ... and the real one completes the sign-in.
          const state = u.searchParams.get("state") ?? "";
          const ok = await globalThis.fetch(`${local}?code=the-code&state=${state}`);
          expect(ok.status).toBe(200);
        },
      },
      { fetch },
    );
    expect(token.accessToken).toBe("at-1");
    expect(token.scopes).toEqual(["User.Read", "Mail.Read"]);
  });

  it("maps a denied consent to approval_denied", async () => {
    await expect(
      loopbackSignIn(client, {
        timeoutMs: 5000,
        openUrl: async (url) => {
          const u = new URL(url);
          const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
          await globalThis.fetch(
            `http://127.0.0.1:${redirect.port}/callback?error=access_denied&state=${u.searchParams.get("state")}`,
          );
        },
      }),
    ).rejects.toMatchObject({ code: "approval_denied" });
  });
});

describe("device code", () => {
  it("polls through authorization_pending and slow_down, honouring the interval", async () => {
    const waits: number[] = [];
    const fetch = mockFetch([
      on("POST", ep.deviceCodeUrl!, () =>
        jsonResponse({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 5,
        }),
      ),
      on(
        "POST",
        ep.tokenUrl,
        queue(
          () => jsonResponse({ error: "authorization_pending" }, 400),
          () => jsonResponse({ error: "slow_down" }, 400),
          () => jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 60 }),
        ),
      ),
    ]);
    let t = 0;
    const deps = {
      fetch,
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    };
    const device = await startDeviceAuthorization(client, deps);
    expect(device.userCode).toBe("ABCD-EFGH");
    const token = await pollDeviceToken(client, device, deps);
    expect(token.accessToken).toBe("at");
    expect(waits).toEqual([5000, 5000, 10000]);
    const form = new URLSearchParams(fetch.calls.at(-1)?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("stops on a declined sign-in and on expiry", async () => {
    const device = {
      deviceCode: "dc",
      userCode: "X",
      verificationUri: "https://microsoft.com/devicelogin",
      expiresIn: 60,
      interval: 5,
    };
    const declined = mockFetch([
      on("POST", ep.tokenUrl, () => jsonResponse({ error: "authorization_declined" }, 400)),
    ]);
    await expect(
      pollDeviceToken(client, device, { fetch: declined, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "approval_denied" });

    let t = 0;
    const pending = mockFetch([
      on("POST", ep.tokenUrl, () => jsonResponse({ error: "authorization_pending" }, 400)),
    ]);
    await expect(
      pollDeviceToken(client, device, {
        fetch: pending,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(pending.calls.length).toBeLessThanOrEqual(12);
  });
});

describe("token refresh", () => {
  function setup(expiresAt: number) {
    const secrets = new MemorySecretStore();
    const store = new ConnectorTokenStore("microsoft-365", () => secrets);
    store.save({
      accessToken: "old",
      refreshToken: "rt-old",
      expiresAt,
      scopes: ["User.Read"],
      tokenType: "Bearer",
      obtainedAt: 0,
      idToken: "never-stored",
    });
    return { secrets, store };
  }

  it("never persists the ID token", () => {
    const { secrets } = setup(10_000_000);
    expect(secrets.get("connector.microsoft-365.token")).not.toContain("never-stored");
  });

  it("returns a fresh token without network, and refreshes once (single flight) when due", async () => {
    const fresh = setup(10_000_000);
    const none = mockFetch([]);
    expect(
      (await getValidToken(fresh.store, client, { fetch: none, now: () => 0 })).accessToken,
    ).toBe("old");
    expect(none.calls).toHaveLength(0);

    const due = setup(60_000);
    const fetch = mockFetch([
      on("POST", ep.tokenUrl, (req) => {
        expect(new URLSearchParams(req.body).get("refresh_token")).toBe("rt-old");
        return jsonResponse({ access_token: "new", refresh_token: "rt-new", expires_in: 3600 });
      }),
    ]);
    const [a, b] = await Promise.all([
      getValidToken(due.store, client, { fetch, now: () => 0 }),
      getValidToken(due.store, client, { fetch, now: () => 0 }),
    ]);
    expect(a.accessToken).toBe("new");
    expect(b.accessToken).toBe("new");
    expect(fetch.calls).toHaveLength(1);
    expect(due.store.load()?.refreshToken).toBe("rt-new");
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const due = setup(0);
    const fetch = mockFetch([
      on("POST", ep.tokenUrl, () => jsonResponse({ access_token: "new", expires_in: 3600 })),
    ]);
    await getValidToken(due.store, client, { fetch, now: () => 0 });
    expect(due.store.load()?.refreshToken).toBe("rt-old");
  });

  it("maps invalid_grant to reauth_required and a missing sign-in to not_authenticated", async () => {
    const due = setup(0);
    const fetch = mockFetch([
      on("POST", ep.tokenUrl, () =>
        jsonResponse({ error: "invalid_grant", error_description: "AADSTS secret detail" }, 400),
      ),
    ]);
    const err = await getValidToken(due.store, client, { fetch, now: () => 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "reauth_required" });
    expect(String((err as Error).message)).not.toContain("AADSTS");

    const empty = new ConnectorTokenStore("gmail", () => new MemorySecretStore());
    await expect(getValidToken(empty, client)).rejects.toMatchObject({ code: "not_authenticated" });
  });
});
