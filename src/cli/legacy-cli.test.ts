import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { loadLegacyMcpModules, resolveLegacyMcpDir, runLegacyMcp } from "./legacy-cli.js";
import { getSubCliEntries } from "./program/register.subclis.js";

function fakeRuntime() {
  const errors: string[] = [];
  const runtime: RuntimeEnv = {
    log: () => {},
    error: (...args: unknown[]) => void errors.push(args.join(" ")),
    exit: ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  };
  return { runtime, errors };
}

describe("kurahi legacy mcp", () => {
  it("is registered as a sub-CLI", () => {
    expect(getSubCliEntries().map((e) => e.name)).toContain("legacy");
  });

  it("finds and loads the bundled server module", async () => {
    expect(fs.existsSync(path.join(resolveLegacyMcpDir(), "server.ts"))).toBe(true);
    const mods = await loadLegacyMcpModules();
    expect(typeof mods.runLegacyMcpStdio).toBe("function");
    expect(typeof mods.startLegacyMcpHttp).toBe("function");
  });

  it("reports a missing bundle clearly", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-cli-"));
    expect(() => resolveLegacyMcpDir(empty)).toThrow(/not installed/);
  });

  it("rejects bad options with exit 2 before loading anything", async () => {
    const load = vi.fn();
    for (const opts of [{}, { root: "/x", http: "70000" }, { root: "/x", maxBytes: "10" }]) {
      const { runtime, errors } = fakeRuntime();
      await expect(runLegacyMcp(opts, { runtime, load })).rejects.toThrow("exit 2");
      expect(errors[0]).toMatch(/^kurahi legacy mcp: /);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("serves stdio by default with the resolved root", async () => {
    const runLegacyMcpStdio = vi.fn(async () => {});
    const startLegacyMcpHttp = vi.fn();
    await runLegacyMcp(
      { root: "proj", maxBytes: "8192" },
      {
        runtime: fakeRuntime().runtime,
        load: async () => ({ runLegacyMcpStdio, startLegacyMcpHttp }),
      },
    );
    expect(runLegacyMcpStdio).toHaveBeenCalledWith({ root: path.resolve("proj"), maxBytes: 8192 });
    expect(startLegacyMcpHttp).not.toHaveBeenCalled();
  });
});
