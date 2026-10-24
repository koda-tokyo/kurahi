import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyDocument } from "./schema.js";
import {
  __resetJobsForTest,
  getJob,
  markJobRunning,
  registerJobCancel,
  startJob,
} from "../agents/jobs.js";
import { resolveToolPermissions } from "../agents/permissions.js";
import { addOwner, loadOrCreateOwnerKey, signPolicyFile } from "./attestation.js";
import { PolicyEngine, PolicyGateError } from "./engine.js";
import { resolvePolicyLocations } from "./paths.js";

let home: string;
let loc: ReturnType<typeof resolvePolicyLocations>;
let clock: Date;

function engine(policy: PolicyDocument | null, opts: { mode?: "enforce" | "audit" | "off" } = {}) {
  const e = new PolicyEngine({
    loc,
    mode: opts.mode ?? "enforce",
    now: () => clock,
    persist: false,
    audit: false,
  });
  e.useDocument(policy);
  return e;
}

const ws = "/ws";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-policy-eng-"));
  loc = resolvePolicyLocations({ KOLO_HOME: home });
  clock = new Date("2026-10-14T10:00:00Z");
  __resetJobsForTest();
  process.env.KOLO_HOME = home;
});

afterEach(() => {
  delete process.env.KOLO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("precedence: policy > config permissions > defaults", () => {
  const legacy = resolveToolPermissions({ entry: ["write:/ws/docs/**"], workspaceDir: ws });

  it("falls through to the M5 config rules when the policy says nothing", () => {
    const e = engine({ version: 1 });
    const denied = e.evaluate("tool", {
      agentId: "alice",
      tool: "write",
      args: { path: "/ws/src/a.ts" },
      workspaceDir: ws,
      legacyPermissions: legacy,
    });
    expect(denied.effect).toBe("deny");
    expect(denied.ruleId).toBe("config:agents.list[alice].permissions");
    const ok = e.evaluate("tool", {
      agentId: "alice",
      tool: "write",
      args: { path: "/ws/docs/a.md" },
      workspaceDir: ws,
      legacyPermissions: legacy,
    });
    expect(ok.effect).toBe("allow");
  });

  it("policy permissions decide before the config rules", () => {
    const e = engine({ version: 1, agents: { "ali*": { permissions: ["write:/ws/src/**"] } } });
    const allowed = e.evaluate("tool", {
      agentId: "alice",
      tool: "write",
      args: { path: "/ws/src/a.ts" },
      workspaceDir: ws,
      legacyPermissions: legacy,
    });
    expect(allowed.effect).toBe("allow");
    expect(allowed.ruleId).toBe("agents[ali*].permissions");
    const denied = e.evaluate("tool", {
      agentId: "alice",
      tool: "write",
      args: { path: "/ws/docs/a.md" },
      workspaceDir: ws,
      legacyPermissions: legacy,
    });
    expect(denied.effect).toBe("deny");
    expect(denied.ruleId).toBe("agents[ali*].permissions");
  });

  it("defaults allow when neither system has a rule", () => {
    const d = engine(null).evaluate("tool", {
      agentId: "alice",
      tool: "read",
      args: { path: "/x" },
      workspaceDir: ws,
    });
    expect(d).toMatchObject({ effect: "allow", ruleId: "default" });
  });

  it("mode off allows everything", () => {
    const e = engine({ version: 1, kill: { fleet: true } }, { mode: "off" });
    expect(e.evaluate("job", { agentId: "alice", kind: "agent", sessionKey: "s" }).ruleId).toBe(
      "mode:off",
    );
  });
});

describe("tool dispatch", () => {
  it("deny wins over allow; allow lists restrict", () => {
    const e = engine({
      version: 1,
      agents: { "*": { tools: { allow: ["read", "mcp_*"], deny: ["mcp_evil_*"] } } },
    });
    expect(e.evaluate("tool", { agentId: "a", tool: "read", workspaceDir: ws }).effect).toBe(
      "allow",
    );
    expect(e.evaluate("tool", { agentId: "a", tool: "exec", workspaceDir: ws })).toMatchObject({
      effect: "deny",
      ruleId: "agents[*].tools.allow",
    });
    expect(
      e.evaluate("tool", { agentId: "a", tool: "mcp_evil_rm", workspaceDir: ws }),
    ).toMatchObject({ effect: "deny", ruleId: "agents[*].tools.deny[0]" });
  });

  it("MCP servers, egress hosts, never-read paths and secret patterns", () => {
    const e = engine({
      version: 1,
      network: {
        egress: { allow: ["*.example.com"], deny: ["evil.example.com"] },
        mcp: { allow: ["docs"] },
      },
      data: {
        neverRead: ["~/.ssh/**", "**/.env"],
        neverWrite: ["/etc/**"],
        secretPatterns: ["AKIA[0-9A-Z]{16}"],
      },
    });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "mcp_docs_search",
        mcpServer: "docs",
        workspaceDir: ws,
      }).effect,
    ).toBe("allow");
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "mcp_shell_run",
        mcpServer: "shell",
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "network.mcp.allow" });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "web_fetch",
        args: { url: "https://api.example.com/x" },
        workspaceDir: ws,
      }).effect,
    ).toBe("allow");
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "web_fetch",
        args: { url: "https://evil.example.com/x" },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "network.egress.deny[0]" });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "web_fetch",
        args: { url: "https://other.org/" },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "network.egress.allow" });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "read",
        args: { path: `${os.homedir()}/.ssh/id_ed25519` },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "data.neverRead[0]" });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "read",
        args: { path: "/ws/app/.env" },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "data.neverRead[1]" });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "write",
        args: { path: "/etc/passwd" },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "data.neverWrite[0]" });
    expect(
      e.evaluate("tool", {
        agentId: "a",
        tool: "exec",
        args: { command: "export AWS_KEY=AKIAABCDEFGHIJKLMNOP" },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "deny", ruleId: "data.secretPatterns[0]" });
  });

  it("asks for approval by class and by tool glob, scoped to agents", () => {
    const e = engine({
      version: 1,
      approvals: { require: [{ class: "exec", agents: ["ops-*"] }, { class: "tool:message" }] },
    });
    expect(
      e.evaluate("tool", {
        agentId: "ops-bot",
        tool: "exec",
        args: { command: "ls" },
        workspaceDir: ws,
      }),
    ).toMatchObject({ effect: "ask", ruleId: "approvals.require[0]" });
    expect(
      e.evaluate("tool", {
        agentId: "alice",
        tool: "exec",
        args: { command: "ls" },
        workspaceDir: ws,
      }).effect,
    ).toBe("allow");
    expect(
      e.evaluate("tool", { agentId: "alice", tool: "message", workspaceDir: ws }),
    ).toMatchObject({ effect: "ask", ruleId: "approvals.require[1]" });
  });
});

