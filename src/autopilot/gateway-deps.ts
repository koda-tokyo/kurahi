// Runner dependencies inside the gateway: tools through the /tools/invoke path for the routine's
// project session (each call under the engine invocation context, engine-origin.ts), the CLI
// reasoner, the work queue adapter and the policy kill switch.

import type { RunnerDeps, ToolInvoker } from "./runner.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveInvocableTools } from "../gateway/invocable-tools.js";
import { invokeToolForSession } from "../gateway/tools-invoke-core.js";
import { getPolicyEngine } from "../policy/engine.js";
import { invokeAsEngine } from "./engine-origin.js";
import { createCliReasoner } from "./reasoner.js";
import { toolText } from "./runner.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

export const gatewayToolInvoker: ToolInvoker = async (call) => {
  const {
    value: out,
    used,
    fallback,
  } = await invokeAsEngine(call, () =>
    invokeToolForSession({
      cfg: loadConfig(),
      sessionKey: call.sessionKey,
      toolName: call.tool,
      args: call.args,
      source: call.source,
      callId: `${call.source}-${Date.now()}`,
    }),
  );
  if (!out.ok) {
    return { ok: false, error: `${out.type}: ${out.message}`.slice(0, 300) };
  }
  // A tool that failed reports it in its result (isError / details.error) rather than throwing.
  const r = out.result as { isError?: boolean; details?: Record<string, unknown> } | null;
  if (r?.isError || (r?.details && r.details.error)) {
    return { ok: false, error: toolText(out.result).slice(0, 300) || "tool error" };
  }
  return {
    ok: true,
    text: toolText(out.result),
    pluginId: out.pluginId,
    ...(r?.details && typeof r.details === "object" ? { details: r.details } : {}),
    approvalUsed: used?.approvalId ?? null,
    approvalFallback: fallback,
  };
};

let override: Partial<RunnerDeps> | null = null;
/** Tests replace parts of the runner (reasoner, tools, sink); null restores the defaults. */
export function setAutopilotDepsForTests(deps: Partial<RunnerDeps> | null): void {
  override = deps;
}

export function gatewayRunnerDeps(): RunnerDeps {
  const cfg = loadConfig();
  return {
    cfg,
    reasoner: createCliReasoner(cfg),
    tools: gatewayToolInvoker,
    workItems: defaultWorkItemSink(),
    defaultAgentId: resolveDefaultAgentId(cfg),
    killed: (agentId) => {
      const kill = getPolicyEngine().status().kill;
      if (kill.fleet) {
        return `fleet stopped by ${kill.fleet.by}`;
      }
      const mark = kill.agents[agentId];
      return mark ? `agent ${agentId} stopped by ${mark.by}` : null;
    },
    // Resolving the session's tools loads the gateway's plugins if they are not loaded yet
    // (the office plugin registers its spec parsers when it loads).
    ensureTools: (sessionKey) => {
      resolveInvocableTools({ cfg: loadConfig(), sessionKey });
    },
    ...override,
  };
}
