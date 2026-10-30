import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AuthAttemptLimiter } from "../gateway/rate-limiter.js";
import { resolveIdentitySettings } from "./config.js";
import {
  authorizeSsoSession,
  consoleReturnTo,
  createSsoHttpHandlers,
  getHttpPerson,
  safeReturnTo,
  SSO_CODE_TTL_MS,
} from "./http.js";
import { IdentityService } from "./service.js";
import { SessionStore } from "./sessions.js";
import { IdentityStore } from "./store.js";
import { fakeIdp, ISSUER, CLIENT_ID } from "./test-helpers.js";

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

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;

/** POST /api/identity/sso/exchange with a JSON body and the browser's cookie. */
function postJson(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  r.headers = { "content-type": "application/json", ...headers };
  r.method = "POST";
  return r;
}

type Handlers = ReturnType<typeof createSsoHttpHandlers>;

async function exchange(h: Handlers, code: string, cookie: string) {
  const out = fakeRes();
  await h.exchangeSsoCode(postJson({ code }, { cookie }), out.res);
  return {
    status: out.res.statusCode,
    body: JSON.parse(out.res.body || "{}") as { token?: string; error?: { type?: string } },
  };
}

/** Sign in through the fake IdP; returns the callback Location and the binding cookie. */
async function signInFlow(h: Handlers, idp: ReturnType<typeof fakeIdp>, returnTo?: string) {
  const login = fakeRes();
  const q = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  await h.startSsoLogin(req(), login.res, {
    url: new URL(`https://gateway.example.test/api/identity/sso/corp/login${q}`),
    params: { provider: "corp" },
  });
  const { code, state } = idp.authorize(login.headers.location);
  const cookie = login.headers["set-cookie"].split(";")[0];
  const cb = fakeRes();
  await h.ssoCallback(req({ cookie }), cb.res, {
    url: new URL(
      `https://gateway.example.test/api/identity/sso/corp/callback?code=${code}&state=${state}`,
    ),
    params: { provider: "corp" },
  });
  return { location: cb.headers.location, cookie, setCookie: cb.headers["set-cookie"] };
}

const codeOf = (location: string) => location.split("#sso_code=")[1] ?? "";

