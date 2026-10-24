// Tool-dispatch guard (KoLo 2.0, M13b): the single wrapper that puts every agent tool call
// (core tools, MCP tools, and scripts in Code Mode, which runs over the same wrapped list)
// through the policy engine. Replaces the M5 permission wrapper; the M5 rule set is passed in
// as one input so `policy > agents.list[].permissions > defaults` holds in one place.
//
// `ask` decisions reuse the exec approval path: the gateway broadcasts
// `exec.approval.requested` (channels forward it to humans), and the call runs only after an
// `allow-once`/`allow-always` decision arrives before the policy's timeout.
import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "../agents/pi-tools.types.js";
import { ToolPermissionDeniedError, type ToolPermissionSet } from "../agents/permissions.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { emitEvidenceSignal } from "../evidence/bus.js";
import { digestOf } from "../evidence/redact.js";
import { getMcpToolMeta } from "../mcp/client/meta.js";
import { getPolicyEngine, type PolicyEngine } from "./engine.js";
import {
  compileRedactor,
  type CompiledRedactor,
  redactionApplies,
  redactToolResult,
  type RedactRules,
  restoreAllowed,
  restoreValue,
  toolRef,
  vaultFor,
} from "./redact.js";

const DEFAULT_ASK_TIMEOUT_MS = 120_000;

export class PolicyDeniedError extends ToolPermissionDeniedError {
  constructor(
    message: string,
    tools: string[],
    public readonly ruleId: string,
    public readonly effect: "deny" | "pause" | "ask",
  ) {
    super(message, tools);
    this.name = "PolicyDeniedError";
  }
}

export type PolicyGuardContext = {
  agentId: string;
  workspaceDir: string;
  sessionKey?: string;
  legacyPermissions?: ToolPermissionSet;
  engine?: PolicyEngine;
  /** Injected for tests; defaults to the gateway approval request. */
  askHuman?: (params: AskParams) => Promise<"allow" | "deny" | AskVerdict>;
};

/** A human decision with who made it, when the approval path reports it. */
export type AskVerdict = {
  decision: "allow" | "deny";
  approver?: string | null;
  approvalId?: string;
};

export type AskParams = {
  agentId: string;
  sessionKey?: string;
  tool: string;
  args: Record<string, unknown>;
  ruleId: string;
  timeoutMs: number;
  channel?: string;
};

export async function askViaGateway(params: AskParams): Promise<AskVerdict> {
  const approvalId = randomUUID();
  try {
    const result = await callGatewayTool<{ decision?: string; resolvedBy?: string | null }>(
      "exec.approval.request",
      { timeoutMs: params.timeoutMs + 5_000 },
      {
        id: approvalId,
        command: `${params.tool} ${JSON.stringify(params.args).slice(0, 400)}`,
        host: "gateway",
        security: "policy",
        ask: `policy:${params.ruleId}${params.channel ? ` via ${params.channel}` : ""}`,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
      },
    );
    const decision = typeof result?.decision === "string" ? result.decision : "";
    return {
      decision: decision === "allow-once" || decision === "allow-always" ? "allow" : "deny",
      approver: typeof result?.resolvedBy === "string" ? result.resolvedBy : null,
      approvalId,
    };
  } catch {
    return { decision: "deny", approver: null, approvalId };
  }
}

/** Wrap one tool. The engine is consulted on every call; inert when no policy is loaded. */
export function wrapToolWithPolicyGuard(tool: AnyAgentTool, ctx: PolicyGuardContext): AnyAgentTool {
  const execute = tool.execute;
  if (typeof execute !== "function") {
    return tool;
  }
  const engine = ctx.engine ?? getPolicyEngine();
  const mcpServer = getMcpToolMeta(tool)?.server;
  const ref = toolRef(tool.name, mcpServer);
  // Compiled redactor cache keyed by the rules object (a policy reload swaps the object).
  let compiledFor: RedactRules | undefined;
  let compiled: CompiledRedactor | undefined;

  // Context guard (M13f): real values back into permitted arguments, personal data out of the
  // result before the model reads it. Inert when the policy has no `data.redact`.
  const guarded = async (args: Parameters<typeof execute>) => {
    const rules = engine.document?.data?.redact as RedactRules | undefined;
    if (!rules || !redactionApplies(rules, ctx.agentId, ref, tool.name)) {
      return execute(...args);
    }
    const vault = vaultFor(ctx.sessionKey);
    let restored = 0;
    if (restoreAllowed(rules, ref, tool.name) && args[1] && typeof args[1] === "object") {
      const counter = { n: 0 };
      const next = [...args] as unknown[];
      next[1] = restoreValue(args[1], vault, counter);
      restored = counter.n;
      args = next as Parameters<typeof execute>;
    }
    const raw = await execute(...args);
    if (compiledFor !== rules) {
      compiled = compileRedactor(rules);
      compiledFor = rules;
    }
    const { result, counts } = redactToolResult(raw, compiled!, vault);
    const masked = Object.values(counts).reduce((a, b) => a + b, 0);
    if (ctx.sessionKey && (masked > 0 || restored > 0)) {
      emitEvidenceSignal({
        kind: "redaction",
        sessionKey: ctx.sessionKey,
        tool: ref,
        counts,
        restored,
      });
    }
    return result as Awaited<ReturnType<typeof execute>>;
  };

  return {
    ...tool,
    execute: async (...args: Parameters<typeof execute>) => {
      const toolArgs = (args[1] ?? {}) as Record<string, unknown>;
      const decision = engine.evaluate("tool", {
        agentId: ctx.agentId,
        tool: tool.name,
        args: toolArgs,
        sessionKey: ctx.sessionKey,
        mcpServer,
        workspaceDir: ctx.workspaceDir,
        legacyPermissions: ctx.legacyPermissions,
      });
      if (decision.effect === "allow") {
        return guarded(args);
      }
      if (decision.effect === "ask") {
        const approvals = engine.document?.approvals;
        const raw = await (ctx.askHuman ?? askViaGateway)({
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          tool: tool.name,
          args: toolArgs,
          ruleId: decision.ruleId,
          timeoutMs: approvals?.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
          channel: approvals?.channel,
        });
        const verdict: AskVerdict = typeof raw === "string" ? { decision: raw } : raw;
        if (ctx.sessionKey) {
          // Approvals are first-class evidence: the evaluator checks approval-before-action on it.
          emitEvidenceSignal({
            kind: "approval",
            sessionKey: ctx.sessionKey,
            tool: ref,
            decision: verdict.decision,
            ruleId: decision.ruleId,
            approvalId: verdict.approvalId,
            approver: verdict.approver ?? null,
            argsDigest: digestOf(toolArgs),
          });
        }
        if (verdict.decision === "allow") {
          return guarded(args);
        }
        throw new PolicyDeniedError(
          `Policy: ${tool.name} needs a human approval (rule ${decision.ruleId}) and none was given.`,
          [tool.name],
          decision.ruleId,
          "ask",
        );
      }
      const label = decision.effect === "pause" ? "paused" : "denied";
      throw new PolicyDeniedError(
        `Policy ${label}: ${decision.reason} (rule ${decision.ruleId}). An owner can change the policy with \`kurahi policy\`.`,
        [tool.name],
        decision.ruleId,
        decision.effect,
      );
    },
  } as AnyAgentTool;
}
