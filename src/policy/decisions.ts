import type { KillState } from "./kill.js";
import type { AgentPolicy, PolicyDocument } from "./schema.js";
// Pure decision rules over a policy document (KoLo 2.0, M13b). No I/O: the engine supplies the
// document, the kill state and the budget breaches; these functions return the first clause that
// decides, with its rule id. Within the document: deny > ask > pause > allow. Across systems:
// policy > agents.list[].permissions (M5) > built-in defaults.
import {
  checkToolPermission,
  classifyToolCall,
  normalizePathTarget,
  resolveToolPermissions,
  type ToolPermissionSet,
} from "../agents/permissions.js";
import {
  anyNameMatches,
  anyPathMatches,
  argsText,
  extractHosts,
  firstMatchIndex,
  nameMatches,
} from "./match.js";

export type DecisionEffect = "allow" | "deny" | "ask" | "pause";
export type DecisionPoint = "tool" | "model" | "channel" | "request" | "job";

export type PolicyDecision = {
  effect: DecisionEffect;
  /** Path of the clause that decided (`agents[trading-*].tools.deny[0]`, `kill.fleet`, …). */
  ruleId: string;
  reason: string;
  point: DecisionPoint;
};

export type ToolContext = {
  agentId: string;
  tool: string;
  args?: Record<string, unknown>;
  sessionKey?: string;
  /** MCP server id when the tool is an MCP tool. */
  mcpServer?: string;
  workspaceDir: string;
  /** M5 rules from the config (`agents.list[].permissions` + defaults), already compiled. */
  legacyPermissions?: ToolPermissionSet;
};

export type ModelContext = {
  agentId: string;
  provider: string;
  model: string;
  sessionKey?: string;
};
export type ChannelContext = {
  agentId?: string;
  channel: string;
  direction: "in" | "out";
  target?: string;
};
export type RequestContext = {
  surface: "http" | "ws";
  operation: string;
  scope?: string;
  agentId?: string;
};
export type JobContext = {
  agentId: string;
  kind: string;
  sessionKey: string;
  runningJobs?: number;
};

export const decide = (
  point: DecisionPoint,
  effect: DecisionEffect,
  ruleId: string,
  reason: string,
): PolicyDecision => ({ point, effect, ruleId, reason });

/** Entries of `policy.agents` whose glob matches `agentId`, in document order. */
export function matchingAgentEntries(
  policy: PolicyDocument | null,
  agentId: string,
): Array<{ key: string; entry: AgentPolicy }> {
  if (!policy?.agents) {
    return [];
  }
  return Object.entries(policy.agents)
    .filter(([key]) => nameMatches(key, agentId))
    .map(([key, entry]) => ({ key, entry }));
}

/** Operations that drive an agent; a kill refuses them even when the agent is not named. */
export const AGENT_DRIVING_OPERATIONS: readonly string[] = [
  "chat.send",
  "agent",
  "agent.wait",
  "send",
  "wake",
  "codeMode.run",
  "node.invoke",
  "sibling.send",
  "sessions.send",
  "invokeTool",
  "runCodeMode",
  "createResponse",
  "createChatCompletion",
  // The console terminal starts commands: the kill switch stops new sessions and new input.
  "terminal.open",
  "terminal.input",
];

export function killDecision(
  point: DecisionPoint,
  policy: PolicyDocument | null,
  kill: KillState,
  agentId: string | undefined,
): PolicyDecision | null {
  if (kill.fleet) {
    return decide(point, "deny", "kill.fleet", `fleet kill switch is on (by ${kill.fleet.by})`);
  }
  if (policy?.kill?.fleet) {
    return decide(point, "deny", "kill.fleet", "fleet kill switch is on in the policy");
  }
  if (!agentId) {
    return null;
  }
  const mark = kill.agents[agentId];
  if (mark) {
    return decide(
      point,
      "deny",
      `kill.agents[${agentId}]`,
      `agent ${agentId} is stopped (by ${mark.by})`,
    );
  }
  const idx = firstMatchIndex(policy?.kill?.agents, agentId);
  if (idx >= 0) {
    return decide(
      point,
      "deny",
      `kill.agents[${idx}]`,
      `agent ${agentId} is stopped in the policy`,
    );
  }
  return null;
}

