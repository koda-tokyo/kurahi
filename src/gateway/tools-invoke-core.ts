// One tool call for a session, as POST /tools/invoke runs it: the invocable tool list (same
// policy stack as the embedded runner), the backend capability gate, the gateway guard (risk +
// paths), then the tool. Shared by the HTTP route and the autopilot engine, so a routine's gather
// and its executed actions take exactly the path an operator's tool call takes.
import type { KoLoConfig } from "../config/config.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { guardOutboundCall } from "../governance/outbound-guard.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { parseProjectSessionKey } from "../projects/scope.js";
import { getProject, projectDataDir } from "../projects/store.js";
import { guardToolCall, logGuardDecision } from "./guard/index.js";
import { checkInvocableCapability, resolveInvocableTools } from "./invocable-tools.js";

export type ToolInvokeOutcome =
  | { ok: true; result: unknown; pluginId: string | null }
  | {
      ok: false;
      status: 400 | 403 | 404;
      type: "permission_denied" | "not_found" | "tool_error";
      message: string;
      details?: Record<string, unknown>;
    };

function mergeActionIntoArgsIfSupported(params: {
  toolSchema: unknown;
  action: string | undefined;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const { toolSchema, action, args } = params;
  if (!action) {
    return args;
  }
  if (args.action !== undefined) {
    return args;
  }
  // TypeBox schemas are plain objects; many tools define an `action` property.
  const schemaObj = toolSchema as { properties?: Record<string, unknown> } | null;
  const hasAction = Boolean(
    schemaObj &&
    typeof schemaObj === "object" &&
    schemaObj.properties &&
    "action" in schemaObj.properties,
  );
  if (!hasAction) {
    return args;
  }
  return { ...args, action };
}

export async function invokeToolForSession(params: {
  cfg: KoLoConfig;
  sessionKey: string;
  toolName: string;
  args: Record<string, unknown>;
  action?: string;
  messageChannel?: GatewayMessageChannel;
  accountId?: string;
  /** Audit source of the call (e.g. `http:/tools/invoke`, `autopilot:<routine>`). */
  source: string;
  callId: string;
}): Promise<ToolInvokeOutcome> {
  const { cfg, sessionKey, toolName } = params;
  const resolved = resolveInvocableTools({
    cfg,
    sessionKey,
    messageChannel: params.messageChannel,
    accountId: params.accountId,
  });
  const agentId = resolved.agentId;

  // Backend capability gate (M2a): an agent whose backend declares tools=none gets no tools here
  // either; the attempt is rejected and audited.
  const capabilityDecision = checkInvocableCapability(resolved, toolName, params.source);
  if (!capabilityDecision.ok) {
    return {
      ok: false,
      status: 403,
      type: "permission_denied",
      message: capabilityDecision.reason,
    };
  }

  const tool = resolved.tools.find((t) => t.name === toolName);
  if (!tool) {
    return {
      ok: false,
      status: 404,
      type: "not_found",
      message: `Tool not available: ${toolName}`,
    };
  }

  try {
    const toolArgs = mergeActionIntoArgsIfSupported({
      // oxlint-disable-next-line typescript/no-explicit-any
      toolSchema: (tool as any).parameters,
      action: params.action,
      args: params.args,
    });

    // ── Guard: risk assessment + path validation before execution ──
    const command = typeof toolArgs.command === "string" ? toolArgs.command : undefined;
    // A project session's paths belong to the project: its folder and data area are the roots,
    // and relative paths resolve against the folder (the tools themselves do the same).
    const projectRef = parseProjectSessionKey(sessionKey);
    const project = projectRef ? getProject(projectRef.projectId) : null;
    const guardResult = await guardToolCall({
      toolName,
      args: toolArgs,
      command,
      workspaceRoots: project ? [project.folder, projectDataDir(project.id)] : [process.cwd()],
      ...(project ? { baseDir: project.folder } : {}),
    });
    logGuardDecision({ toolName, result: guardResult, sessionKey, agentId });

    if (guardResult.blocked) {
      return {
        ok: false,
        status: 403,
        type: "permission_denied",
        message: guardResult.explainer ?? `Access denied for ${toolName}`,
        details: { risk: guardResult.risk.tier, flags: guardResult.risk.flags },
      };
    }

    // APPI / マイナンバー guard on outbound connector tools (src/governance/outbound-guard.ts).
    const personal = guardOutboundCall({
      toolName,
      args: toolArgs,
      agentId,
      sessionKey,
      config: cfg,
    });
    if (personal.action === "block") {
      return {
        ok: false,
        status: 403,
        type: "permission_denied",
        message: personal.reason,
        details: {
          rule: "personal-data",
          kinds: [...new Set(personal.findings.map((f) => f.kind))],
        },
      };
    }

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = await (tool as any).execute?.(params.callId, toolArgs);
    return { ok: true, result, pluginId: getPluginToolMeta(tool)?.pluginId ?? null };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      type: "tool_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