describe("reasoning exposure", () => {
  it("is restricted by a matching agents[].reasoning.expose false, in enforce mode only", () => {
    const doc: PolicyDocument = {
      version: 1,
      agents: { "trading-*": { reasoning: { expose: false } }, alice: { reasoning: {} } },
    };
    expect(engine(doc).reasoningExposure("trading-eu")).toBe(false);
    expect(engine(doc).reasoningExposure("alice")).toBeUndefined();
    expect(engine(doc, { mode: "audit" }).reasoningExposure("trading-eu")).toBeUndefined();
    expect(engine(null).reasoningExposure("trading-eu")).toBeUndefined();
  });
});

describe("model, channel, request and job decision points", () => {
  it("providers and models", () => {
    const e = engine({
      version: 1,
      agents: { alice: { providers: ["acme"], models: ["acme/large-*"] } },
    });
    expect(
      e.evaluate("model", { agentId: "alice", provider: "acme", model: "large-2" }).effect,
    ).toBe("allow");
    expect(e.evaluate("model", { agentId: "alice", provider: "other", model: "x" })).toMatchObject({
      effect: "deny",
      ruleId: "agents[alice].providers",
    });
    expect(
      e.evaluate("model", { agentId: "alice", provider: "acme", model: "small" }),
    ).toMatchObject({ effect: "deny", ruleId: "agents[alice].models" });
    expect(e.evaluate("model", { agentId: "bob", provider: "other", model: "x" }).effect).toBe(
      "allow",
    );
  });

  it("channels in both directions", () => {
    const e = engine({ version: 1, agents: { alice: { channels: ["slack"] } } });
    expect(
      e.evaluate("channel", { agentId: "alice", channel: "slack", direction: "in" }).effect,
    ).toBe("allow");
    expect(
      e.evaluate("channel", { agentId: "alice", channel: "telegram", direction: "out" }),
    ).toMatchObject({ effect: "deny", ruleId: "agents[alice].channels" });
    expect(e.evaluate("channel", { channel: "telegram", direction: "out" }).effect).toBe("allow");
  });

  it("requests by operation and scope", () => {
    const e = engine({
      version: 1,
      requests: { deny: [{ operations: ["runCodeMode", "codeMode.*"], scopes: ["attach"] }] },
    });
    expect(
      e.evaluate("request", { surface: "http", operation: "runCodeMode", scope: "attach" }),
    ).toMatchObject({ effect: "deny", ruleId: "requests.deny[0]" });
    expect(
      e.evaluate("request", { surface: "ws", operation: "codeMode.run", scope: "admin" }).effect,
    ).toBe("allow");
    expect(
      e.evaluate("request", { surface: "ws", operation: "chat.send", scope: "attach" }).effect,
    ).toBe("allow");
  });

  it("jobs: concurrency limit and per-job limits", () => {
    const e = engine({
      version: 1,
      agents: {
        alice: { limits: { maxConcurrentJobs: 1, wallClockPerJobMs: 5000, maxSteps: 10 } },
      },
      budgets: { fleet: { wallClockPerJobMs: 4000 } },
    });
    expect(
      e.evaluate("job", { agentId: "alice", kind: "agent", sessionKey: "s", runningJobs: 0 })
        .effect,
    ).toBe("allow");
    expect(
      e.evaluate("job", { agentId: "alice", kind: "agent", sessionKey: "s", runningJobs: 1 }),
    ).toMatchObject({ effect: "deny", ruleId: "agents[alice].limits.maxConcurrentJobs" });
    expect(e.jobLimits("alice")).toEqual({ wallClockPerJobMs: 4000, maxSteps: 10 });
  });
});