function approvalClassesFor(ctx: ToolContext): string[] {
  const { toolClass } = classifyToolCall(ctx.tool, ctx.args);
  const classes = new Set<string>();
  if (toolClass === "exec" || toolClass === "write" || toolClass === "read") {
    classes.add(toolClass);
  }
  const tool = ctx.tool.trim().toLowerCase();
  if (
    extractHosts(ctx.args).length > 0 ||
    tool === "web_fetch" ||
    tool === "web_search" ||
    tool === "browser"
  ) {
    classes.add("network");
  }
  if (ctx.mcpServer || tool.startsWith("mcp_")) {
    classes.add("mcp");
  }
  if (tool === "message" || tool === "sessions_send" || tool === "sibling_send") {
    classes.add("messaging");
  }
  return [...classes];
}

/** Tool dispatch: kill, tool allow/deny, data, secrets, network, approvals, permissions. */
export function toolDecision(
  policy: PolicyDocument | null,
  ctx: ToolContext,
  homeDir: string,
): PolicyDecision {
  const point: DecisionPoint = "tool";
  const tool = ctx.tool.trim().toLowerCase();
  const entries = matchingAgentEntries(policy, ctx.agentId);

  for (const { key, entry } of entries) {
    const deny = firstMatchIndex(entry.tools?.deny, tool);
    if (deny >= 0) {
      return decide(
        point,
        "deny",
        `agents[${key}].tools.deny[${deny}]`,
        `tool ${tool} is denied for ${ctx.agentId}`,
      );
    }
  }
  const allowLists = entries.filter((e) => e.entry.tools?.allow !== undefined);
  if (
    allowLists.length > 0 &&
    !allowLists.some((e) => anyNameMatches(e.entry.tools?.allow, tool))
  ) {
    const key = allowLists[allowLists.length - 1].key;
    return decide(
      point,
      "deny",
      `agents[${key}].tools.allow`,
      `tool ${tool} is not in the allow list for ${ctx.agentId}`,
    );
  }

  if (ctx.mcpServer) {
    const deny = firstMatchIndex(policy?.network?.mcp?.deny, ctx.mcpServer);
    if (deny >= 0) {
      return decide(
        point,
        "deny",
        `network.mcp.deny[${deny}]`,
        `MCP server ${ctx.mcpServer} is denied`,
      );
    }
    const allow = policy?.network?.mcp?.allow;
    if (allow !== undefined && !anyNameMatches(allow, ctx.mcpServer)) {
      return decide(
        point,
        "deny",
        "network.mcp.allow",
        `MCP server ${ctx.mcpServer} is not allowed`,
      );
    }
  }

  const { toolClass, targets } = classifyToolCall(ctx.tool, ctx.args);
  if ((toolClass === "read" || toolClass === "write") && policy?.data) {
    const list = toolClass === "read" ? policy.data.neverRead : policy.data.neverWrite;
    const field = toolClass === "read" ? "neverRead" : "neverWrite";
    for (const target of targets) {
      if (!target) {
        continue;
      }
      const abs = normalizePathTarget(target, ctx.workspaceDir);
      const hit = anyPathMatches(list, abs, homeDir);
      if (hit !== undefined) {
        const idx = (list ?? []).indexOf(hit);
        return decide(
          point,
          "deny",
          `data.${field}[${idx}]`,
          `${toolClass} of ${abs} is never allowed`,
        );
      }
    }
  }
  const secretPatterns = policy?.data?.secretPatterns ?? [];
  if (secretPatterns.length > 0) {
    const text = argsText(ctx.args);
    for (const [i, pattern] of secretPatterns.entries()) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      if (re.test(text)) {
        return decide(
          point,
          "deny",
          `data.secretPatterns[${i}]`,
          "tool arguments match a secret pattern",
        );
      }
    }
  }

  const hosts = extractHosts(ctx.args);
  if (hosts.length > 0 && policy?.network?.egress) {
    const { allow, deny } = policy.network.egress;
    for (const host of hosts) {
      const d = firstMatchIndex(deny, host);
      if (d >= 0) {
        return decide(point, "deny", `network.egress.deny[${d}]`, `egress to ${host} is denied`);
      }
      if (allow !== undefined && !anyNameMatches(allow, host)) {
        return decide(point, "deny", "network.egress.allow", `egress to ${host} is not allowed`);
      }
    }
  }

  const classes = approvalClassesFor(ctx);
  for (const [i, rule] of (policy?.approvals?.require ?? []).entries()) {
    if (rule.agents !== undefined && !anyNameMatches(rule.agents, ctx.agentId)) {
      continue;
    }
    const hit = rule.class.startsWith("tool:")
      ? nameMatches(rule.class.slice(5), tool)
      : classes.includes(rule.class);
    if (hit) {
      return decide(
        point,
        "ask",
        `approvals.require[${i}]`,
        `tool ${tool} (${rule.class}) needs a human approval`,
      );
    }
  }

  // Policy-level permission globs decide before the config's (precedence), with the M5 matcher.
  const policyRules = entries.flatMap((e) =>
    (e.entry.permissions ?? []).map((rule) => ({ key: e.key, rule })),
  );
  if (policyRules.length > 0) {
    const set = resolveToolPermissions({
      entry: policyRules.map((r) => r.rule),
      workspaceDir: ctx.workspaceDir,
    });
    const verdict = checkToolPermission({
      toolName: ctx.tool,
      args: ctx.args,
      permissionSet: set,
      workspaceDir: ctx.workspaceDir,
    });
    const key = policyRules[policyRules.length - 1].key;
    if (!verdict.ok) {
      return decide(point, "deny", `agents[${key}].permissions`, verdict.reason);
    }
    return decide(point, "allow", `agents[${key}].permissions`, "allowed by policy permissions");
  }
  if (ctx.legacyPermissions?.active) {
    const verdict = checkToolPermission({
      toolName: ctx.tool,
      args: ctx.args,
      permissionSet: ctx.legacyPermissions,
      workspaceDir: ctx.workspaceDir,
    });
    if (!verdict.ok) {
      return decide(
        point,
        "deny",
        `config:agents.list[${ctx.agentId}].permissions`,
        verdict.reason,
      );
    }
    return decide(
      point,
      "allow",
      `config:agents.list[${ctx.agentId}].permissions`,
      "allowed by config permissions",
    );
  }
  return decide(point, "allow", "default", "no rule matched");
}

