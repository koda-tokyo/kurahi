import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AuditEvent } from "../security/audit-log.js";
import {
  DEMO_INVITES_FILENAME,
  DEMO_INVITE_CODE_PREFIX,
  DemoInviteStore,
  MAX_DEMO_INVITE_DAYS,
  authorizeDemoInviteConnect,
  demoInviteAdmitsSession,
  demoInviteRefusalMessage,
  demoVisitorRequestError,
} from "./demo-invites.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-demo-invites-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60 * 1000;

function harness(filePath: string | null = null) {
  let nowMs = Date.parse("2026-10-28T00:00:00.000Z");
  const events: Omit<AuditEvent, "ts">[] = [];
  const store = new DemoInviteStore({
    filePath,
    now: () => new Date(nowMs),
    audit: (event) => {
      events.push(event);
      return { ts: "", ...event };
    },
  });
  return { store, events, advance: (ms: number) => (nowMs += ms) };
}

describe("demo invites", () => {
  it("binds one person to one Project for seven days by default", () => {
    const { store, advance } = harness();
    const created = store.create({ label: "Tanaka, Example Corp", projectId: "pdemobiz001" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    expect(created.code.startsWith(DEMO_INVITE_CODE_PREFIX)).toBe(true);
    expect(created.invite.expiresAt).toBe("2026-11-04T00:00:00.000Z");

    const first = store.resolve(created.code);
    expect(first.ok && first.invite.projectId).toBe("pdemobiz001");
    advance(6 * DAY_MS);
    expect(store.resolve(created.code).ok).toBe(true);
    advance(DAY_MS);
    expect(store.resolve(created.code)).toEqual({ ok: false, reason: "expired" });
  });

  it("caps the expiry and refuses a second live invite on the same Project", () => {
    const { store, events } = harness();
    const long = store.create({ label: "A", projectId: "pdemoaaa001", days: 365 });
    expect(long.ok && Date.parse(long.invite.expiresAt) - Date.parse(long.invite.createdAt)).toBe(
      MAX_DEMO_INVITE_DAYS * DAY_MS,
    );
    expect(store.create({ label: "B", projectId: "pdemoaaa001" })).toEqual({
      ok: false,
      reason: "project_has_active_invite",
    });
    expect(events.at(-1)).toMatchObject({ action: "demo.invite.create", outcome: "denied" });
    if (long.ok) {
      store.revoke(long.invite.id);
    }
    expect(store.create({ label: "B", projectId: "pdemoaaa001" }).ok).toBe(true);
  });

  it("refuses revoked, unknown and malformed input", () => {
    const { store } = harness();
    const created = store.create({ label: "C", projectId: "pdemoaaa002" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    store.revoke(created.invite.id);
    expect(store.resolve(created.code)).toEqual({ ok: false, reason: "revoked" });
    expect(store.resolve("kdi_nope")).toEqual({ ok: false, reason: "unknown_code" });
    expect(store.revoke("dinv_nope")).toEqual({ ok: false, reason: "unknown_invite" });
    expect(store.create({ label: "  ", projectId: "pdemoaaa003" })).toEqual({
      ok: false,
      reason: "invalid_label",
    });
    expect(store.create({ label: "D", projectId: "pdemoaaa003\n" })).toEqual({
      ok: false,
      reason: "invalid_project",
    });
  });

  it("persists hashes only, 0600, and survives a restart", () => {
    const file = path.join(root, "secrets", "demo-invites.json");
    const { store } = harness(file);
    const created = store.create({ label: "E", projectId: "pdemoaaa004" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(created.code);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const reloaded = harness(file).store;
    expect(reloaded.resolve(created.code).ok).toBe(true);
    expect(reloaded.list().map((invite) => invite.projectId)).toEqual(["pdemoaaa004"]);
  });

  it("sees what another process wrote: a revoke bites and nothing is clobbered", () => {
    const file = path.join(root, "shared", "demo-invites.json");
    const gateway = harness(file).store;
    const operator = harness(file).store;
    const first = operator.create({ label: "F", projectId: "pdemoaaa008" });
    if (!first.ok) {
      throw new Error(first.reason);
    }
    // The gateway store was built before the invite existed.
    expect(gateway.resolve(first.code).ok).toBe(true);

    const second = operator.create({ label: "G", projectId: "pdemoaaa009" });
    if (!second.ok) {
      throw new Error(second.reason);
    }
    operator.revoke(first.invite.id);
    expect(gateway.resolve(first.code)).toEqual({ ok: false, reason: "revoked" });
    // A sign-in on the gateway persists lastUsedAt; it must not drop the operator's invite.
    expect(gateway.resolve(second.code).ok).toBe(true);
    expect(
      harness(file)
        .store.list()
        .map((invite) => invite.projectId),
    ).toEqual(["pdemoaaa008", "pdemoaaa009"]);
    expect(operator.create({ label: "H", projectId: "pdemoaaa009" })).toEqual({
      ok: false,
      reason: "project_has_active_invite",
    });
  });

  it("never loses a revoke that lands while the gateway is writing a sign-in", () => {
    const file = path.join(root, "race", "demo-invites.json");
    const operator = new DemoInviteStore({ filePath: file, audit: () => ({}) as AuditEvent });
    const created = operator.create({ label: "R", projectId: "pdemoaaa010" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    // The operator revokes from another process between the gateway's read and its write.
    let interleaved: unknown = null;
    const gateway = new DemoInviteStore({
      filePath: file,
      audit: () => ({}) as AuditEvent,
      lockTimeoutMs: 50,
      now: () => {
        if (interleaved === null) {
          try {
            interleaved = operator.revoke(created.invite.id);
          } catch (err) {
            interleaved = err;
          }
        }
        return new Date();
      },
    });
    gateway.resolve(created.code);
    if (interleaved instanceof Error) {
      // Refused while the gateway held the file; the operator tries again.
      expect(interleaved.message).toMatch(/busy/);
      expect(operator.revoke(created.invite.id).ok).toBe(true);
    }
    expect(new DemoInviteStore({ filePath: file }).check(created.invite.id)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("only accepts real Project ids", () => {
    const { store } = harness();
    for (const projectId of [
      "demo-business-1",
      "p1",
      "PDEMOAAA005",
      "pdemoaaa005-x",
      "../pdemoaaa",
    ]) {
      expect(store.create({ label: "F", projectId })).toEqual({
        ok: false,
        reason: "invalid_project",
      });
    }
  });

  it("admits only the chats of the invite's own Project", () => {
    const invite = { projectId: "pdemoaaa006" };
    expect(demoInviteAdmitsSession(invite, "agent:main:proj-pdemoaaa006-c1")).toBe(true);
    expect(demoInviteAdmitsSession(invite, "agent:ops:proj-pdemoaaa006-deptsales0ab")).toBe(true);
    for (const key of [
      "agent:main:proj-pdemoaaa007-c1",
      "agent:main:main",
      "agent:main:x:proj-pdemoaaa006-c1",
      "agent:main:proj-pdemoaaa006-c1:x",
      "proj-pdemoaaa006-c1",
      "pdemoaaa006",
      "",
    ]) {
      expect(demoInviteAdmitsSession(invite, key)).toBe(false);
    }
  });

  it("re-checks a signed-in visitor by invite id on every request", () => {
    const { store, events, advance } = harness();
    const created = store.create({ label: "I", projectId: "pdemoaaa010" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const before = events.length;
    expect(store.check(created.invite.id)).toMatchObject({ ok: true });
    expect(store.list()[0]?.lastUsedAt).toBeUndefined();
    expect(events.length).toBe(before);
    expect(store.check("dinv_nope")).toEqual({ ok: false, reason: "unknown_invite" });
    advance(8 * DAY_MS);
    expect(store.check(created.invite.id)).toEqual({ ok: false, reason: "expired" });
    const second = store.create({ label: "J", projectId: "pdemoaaa010" });
    if (!second.ok) {
      throw new Error(second.reason);
    }
    store.revoke(second.invite.id);
    expect(store.check(second.invite.id)).toEqual({ ok: false, reason: "revoked" });
  });

  it("lets a demo visitor drive only its own Project's chats", () => {
    const invite = { projectId: "pdemoaaa011" };
    const own = "agent:main:proj-pdemoaaa011-c1";
    for (const method of ["chat.send", "chat.history", "chat.abort"]) {
      expect(demoVisitorRequestError(invite, method, { sessionKey: own })).toBeNull();
      expect(
        demoVisitorRequestError(invite, method, { sessionKey: "agent:main:proj-pdemoaaa012-c1" }),
      ).toMatch(/session not allowed/);
      expect(demoVisitorRequestError(invite, method, {})).toMatch(/session not allowed/);
    }
    expect(demoVisitorRequestError(invite, "session.attach", { key: own })).toBeNull();
    expect(
      demoVisitorRequestError(invite, "session.attach", { key: own, channel: "line", to: "u1" }),
    ).toMatch(/session not allowed/);
    expect(
      demoVisitorRequestError(invite, "chat.send", { sessionKey: own, agentId: "ops" }),
    ).toMatch(/session not allowed/);
    for (const method of [
      "agent",
      "send",
      "sessions.list",
      "sessions.patch",
      "config.get",
      "projects.list",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(demoVisitorRequestError(invite, method, { sessionKey: own })).toMatch(
        /method not allowed/,
      );
    }
  });

  it("signs in with a code only under the demo profile, as an operator, with fixed scopes", () => {
    const { store } = harness();
    const created = store.create({ label: "K", projectId: "pdemoaaa012" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const demo = { KURAHI_DEMO: "1" };
    expect(
      authorizeDemoInviteConnect({ code: created.code, role: "operator", env: {}, store }),
    ).toEqual({ ok: false, reason: "demo_disabled" });
    expect(
      authorizeDemoInviteConnect({ code: created.code, role: "node", env: demo, store }),
    ).toEqual({ ok: false, reason: "demo_role" });
    expect(
      authorizeDemoInviteConnect({ code: "kdi_nope", role: "operator", env: demo, store }),
    ).toEqual({ ok: false, reason: "demo_unknown_code" });
    expect(
      authorizeDemoInviteConnect({ code: created.code, role: "operator", env: demo, store }),
    ).toEqual({
      ok: true,
      visitor: { inviteId: created.invite.id, projectId: "pdemoaaa012" },
      scopes: ["operator.read", "operator.write"],
    });
    store.revoke(created.invite.id);
    expect(
      authorizeDemoInviteConnect({ code: created.code, role: "operator", env: demo, store }),
    ).toEqual({ ok: false, reason: "demo_revoked" });
  });

  it("answers a sign-in that finds the invites file busy with a retryable refusal", () => {
    const file = path.join(root, "busy", DEMO_INVITES_FILENAME);
    const store = new DemoInviteStore({
      filePath: file,
      audit: () => ({}) as AuditEvent,
      lockTimeoutMs: 20,
    });
    const created = store.create({ label: "K", projectId: "pdemoaaa013" });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    // The operator's CLI holds the file (a fresh lock, not a stale one).
    fs.writeFileSync(`${file}.lock`, "1\n");
    try {
      expect(
        authorizeDemoInviteConnect({
          code: created.code,
          role: "operator",
          env: { KURAHI_DEMO: "1" },
          store,
        }),
      ).toEqual({ ok: false, reason: "demo_busy" });
    } finally {
      fs.rmSync(`${file}.lock`, { force: true });
    }
    expect(demoInviteRefusalMessage("busy")).toBe("unavailable: demo invites are busy; try again");
    expect(
      authorizeDemoInviteConnect({
        code: created.code,
        role: "operator",
        env: { KURAHI_DEMO: "1" },
        store,
      }).ok,
    ).toBe(true);
  });
});
