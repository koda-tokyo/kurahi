import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AuthAttemptLimiter } from "../gateway/rate-limiter.js";
import { authorizeSsoSession, createSsoHttpHandlers } from "./http.js";
import { createPasskeyHttpHandlers } from "./passkey-http.js";
import { enrolPasskey, passkeyService } from "./passkey-test-helpers.js";
import { base32Decode, totp } from "./totp.js";
import { TestAuthenticator } from "./webauthn/test-authenticator.js";

const ORIGIN = "https://kurahi.example.test";

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

function post(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const r = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
  const all: Record<string, string> = {
    "content-type": "application/json",
    origin: ORIGIN,
    ...headers,
  };
  // An empty value means "no such header".
  r.headers = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== ""));
  r.method = "POST";
  return r;
}

type Handlers = ReturnType<typeof createPasskeyHttpHandlers>;
type Name = keyof Handlers;

async function call(h: Handlers, name: Name, body: unknown, headers: Record<string, string> = {}) {
  const out = fakeRes();
  const req = post(body, headers);
  if (headers.authorization) {
    // As the router would: the sso-session authenticator attaches the person.
    authorizeSsoSession(req, { operationId: name, minScope: "observe" }, svcOf.get(h)!);
  }
  await (h[name] as (req: IncomingMessage, res: ServerResponse) => Promise<void> | void)(
    req,
    out.res,
  );
  return {
    status: out.res.statusCode,
    // Response bodies are read loosely: the shapes are asserted by the expectations.
    // oxlint-disable-next-line typescript/no-explicit-any
    body: JSON.parse(out.res.body || "{}") as Record<string, any>,
  };
}

const svcOf = new WeakMap<Handlers, ReturnType<typeof passkeyService>["svc"]>();

function setup(opts: Parameters<typeof passkeyService>[0] = {}, limiter?: AuthAttemptLimiter) {
  const env = passkeyService(opts);
  const h = createPasskeyHttpHandlers({
    service: () => env.svc,
    attemptKey: () => null,
    loginStartLimiter: limiter,
  });
  svcOf.set(h, env.svc);
  return { ...env, h };
}

async function httpSignIn(h: Handlers, a: TestAuthenticator) {
  const begin = await call(h, "beginPasskeyLogin", {});
  expect(begin.status).toBe(200);
  return call(h, "finishPasskeyLogin", {
    ceremonyId: begin.body.ceremonyId,
    credential: a.assert(begin.body.publicKey, ORIGIN),
  });
}