export function modelDecision(policy: PolicyDocument | null, ctx: ModelContext): PolicyDecision {
  const point: DecisionPoint = "model";
  const ref = `${ctx.provider}/${ctx.model}`;
  for (const { key, entry } of matchingAgentEntries(policy, ctx.agentId)) {
    if (entry.providers !== undefined && !anyNameMatches(entry.providers, ctx.provider)) {
      return decide(
        point,
        "deny",
        `agents[${key}].providers`,
        `provider ${ctx.provider} is not allowed for ${ctx.agentId}`,
      );
    }
    if (entry.models !== undefined && !anyNameMatches(entry.models, ref)) {
      return decide(
        point,
        "deny",
        `agents[${key}].models`,
        `model ${ref} is not allowed for ${ctx.agentId}`,
      );
    }
  }
  return decide(point, "allow", "default", "no rule matched");
}

export function channelDecision(
  policy: PolicyDocument | null,
  ctx: ChannelContext,
): PolicyDecision {
  const point: DecisionPoint = "channel";
  if (!ctx.agentId) {
    return decide(point, "allow", "default", "no agent in context");
  }
  for (const { key, entry } of matchingAgentEntries(policy, ctx.agentId)) {
    if (entry.channels !== undefined && !anyNameMatches(entry.channels, ctx.channel)) {
      return decide(
        point,
        "deny",
        `agents[${key}].channels`,
        `channel ${ctx.channel} is not allowed for ${ctx.agentId} (${ctx.direction})`,
      );
    }
  }
  return decide(point, "allow", "default", "no rule matched");
}

