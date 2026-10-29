import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { RuntimeEnv } from "../runtime.js";
import { runDemoInviteCreate, runDemoInviteList, runDemoInviteRevoke } from "../cli/demo-cli.js";
import { DemoInviteStore, setDemoInviteStoreForTest } from "../packaging/demo-invites.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const openWs = async (port: number) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

function invite(store: DemoInviteStore, projectId: string) {
  const created = store.create({ label: "Tanaka, Example Corp", projectId });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created;
}

describe("gateway connect with a demo invite code", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let port: number;
  let store: DemoInviteStore;
  const prevDemo = process.env.KURAHI_DEMO;

  beforeAll(async () => {
    port = await getFreePort();
    server = await startGatewayServer(port);
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    setDemoInviteStoreForTest(null);
    if (prevDemo === undefined) {
      delete process.env.KURAHI_DEMO;
    } else {
      process.env.KURAHI_DEMO = prevDemo;
    }
  });

  function freshStore() {
    store = new DemoInviteStore({ filePath: null, audit: (event) => ({ ts: "", ...event }) });
    setDemoInviteStoreForTest(store);
    return store;
  }

  test("is refused outside the demo profile", async () => {
    delete process.env.KURAHI_DEMO;
    const { code } = invite(freshStore(), "pdemoe2e001");
    const ws = await openWs(port);
    const res = await connectReq(ws, { token: code });
    expect(res.ok).toBe(false);
    ws.close();
  });

  test("signs in a visitor with no device token, gated to its Project's chats", async () => {
    process.env.KURAHI_DEMO = "1";
    const created = invite(freshStore(), "pdemoe2e002");
    const ws = await openWs(port);
    const res = await connectReq(ws, { token: created.code, scopes: ["operator.admin"] });
    expect(res.ok).toBe(true);
    expect((res.payload as { auth?: unknown }).auth).toBeUndefined();

    const admin = await rpcReq(ws, "config.get", {});
    expect(admin.ok).toBe(false);
    expect(admin.error?.message).toMatch(/method not allowed for a demo invite/);

    const other = await rpcReq(ws, "chat.history", { sessionKey: "agent:main:main" });
    expect(other.ok).toBe(false);
    expect(other.error?.message).toMatch(/session not allowed/);

    store.revoke(created.invite.id);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    const afterRevoke = await rpcReq(ws, "config.get", {});
    expect(afterRevoke.ok).toBe(false);
    expect(afterRevoke.error?.message).toMatch(/demo invite revoked/);
    // The socket is closed with the handshake's refusal, so the dashboard shows the invite notice.
    expect(await closed).toEqual({
      code: 1008,
      reason: "unauthorized: demo invite revoked (ask for a new invite link)",
    });
  });

  test("refuses an unknown code, a revoked code and a node role", async () => {
    process.env.KURAHI_DEMO = "1";
    const s = freshStore();
    const created = invite(s, "pdemoe2e003");

    const unknown = await openWs(port);
    const unknownRes = await connectReq(unknown, { token: "kdi_not-a-real-code" });
    expect(unknownRes.ok).toBe(false);
    expect(unknownRes.error?.message).toBe(
      "unauthorized: demo invite not valid (ask for a new invite link)",
    );
    unknown.close();

    const node = await openWs(port);
    expect((await connectReq(node, { token: created.code, role: "node" })).ok).toBe(false);
    node.close();

    s.revoke(created.invite.id);
    const revoked = await openWs(port);
    const revokedRes = await connectReq(revoked, { token: created.code });
    expect(revokedRes.ok).toBe(false);
    expect(revokedRes.error?.message).toBe(
      "unauthorized: demo invite revoked (ask for a new invite link)",
    );
    revoked.close();
  });

  test("a busy invites file is a retryable refusal, not an ended invite", async () => {
    process.env.KURAHI_DEMO = "1";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-demo-busy-"));
    try {
      const filePath = path.join(dir, "demo-invites.json");
      const s = new DemoInviteStore({
        filePath,
        audit: (e) => ({ ts: "", ...e }),
        lockTimeoutMs: 20,
      });
      setDemoInviteStoreForTest(s);
      const created = invite(s, "pdemoe2e005");
      // The operator's CLI holds the file while the visitor signs in.
      fs.writeFileSync(`${filePath}.lock`, "1\n");
      const ws = await openWs(port);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.once("close", (c, reason) => resolve({ code: c, reason: reason.toString() })),
      );
      const res = await connectReq(ws, { token: created.code });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toBe("unavailable: demo invites are busy; try again");
      expect(res.error?.retryable).toBe(true);
      // 1013 (try again later), not 1008: the dashboard keeps retrying instead of ending the invite.
      expect(await closed).toEqual({
        code: 1013,
        reason: "unavailable: demo invites are busy; try again",
      });

      fs.rmSync(`${filePath}.lock`, { force: true });
      const retry = await openWs(port);
      expect((await connectReq(retry, { token: created.code })).ok).toBe(true);
      retry.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an operator's CLI invite link signs a visitor in and a CLI revoke ends the session", async () => {
    process.env.KURAHI_DEMO = "1";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-demo-smoke-"));
    try {
      const filePath = path.join(dir, "demo-invites.json");
      const fileStore = () => new DemoInviteStore({ filePath, audit: (e) => ({ ts: "", ...e }) });
      // The gateway and each CLI run hold separate stores over one file, like separate processes.
      setDemoInviteStoreForTest(fileStore());
      const out: string[] = [];
      const runtime: RuntimeEnv = {
        log: (...args) => void out.push(args.join(" ")),
        error: (...args) => void out.push(args.join(" ")),
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      };
      const deps = { runtime, store: fileStore, env: { KURAHI_DEMO: "1" } };

      const created = runDemoInviteCreate(
        { project: "pdemoe2e004", label: "Tanaka, Example Corp", url: "https://demo.example/" },
        deps,
      );
      expect(created).toBe(0);
      const link =
        out
          .find((l) => l.trim().startsWith("Link"))
          ?.trim()
          .split(/\s+/)[1] ?? "";
      const code = new URLSearchParams(new URL(link).hash.slice(1)).get("invite") ?? "";
      expect(code).toMatch(/^kdi_/);

      const ws = await openWs(port);
      expect((await connectReq(ws, { token: code })).ok).toBe(true);

      out.length = 0;
      expect(runDemoInviteList({ json: true }, deps)).toBe(0);
      const [row] = JSON.parse(out.join("\n")) as Array<{ id: string; lastUsedAt?: string }>;
      expect(row?.lastUsedAt).toBeTruthy();

      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.once("close", (c, reason) => resolve({ code: c, reason: reason.toString() })),
      );
      expect(runDemoInviteRevoke(row.id, deps)).toBe(0);
      expect((await rpcReq(ws, "config.get", {})).ok).toBe(false);
      expect(await closed).toEqual({
        code: 1008,
        reason: "unauthorized: demo invite revoked (ask for a new invite link)",
      });

      const again = await openWs(port);
      const againRes = await connectReq(again, { token: code });
      expect(againRes.ok).toBe(false);
      expect(againRes.error?.message).toBe(
        "unauthorized: demo invite revoked (ask for a new invite link)",
      );
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
