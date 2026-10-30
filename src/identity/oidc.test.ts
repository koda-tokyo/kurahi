import { describe, expect, it } from "vitest";
import {
  emailDomain,
  MAX_PENDING_PER_SOURCE,
  OidcClient,
  OidcError,
  PendingQuota,
  pkceChallenge,
} from "./oidc.js";
import {
  CLIENT_ID,
  ecKey,
  fakeIdp,
  ISSUER,
  oidcProvider,
  rsaKey,
  signJwt,
} from "./test-helpers.js";

const REDIRECT = "https://gateway.example.test/api/identity/sso/corp/callback";

function setup() {
  let t = Date.now();
  const idp = fakeIdp({ now: () => t });
  const client = new OidcClient({ fetch: idp.fetch, now: () => t, clockSkewSec: 60 });
  return {
    idp,
    client,
    p: oidcProvider(),
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

async function signIn(s: ReturnType<typeof setup>, p = s.p) {
  const { url } = await s.client.begin(p, { redirectUri: REDIRECT, returnTo: "/console" });
  const { code, state } = s.idp.authorize(url);
  return {
    url,
    code,
    state,
    run: () => s.client.complete(p, { code, state }, { redirectUri: REDIRECT }),
  };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "accepted";
  } catch (err) {
    if (err instanceof OidcError) {
      return err.reason;
    }
    throw err;
  }
}

describe("OIDC relying party (local fake IdP)", () => {
  it("authorization code + PKCE happy path: state, nonce, JWKS signature, claims", async () => {
    const s = setup();
    const flow = await signIn(s);
    const u = new URL(flow.url);
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("nonce")).toBeTruthy();
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    const done = await flow.run();
    expect(done.returnTo).toBe("/console");
    expect(done.claims).toMatchObject({
      issuer: ISSUER,
      subject: "user-1",
      email: "alice@example.com",
      displayName: "Alice Example",
      groups: ["g-finance"],
    });
    // The token endpoint got the verifier whose S256 matches the challenge (checked by the IdP).
    const verifier = s.idp.tokenRequests[0].get("code_verifier") ?? "";
    expect(pkceChallenge(verifier)).toBe(u.searchParams.get("code_challenge"));
  });

  it("records how and when the person authenticated (auth_time, amr, acr)", async () => {
    const s = setup();
    const t = Math.floor(Date.now() / 1000) - 60;
    s.idp.nextClaims = { auth_time: t, amr: ["pwd", "mfa", 7, "x".repeat(65)], acr: "urn:mfa" };
    const { claims } = await (await signIn(s)).run();
    expect(claims.auth).toEqual({
      at: new Date(t * 1000).toISOString(),
      methods: ["pwd", "mfa"],
      context: "urn:mfa",
    });
    const plain = setup();
    const done = await (await signIn(plain)).run();
    expect(done.claims.auth).toMatchObject({ methods: [], context: null });
  });

  it("uses an e-mail only with email_verified: true, never preferred_username or upn", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const s = setup();
      s.idp.nextClaims = extra;
      return (await (await signIn(s)).run()).claims;
    };
    expect(await run({ email_verified: false })).toMatchObject({
      email: null,
      emailVerified: false,
    });
    expect(await run({ email_verified: "true" })).toMatchObject({ email: null });
    expect(
      await run({
        email: undefined,
        email_verified: undefined,
        preferred_username: "victim@example.com",
        upn: "victim@example.com",
      }),
    ).toMatchObject({ email: null, emailVerified: false });
    expect(await run({})).toMatchObject({ email: "alice@example.com", emailVerified: true });
    // A domain allowlist cannot be met by an unverified address.
    const s = setup();
    s.idp.nextClaims = { email_verified: false };
    expect(
      await reason((await signIn(s, oidcProvider({ allowedDomains: ["example.com"] }))).run()),
    ).toBe("domain_not_allowed");
  });

  it("checks the domain after the only @, and refuses addresses with several", async () => {
    const run = async (email: string) => {
      const s = setup();
      s.idp.nextClaims = { email };
      return reason((await signIn(s, oidcProvider({ allowedDomains: ["example.com"] }))).run());
    };
    expect(await run("attacker@example.com@evil.test")).toBe("domain_not_allowed");
    expect(await run("attacker@evil.test@example.com")).toBe("domain_not_allowed");
    expect(await run("alice@example.com")).toBe("accepted");
  });

  it("times out a hung IdP instead of waiting forever", async () => {
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const client = new OidcClient({ fetch: hung, fetchTimeoutMs: 50 });
    const started = Date.now();
    expect(
      await reason(client.begin(oidcProvider(), { redirectUri: REDIRECT, returnTo: "/" })),
    ).toBe("discovery_failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a flood from one source never evicts another source's pending sign-in", async () => {
    const s = setup();
    const { url } = await s.client.begin(s.p, {
      redirectUri: REDIRECT,
      returnTo: "/console",
      source: "203.0.113.7",
    });
    for (let i = 0; i < MAX_PENDING_PER_SOURCE * 3; i += 1) {
      await s.client.begin(s.p, { redirectUri: REDIRECT, returnTo: "/", source: "198.51.100.9" });
    }
    const { code, state } = s.idp.authorize(url);
    expect(await reason(s.client.complete(s.p, { code, state }, { redirectUri: REDIRECT }))).toBe(
      "accepted",
    );
  });

  it("accepts ES256 and PS256 keys", async () => {
    for (const key of [ecKey("e1"), rsaKey("p1", "PS256")]) {
      const s = setup();
      s.idp.keys = [key];
      expect(await reason((await signIn(s)).run())).toBe("accepted");
    }
  });

  it("refuses a replayed callback (state is single use)", async () => {
    const s = setup();
    const flow = await signIn(s);
    await flow.run();
    expect(await reason(flow.run())).toBe("state_unknown");
  });

  it("refuses an unknown or expired state", async () => {
    const s = setup();
    expect(
      await reason(s.client.complete(s.p, { code: "c", state: "nope" }, { redirectUri: REDIRECT })),
    ).toBe("state_unknown");
    const flow = await signIn(s);
    s.advance(11 * 60_000);
    expect(await reason(flow.run())).toBe("state_unknown");
  });

  it("refuses a nonce mismatch", async () => {
    const s = setup();
    s.idp.nextClaims = { nonce: "someone-elses-nonce" };
    expect(await reason((await signIn(s)).run())).toBe("nonce_mismatch");
  });

  it("refuses a replayed ID token in a new flow", async () => {
    const s = setup();
    await (await signIn(s)).run();
    s.idp.nextIdToken = s.idp.lastIdToken;
    // A captured token carries the first flow's nonce: refused in any other flow.
    expect(await reason((await signIn(s)).run())).toBe("nonce_mismatch");
    // And re-validating it for its own nonce again is a replay.
    const nonce = JSON.parse(
      Buffer.from((s.idp.lastIdToken ?? "").split(".")[1], "base64url").toString(),
    ).nonce as string;
    expect(
      await reason(
        s.client.validateIdToken(s.p, s.idp.lastIdToken ?? "", {
          nonce,
          flowStartedAt: s.now() - 1000,
        }),
      ),
    ).toBe("nonce_replayed");
  });

  it("refuses expired, future and pre-flow tokens", async () => {
    const t = () => Math.floor(Date.now() / 1000);
    let s = setup();
    s.idp.nextClaims = { exp: t() - 600 };
    expect(await reason((await signIn(s)).run())).toBe("expired");
    s = setup();
    s.idp.nextClaims = { iat: t() + 900 };
    expect(await reason((await signIn(s)).run())).toBe("not_yet_valid");
    s = setup();
    s.idp.nextClaims = { iat: t() - 3600, exp: t() + 300 };
    expect(await reason((await signIn(s)).run())).toBe("expired");
  });

  it("refuses wrong audience, issuer, tenant and domain", async () => {
    let s = setup();
    s.idp.nextClaims = { aud: "another-app" };
    expect(await reason((await signIn(s)).run())).toBe("wrong_audience");
    s = setup();
    s.idp.nextClaims = { aud: [CLIENT_ID, "another-app"] };
    expect(await reason((await signIn(s)).run())).toBe("wrong_audience");
    s = setup();
    s.idp.nextClaims = { iss: "https://evil.example.test" };
    expect(await reason((await signIn(s)).run())).toBe("wrong_issuer");
    s = setup();
    s.idp.nextClaims = { tid: "other-tenant" };
    expect(await reason((await signIn(s, oidcProvider({ allowedTenants: ["t-1"] }))).run())).toBe(
      "wrong_tenant",
    );
    s = setup();
    expect(
      await reason((await signIn(s, oidcProvider({ allowedDomains: ["corp.example"] }))).run()),
    ).toBe("domain_not_allowed");
  });

  it("refuses alg none, HMAC with the public key, unknown kids and bad signatures", async () => {
    const t = Math.floor(Date.now() / 1000);
    const claims = (nonce: string) => ({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "x",
      iat: t,
      exp: t + 300,
      nonce,
    });
    const forge = async (make: (nonce: string) => string) => {
      const s = setup();
      const { url } = await s.client.begin(s.p, { redirectUri: REDIRECT, returnTo: "/" });
      const nonce = new URL(url).searchParams.get("nonce") ?? "";
      s.idp.nextIdToken = make(nonce);
      const { code, state } = s.idp.authorize(url);
      return reason(s.client.complete(s.p, { code, state }, { redirectUri: REDIRECT }));
    };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(await forge((n) => `${b64({ alg: "none", kid: "k1" })}.${b64(claims(n))}.x`)).toBe(
      "unsupported_alg",
    );
    expect(await forge((n) => `${b64({ alg: "HS256", kid: "k1" })}.${b64(claims(n))}.x`)).toBe(
      "unsupported_alg",
    );
    expect(await forge((n) => signJwt(rsaKey("k-unknown"), claims(n)))).toBe("unknown_key");
    expect(await forge((n) => signJwt({ ...rsaKey("k1") }, claims(n)))).toBe("bad_signature");
  });

  it("builds an RP-initiated logout URL from end_session_endpoint", async () => {
    const s = setup();
    const url = await s.client.endSessionUrl(s.p, {
      idTokenHint: "tok",
      postLogoutRedirectUri: "https://gateway.example.test/",
    });
    expect(url).toContain(`${ISSUER}/logout?`);
    expect(url).toContain("id_token_hint=tok");
  });

  it("refuses discovery documents whose issuer differs or endpoints are not https", async () => {
    const s = setup();
    const client = new OidcClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            issuer: "https://other.example.test",
            authorization_endpoint: "https://x",
            token_endpoint: "https://x",
            jwks_uri: "https://x",
          }),
        ),
    });
    expect(await reason(client.begin(s.p, { redirectUri: REDIRECT, returnTo: "/" }))).toBe(
      "discovery_failed",
    );
    const client2 = new OidcClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: "http://x",
            token_endpoint: "https://x",
            jwks_uri: "https://x",
          }),
        ),
    });
    expect(await reason(client2.begin(s.p, { redirectUri: REDIRECT, returnTo: "/" }))).toBe(
      "discovery_failed",
    );
  });
});

describe("sign-in helpers", () => {
  it("emailDomain uses the part after the only @", () => {
    expect(emailDomain("a@Example.com")).toBe("example.com");
    for (const bad of ["a@b@example.com", "@example.com", "a@", "plain", ""]) {
      expect(emailDomain(bad), bad).toBeNull();
    }
  });

  it("PendingQuota: per-source eviction, refusal (not eviction) when full", () => {
    const q = new PendingQuota<{ source: string; createdAt: number }>(3, 2, 60_000, () => 0);
    expect(q.add("a1", { source: "a", createdAt: 0 })).toBe(true);
    expect(q.add("b1", { source: "b", createdAt: 0 })).toBe(true);
    expect(q.add("a2", { source: "a", createdAt: 0 })).toBe(true);
    // Full: a new source is refused; nobody's live entry is evicted.
    expect(q.add("c1", { source: "c", createdAt: 0 })).toBe(false);
    expect(q.get("b1")).toBeDefined();
    // A source at its quota replaces its own oldest.
    expect(q.add("a3", { source: "a", createdAt: 0 })).toBe(true);
    expect(q.get("a1")).toBeUndefined();
    expect(q.get("b1")).toBeDefined();
  });
});