export function requestDecision(
  policy: PolicyDocument | null,
  ctx: RequestContext,
): PolicyDecision {
  const point: DecisionPoint = "request";
  for (const [i, rule] of (policy?.requests?.deny ?? []).entries()) {
    if (!anyNameMatches(rule.operations, ctx.operation)) {
      continue;
    }
    if (rule.scopes !== undefined && !anyNameMatches(rule.scopes, ctx.scope ?? "owner")) {
      continue;
    }
    return decide(
      point,
      "deny",
      `requests.deny[${i}]`,
      `${ctx.surface} ${ctx.operation} is denied for scope ${ctx.scope ?? "owner"}`,
    );
  }
  return decide(point, "allow", "default", "no rule matched");
}

export function jobDecision(policy: PolicyDocument | null, ctx: JobContext): PolicyDecision {
  const point: DecisionPoint = "job";
  for (const { key, entry } of matchingAgentEntries(policy, ctx.agentId)) {
    const max = entry.limits?.maxConcurrentJobs;
    if (max !== undefined && (ctx.runningJobs ?? 0) >= max) {
      return decide(
        point,
        "deny",
        `agents[${key}].limits.maxConcurrentJobs`,
        `${ctx.agentId} already runs ${ctx.runningJobs} job(s) (limit ${max})`,
      );
    }
  }
  return decide(point, "allow", "default", "no rule matched");
}

/**
 * Whether an agent's reasoning may be streamed to clients: `false` when any matching
 * `agents[<glob>].reasoning.expose` is false (the most restrictive entry wins), else undefined.
 */
export function reasoningExposureFor(
  policy: PolicyDocument | null,
  agentId: string,
): false | undefined {
  for (const { entry } of matchingAgentEntries(policy, agentId)) {
    if (entry.reasoning?.expose === false) {
      return false;
    }
  }
  return undefined;
}

/** Effective per-job limits (wall clock, steps) for the embedded runner. */
export function jobLimitsFor(
  policy: PolicyDocument | null,
  agentId: string,
): { wallClockPerJobMs?: number; maxSteps?: number } {
  const out: { wallClockPerJobMs?: number; maxSteps?: number } = {};
  for (const { entry } of matchingAgentEntries(policy, agentId)) {
    if (entry.limits?.wallClockPerJobMs !== undefined) {
      out.wallClockPerJobMs = Math.min(
        out.wallClockPerJobMs ?? Infinity,
        entry.limits.wallClockPerJobMs,
      );
    }
    if (entry.limits?.maxSteps !== undefined) {
      out.maxSteps = Math.min(out.maxSteps ?? Infinity, entry.limits.maxSteps);
    }
  }
  for (const [key, limits] of Object.entries(policy?.budgets?.agents ?? {})) {
    if (nameMatches(key, agentId) && limits.wallClockPerJobMs !== undefined) {
      out.wallClockPerJobMs = Math.min(out.wallClockPerJobMs ?? Infinity, limits.wallClockPerJobMs);
    }
  }
  if (policy?.budgets?.fleet?.wallClockPerJobMs !== undefined) {
    out.wallClockPerJobMs = Math.min(
      out.wallClockPerJobMs ?? Infinity,
      policy.budgets.fleet.wallClockPerJobMs,
    );
  }
  return out;
}
