import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const audits: Array<{ action: string; outcome: string }> = [];
vi.mock("../../audit/audit-log.js", () => ({
  auditSafe: async (input: { action: string; outcome: string }) => {
    audits.push(input);
    return null;
  },
}));

const { debugHandlers } = await import("./debug.js");
const { writeDebugProfileFiles } = await import("../../cli/debug-cli.js");
const { wsMethodMinScope } = await import("../scopes.js");
const { BASE_GATEWAY_METHODS } = await import("../server-methods-list.js");

function call(params: Record<string, unknown>) {
  return new Promise<{ ok: boolean; payload: unknown; error: unknown }>((resolve) => {
    void debugHandlers["debug.profile"]({
      params,
      client: null,
      respond: (ok: boolean, payload: unknown, error: unknown) => resolve({ ok, payload, error }),
    } as unknown as GatewayRequestHandlerOptions);
  });
}

describe("debug.profile", () => {
  test("is a listed, admin-only method", () => {
    expect(BASE_GATEWAY_METHODS).toContain("debug.profile");
    expect(wsMethodMinScope("debug.profile")).toBe("admin");
  });

  test("captures, audits, and the CLI writes devtools + pprof files", async () => {
    const res = await call({ seconds: 1, heap: true });
    expect(res.ok).toBe(true);
    const payload = res.payload as Parameters<typeof writeDebugProfileFiles>[0];
    expect(payload.pid).toBe(process.pid);
    expect(payload.seconds).toBe(1);
    expect(payload.cpuProfileGzB64.length).toBeGreaterThan(0);
    expect(payload.heapProfileGzB64).toBeTruthy();
    expect(audits.at(-1)).toMatchObject({ action: "debug.profile", outcome: "ok" });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-debug-profile-"));
    try {
      const files = writeDebugProfileFiles(payload, dir);
      const cpu = JSON.parse(fs.readFileSync(files.cpuprofile, "utf8")) as { nodes: unknown[] };
      expect(cpu.nodes.length).toBeGreaterThan(0);
      expect(fs.statSync(files.cpuPprof!).size).toBeGreaterThan(0);
      expect(fs.existsSync(files.heapprofile!)).toBe(true);
      expect(fs.statSync(files.heapPprof!).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a concurrent capture is refused and audited as denied", async () => {
    const first = call({ seconds: 1 });
    const second = await call({ seconds: 1 });
    expect(second.ok).toBe(false);
    expect(audits.at(-1)).toMatchObject({ action: "debug.profile", outcome: "denied" });
    expect((await first).ok).toBe(true);
  });
});