describe("passkey HTTP endpoints", () => {
  it("the SSO config advertises built-in sign-in", () => {
    const { svc } = setup();
    const sso = createSsoHttpHandlers({ service: () => svc, attemptKey: () => null });
    const out = fakeRes();
    sso.getSsoConfig({} as IncomingMessage, out.res);
    expect(JSON.parse(out.res.body)).toMatchObject({
      enabled: true,
      providers: [],
      passkeys: { enabled: true, totp: true },
    });
  });

  it("enrols with a code, signs in, and the token is a working SSO session", async () => {
    const { svc, h, person } = setup();
    const { code } = svc.passkeys.issueEnrollment(person.id, "person:admin");
    const a = new TestAuthenticator();
    const begin = await call(h, "beginPasskeyRegistration", { enrollmentCode: code });
    expect(begin.status).toBe(200);
    expect(begin.body.publicKey.rp).toEqual({ id: "kurahi.example.test", name: "Kurahi" });
    const fin = await call(h, "finishPasskeyRegistration", {
      ceremonyId: begin.body.ceremonyId,
      credential: a.register(begin.body.publicKey, ORIGIN),
      label: "Work laptop",
    });
    expect(fin.status).toBe(200);
    expect(fin.body.passkey).toMatchObject({ label: "Work laptop", synced: false });

    const signed = await httpSignIn(h, a);
    expect(signed.status).toBe(200);
    expect(signed.body.methods).toEqual(["hwk", "user"]);
    expect(signed.body.principal).toBe(`person:${person.id}`);
    const verified = svc.verifyToken(signed.body.token);
    expect(verified.ok && verified.principal.providerId).toBe("passkey");

    // Signed in, the person lists their passkeys and adds another one.
    const auth = { authorization: `Bearer ${signed.body.token}` };
    const list = await call(h, "listOwnAuthenticators", {}, auth);
    expect(list.body.passkeys).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(
      svc.authenticators.listPasskeys(person.id)[0].publicKey,
    );
    const more = await call(h, "beginPasskeyRegistration", {}, auth);
    expect(more.status).toBe(200);
    expect(more.body.publicKey.excludeCredentials).toHaveLength(1);
  });

  it("refuses other content types, foreign origins, bad bearers and replayed ceremonies", async () => {
    const { svc, h, person } = setup();
    const revokedCode = svc.passkeys.issueEnrollment(person.id, "person:admin");
    svc.authenticators.revokeEnrollment(revokedCode.enrollment.id);
    const a = enrolPasskey(svc, person.id);
    expect(
      (await call(h, "beginPasskeyLogin", "x=1", { "content-type": "text/plain" })).status,
    ).toBe(415);
    const foreign = await call(h, "beginPasskeyLogin", {}, { origin: "https://evil.example" });
    expect(foreign).toMatchObject({ status: 403, body: { error: { type: "origin_mismatch" } } });
    expect((await call(h, "beginPasskeyLogin", "{nope")).status).toBe(400);
    const bad = await call(h, "beginPasskeyRegistration", {}, { authorization: "Bearer kss_nope" });
    expect(bad).toMatchObject({ status: 401, body: { error: { type: "not_signed_in" } } });
    expect((await call(h, "beginPasskeyRegistration", {})).status).toBe(401);
    expect(
      await call(h, "beginPasskeyRegistration", { enrollmentCode: revokedCode.code }),
    ).toMatchObject({ status: 400, body: { error: { type: "enrollment_invalid" } } });

    const begin = await call(h, "beginPasskeyLogin", {});
    const assertion = a.assert(begin.body.publicKey, ORIGIN);
    const first = await call(h, "finishPasskeyLogin", {
      ceremonyId: begin.body.ceremonyId,
      credential: assertion,
    });
    expect(first.status).toBe(200);
    const replay = await call(h, "finishPasskeyLogin", {
      ceremonyId: begin.body.ceremonyId,
      credential: assertion,
    });
    expect(replay).toMatchObject({ status: 400, body: { error: { type: "ceremony_unknown" } } });
    // A wrong-origin assertion that reached the server anyway (no Origin header) is refused.
    const next = await call(h, "beginPasskeyLogin", {});
    const wrong = await call(
      h,
      "finishPasskeyLogin",
      {
        ceremonyId: next.body.ceremonyId,
        credential: a.assert(next.body.publicKey, "https://evil.example"),
      },
      { origin: "" },
    );
    expect(wrong.body.error?.type).toBe("origin_mismatch");
  });

  it("step-up and TOTP endpoints need the session; TOTP signs in and steps up", async () => {
    const { svc, h, person } = setup();
    const a = enrolPasskey(svc, person.id);
    const signed = await httpSignIn(h, a);
    const auth = { authorization: `Bearer ${signed.body.token}` };
    expect((await call(h, "beginPasskeyStepUp", {})).status).toBe(401);
    const begin = await call(h, "beginPasskeyStepUp", {}, auth);
    expect(begin.status).toBe(200);
    const fin = await call(
      h,
      "finishPasskeyStepUp",
      { ceremonyId: begin.body.ceremonyId, credential: a.assert(begin.body.publicKey, ORIGIN) },
      auth,
    );
    expect(fin).toMatchObject({
      status: 200,
      body: { ok: true, auth: { methods: ["hwk", "user"] } },
    });

    // Authenticator app, added while signed in.
    const tb = await call(h, "beginTotpEnrollment", {}, auth);
    expect(tb.status).toBe(200);
    expect(tb.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Kurahi:/);
    const secret = base32Decode(tb.body.secret) as Buffer;
    const t0 = Date.now() / 1000;
    const tf = await call(h, "finishTotpEnrollment", {
      ceremonyId: tb.body.ceremonyId,
      code: totp(secret, t0 - 30),
    });
    expect(tf.status).toBe(200);
    const login = await call(h, "verifyTotp", {
      userName: "aiko@example.com",
      code: totp(secret, t0),
    });
    expect(login).toMatchObject({ status: 200, body: { methods: ["otp"] } });
    const wrong = await call(h, "verifyTotp", { userName: "aiko@example.com", code: "000000" });
    expect(wrong).toMatchObject({ status: 400, body: { error: { type: "code_refused" } } });
    const up = await call(h, "stepUpTotp", { code: totp(secret, t0 + 30) }, auth);
    expect(up).toMatchObject({ status: 200, body: { auth: { methods: ["otp"] } } });
  });

  it("adding or replacing an authenticator while signed in needs a fresh authentication", async () => {
    const { svc, h, person } = setup();
    const a = enrolPasskey(svc, person.id);
    const signed = await httpSignIn(h, a);
    const auth = { authorization: `Bearer ${signed.body.token}` };
    const session = svc.sessions.get(signed.body.session.id)!;
    // A stolen session from ten minutes ago cannot add its own passkey or authenticator app.
    session.auth = { ...session.auth!, at: new Date(Date.now() - 600_000).toISOString() };
    for (const name of ["beginPasskeyRegistration", "beginTotpEnrollment"] as const) {
      const r = await call(h, name, {}, auth);
      expect(r, name).toMatchObject({
        status: 403,
        body: {
          error: {
            type: "step_up_required",
            details: { code: "step_up_required", action: "authenticatorChange", why: "stale" },
          },
        },
      });
    }
    // Fresh again (IdP or passkey step-up): a first authenticator app is fine.
    session.auth = { at: new Date().toISOString(), methods: ["pwd"], context: null };
    const tb = await call(h, "beginTotpEnrollment", {}, auth);
    expect(tb.status).toBe(200);
    const secret = base32Decode(tb.body.secret) as Buffer;
    expect(
      (
        await call(h, "finishTotpEnrollment", {
          ceremonyId: tb.body.ceremonyId,
          code: totp(secret, Date.now() / 1000),
        })
      ).status,
    ).toBe(200);
    // Replacing it: a fresh IdP password alone is not enough, a passkey (or a code) is.
    const replace = await call(h, "beginTotpEnrollment", {}, auth);
    expect(replace.body.error).toMatchObject({
      type: "step_up_required",
      details: { why: "method", requireMethods: ["otp", "hwk", "swk"] },
    });
    session.auth = { at: new Date().toISOString(), methods: ["hwk", "user"], context: null };
    expect((await call(h, "beginTotpEnrollment", {}, auth)).status).toBe(200);
  });

  it("is 404 when passkeys are off and rate-limits starts per source", async () => {
    const off = passkeyService();
    off.svc.updateSettings({
      ...off.svc.settings,
      passkeys: { ...off.svc.settings.passkeys, enabled: false },
    });
    const h0 = createPasskeyHttpHandlers({ service: () => off.svc, attemptKey: () => null });
    svcOf.set(h0, off.svc);
    expect((await call(h0, "beginPasskeyLogin", {})).status).toBe(404);

    const { h } = setup({}, new AuthAttemptLimiter(2, 60_000));
    expect((await call(h, "beginPasskeyLogin", {})).status).toBe(200);
    expect((await call(h, "beginPasskeyLogin", {})).status).toBe(200);
    expect((await call(h, "beginPasskeyLogin", {})).status).toBe(429);
  });
});
