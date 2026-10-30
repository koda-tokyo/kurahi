import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { PersonPrincipal, SignInAuth, SignInClaims } from "./types.js";
import { resolveIdentitySettings, resolveStepUp, type StepUpSettings } from "./config.js";
import { createSsoHttpHandlers, setHttpPersonForTest } from "./http.js";
import { IdentityService } from "./service.js";
import { SessionStore } from "./sessions.js";
import { checkStepUp, stepUpCovers, stepUpGate } from "./step-up.js";
import { IdentityStore } from "./store.js";
import { CLIENT_ID, fakeIdp, ISSUER } from "./test-helpers.js";

const NOW = Date.parse("2026-10-30T03:00:00Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const auth = (secAgo: number, methods = ["pwd"]): SignInAuth => ({
  at: at(secAgo),
  methods,
  context: null,
});
const settings = (over: Partial<StepUpSettings> = {}): StepUpSettings => ({
  ...resolveStepUp(undefined, true),
  ...over,
});

describe("step-up policy", () => {
  it("defaults are safe: on with identity configured, 300 s, every action covered", () => {
    expect(resolveStepUp(undefined, true)).toEqual({
      enabled: true,
      maxAgeSec: 300,
      requireMethods: [],
      approvals: { enabled: true, amountAtLeast: null, amountField: "amount" },
      autopilotLevel: true,
      emergencyStopRelease: true,
      identityAdmin: true,
      authenticatorChange: true,
      governance: true,
    });
    expect(resolveStepUp(undefined, false).enabled).toBe(false);
    expect(resolveStepUp({ maxAgeSeconds: 5 }, true).maxAgeSec).toBe(30);
    expect(resolveStepUp({ maxAgeSeconds: 99_999 }, true).maxAgeSec).toBe(3600);
    expect(
      resolveStepUp(
        { actions: { approvals: { amountAtLeast: 100_000, amountField: "total" } } },
        true,
      ).approvals,
    ).toEqual({ enabled: true, amountAtLeast: 100_000, amountField: "total" });
    expect(resolveIdentitySettings({ providers: [], ssoRequired: true }).stepUp.enabled).toBe(true);
    expect(resolveIdentitySettings({}).stepUp.enabled).toBe(false);
  });

  it.each([
    ["fresh", auth(10), {}, { ok: true, covered: true }],
    ["exactly at the limit", auth(300), {}, { ok: true, covered: true }],
    ["stale", auth(301), {}, { ok: false, why: "stale" }],
    ["old session (no auth)", null, {}, { ok: false, why: "no_auth" }],
    [
      "unparseable time",
      { at: "yesterday", methods: [], context: null },
      {},
      { ok: false, why: "no_auth" },
    ],
    ["from the future beyond skew", auth(-600), {}, { ok: false, why: "stale" }],
    ["slightly in the future (skew)", auth(-30), {}, { ok: true, covered: true }],
    [
      "required method present",
      auth(10, ["pwd", "hwk"]),
      { requireMethods: ["hwk", "mfa"] },
      { ok: true, covered: true },
    ],
    [
      "required method missing",
      auth(10, ["pwd"]),
      { requireMethods: ["hwk"] },
      { ok: false, why: "method" },
    ],
    [
      "stale wins over method",
      auth(900, ["pwd"]),
      { requireMethods: ["hwk"] },
      { ok: false, why: "stale" },
    ],
    ["disabled", null, { enabled: false }, { ok: true, covered: false }],
    ["shorter max age", auth(61), { maxAgeSec: 60 }, { ok: false, why: "stale" }],
  ] as const)("%s", (_name, a, over, expected) => {
    const r = checkStepUp({
      settings: settings(over as Partial<StepUpSettings>),
      auth: a as SignInAuth | null,
      action: "approval",
      now: NOW,
      skewSec: 120,
    });
    expect(r).toMatchObject(expected);
    if (!r.ok) {
      expect(r.reason).toBe("step_up_required");
      expect(r.maxAgeSeconds).toBe(settings(over as Partial<StepUpSettings>).maxAgeSec);
    }
  });

  it.each([
    ["approval, no threshold", "approval", {}, {}, true],
    ["approval below threshold", "approval", { amount: 99_999 }, { min: 100_000 }, false],
    ["approval at threshold", "approval", { amount: 100_000 }, { min: 100_000 }, true],
    ["approval without an amount", "approval", { amount: null }, { min: 100_000 }, false],
    ["approval with a non-numeric amount", "approval", { amount: NaN }, { min: 100_000 }, true],
    ["approvals off", "approval", {}, { approvalsOff: true }, false],
    ["autopilot level", "autopilotLevel", {}, {}, true],
    ["emergency stop release off", "emergencyStopRelease", {}, { stopOff: true }, false],
    ["identity admin", "identityAdmin", {}, {}, true],
    [
      "clearing a flag (always) below threshold",
      "approval",
      { amount: 1, always: true },
      { min: 100_000 },
      true,
    ],
    ["authenticator change", "authenticatorChange", {}, {}, true],
    ["governance", "governance", {}, {}, true],
  ] as const)("covers: %s", (_name, action, ctx, o, expected) => {
    const opts = o as { min?: number; approvalsOff?: boolean; stopOff?: boolean };
    const s = settings({
      approvals: {
        enabled: !opts.approvalsOff,
        amountAtLeast: opts.min ?? null,
        amountField: "amount",
      },
      emergencyStopRelease: !opts.stopOff,
    });
    expect(stepUpCovers(s, action, ctx)).toBe(expected);
    // Not covered: allowed even for an old session.
    expect(checkStepUp({ settings: s, auth: null, action, context: ctx, now: NOW }).ok).toBe(
      !expected,
    );
  });
});