describe("budgets", () => {
  it("warn allows and keeps counting; stop denies; pause holds until release or the next window", () => {
    const e = engine({
      version: 1,
      budgets: {
        fleet: { tokensPerDay: 100, onBreach: "warn" },
        agents: {
          "stop-*": { tokensPerDay: 10, onBreach: "stop" },
          "pause-*": { toolCallsPerHour: 2, onBreach: "pause" },
        },
      },
    });
    e.recordUsage("stop-a", { tokens: 10 });
    expect(e.evaluate("model", { agentId: "stop-a", provider: "p", model: "m" })).toMatchObject({
      effect: "deny",
      ruleId: "budgets.agents[stop-*].tokensPerDay",
    });
    e.recordUsage("warn-a", { tokens: 200 });
    expect(e.evaluate("model", { agentId: "warn-a", provider: "p", model: "m" }).effect).toBe(
      "allow",
    );

    const tool = { agentId: "pause-a", tool: "read", workspaceDir: ws };
    expect(e.evaluate("tool", tool).effect).toBe("allow");
    expect(e.evaluate("tool", tool).effect).toBe("allow");
    const paused = e.evaluate("tool", tool);
    expect(paused).toMatchObject({
      effect: "pause",
      ruleId: "budgets.agents[pause-*].toolCallsPerHour",
    });
    expect(e.evaluate("job", { agentId: "pause-a", kind: "agent", sessionKey: "s" }).effect).toBe(
      "pause",
    );
    expect(e.status().paused["pause-a"]?.rule).toBe("budgets.agents[pause-*].toolCallsPerHour");

    clock = new Date("2026-10-14T11:00:01Z");
    expect(e.evaluate("tool", tool).effect).toBe("allow");
  });

  it("release lifts a pause before the window ends", () => {
    const e = engine({
      version: 1,
      budgets: { agents: { "*": { toolCallsPerHour: 1, onBreach: "pause" } } },
    });
    const tool = { agentId: "a", tool: "read", workspaceDir: ws };
    e.evaluate("tool", tool);
    expect(e.evaluate("tool", tool).effect).toBe("pause");
    expect(e.release({ agent: "a", by: "owner" }).released).toBe(true);
    expect(e.evaluate("job", { agentId: "a", kind: "agent", sessionKey: "s" }).effect).toBe(
      "allow",
    );
  });
});

