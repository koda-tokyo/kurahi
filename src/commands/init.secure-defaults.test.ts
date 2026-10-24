import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { loadPolicyFile } from "../policy/load.js";
import { resolvePolicyLocations } from "../policy/paths.js";
import { buildDoctorJsonReport } from "./doctor-json.js";
import { initCommand } from "./init.js";

vi.mock(import("../audit/audit-log.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  auditSafe: vi.fn(async () => null),
  appendAudit: vi.fn(async () => null as never),
}));
// No container runtime on this machine: init must say so, not fail.
vi.mock(import("./doctor-sandbox.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  isDockerAvailable: vi.fn(async () => false),
}));

const prevEnv = { ...process.env };
const dirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-init-secure-"));
  dirs.push(dir);
  return dir;
}

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (...a: unknown[]) => lines.push(a.join(" ")),
    error: (...a: unknown[]) => errors.push(a.join(" ")),
    exit: () => {},
  } as RuntimeEnv;
  return { runtime, lines, errors };
}

beforeEach(() => {
  delete process.env.KOLO_CONFIG_PATH;
  process.env.KOLO_SECRETS_BACKEND = "file";
  process.env.KOLO_SECRETS_KEY = "init-secure-test-key-0123456789abcdef";
  process.env.KOLO_DISABLE_CONFIG_CACHE = "1";
});

afterEach(() => {
  process.env = { ...prevEnv };
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("kurahi init: secure defaults for new installations", () => {
  test("a fresh install gets isolation, the sandbox, exec approvals and a signed starter policy", async () => {
    const home = tempHome();
    const run = capture();
    await initCommand({ nonInteractive: true, stateDir: home, name: "alice" }, run.runtime);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "kolo.json"), "utf8"));
    expect(cfg.auth).toMatchObject({ isolation: "explicit", grants: { alice: ["*"] } });
    expect(cfg.agents.defaults.sandbox).toEqual({ mode: "non-main", workspaceAccess: "rw" });
    expect(cfg.tools.exec.unsandboxed).toBe("approve");
    expect(cfg.integrity.supplyChain.mode).toBe("enforce");
    expect(cfg.memory.provenance.mode).toBe("enforce");
    expect(cfg.agents.messaging.signing.mode).toBe("enforce");

    const loc = resolvePolicyLocations({ ...process.env, KOLO_HOME: home });
    const policy = loadPolicyFile(loc);
    expect(policy.state).toBe("loaded");
    if (policy.state === "loaded") {
      expect(policy.attestation.state).toBe("signed");
      expect(policy.policy.agents?.["*"]?.limits).toMatchObject({
        maxConcurrentJobs: 4,
        wallClockPerJobMs: 1_800_000,
        maxSteps: 200,
      });
      expect(policy.policy.budgets?.agents?.["*"]).toMatchObject({
        tokensPerDay: 5_000_000,
        toolCallsPerHour: 1200,
        onBreach: "pause",
      });
    }

    const out = run.lines.join("\n");
    expect(out).toContain("secure defaults: credential isolation");
    expect(out).toContain("starter policy installed and signed");
    expect(out).toContain("no container runtime found: exec is refused in sandboxed sessions");
    expect(run.errors).toEqual([]);

    const report = await buildDoctorJsonReport(process.env, { dockerAvailable: async () => false });
    const ids = report.checks.filter((c) => c.level !== "ok").map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("secure-defaults."))).toEqual([]);
    expect(report.checks.find((c) => c.id === "policy.present")?.level).toBe("ok");
    expect(report.checks.find((c) => c.id === "sandbox.runtime")?.level).toBe("warn");
  });

  test("an existing config keeps its behaviour and gets warnings, not changes", async () => {
    const home = tempHome();
    const before = {
      agents: { list: [{ id: "alice", default: true }, { id: "ops" }] },
      gateway: { mode: "local" },
    };
    fs.writeFileSync(path.join(home, "kolo.json"), JSON.stringify(before));
    const run = capture();
    await initCommand({ nonInteractive: true, stateDir: home, name: "alice" }, run.runtime);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "kolo.json"), "utf8"));
    expect(cfg.auth?.isolation).toBeUndefined();
    expect(cfg.agents.defaults?.sandbox).toBeUndefined();
    expect(cfg.tools?.exec?.unsandboxed).toBeUndefined();
    expect(cfg.agents.messaging).toBeUndefined();
    expect(fs.existsSync(path.join(home, "policy", "policy.yaml"))).toBe(false);
    const out = run.lines.join("\n");
    expect(out).toContain("existing config kept; 6 setting(s) still use legacy defaults");
    expect(out).toContain("no policy: no budgets or job limits");

    const report = await buildDoctorJsonReport(process.env);
    const warn = new Map(report.checks.map((c) => [c.id, c]));
    expect(warn.get("secure-defaults.auth-isolation")?.detail).toMatch(/2 agents inherit/);
    expect(warn.get("secure-defaults.sandbox")?.level).toBe("warn");
    expect(warn.get("secure-defaults.exec-unsandboxed")?.detail).toMatch(/no approvals/);
    expect(warn.get("secure-defaults.supply-chain")?.detail).toMatch(/kurahi skills pin --all/);
    expect(warn.get("secure-defaults.memory-provenance")?.level).toBe("warn");
    expect(warn.get("secure-defaults.agent-message-signing")?.level).toBe("warn");
    expect(warn.get("policy.present")?.level).toBe("warn");
    expect(report.ok).toBe(true);
  });

  test("an existing policy is never replaced", async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, "policy"), { recursive: true });
    fs.writeFileSync(path.join(home, "policy", "policy.yaml"), "version: 1\nname: mine\n");
    const run = capture();
    await initCommand({ nonInteractive: true, stateDir: home, name: "alice" }, run.runtime);
    expect(fs.readFileSync(path.join(home, "policy", "policy.yaml"), "utf8")).toContain("mine");
    expect(run.lines.join("\n")).toContain("existing policy kept");
  });
});