describe("step-up extras", () => {
  it("context methods add a proof on top of freshness (replacing an authenticator app)", () => {
    const base = { settings: settings(), action: "authenticatorChange" as const, now: NOW };
    const proof = { methods: ["otp", "hwk", "swk"] };
    expect(checkStepUp({ ...base, auth: auth(10, ["pwd"]), context: proof })).toMatchObject({
      ok: false,
      why: "method",
      requireMethods: ["otp", "hwk", "swk"],
    });
    expect(checkStepUp({ ...base, auth: auth(10, ["otp"]), context: proof }).ok).toBe(true);
    expect(checkStepUp({ ...base, auth: auth(900, ["hwk"]), context: proof })).toMatchObject({
      why: "stale",
    });
  });
});

// ---- the IdP round trip ----

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

function postJson(body: unknown, person?: PersonPrincipal): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  r.headers = { "content-type": "application/json" };
  r.method = "POST";
  if (person) {
    setHttpPersonForTest(r, person);
  }
  return r;
}

const claims = (over: Partial<SignInClaims> = {}): SignInClaims => ({
  providerId: "corp",
  protocol: "oidc",
  issuer: ISSUER,
  subject: "user-1",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  givenName: null,
  familyName: null,
  groups: [],
  idTokenHint: null,
  auth: { at: new Date(Date.now() - 3_600_000).toISOString(), methods: ["pwd"], context: null },
  ...over,
});

function setup() {
  const idp = fakeIdp();
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      defaultRole: "approver",
      providers: [
        {
          id: "corp",
          kind: "oidc",
          issuer: ISSUER,
          clientId: CLIENT_ID,
          stepUpAcrValues: ["urn:example:mfa"],
        },
      ],
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
      oidc: { fetch: idp.fetch },
    },
  );
  const h = createSsoHttpHandlers({ service: () => svc, attemptKey: () => null });
  // Alice signed in an hour ago (the IdP's subject user-1).
  const signed = svc.signIn(claims());
  if (!signed.ok) {
    throw new Error(signed.reason);
  }
  return { idp, svc, h, principal: signed.principal, token: signed.token };
}

async function startStepUp(s: ReturnType<typeof setup>, body: unknown = { returnTo: "/business" }) {
  const out = fakeRes();
  await s.h.startStepUp(postJson(body, s.principal), out.res);
  return {
    status: out.res.statusCode,
    body: JSON.parse(out.res.body || "{}") as { url?: string; error?: { type?: string } },
    cookie: (out.headers["set-cookie"] ?? "").split(";")[0],
  };
}

async function callback(s: ReturnType<typeof setup>, url: string, cookie: string) {
  const { code, state } = s.idp.authorize(url);
  const cb = fakeRes();
  await s.h.ssoCallback({ headers: { cookie } } as unknown as IncomingMessage, cb.res, {
    url: new URL(
      `https://gateway.example.test/api/identity/sso/corp/callback?code=${code}&state=${state}`,
    ),
    params: { provider: "corp" },
  });
  return cb.headers.location ?? "";
}

