import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KoLoConfig } from "../config/config.js";

// Secure default: a session that must be sandboxed but cannot be (no container runtime) keeps
// running, with exec refused and file tools inside the workspace. Never a silent host fallback.

const dirs: string[] = [];
function tmp(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.doUnmock("node:child_process");
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("sandbox unavailable", () => {
  it("resolves to unavailable (not a thrown run) when the container runtime is missing", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
        }),
      };
    });
    const { resolveSandboxContextOrUnavailable } = await import("./sandbox.js");
    const root = tmp("kurahi-sbx-root-");
    const cfg: KoLoConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceRoot: root } },
        list: [{ id: "main" }],
      },
    };
    const res = await resolveSandboxContextOrUnavailable({
      config: cfg,
      sessionKey: "agent:main:telegram:group:42",
      workspaceDir: tmp("kurahi-sbx-ws-"),
    });
    expect(res.sandbox).toBeNull();
    expect(res.unavailable?.reason).toMatch(/docker/i);
  }, 20_000);

  it("never sandboxes a project session (the project scope confines it instead)", async () => {
    const { resolveSandboxRuntimeStatus } = await import("./sandbox/runtime-status.js");
    const cfg: KoLoConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
    expect(
      resolveSandboxRuntimeStatus({ cfg, sessionKey: "agent:main:proj-pabcdefghij-c1" }).sandboxed,
    ).toBe(false);
    expect(
      resolveSandboxRuntimeStatus({ cfg, sessionKey: "agent:main:telegram:group:42" }).sandboxed,
    ).toBe(true);
  });

  it("the tool set refuses exec and keeps file tools inside the workspace", async () => {
    const { createKoLoCodingTools } = await import("./pi-tools.js");
    const ws = tmp("kurahi-degraded-ws-");
    const outside = tmp("kurahi-degraded-out-");
    fs.writeFileSync(path.join(ws, "inside.txt"), "inside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
    const tools = createKoLoCodingTools({
      workspaceDir: ws,
      sessionKey: "agent:main:telegram:group:42",
      config: { plugins: { enabled: false }, tools: { exec: { unsandboxed: "host" } } },
      sandboxUnavailable: { reason: "spawn docker ENOENT" },
    });
    const exec = tools.find((t) => t.name === "exec");
    const read = tools.find((t) => t.name === "read");
    expect(exec && read).toBeTruthy();
    await expect(exec!.execute("e1", { command: "echo hi" }, undefined)).rejects.toThrow(
      /sandbox is not available \(spawn docker ENOENT\)/,
    );
    const ok = await read!.execute("r1", { path: path.join(ws, "inside.txt") }, undefined);
    expect(JSON.stringify(ok.content)).toContain("inside");
    await expect(
      read!.execute("r2", { path: path.join(outside, "secret.txt") }, undefined),
    ).rejects.toThrow();
  });
});
