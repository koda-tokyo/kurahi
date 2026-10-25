import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { resolveIdentitySettings } from "../identity/config.js";
import { IdentityService, setIdentityServiceForTest } from "../identity/service.js";
import { SessionStore } from "../identity/sessions.js";
import { IdentityStore } from "../identity/store.js";
import { setPersonReevaluateIntervalForTest } from "./server/ws-connection/person-watch.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const openWs = async (port: number) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

// The provider the sessions below are opened through (a session of an unconfigured provider ends).
const corp = {
  providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "kurahi" }],
};

function useService(over: Record<string, unknown> = {}) {
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      defaultRole: "member",
      ...over,
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
    },
  );
  setIdentityServiceForTest(svc);
  return svc;
}

function signIn(svc: IdentityService) {
  const r = svc.signIn({
    providerId: "corp",
    protocol: "oidc",
    issuer: "https://idp.example.test",
    subject: "s-1",
    email: "alice@example.com",
    emailVerified: true,
    displayName: "Alice",
    givenName: null,
    familyName: null,
    groups: [],
    idTokenHint: null,
  });
  if (!r.ok) {
    throw new Error(r.reason);
  }
  return r;
}

describe("gateway enterprise identity (WebSocket)", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let port: number;

  beforeAll(async () => {
    port = await getFreePort();
    server = await startGatewayServer(port);
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => setIdentityServiceForTest(null));

  test("an SSO session token connects as a person with role scopes", async () => {
    const svc = useService(corp);
    const { token, principal } = signIn(svc);
    const ws = await openWs(port);
    const res = await connectReq(ws, {
      token,
      client: { id: "kolo-control-ui", version: "1", platform: "test", mode: "webchat" },
    });
    expect(res.ok).toBe(true);
    // No device token is minted for a person (it would outlive the SSO session).
    expect((res.payload as { auth?: unknown }).auth).toBeUndefined();
    const who = await rpcReq(ws, "identity.whoami", {});
    expect(who.payload).toMatchObject({
      kind: "person",
      principal: principal.principal,
      scope: "attach",
    });
    // member: attach scope, no admin methods.
    const cfg = await rpcReq(ws, "config.get", {});
    expect(cfg.ok).toBe(false);
    ws.close();
  });

  test("a revoked session closes the connection at once", async () => {
    const svc = useService(corp);
    const { token, principal } = signIn(svc);
    const ws = await openWs(port);
    expect((await connectReq(ws, { token })).ok).toBe(true);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    svc.revokePersonSessions(principal.personId, "scim_deactivated", "test");
    expect(await closed).toBe(4001);
  });

  test("deactivating the person in the directory closes the connection at once", async () => {
    const svc = useService(corp);
    const { token, principal } = signIn(svc);
    const ws = await openWs(port);
    expect((await connectReq(ws, { token })).ok).toBe(true);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    // A directory change alone (no session revocation): the open socket re-evaluates.
    svc.store.updatePerson(principal.personId, { active: false });
    expect(await closed).toBe(4001);
  });

  test("an idle connection closes when its session expires", async () => {
    let now = Date.now();
    const svc = new IdentityService(
      resolveIdentitySettings({
        publicUrl: "https://gateway.example.test",
        defaultRole: "member",
        ...corp,
      }),
      {
        store: new IdentityStore({ filePath: null }),
        sessions: new SessionStore({ filePath: null, now: () => now }),
      },
    );
    setIdentityServiceForTest(svc);
    setPersonReevaluateIntervalForTest(50);
    try {
      const { token, principal } = signIn(svc);
      const ws = await openWs(port);
      expect((await connectReq(ws, { token })).ok).toBe(true);
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      const session = svc.sessions.get(principal.sessionId);
      now = Date.parse(session?.expiresAt ?? "") + 1;
      if (session) {
        session.lastSeenAt = new Date(now).toISOString();
      }
      expect(await closed).toBe(4001);
    } finally {
      setPersonReevaluateIntervalForTest(null);
    }
  });

  test("an unknown SSO token is refused", async () => {
    useService();
    const ws = await openWs(port);
    const res = await connectReq(ws, { token: "kss_not-a-real-session-token-000000000000" });
    expect(res.ok).toBe(false);
    ws.close();
  });

  test("SSO required blocks token login except an audited break-glass", async () => {
    useService({ ssoRequired: true });
    const ws = await openWs(port);
    const refused = await connectReq(ws);
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("SSO is required");
    ws.close();

    const ws2 = await openWs(port);
    const glass = await connectReq(ws2, { breakGlass: "IdP outage, ticket 42" });
    expect(glass.ok).toBe(true);
    const who = await rpcReq(ws2, "identity.whoami", {});
    expect(who.payload).toMatchObject({ kind: "owner", breakGlass: true });
    ws2.close();
  });

  test("with SSO configured, an owner-token CLI connection cannot decide", async () => {
    useService({
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "kurahi" },
      ],
    });
    const ws = await openWs(port);
    const cli = { id: "cli", version: "1", platform: "test", mode: "cli", displayName: "Alice" };
    expect((await connectReq(ws, { client: cli })).ok).toBe(true);
    const decide = await rpcReq(ws, "workitems.decide", {
      projectId: "p",
      id: "w",
      decision: "approve",
    });
    expect(decide.ok).toBe(false);
    expect((decide.error as { details?: { code?: string } })?.details?.code).toBe("not_a_person");
    ws.close();
  });

  test("SSO required: a local backend-mode connection is admitted, audited, never a person", async () => {
    useService({ ssoRequired: true });
    const ws = await openWs(port);
    const backend = { id: "gateway-client", version: "1", platform: "test", mode: "backend" };
    expect((await connectReq(ws, { client: backend })).ok).toBe(true);
    const who = await rpcReq(ws, "identity.whoami", {});
    expect(who.payload).toMatchObject({ kind: "agent" });
    const stop = await rpcReq(ws, "autopilot.stopAll", { reason: "x" });
    expect(stop.ok).toBe(false);
    expect((stop.error as { details?: { code?: string } })?.details?.code).toBe("not_a_person");
    ws.close();
  });

  test("SSO required: the gateway token over loopback HTTP needs a break-glass reason", async () => {
    useService({ ssoRequired: true });
    const token =
      (testState.gatewayAuth as { token?: string } | undefined)?.token ??
      process.env.KOLO_GATEWAY_TOKEN ??
      "";
    const get = (headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/api/policy/status`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
    expect((await get()).status).toBe(401);
    const ok = await get({ "x-kolo-break-glass": encodeURIComponent("IdP 障害, ticket 42") });
    expect(ok.status).toBe(200);
    // Without SSO required, the token works as before.
    useService();
    expect((await get()).status).toBe(200);
  });

  test("SSO required: /metrics and /api/admin/* take the gateway token only as break-glass", async () => {
    useService({ ssoRequired: true });
    const token =
      (testState.gatewayAuth as { token?: string } | undefined)?.token ??
      process.env.KOLO_GATEWAY_TOKEN ??
      "";
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
    for (const path of ["/metrics", "/api/admin/status"]) {
      expect((await get(path)).status).toBe(401);
      expect((await get(path, { "x-kolo-break-glass": "IdP outage" })).status).not.toBe(401);
    }
    useService();
    expect((await get("/metrics")).status).toBe(200);
  });

  test("identity configured: a break-glass owner cannot approve or decide, but may pause", async () => {
    useService({
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "kurahi" },
      ],
    });
    const ws = await openWs(port);
    const cli = { id: "cli", version: "1", platform: "test", mode: "cli" };
    expect((await connectReq(ws, { client: cli, breakGlass: "IdP outage" })).ok).toBe(true);
    const code = (r: { error?: unknown }) =>
      (r.error as { details?: { code?: string } } | undefined)?.details?.code;
    for (const [method, params] of [
      ["workitems.decide", { projectId: "p", id: "w", decision: "approve" }],
      ["autopilot.approvals.create", { projectId: "p", routineId: "r" }],
      ["autopilot.startAll", { reason: "x" }],
    ] as const) {
      const res = await rpcReq(ws, method, params);
      expect(res.ok, method).toBe(false);
      expect(code(res), method).toBe("not_a_person");
      expect(res.error?.message, method).toContain("needs an SSO sign-in");
    }
    // Recovery powers stay: pause gets past the person gate (and fails on the unknown project).
    const pause = await rpcReq(ws, "autopilot.pause", { projectId: "p", routineId: "r" });
    expect(code(pause)).not.toBe("not_a_person");
    ws.close();
  });

  test("SSO required: a node needs its device identity, the shared token alone is refused", async () => {
    useService({ ssoRequired: true });
    const node = { id: "node-host", version: "1", platform: "test", mode: "node" };
    const ws = await openWs(port);
    const bare = await connectReq(ws, { role: "node", client: node, device: null });
    expect(bare.ok).toBe(false);
    expect(bare.error?.message).toContain("paired device");
    ws.close();
    // With a device identity (local, so pairing approves it silently) the node connects.
    const ws2 = await openWs(port);
    expect((await connectReq(ws2, { role: "node", client: node })).ok).toBe(true);
    ws2.close();
  });
});