describe("step-up through the IdP", () => {
  it("OIDC asks for a fresh login (max_age=0, prompt=login, acr_values)", async () => {
    const s = setup();
    const r = await startStepUp(s);
    expect(r.status).toBe(200);
    const u = new URL(r.body.url!);
    expect(u.searchParams.get("max_age")).toBe("0");
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("acr_values")).toBe("urn:example:mfa");
    expect(r.cookie).toMatch(/^kurahi_sso_bind=/);
  });

  it("an ordinary sign-in does not force a login", async () => {
    const s = setup();
    const out = fakeRes();
    await s.h.startSsoLogin({ headers: {} } as unknown as IncomingMessage, out.res, {
      url: new URL("https://gateway.example.test/api/identity/sso/corp/login"),
      params: { provider: "corp" },
    });
    const u = new URL(out.headers.location);
    expect(u.searchParams.has("max_age")).toBe(false);
    expect(u.searchParams.has("prompt")).toBe(false);
  });

  it("the same person's fresh login refreshes this session: no new session, no code", async () => {
    const s = setup();
    const before = s.svc.sessions.listForPerson(s.principal.personId).length;
    const r = await startStepUp(s);
    s.idp.nextClaims = {
      auth_time: Math.floor(Date.now() / 1000),
      amr: ["pwd", "hwk"],
      acr: "urn:example:mfa",
    };
    const location = await callback(s, r.body.url!, r.cookie);
    expect(location).toBe("/business#sso_stepup=ok");
    expect(location).not.toContain("sso_code");
    expect(s.svc.sessions.listForPerson(s.principal.personId)).toHaveLength(before);
    const session = s.svc.sessions.get(s.principal.sessionId)!;
    expect(session.auth?.methods).toEqual(["pwd", "hwk"]);
    expect(session.auth?.context).toBe("urn:example:mfa");
    // The same token now passes the step-up gate.
    const v = s.svc.verifyToken(s.token);
    expect(v.ok && v.principal.personId).toBe(s.principal.personId);
    const gate = stepUpGate(v.ok ? v.principal : null, "approval", {}, { service: s.svc });
    expect(gate).toMatchObject({ ok: true, evidence: { stepUp: true, protocol: "oidc" } });
  });

  it("another person at the IdP is refused; the session keeps its old authentication", async () => {
    const s = setup();
    const old = s.svc.sessions.get(s.principal.sessionId)!.auth;
    const r = await startStepUp(s);
    s.idp.nextClaims = { sub: "user-2", auth_time: Math.floor(Date.now() / 1000) };
    const location = await callback(s, r.body.url!, r.cookie);
    expect(location).toBe("/business#sso_error=person_mismatch");
    expect(s.svc.sessions.get(s.principal.sessionId)!.auth).toEqual(old);
    expect(s.svc.store.findByLink("corp", ISSUER, "user-2")).toBeNull();
  });

  it("an IdP that ignores prompt=login (old auth_time) is refused as not fresh", async () => {
    const s = setup();
    const r = await startStepUp(s);
    s.idp.nextClaims = { auth_time: Math.floor(Date.now() / 1000) - 3600 };
    expect(await callback(s, r.body.url!, r.cookie)).toBe("/business#sso_error=not_fresh");
  });

  it("an IdP that leaves out auth_time is refused: the token's iat never counts", async () => {
    const s = setup();
    const before = s.svc.sessions.get(s.principal.sessionId)!.auth;
    const r = await startStepUp(s);
    s.idp.nextClaims = {};
    expect(await callback(s, r.body.url!, r.cookie)).toContain("sso_error=not_fresh");
    expect(s.svc.sessions.get(s.principal.sessionId)!.auth).toEqual(before);
  });

  it("the gate reads the session as it is now: a step-up counts for the very next request", () => {
    const s = setup();
    // The principal a connection resolved before the step-up (an hour-old authentication).
    const stale = s.principal;
    expect(stepUpGate(stale, "approval", {}, { service: s.svc }).ok).toBe(false);
    s.svc.sessions.refreshAuth(stale.sessionId, {
      at: new Date().toISOString(),
      methods: ["hwk"],
      context: null,
    });
    expect(stepUpGate(stale, "approval", {}, { service: s.svc })).toMatchObject({
      ok: true,
      evidence: { methods: ["hwk"], stepUp: true },
    });
  });

  it("a step-up authentication may precede the start by 5 seconds at most", () => {
    const s = setup();
    const startedAt = Date.now() - 1000;
    const flow = { sessionId: s.principal.sessionId, personId: s.principal.personId, startedAt };
    const at = (ms: number) =>
      claims({ auth: { at: new Date(ms).toISOString(), methods: [], context: null } });
    expect(s.svc.completeStepUp(at(startedAt - 6000), flow)).toEqual({
      ok: false,
      reason: "not_fresh",
    });
    expect(s.svc.completeStepUp(at(startedAt - 4000), flow).ok).toBe(true);
  });

  it("a step-up needs the session and a provider the person is linked to", async () => {
    const s = setup();
    const out = fakeRes();
    await s.h.startStepUp(postJson({}), out.res);
    expect(out.res.statusCode).toBe(401);
    const other = await startStepUp(s, { provider: "elsewhere" });
    expect(other.status).toBe(400);
    expect(other.body.error?.type).toBe("no_provider");
  });

  it("completeStepUp never switches persons or revives an ended session (SAML claims too)", () => {
    const s = setup();
    const flow = {
      sessionId: s.principal.sessionId,
      personId: s.principal.personId,
      startedAt: Date.now() - 1000,
    };
    const fresh = { at: new Date().toISOString(), methods: ["hwk"], context: "x509" };
    const saml = claims({ protocol: "saml", auth: fresh });
    expect(s.svc.completeStepUp({ ...saml, subject: "intruder" }, flow)).toEqual({
      ok: false,
      reason: "person_mismatch",
    });
    expect(
      s.svc.completeStepUp({ ...saml, auth: { ...fresh, at: new Date(0).toISOString() } }, flow),
    ).toEqual({ ok: false, reason: "not_fresh" });
    expect(s.svc.completeStepUp(saml, { ...flow, personId: "someone-else" })).toEqual({
      ok: false,
      reason: "session_ended",
    });
    expect(s.svc.completeStepUp(saml, flow).ok).toBe(true);
    s.svc.sessions.revoke(s.principal.sessionId, "logout");
    expect(s.svc.completeStepUp(saml, flow)).toEqual({ ok: false, reason: "session_ended" });
  });
});
