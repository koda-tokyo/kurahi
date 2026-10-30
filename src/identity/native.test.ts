import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SignInClaims } from "./types.js";
import { resolveIdentitySettings } from "./config.js";
import { setHttpPersonForTest } from "./http.js";
import { createNativeSignInHandlers, USER_CODE_FAILURES } from "./native-http.js";
import {
  checkRedirectUri,
  DEVICE_CODE_TTL_MS,
  normalizeUserCode,
  signInPageReturnTo,
  USER_CODE_ALPHABET,
} from "./native.js";
import { enrolPasskey, passkeyService } from "./passkey-test-helpers.js";
import { IdentityService } from "./service.js";
import { SessionStore } from "./sessions.js";
import { IdentityStore } from "./store.js";

const claims = (over: Partial<SignInClaims> = {}): SignInClaims => ({
  providerId: "corp",
  protocol: "oidc",
  issuer: "https://idp.example.test",
  subject: "sub-1",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  givenName: null,
  familyName: null,
  groups: [],
  idTokenHint: null,
  auth: { at: "2026-10-30T00:00:00.000Z", methods: ["pwd", "mfa"], context: "urn:acr:mfa" },
  ...over,
});

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: "",
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: (b?: string) => {
      res.body = b ?? "";
    },
  };
  return { res: res as unknown as ServerResponse & { body: string }, headers };
}

function post(
  body: Record<string, unknown> | string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const form = typeof body === "string";
  const r = Readable.from([
    Buffer.from(form ? body : JSON.stringify(body)),
  ]) as unknown as IncomingMessage;
  r.headers = {
    "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
    ...headers,
  };
  r.method = "POST";
  return r;
}

const get = (headers: Record<string, string> = {}) =>
  ({ headers, socket: { remoteAddress: "203.0.113.9" } }) as unknown as IncomingMessage;

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function setup(over: Record<string, unknown> = {}) {
  let t = Date.parse("2026-10-30T09:00:00.000Z");
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" }],
      defaultRole: "member",
      ...over,
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null, now: clock.now }),
    },
  );
  const h = createNativeSignInHandlers({
    service: () => svc,
    attemptKey: () => null,
    clientIp: () => "203.0.113.9",
    now: clock.now,
  });
  // The browser sign-in that approves.
  const signed = svc.signIn(claims());
  if (!signed.ok) {
    throw new Error("sign-in failed");
  }
  const asPerson = (r: IncomingMessage) => {
    setHttpPersonForTest(r, signed.principal);
    return r;
  };
  return { svc, h, clock, browser: signed, asPerson };
}

type Ctx = ReturnType<typeof setup>;

async function call(
  fn: (req: IncomingMessage, res: ServerResponse) => unknown,
  req: IncomingMessage,
) {
  const out = fakeRes();
  await fn(req, out.res);
  return {
    status: out.res.statusCode,
    headers: out.headers,
    // Responses are checked field by field below.
    // oxlint-disable-next-line typescript/no-explicit-any
    body: (out.res.body ? JSON.parse(out.res.body) : {}) as Record<string, any>,
  };
}

async function startDevice(c: Ctx, extra: Record<string, string> = {}) {
  const r = await call(
    c.h.deviceAuthorization,
    post(form({ client_id: "kurahi-cli", device_name: "alice@build-01", ...extra })),
  );
  expect(r.status).toBe(200);
  return r.body as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
}

const poll = (c: Ctx, deviceCode: string, clientId = "kurahi-cli") =>
  call(
    c.h.token,
    post(form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId })),
  );

const lookup = (c: Ctx, userCode: string) =>
  call(c.h.lookupDeviceCode, c.asPerson(post({ user_code: userCode })));

const decide = (c: Ctx, userCode: string, approve: boolean) =>
  call(c.h.decideDeviceCode, c.asPerson(post({ user_code: userCode, approve })));