describe("kill switch", () => {
  it("aborts running jobs, refuses new work, and takes effect within one tick", () => {
    const e = engine({ version: 1 });
    const aborted: string[] = [];
    const running = startJob({ agent: "alice", sessionKey: "agent:alice:main" });
    markJobRunning(running.id);
    registerJobCancel(running.id, () => aborted.push(running.id));
    const other = startJob({ agent: "bob", sessionKey: "agent:bob:main" });
    markJobRunning(other.id);
    const events: string[] = [];
    e.onEvent((evt) => events.push(evt.type));

    const t0 = performance.now();
    const result = e.kill({ agent: "alice", by: "owner", reason: "incident 42" });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(result.jobsAborted).toBe(1);
    expect(aborted).toEqual([running.id]);
    expect(getJob(running.id)?.status).toBe("cancelled");
    expect(getJob(other.id)?.status).toBe("running");
    expect(events).toEqual(["kill"]);

    expect(e.evaluate("job", { agentId: "alice", kind: "agent", sessionKey: "s" })).toMatchObject({
      effect: "deny",
      ruleId: "kill.agents[alice]",
    });
    expect(
      e.evaluate("request", { surface: "ws", operation: "chat.send", agentId: "alice" }).effect,
    ).toBe("deny");
    expect(
      e.evaluate("request", { surface: "ws", operation: "sessions.list", agentId: "alice" }).effect,
    ).toBe("allow");
    expect(
      e.evaluate("channel", { agentId: "alice", channel: "slack", direction: "in" }).effect,
    ).toBe("deny");
    expect(e.evaluate("job", { agentId: "bob", kind: "agent", sessionKey: "s" }).effect).toBe(
      "allow",
    );

    e.kill({ by: "admin" });
    expect(getJob(other.id)?.status).toBe("cancelled");
    expect(e.evaluate("model", { agentId: "bob", provider: "p", model: "m" })).toMatchObject({
      effect: "deny",
      ruleId: "kill.fleet",
    });
    expect(
      e.evaluate("request", { surface: "http", operation: "createChatCompletion" }).effect,
    ).toBe("deny");

    expect(e.release({ by: "owner" }).released).toBe(true);
    expect(e.evaluate("job", { agentId: "alice", kind: "agent", sessionKey: "s" }).effect).toBe(
      "allow",
    );
    expect(e.status().kill.fleet).toBeNull();
  });

  it("honours the document's own kill section and mayFlip", () => {
    const e = engine({ version: 1, kill: { agents: ["trading-*"], mayFlip: ["owner"] } });
    expect(
      e.evaluate("job", { agentId: "trading-1", kind: "agent", sessionKey: "s" }),
    ).toMatchObject({ effect: "deny", ruleId: "kill.agents[0]" });
    expect(e.mayFlip("admin")).toBe(false);
    expect(e.mayFlip("owner")).toBe(true);
  });

  it("persists the runtime switch across engine instances", () => {
    const a = new PolicyEngine({ loc, mode: "enforce", audit: false });
    a.useDocument({ version: 1 });
    a.kill({ agent: "alice", by: "owner" });
    const b = new PolicyEngine({ loc, mode: "enforce", audit: false });
    b.useDocument({ version: 1 });
    expect(b.isKilled("alice")).toBe(true);
    expect(b.isKilled("bob")).toBe(false);
  });
});

describe("loading from disk", () => {
  function writePolicy(text: string) {
    fs.mkdirSync(loc.dir, { recursive: true });
    fs.writeFileSync(loc.policyPath, text);
  }

  it("boot gate refuses an unsigned policy in enforce mode and loads it in audit mode", () => {
    writePolicy("version: 1\nname: unsigned\n");
    const strict = new PolicyEngine({ loc, mode: "enforce", audit: false });
    expect(() => strict.load({ strict: true })).toThrow(PolicyGateError);
    const audit = new PolicyEngine({ loc, mode: "audit", audit: false });
    expect(audit.load({ strict: true }).ok).toBe(true);
    expect(audit.status().name).toBe("unsigned");
    expect(audit.status().attestation).toBe("unsigned");
  });

  it("loads a signed policy and keeps it when a later edit breaks the signature", () => {
    writePolicy("version: 1\nname: first\n");
    const key = loadOrCreateOwnerKey(loc.ownerKeyPath);
    addOwner(loc.ownersPath, { publicKey: key.publicKey });
    signPolicyFile({ policyPath: loc.policyPath, signaturePath: loc.signaturePath, key });
    const e = new PolicyEngine({ loc, mode: "enforce", audit: false });
    expect(e.load({ strict: true }).ok).toBe(true);
    expect(e.status().name).toBe("first");

    writePolicy("version: 1\nname: tampered\nkill:\n  fleet: true\n");
    const reload = e.load({ source: "watch" });
    expect(reload.ok).toBe(false);
    expect(e.status().name).toBe("first");
    expect(e.isKilled()).toBe(false);

    signPolicyFile({ policyPath: loc.policyPath, signaturePath: loc.signaturePath, key });
    expect(e.load({ source: "watch" }).ok).toBe(true);
    expect(e.status().name).toBe("tampered");
    expect(e.isKilled()).toBe(true);
  });

  it("is inert without a policy file", () => {
    const e = new PolicyEngine({ loc, mode: "enforce", audit: false });
    expect(e.load({ strict: true }).ok).toBe(true);
    expect(e.status().loaded).toBe(false);
    expect(e.evaluate("job", { agentId: "x", kind: "agent", sessionKey: "s" }).ruleId).toBe(
      "default",
    );
  });
});
