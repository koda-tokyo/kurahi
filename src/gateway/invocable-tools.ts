import type { AnyAgentTool } from "../agents/tools/common.js";
import type { KoLoConfig } from "../config/config.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
// Tools a gateway request may invoke for a session (KoLo 2.0, M4/M6). The same policy stack the
// embedded runner applies (profile, provider profile, global, agent, group, subagent) over the
// gateway tool list (core + plugin + MCP), plus the M2 backend capability gate. Shared by
// POST /tools/invoke, POST /api/code-mode/run and WS codeMode.run.
// A project session (Kurahi v0.3) also gets the project's own plugin tools and the project
// permission guard, as in the embedded runner; an unknown or archived project, or an agent the
// project does not allow, gets no tools at all.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createKoLoTools } from "../agents/kolo-tools.js";
import { wrapToolWithPermissionGuard } from "../agents/permissions.js";
import {
  filterToolsByPolicy,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "../agents/pi-tools.policy.js";
import {
  checkToolCallCapability,
  resolveAgentToolCapability,
  type ToolCapability,
} from "../agents/tool-capability.js";
import {
  buildPluginToolGroups,
  collectExplicitAllowlist,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  stripPluginOnlyAllowlist,
} from "../agents/tool-policy.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { logWarn } from "../logger.js";
import {
  copyPluginToolMeta,
  getPluginToolMeta,
  resolveProjectScopedPluginTools,
} from "../plugins/tools.js";
import {
  parseProjectSessionKey,
  projectPermissionSet,
  projectPluginIds,
} from "../projects/scope.js";
import { getProject, isAgentAllowed } from "../projects/store.js";
import { isSubagentSessionKey } from "../routing/session-key.js";

export type InvocableTools = {
  sessionKey: string;
  agentId?: string;
  capability: ToolCapability;
  tools: AnyAgentTool[];
  /** Set when the session is a project session that may not run tools here (fails closed). */
  projectDenied?: string;
};

export function resolveInvocableSessionKey(cfg: KoLoConfig, raw: string | undefined): string {
  const trimmed = raw?.trim();
  return !trimmed || trimmed === "main" ? resolveMainSessionKey(cfg) : trimmed;
}

export function resolveInvocableTools(params: {
  cfg: KoLoConfig;
  sessionKey: string;
  messageChannel?: GatewayMessageChannel;
  accountId?: string;
}): InvocableTools {
  const { cfg, sessionKey, messageChannel, accountId } = params;
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: cfg, sessionKey });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const capability = resolveAgentToolCapability(cfg, agentId);

  const projectRef = parseProjectSessionKey(sessionKey);
  const project = projectRef ? getProject(projectRef.projectId) : null;
  if (projectRef) {
    const denied =
      !project || project.archived
        ? "project not found or archived"
        : !isAgentAllowed(project, projectRef.agentId, resolveDefaultAgentId(cfg))
          ? `agent ${projectRef.agentId} is not allowed in this project`
          : undefined;
    if (denied) {
      return { sessionKey, agentId, capability, tools: [], projectDenied: denied };
    }
  }

  const mergeAlsoAllow = (policy: typeof profilePolicy, alsoAllow?: string[]) => {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
      return policy;
    }
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
  };
  const profilePolicyWithAlsoAllow = mergeAlsoAllow(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllow(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey,
    messageProvider: messageChannel ?? undefined,
    accountId: accountId ?? null,
  });
  const subagentPolicy = isSubagentSessionKey(sessionKey)
    ? resolveSubagentToolPolicy(cfg)
    : undefined;

  const gatewayTools = createKoLoTools({
    agentSessionKey: sessionKey,
    agentChannel: messageChannel ?? undefined,
    agentAccountId: accountId,
    config: cfg,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
    ]),
  });
  // Plugins the project's template enables for this project only; the same policies below and the
  // project guard apply to them.
  const allTools =
    project && !project.archived && projectPluginIds(project).length > 0
      ? [
          ...gatewayTools,
          ...resolveProjectScopedPluginTools({
            pluginIds: projectPluginIds(project),
            context: {
              config: cfg,
              workspaceDir: project.folder,
              agentId,
              sessionKey,
              messageChannel,
              agentAccountId: accountId,
              sandboxed: false,
            },
            existingToolNames: new Set(gatewayTools.map((tool) => tool.name)),
          }),
        ]
      : gatewayTools;

  const coreToolNames = new Set(
    allTools
      .filter((tool) => !getPluginToolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools: allTools,
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const resolvePolicy = (policy: typeof profilePolicy, label: string) => {
    const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
    if (resolved.unknownAllowlist.length > 0) {
      const entries = resolved.unknownAllowlist.join(", ");
      const suffix = resolved.strippedAllowlist
        ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
        : "These entries won't match any tool unless the plugin is enabled.";
      logWarn(`tools: ${label} allowlist contains unknown entries (${entries}). ${suffix}`);
    }
    return expandPolicyWithPluginGroups(resolved.policy, pluginGroups);
  };
  const stages: Array<ReturnType<typeof resolvePolicy>> = [
    resolvePolicy(
      profilePolicyWithAlsoAllow,
      profile ? `tools.profile (${profile})` : "tools.profile",
    ),
    resolvePolicy(
      providerProfilePolicyWithAlsoAllow,
      providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
    ),
    resolvePolicy(globalPolicy, "tools.allow"),
    resolvePolicy(globalProviderPolicy, "tools.byProvider.allow"),
    resolvePolicy(agentPolicy, agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow"),
    resolvePolicy(
      agentProviderPolicy,
      agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
    ),
    resolvePolicy(groupPolicy, "group tools.allow"),
    expandPolicyWithPluginGroups(subagentPolicy, pluginGroups),
  ];
  let tools = allTools;
  for (const policy of stages) {
    if (policy) {
      tools = filterToolsByPolicy(tools, policy);
    }
  }
  if (project) {
    // The project's folder/data-area reach and its mode's tool list, as in the embedded runner.
    const permissionSet = projectPermissionSet(project);
    // Keep each tool's plugin origin on its guard wrapper: callers (the autopilot engine) check
    // that a tool answers from the plugin that declared it.
    tools = tools.map((tool) =>
      copyPluginToolMeta(
        tool,
        wrapToolWithPermissionGuard(tool, {
          permissionSet,
          workspaceDir: project.folder,
          agentId,
          sessionKey,
        }),
      ),
    );
  }
  return { sessionKey, agentId, capability, tools };
}

/** M2 capability gate for one call from a gateway surface; denied calls are audited. */
export function checkInvocableCapability(
  resolved: InvocableTools,
  toolName: string,
  source: string,
): { ok: true } | { ok: false; reason: string } {
  if (resolved.projectDenied) {
    return { ok: false, reason: `Permission denied: ${resolved.projectDenied}.` };
  }
  return checkToolCallCapability({
    capability: resolved.capability,
    toolName,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    source,
  });
}
