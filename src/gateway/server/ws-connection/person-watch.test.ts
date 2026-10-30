import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayWsClient } from "../ws-types.js";
import { resolveIdentitySettings } from "../../../identity/config.js";
import { IdentityService } from "../../../identity/service.js";
import { SessionStore } from "../../../identity/sessions.js";
import { IdentityStore } from "../../../identity/store.js";
import { createGatewayBroadcaster } from "../../server-broadcast.js";
import { PERSON_REEVALUATE_MS, watchPersonConnection } from "./person-watch.js";

let clock = Date.parse("2026-10-01T00:00:00Z");

function setup() {
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      defaultRole: "member",
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "kurahi" },
      ],
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null, now: () => clock }),
    },
  );
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
    auth: { at: new Date().toISOString(), methods: ["pwd"], context: null },
  });
  if (!r.ok) {
    throw new Error(r.reason);
  }
  const sent: string[] = [];
  const client = {
    socket: { bufferedAmount: 0, send: (f: string) => sent.push(f), close: () => {} },
    connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
    connId: "c1",
    person: r.principal,
  } as unknown as GatewayWsClient;
  const close = vi.fn();
  const stop = watchPersonConnection({
    client,
    sessionId: r.principal.sessionId,
    identity: svc,
    close,
  });
  return { svc, client, close, stop, sent, principal: r.principal };
}

const flush = () => Promise.resolve();

describe("watchPersonConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    clock = Date.parse("2026-10-01T00:00:00Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes with 4001 once the session reaches its absolute lifetime", () => {
    const { svc, close, principal } = setup();
    const session = svc.sessions.get(principal.sessionId);
    clock = Date.parse(session?.expiresAt ?? "") + 1;
    // Keep the idle timer from being what ends it.
    if (session) {
      session.lastSeenAt = new Date(clock).toISOString();
    }
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PERSON_REEVALUATE_MS);
    expect(close).toHaveBeenCalledWith(4001, "session ended");
  });

  it("closes with 4001 after the idle timeout", () => {
    const { svc, close, principal } = setup();
    const session = svc.sessions.get(principal.sessionId);
    clock += (session?.idleTimeoutMs ?? 0) + 1;
    vi.advanceTimersByTime(PERSON_REEVALUATE_MS);
    expect(close).toHaveBeenCalledWith(4001, "session ended");
  });

  it("closes at once when the person is deactivated in the directory", async () => {
    const { svc, close, principal } = setup();
    svc.store.updatePerson(principal.personId, { active: false });
    await flush();
    expect(close).toHaveBeenCalledWith(4001, "session ended");
  });

  it("refreshes scopes at once on a role change, and broadcasts follow them", async () => {
    const { svc, client, sent, principal } = setup();
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([client]) });
    broadcast("exec.approval.requested", { id: "a1" });
    expect(sent).toHaveLength(0);

    const grant = svc.store.assign(`person:${principal.personId}`, "org-admin", null, "test");
    await flush();
    expect(client.connect.scopes).toContain("operator.approvals");
    broadcast("exec.approval.requested", { id: "a2" });
    expect(sent).toHaveLength(1);

    svc.store.revokeAssignment(grant.id);
    await flush();
    expect(client.connect.scopes).not.toContain("operator.approvals");
    broadcast("exec.approval.requested", { id: "a3" });
    expect(sent).toHaveLength(1);
  });

  it("stops its timer and listeners when the connection closes", async () => {
    const { svc, close, stop, principal } = setup();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    svc.store.updatePerson(principal.personId, { active: false });
    svc.revokePersonSessions(principal.personId, "test", "test");
    await flush();
    expect(close).not.toHaveBeenCalled();
  });
});
