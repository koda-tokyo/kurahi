import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/pi-tools.types.js";
import type { PolicyDocument } from "./schema.js";
import { resolveToolPermissions } from "../agents/permissions.js";
import { type EvidenceSignal, subscribeEvidenceSignals } from "../evidence/bus.js";
import { digestOf } from "../evidence/redact.js";
import { PolicyEngine } from "./engine.js";
import { PolicyDeniedError, wrapToolWithPolicyGuard } from "./guard.js";
import { resolvePolicyLocations } from "./paths.js";

let home: string;

function fakeTool(name: string, calls: string[]): AnyAgentTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async (_id: string, args: Record<string, unknown>) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as AnyAgentTool;
}

function engineWith(policy: PolicyDocument | null) {
  const e = new PolicyEngine({
    loc: resolvePolicyLocations({ KOLO_HOME: home }),
    mode: "enforce",
    persist: false,
    audit: false,
  });
  e.useDocument(policy);
  return e;
}

async function run(tool: AnyAgentTool, args: Record<string, unknown>) {
  const execute = tool.execute as (id: string, a: Record<string, unknown>) => Promise<unknown>;
  return await execute("call-1", args);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-policy-guard-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("wrapToolWithPolicyGuard", () => {
  it("is inert without a policy and without config rules", async () => {
    const calls: string[] = [];
    const tool = wrapToolWithPolicyGuard(fakeTool("exec", calls), {
      agentId: "alice",
      workspaceDir: "/ws",
      engine: engineWith(null),
    });
    await run(tool, { command: "ls" });
    expect(calls).toEqual(['exec:{"command":"ls"}']);
  });

  it("still enforces the M5 config rules when the policy is silent", async () => {
    const calls: string[] = [];
    const tool = wrapToolWithPolicyGuard(fakeTool("exec", calls), {
      agentId: "alice",
      workspaceDir: "/ws",
      engine: engineWith(null),
      legacyPermissions: resolveToolPermissions({ entry: ["exec:git *"], workspaceDir: "/ws" }),
    });
    await run(tool, { command: "git status" });
    await expect(run(tool, { command: "rm -rf /" })).rejects.toThrow(PolicyDeniedError);
    expect(calls).toHaveLength(1);
  });

  it("denies with the rule id in the model-visible error", async () => {
    const calls: string[] = [];
    const tool = wrapToolWithPolicyGuard(fakeTool("exec", calls), {
      agentId: "alice",
      workspaceDir: "/ws",
      engine: engineWith({ version: 1, agents: { "*": { tools: { deny: ["exec"] } } } }),
    });
    const err = await run(tool, { command: "ls" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).ruleId).toBe("agents[*].tools.deny[0]");
    expect((err as PolicyDeniedError).message).toMatch(/kurahi policy/);
    expect(calls).toHaveLength(0);
  });

  it("asks a human and runs only on an allow", async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    let answer: "allow" | "deny" = "allow";
    const tool = wrapToolWithPolicyGuard(fakeTool("exec", calls), {
      agentId: "alice",
      workspaceDir: "/ws",
      engine: engineWith({
        version: 1,
        approvals: { channel: "slack:#ops", timeoutMs: 5000, require: [{ class: "exec" }] },
      }),
      askHuman: async (params) => {
        asked.push(`${params.ruleId}@${params.channel}:${params.timeoutMs}`);
        return answer;
      },
    });
    await run(tool, { command: "deploy" });
    expect(calls).toHaveLength(1);
    answer = "deny";
    const err = await run(tool, { command: "deploy" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).effect).toBe("ask");
    expect(asked).toEqual([
      "approvals.require[0]@slack:#ops:5000",
      "approvals.require[0]@slack:#ops:5000",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("records every human decision as an approval evidence signal, with the approver", async () => {
    const calls: string[] = [];
    const signals: EvidenceSignal[] = [];
    const off = subscribeEvidenceSignals("agent:alice:main", (s) => signals.push(s));
    let answer: "allow" | "deny" = "allow";
    const tool = wrapToolWithPolicyGuard(fakeTool("exec", calls), {
      agentId: "alice",
      workspaceDir: "/ws",
      sessionKey: "agent:alice:main",
      engine: engineWith({ version: 1, approvals: { require: [{ class: "exec" }] } }),
      askHuman: async () => ({ decision: answer, approver: "device:owner-1", approvalId: "ap-9" }),
    });
    try {
      await run(tool, { command: "deploy" });
      answer = "deny";
      await run(tool, { command: "deploy" }).catch(() => undefined);
    } finally {
      off();
    }
    expect(signals).toEqual([
      expect.objectContaining({
        kind: "approval",
        decision: "allow",
        approver: "device:owner-1",
        approvalId: "ap-9",
        argsDigest: digestOf({ command: "deploy" }),
      }),
      expect.objectContaining({ kind: "approval", decision: "deny" }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("reports a pause as paused", async () => {
    const calls: string[] = [];
    const engine = engineWith({
      version: 1,
      budgets: { agents: { "*": { toolCallsPerHour: 1, onBreach: "pause" } } },
    });
    const tool = wrapToolWithPolicyGuard(fakeTool("read", calls), {
      agentId: "alice",
      workspaceDir: "/ws",
      engine,
    });
    await run(tool, { path: "/ws/a" });
    const err = await run(tool, { path: "/ws/b" }).catch((e: unknown) => e);
    expect((err as PolicyDeniedError).effect).toBe("pause");
    expect((err as PolicyDeniedError).message).toMatch(/^Policy paused/);
  });
});