describe("user codes and return targets", () => {
  it("normalises user codes and refuses other letters", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode("BCDF GHJK")).toBe("BCDFGHJK");
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull(); // vowels are not in the alphabet
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOUY01]/);
  });

  it("lets only the two sign-in pages be return targets", () => {
    expect(signInPageReturnTo("/api/identity/device")).toBe("/api/identity/device");
    expect(signInPageReturnTo("/api/identity/device?user_code=bcdf-ghjk")).toBe(
      "/api/identity/device?user_code=BCDF-GHJK",
    );
    const id = "a".repeat(43);
    expect(signInPageReturnTo(`/api/identity/oauth/continue?request=${id}`)).toBe(
      `/api/identity/oauth/continue?request=${id}`,
    );
    expect(signInPageReturnTo("/api/identity/device?user_code=x&next=//evil")).toBeNull();
    expect(signInPageReturnTo("/api/identity/oauth/continue?request=short")).toBeNull();
    expect(signInPageReturnTo("/api/identity/session")).toBeNull();
  });
});

describe("device authorization grant (command line)", () => {
  it("issues codes, then a separate session after approval (happy path)", async () => {
    const c = setup();
    const d = await startDevice(c);
    expect(d.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(normalizeUserCode(d.user_code)).not.toBeNull();
    expect(d.device_code.length).toBeGreaterThanOrEqual(43);
    expect(d.verification_uri).toBe("https://gateway.example.test/api/identity/device");
    expect(d.verification_uri_complete).toBe(`${d.verification_uri}?user_code=${d.user_code}`);
    expect(d.expires_in).toBeLessThanOrEqual(600);
    expect(d.interval).toBe(5);

    expect((await poll(c, d.device_code)).body.error).toBe("authorization_pending");

    const seen = await lookup(c, d.user_code.toLowerCase());
    expect(seen.status).toBe(200);
    expect(seen.body.request).toMatchObject({
      userCode: d.user_code,
      clientId: "kurahi-cli",
      clientName: "Kurahi CLI",
      deviceName: "alice@build-01",
      ip: "203.0.113.9",
    });
    expect((await decide(c, d.user_code, true)).body).toEqual({ ok: true, approved: true });

    c.clock.advance(5_000);
    const tok = await poll(c, d.device_code);
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe("Bearer");
    expect(tok.body.access_token).toMatch(/^kss_/);
    expect(tok.body.access_token).not.toBe(c.browser.token);
    expect(tok.body.expires_in).toBeGreaterThan(0);

    // Same person, provider and protocol; its own session, labelled as CLI. It never inherits
    // the approving browser's authentication: covered decisions need their own step-up.
    const v = c.svc.verifyToken(tok.body.access_token);
    expect(v.ok && v.principal.personId).toBe(c.browser.principal.personId);
    const s = c.svc.sessions.get(tok.body.session_id);
    const b = c.svc.sessions.get(c.browser.principal.sessionId);
    expect(s?.id).not.toBe(b?.id);
    expect(s?.providerId).toBe("corp");
    expect(s?.protocol).toBe("oidc");
    expect(b?.auth).toBeDefined();
    expect(s?.auth).toBeUndefined();
    expect(s?.client).toEqual({
      flow: "device",
      id: "kurahi-cli",
      name: "Kurahi CLI",
      label: "CLI: Kurahi CLI (alice@build-01)",
    });
    // Never outlives the sign-in it rests on.
    expect(Date.parse(s?.expiresAt ?? "")).toBeLessThanOrEqual(Date.parse(b?.expiresAt ?? ""));

    // Ending the browser session leaves the CLI session; revoking it is separate.
    c.svc.sessions.revoke(c.browser.principal.sessionId, "logout");
    expect(c.svc.verifyToken(tok.body.access_token).ok).toBe(true);
    c.svc.sessions.revoke(tok.body.session_id, "admin");
    expect(c.svc.verifyToken(tok.body.access_token).ok).toBe(false);
  });

  it("answers slow_down to fast polling and widens the interval", async () => {
    const c = setup();
    const d = await startDevice(c);
    expect((await poll(c, d.device_code)).body.error).toBe("authorization_pending");
    c.clock.advance(1_000);
    const fast = await poll(c, d.device_code);
    expect(fast.body).toEqual({ error: "slow_down", interval: 10 });
    c.clock.advance(5_000);
    expect((await poll(c, d.device_code)).body.error).toBe("slow_down");
    c.clock.advance(15_000);
    expect((await poll(c, d.device_code)).body.error).toBe("authorization_pending");
  });

  it("answers access_denied once the person denies, then forgets the code", async () => {
    const c = setup();
    const d = await startDevice(c);
    expect((await decide(c, d.user_code, false)).body).toEqual({ ok: true, approved: false });
    expect((await poll(c, d.device_code)).body.error).toBe("access_denied");
    expect((await poll(c, d.device_code)).body.error).toBe("invalid_grant");
  });

  it("answers expired_token after 10 minutes; the user code no longer works", async () => {
    const c = setup();
    const d = await startDevice(c);
    c.clock.advance(DEVICE_CODE_TTL_MS);
    expect((await lookup(c, d.user_code)).status).toBe(404);
    expect((await poll(c, d.device_code)).body.error).toBe("expired_token");
  });

  it("redeems a device code once", async () => {
    const c = setup();
    const d = await startDevice(c);
    await decide(c, d.user_code, true);
    expect((await poll(c, d.device_code)).status).toBe(200);
    c.clock.advance(10_000);
    const again = await poll(c, d.device_code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    // A decided code cannot be decided again either.
    expect((await decide(c, d.user_code, true)).status).toBe(404);
  });

  it("refuses another client's device code and unknown clients", async () => {
    const c = setup();
    const d = await startDevice(c);
    expect((await poll(c, d.device_code, "kurahi-desktop")).body.error).toBe("invalid_grant");
    const r = await call(c.h.deviceAuthorization, post(form({ client_id: "evil" })));
    expect(r.body.error).toBe("invalid_client");
  });

  it("locks a person out after wrong codes, never other people's pending codes", async () => {
    const c = setup();
    const d = await startDevice(c);
    for (let i = 0; i < USER_CODE_FAILURES; i += 1) {
      expect((await lookup(c, "BBBB-BBBB")).status).toBe(404);
    }
    // Locked now, even for the right code.
    const locked = await lookup(c, d.user_code);
    expect(locked.status).toBe(429);
    expect(locked.body.error.type).toBe("locked");
    expect((await decide(c, d.user_code, true)).status).toBe(429);

    // Someone else behind the same address is not locked by this person's misses.
    const other = c.svc.signIn(claims({ subject: "sub-2", email: "bob@example.com" }));
    if (!other.ok) {
      throw new Error(other.reason);
    }
    const asOther = (r: IncomingMessage) => {
      setHttpPersonForTest(r, other.principal);
      return r;
    };
    expect(
      (await call(c.h.lookupDeviceCode, asOther(post({ user_code: d.user_code })))).status,
    ).toBe(200);

    // Many wrong guesses (by anyone) leave a pending code alone.
    const c2 = setup();
    const d2 = await startDevice(c2);
    for (let i = 0; i < 100; i += 1) {
      c2.h._device.find("CCCC-CCCC");
    }
    expect((await lookup(c2, d2.user_code)).status).toBe(200);
    expect((await poll(c2, d2.device_code)).body.error).toBe("authorization_pending");
  });

  it("refuses the token when the person was deactivated after approving", async () => {
    const c = setup();
    const d = await startDevice(c);
    await decide(c, d.user_code, true);
    c.svc.store.updatePerson(c.browser.principal.personId, { active: false });
    const r = await poll(c, d.device_code);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("access_denied");
    expect(c.svc.sessions.listForPerson(c.browser.principal.personId)).toHaveLength(1);
  });

  it("limits pending requests per source", async () => {
    const c = setup();
    for (let i = 0; i < 10; i += 1) {
      await startDevice(c);
    }
    const r = await call(c.h.deviceAuthorization, post(form({ client_id: "kurahi-cli" })));
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("slow_down");
  });

  it("is off with deviceSignIn: false", async () => {
    const c = setup({ deviceSignIn: false });
    const r = await call(c.h.deviceAuthorization, post(form({ client_id: "kurahi-cli" })));
    expect(r.body.error).toBe("unauthorized_client");
  });

  it("serves the verification page with a strict CSP and the code prefilled", async () => {
    const c = setup();
    const out = fakeRes();
    c.h.deviceVerificationPage(get(), out.res, {
      url: new URL("https://gateway.example.test/api/identity/device?user_code=bcdf-ghjk"),
      params: {},
    });
    expect(out.res.statusCode).toBe(200);
    expect(out.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
    expect(out.headers["x-frame-options"]).toBe("DENY");
    expect(out.res.body).toContain('"userCode":"BCDF-GHJK"');
    // The person types the code; the link's code is only shown, never accepted silently.
    expect(out.res.body).toContain('$("user-code").value = "";');
    expect(out.res.body).toContain("full access to Kurahi as");
  });

  it("works with only the built-in passkey provider (sign-in on the page itself)", async () => {
    const env = passkeyService();
    const a = enrolPasskey(env.svc, env.person.id);
    const h = createNativeSignInHandlers({ service: () => env.svc, attemptKey: () => null });
    const started = await call(h.deviceAuthorization, post(form({ client_id: "kurahi-cli" })));
    expect(started.status).toBe(200);
    const page = fakeRes();
    h.deviceVerificationPage(get(), page.res, {
      url: new URL("https://kurahi.example.test/api/identity/device"),
      params: {},
    });
    expect(page.res.statusCode).toBe(200);
    expect(page.res.body).toContain("Sign in with a passkey");
    expect(page.res.body).toContain("/api/identity/passkey/login/begin");
    // A passkey session approves; the command line gets its own session with no step-up credit.
    const begin = env.svc.passkeys.beginSignIn({ source: "t" });
    const signed = env.svc.passkeys.finishSignIn({
      ceremonyId: begin.ceremonyId,
      credential: a.assert(begin.publicKey, "https://kurahi.example.test"),
    });
    const as = (r: IncomingMessage) => {
      setHttpPersonForTest(r, signed.principal);
      return r;
    };
    const userCode = started.body.user_code as string;
    expect((await call(h.lookupDeviceCode, as(post({ user_code: userCode })))).status).toBe(200);
    expect(
      (await call(h.decideDeviceCode, as(post({ user_code: userCode, approve: true })))).status,
    ).toBe(200);
    const tok = await call(
      h.token,
      post(
        form({
          grant_type: DEVICE_GRANT,
          device_code: started.body.device_code,
          client_id: "kurahi-cli",
        }),
      ),
    );
    expect(tok.status).toBe(200);
    const s = env.svc.sessions.get(tok.body.session_id);
    expect(s?.protocol).toBe("passkey");
    expect(s?.auth).toBeUndefined();
  });
});

describe("deactivation ends command-line and native sessions", () => {
  it("revokes them with the person's other sessions", async () => {
    const c = setup();
    const d = await startDevice(c);
    await decide(c, d.user_code, true);
    const tok = (await poll(c, d.device_code)).body.access_token as string;
    expect(c.svc.verifyToken(tok).ok).toBe(true);
    // What SCIM deprovisioning does.
    c.svc.store.updatePerson(c.browser.principal.personId, { active: false });
    c.svc.revokePersonSessions(c.browser.principal.personId, "scim_deactivated", "scim");
    expect(c.svc.verifyToken(tok)).toEqual({ ok: false, reason: "session_revoked" });
  });
});

// ---------------------------------------------------------------------------------------------

const verifier = "v".repeat(20) + "-._~" + "w".repeat(30);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function authorizeUrl(q: Record<string, string>) {
  const params = new URLSearchParams({
    client_id: "kurahi-desktop",
    redirect_uri: "http://127.0.0.1:53682/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    ...q,
  });
  for (const [k, v] of Object.entries(q)) {
    if (v === "") {
      params.delete(k);
    }
  }
  return new URL(`https://gateway.example.test/api/identity/oauth/authorize?${params}`);
}

async function authorize(c: Ctx, q: Record<string, string> = {}) {
  const out = fakeRes();
  c.h.authorizeNative(get(), out.res, { url: authorizeUrl(q), params: {} });
  return { status: out.res.statusCode, headers: out.headers, body: out.res.body };
}

/** Authorize, sign in, confirm: the app's redirect. */
async function nativeFlow(c: Ctx, q: Record<string, string> = {}) {
  const a = await authorize(c, q);
  expect(a.status).toBe(303);
  const cookie = a.headers["set-cookie"].split(";")[0];
  const request = new URL(a.headers.location, "https://g").searchParams.get("request") ?? "";
  const page = fakeRes();
  c.h.nativeContinuePage(get({ cookie }), page.res, {
    url: new URL(`https://g${a.headers.location}`),
    params: {},
  });
  expect(page.res.statusCode).toBe(200);
  expect(page.res.body).toContain("Kurahi Desktop");
  const done = await call(
    c.h.completeNativeAuthorization,
    c.asPerson(post({ request, approve: true }, { cookie })),
  );
  return { done, cookie, request };
}

const exchange = (c: Ctx, o: Record<string, string>) =>
  call(
    c.h.token,
    post(
      form({
        grant_type: "authorization_code",
        client_id: "kurahi-desktop",
        redirect_uri: "http://127.0.0.1:53682/callback",
        code_verifier: verifier,
        ...o,
      }),
    ),
  );

describe("native apps: loopback redirect with PKCE", () => {
  it("accepts any loopback port and exchanges the code once for a new session", async () => {
    const c = setup();
    const { done } = await nativeFlow(c);
    expect(done.status).toBe(200);
    const back = new URL(done.body.redirect);
    expect(`${back.origin}${back.pathname}`).toBe("http://127.0.0.1:53682/callback");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe("https://gateway.example.test");
    expect(back.searchParams.has("access_token")).toBe(false);
    expect(done.body.redirect).not.toContain("kss_");
    const code = back.searchParams.get("code") ?? "";

    const tok = await exchange(c, { code });
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toMatch(/^kss_/);
    const s = c.svc.sessions.get(tok.body.session_id);
    expect(s?.client).toEqual({
      flow: "native",
      id: "kurahi-desktop",
      name: "Kurahi Desktop",
      label: "Kurahi Desktop",
    });
    expect(s?.personId).toBe(c.browser.principal.personId);
    expect((await exchange(c, { code })).body.error).toBe("invalid_grant");

    // Another port, IPv6 loopback.
    const v6 = await nativeFlow(c, { redirect_uri: "http://[::1]:61000/cb" });
    expect(v6.done.body.redirect).toMatch(/^http:\/\/\[::1\]:61000\/cb\?code=/);
  });

  it("checks redirect URIs per client kind", () => {
    const loop = { id: "a", name: "A", redirect: "loopback" };
    expect(checkRedirectUri(loop, "http://127.0.0.1:1/x")).not.toBeNull();
    expect(checkRedirectUri(loop, "http://127.0.0.1:65535/")).not.toBeNull();
    expect(checkRedirectUri(loop, "http://[::1]:8080/cb?x=1")).not.toBeNull();
    for (const bad of [
      "http://localhost:8080/cb",
      "https://127.0.0.1:8080/cb",
      "http://127.0.0.1.evil.example/cb",
      "http://127.0.0.1:8080@evil.example/cb",
      "http://evil.example/cb",
      "http://127.0.0.1:70000/cb",
      "http://127.0.0.1:8080/cb#frag",
      "com.example.app:/cb",
    ]) {
      expect(checkRedirectUri(loop, bad)).toBeNull();
    }
    const scheme = { id: "m", name: "M", redirect: "com.kodasoken.kurahi" };
    expect(checkRedirectUri(scheme, "com.kodasoken.kurahi:/oauth")).not.toBeNull();
    expect(checkRedirectUri(scheme, "com.kodasoken.kurahi://host/oauth")).toBeNull();
    expect(checkRedirectUri(scheme, "http://127.0.0.1:8080/cb")).toBeNull();
    expect(checkRedirectUri(scheme, "com.kodasoken.kurahix:/oauth")).toBeNull();
  });

  it("refuses a non-loopback redirect for a loopback client without redirecting", async () => {
    const c = setup();
    for (const uri of ["https://evil.example/cb", "http://localhost:8080/cb"]) {
      const r = await authorize(c, { redirect_uri: uri });
      expect(r.status).toBe(400);
      expect(r.headers.location).toBeUndefined();
    }
  });

  it("refuses an unknown client with an error page", async () => {
    const c = setup();
    const r = await authorize(c, { client_id: "evil-app" });
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
    expect(r.body).toContain("not registered");
    const tok = await exchange(c, { client_id: "evil-app", code: "x" });
    expect(tok.body.error).toBe("invalid_client");
  });

  it("requires state", async () => {
    const c = setup();
    const r = await authorize(c, { state: "" });
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it("requires PKCE S256 (error back to the app)", async () => {
    const c = setup();
    for (const q of [{ code_challenge_method: "plain" }, { code_challenge: "" }]) {
      const r = await authorize(c, q);
      expect(r.status).toBe(302);
      const back = new URL(r.headers.location);
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("state")).toBe("st-1");
    }
  });

  it("refuses a wrong verifier, and the code is spent", async () => {
    const c = setup();
    const { done } = await nativeFlow(c);
    const code = new URL(done.body.redirect).searchParams.get("code") ?? "";
    const bad = await exchange(c, { code, code_verifier: "x".repeat(43) });
    expect(bad.body.error).toBe("invalid_grant");
    expect((await exchange(c, { code })).body.error).toBe("invalid_grant");
  });

  it("refuses a code for another redirect URI or after 60 seconds", async () => {
    const c = setup();
    const one = await nativeFlow(c);
    const code1 = new URL(one.done.body.redirect).searchParams.get("code") ?? "";
    const other = await exchange(c, {
      code: code1,
      redirect_uri: "http://127.0.0.1:1/callback",
    });
    expect(other.body.error).toBe("invalid_grant");
    const two = await nativeFlow(c);
    const code2 = new URL(two.done.body.redirect).searchParams.get("code") ?? "";
    c.clock.advance(61_000);
    expect((await exchange(c, { code: code2 })).body.error).toBe("invalid_grant");
  });

  it("needs the browser that started the request; works once", async () => {
    const c = setup();
    const a = await authorize(c);
    const request = new URL(a.headers.location, "https://g").searchParams.get("request") ?? "";
    const other = await call(
      c.h.completeNativeAuthorization,
      c.asPerson(
        post({ request, approve: true }, { cookie: "kurahi_oauth_req=" + "z".repeat(32) }),
      ),
    );
    expect(other.status).toBe(400);
    const { done, cookie, request: r2 } = await nativeFlow(c);
    expect(done.status).toBe(200);
    const again = await call(
      c.h.completeNativeAuthorization,
      c.asPerson(post({ request: r2, approve: true }, { cookie })),
    );
    expect(again.status).toBe(400);
  });

  it("sends access_denied to the app when the person cancels", async () => {
    const c = setup();
    const a = await authorize(c);
    const cookie = a.headers["set-cookie"].split(";")[0];
    const request = new URL(a.headers.location, "https://g").searchParams.get("request") ?? "";
    const r = await call(
      c.h.completeNativeAuthorization,
      c.asPerson(post({ request, approve: false }, { cookie })),
    );
    const back = new URL(r.body.redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.has("code")).toBe(false);
  });

  it("knows only the configured native clients", async () => {
    const c = setup({ nativeClients: [{ id: "acme-app", name: "Acme", redirect: "loopback" }] });
    expect((await authorize(c)).status).toBe(400);
    expect((await authorize(c, { client_id: "acme-app" })).status).toBe(303);
  });
});