function setup() {
  const idp = fakeIdp();
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [
        {
          id: "corp",
          kind: "oidc",
          issuer: ISSUER,
          clientId: CLIENT_ID,
          trustEmailForLinking: true,
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
  return { idp, svc, h };
}

describe("SSO HTTP endpoints", () => {
  it("only same-origin paths are return targets", () => {
    expect(safeReturnTo("/console?tab=chat")).toBe("/console?tab=chat");
    for (const bad of [
      "https://evil.example",
      "//evil.example/x",
      "/\\evil",
      "/a#b",
      "",
      "javascript:x",
    ]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });

  it("dot segments, encoded dots and backslashes never normalise to another host", () => {
    for (const bad of [
      "/.//evil.com",
      "/..//evil.com",
      "/%2e%2e//evil.com",
      "/%2E//evil.com/x?y=1",
      "/a/../..//evil.com",
      "/\\evil.com",
      "/\\\\evil.com",
      "/%5c%5cevil.com",
      "/%5C/evil.com",
      "/%2f/evil.com",
      "/x/%2e%2e",
      "/%0d%0aSet-Cookie:x",
    ]) {
      expect(safeReturnTo(bad), bad).toBe("/");
    }
    // Ordinary console paths (and encoded characters in the query) still work.
    expect(safeReturnTo("/chat?session=agent%3Amain%2Fx")).toBe("/chat?session=agent%3Amain%2Fx");
    expect(safeReturnTo("/ops/.well")).toBe("/ops/.well");
  });

  it("a crafted returnTo cannot carry the session token to another host", async () => {
    const { idp, svc, h } = setup();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["member"], units: [] },
      "test",
    );
    for (const returnTo of [
      "/.//evil.com",
      "/..//evil.com",
      "/%2e%2e//evil.com",
      "/%5c%5cevil.com",
    ]) {
      const login = fakeRes();
      await h.startSsoLogin(req(), login.res, {
        url: new URL(
          `https://gateway.example.test/api/identity/sso/corp/login?returnTo=${encodeURIComponent(returnTo)}`,
        ),
        params: { provider: "corp" },
      });
      const { code, state } = idp.authorize(login.headers.location);
      const cookie = login.headers["set-cookie"].split(";")[0];
      const cb = fakeRes();
      await h.ssoCallback(req({ cookie }), cb.res, {
        url: new URL(
          `https://gateway.example.test/api/identity/sso/corp/callback?code=${code}&state=${state}`,
        ),
        params: { provider: "corp" },
      });
      const location = cb.headers.location;
      expect(location, returnTo).toMatch(/^\/(?![/\\])/);
      expect(location.startsWith("/#sso_code="), returnTo).toBe(true);
    }
  });

  it("login → IdP → callback returns the session token in the fragment", async () => {
    const { idp, svc, h } = setup();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["approver"], units: [] },
      "test",
    );
    const login = fakeRes();
    await h.startSsoLogin(req(), login.res, {
      url: new URL("https://gateway.example.test/api/identity/sso/corp/login?returnTo=/console"),
      params: { provider: "corp" },
    });
    expect(login.res.statusCode).toBe(302);
    const { code, state } = idp.authorize(login.headers.location);
    const cookie = login.headers["set-cookie"].split(";")[0];
    expect(login.headers["set-cookie"]).toContain("HttpOnly; SameSite=None; Secure");
    const cb = fakeRes();
    await h.ssoCallback(req({ cookie }), cb.res, {
      url: new URL(
        `https://gateway.example.test/api/identity/sso/corp/callback?code=${code}&state=${state}`,
      ),
      params: { provider: "corp" },
    });
    expect(cb.res.statusCode).toBe(302);
    expect(cb.headers["cache-control"]).toBe("no-store");
    const location = cb.headers.location;
    // The fragment carries a one-time code, never the session token.
    expect(location).toMatch(/^\/console#sso_code=[A-Za-z0-9_-]{43}$/);
    expect(location).not.toContain("kss_");
    const exchanged = await exchange(h, codeOf(location), cookie);
    expect(exchanged.status).toBe(200);
    const token = exchanged.body.token ?? "";
    expect(token).toMatch(/^kss_/);
    expect(svc.verifyToken(token).ok).toBe(true);

    // Logout ends the session and offers the IdP logout URL.
    const r = req({ authorization: `Bearer ${token}` });
    expect(
      authorizeSsoSession(r, { operationId: "logoutIdentity", minScope: "observe" }, svc),
    ).toBe(true);
    expect(getHttpPerson(r)?.email).toBe("alice@example.com");
    const out = fakeRes();
    await h.logoutIdentity(r, out.res);
    expect(JSON.parse(out.res.body)).toMatchObject({
      ok: true,
      endSessionUrl: expect.stringContaining(`${ISSUER}/logout`),
    });
    expect(svc.verifyToken(token).ok).toBe(false);
  });

  it("the one-time code works once, only in the signing-in browser, and only briefly", async () => {
    let t = 1_000_000;
    const { idp, svc } = setup();
    const h = createSsoHttpHandlers({ service: () => svc, attemptKey: () => null, now: () => t });
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["member"], units: [] },
      "test",
    );
    // Single use.
    const first = await signInFlow(h, idp, "/chat");
    expect(first.setCookie).toContain("Max-Age=60");
    expect((await exchange(h, codeOf(first.location), first.cookie)).status).toBe(200);
    const replay = await exchange(h, codeOf(first.location), first.cookie);
    expect(replay).toMatchObject({ status: 400, body: { error: { type: "code_unknown" } } });
    // Another browser (no or another binding cookie): refused, and the code is burnt.
    const second = await signInFlow(h, idp, "/chat");
    const other = await exchange(
      h,
      codeOf(second.location),
      "kurahi_sso_bind=another-browser-0000",
    );
    expect(other).toMatchObject({ status: 400, body: { error: { type: "browser_mismatch" } } });
    expect((await exchange(h, codeOf(second.location), second.cookie)).status).toBe(400);
    // Expired: refused, and the session nobody can hold is ended.
    const third = await signInFlow(h, idp, "/chat");
    const live = () => svc.sessions.listForPerson(svc.store.listPersons()[0]?.id ?? "").length;
    const sessionsBefore = live();
    t += SSO_CODE_TTL_MS + 1;
    const late = await exchange(h, codeOf(third.location), third.cookie);
    expect(late).toMatchObject({ status: 400, body: { error: { type: "code_expired" } } });
    expect(live()).toBe(sessionsBefore - 1);
    expect((await exchange(h, "", third.cookie)).status).toBe(400);
  });

  it("returnTo must be a console route under the control UI base path", async () => {
    const gatewayPaths = new Set(["/api/policy/status", "/plugins/widget"]);
    const isGatewayPath = (p: string) => gatewayPaths.has(p) || p.startsWith("/plugins/widget/");
    const root = (raw: string) => consoleReturnTo(raw, { basePath: "", isGatewayPath });
    expect(root("/chat?session=main")).toBe("/chat?session=main");
    expect(root("/agents/fleet")).toBe("/agents/fleet");
    for (const bad of [
      "/__KOLO__/canvas/index.html",
      "/__KOLO__/a2ui/",
      "/avatar/main",
      "/api/policy/status",
      "/plugins/widget/page",
      "/v1/models",
      "/scim/v2/Users",
      "/index.html",
      "/assets/app.js",
    ]) {
      expect(root(bad), bad).toBe("/");
    }
    const ui = (raw: string) => consoleReturnTo(raw, { basePath: "/ui", isGatewayPath });
    expect(ui("/ui/chat")).toBe("/ui/chat");
    expect(ui("/ui")).toBe("/ui");
    for (const bad of ["/chat", "/uix/chat", "/__KOLO__/canvas/", "/ui/x.html"]) {
      expect(ui(bad), bad).toBe("/ui/");
    }
    // Through the handler: the code goes back to the console root, not the canvas page.
    const { idp, svc } = setup();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["member"], units: [] },
      "test",
    );
    const h = createSsoHttpHandlers({
      service: () => svc,
      attemptKey: () => null,
      consoleBasePath: "/ui",
      isGatewayPath,
    });
    const flow = await signInFlow(h, idp, "/__KOLO__/canvas/index.html");
    expect(flow.location.startsWith("/ui/#sso_code=")).toBe(true);
  });

  it("the command-line and native sign-in pages are return targets, with their parameter only", async () => {
    const { idp, svc, h } = setup();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["member"], units: [] },
      "test",
    );
    const device = await signInFlow(h, idp, "/api/identity/device?user_code=bcdf-ghjk");
    expect(device.location).toMatch(
      /^\/api\/identity\/device\?user_code=BCDF-GHJK#sso_code=[A-Za-z0-9_-]{43}$/,
    );
    const id = "R".repeat(43);
    const native = await signInFlow(h, idp, `/api/identity/oauth/continue?request=${id}`);
    expect(native.location.startsWith(`/api/identity/oauth/continue?request=${id}#sso_code=`)).toBe(
      true,
    );
    const other = await signInFlow(h, idp, "/api/identity/device/lookup");
    expect(other.location).toMatch(/^\/#sso_code=/);
  });

  it("rate-limits sign-in starts per source", async () => {
    const { svc } = setup();
    const h = createSsoHttpHandlers({
      service: () => svc,
      attemptKey: () => "203.0.113.5",
      loginStartLimiter: new AuthAttemptLimiter(2, 60_000),
    });
    const start = async () => {
      const r = fakeRes();
      await h.startSsoLogin(req(), r.res, {
        url: new URL("https://gateway.example.test/api/identity/sso/corp/login"),
        params: { provider: "corp" },
      });
      return r;
    };
    expect((await start()).res.statusCode).toBe(302);
    expect((await start()).res.statusCode).toBe(302);
    const third = await start();
    expect(third.res.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeTruthy();
  });

  it("rate-limits sign-in starts across all sources too", async () => {
    const { svc } = setup();
    let n = 0;
    const h = createSsoHttpHandlers({
      service: () => svc,
      attemptKey: () => `203.0.113.${(n += 1)}`,
      globalLoginStartLimiter: new AuthAttemptLimiter(3, 60_000),
    });
    const start = async () => {
      const r = fakeRes();
      await h.startSsoLogin(req(), r.res, {
        url: new URL("https://gateway.example.test/api/identity/sso/corp/login"),
        params: { provider: "corp" },
      });
      return r.res.statusCode;
    };
    // A new source every time: the per-source limit never triggers, the global one does.
    expect([await start(), await start(), await start()]).toEqual([302, 302, 302]);
    expect(await start()).toBe(429);
  });

  it("a refused sign-in comes back as #sso_error without a token", async () => {
    const { idp, h } = setup();
    const login = fakeRes();
    await h.startSsoLogin(req(), login.res, {
      url: new URL("https://gateway.example.test/api/identity/sso/corp/login"),
      params: { provider: "corp" },
    });
    const { code, state } = idp.authorize(login.headers.location);
    const cookie = login.headers["set-cookie"].split(";")[0];
    expect(login.headers["set-cookie"]).toContain("HttpOnly; SameSite=None; Secure");
    const cb = fakeRes();
    await h.ssoCallback(req({ cookie }), cb.res, {
      url: new URL(
        `https://gateway.example.test/api/identity/sso/corp/callback?code=${code}&state=${state}`,
      ),
      params: { provider: "corp" },
    });
    // No mapping and no default role: the person has no role.
    expect(cb.headers.location).toBe("/#sso_error=no_role");
  });

  it("a callback in another browser (no binding cookie) is refused: login CSRF", async () => {
    const { idp, svc, h } = setup();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["member"], units: [] },
      "test",
    );
    const login = fakeRes();
    await h.startSsoLogin(req(), login.res, {
      url: new URL("https://gateway.example.test/api/identity/sso/corp/login"),
      params: { provider: "corp" },
    });
    const { code, state } = idp.authorize(login.headers.location);
    const cb = fakeRes();
    await h.ssoCallback(req({ cookie: "kurahi_sso_bind=someone-elses-binding-value" }), cb.res, {
      url: new URL(
        `https://gateway.example.test/api/identity/sso/corp/callback?code=${code}&state=${state}`,
      ),
      params: { provider: "corp" },
    });
    expect(cb.headers.location).toBe("/#sso_error=browser_mismatch");
  });

  it("auditors read audit and evidence routes over HTTP; other routes need the scope", () => {
    const { svc } = setup();
    svc.store.assign("email:audit@example.com", "auditor", null, "test");
    const r = svc.signIn({
      providerId: "corp",
      protocol: "oidc",
      issuer: ISSUER,
      subject: "a",
      email: "audit@example.com",
      emailVerified: true,
      displayName: null,
      givenName: null,
      familyName: null,
      groups: [],
      idTokenHint: null,
      auth: { at: new Date().toISOString(), methods: ["pwd"], context: null },
    });
    if (!r.ok) {
      throw new Error(r.reason);
    }
    const auth = (operationId: string, minScope: "observe" | "attach" | "admin") =>
      authorizeSsoSession(
        req({ authorization: `Bearer ${r.token}` }),
        { operationId, minScope },
        svc,
      );
    expect(auth("exportJobEvidence", "admin")).toBe(true);
    expect(auth("getAuditChain", "admin")).toBe(true);
    expect(auth("killPolicy", "admin")).toBe("forbidden");
    expect(
      authorizeSsoSession(
        req({ authorization: "Bearer kss_bogus_token_value_000000" }),
        { operationId: "x", minScope: "observe" },
        svc,
      ),
    ).toBe(false);
  });
});
