import {
  codingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import type { KoLoConfig } from "../config/config.js";
import type { ModelAuthMode } from "./model-auth.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
import { createCodeModeTool, finalizeCodeModeTool } from "../code-mode/tool.js";
import { createFactoryTools } from "../factory/tools.js";
import { wrapToolWithFormatter } from "../format/wrapper.js";
import { wrapToolWithPersonalDataGuard } from "../governance/outbound-guard.js";
import { maxAsk, minSecurity } from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { wrapToolWithLspDiagnostics } from "../lsp/diagnostics-wrapper.js";
import {
  createMemoryTurn,
  resolveMemoryGuardContext,
  wrapToolWithMemoryProvenance,
} from "../memory/provenance-guard.js";
import { getPluginToolMeta, resolveProjectScopedPluginTools } from "../plugins/tools.js";
import { wrapToolWithPolicyGuard } from "../policy/guard.js";
import {
  parseProjectSessionKey,
  projectPermissionSet,
  projectPluginIds,
} from "../projects/scope.js";
import { getProject } from "../projects/store.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { wrapToolWithSnapshots } from "../snapshots/wrapper.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  createExecTool,
  createProcessTool,
  type ExecToolDefaults,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { createKipEngineTaskTool } from "./kip-engine-task.js";
import { createKoLoTools } from "./kolo-tools.js";
import { resolveMemorySearchConfig } from "./memory-search.js";
import { resolveToolPermissions, wrapToolWithPermissionGuard } from "./permissions.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import {
  filterToolsByCapability,
  filterToolsByPolicy,
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
  wrapToolWithCapabilityGuard,
} from "./pi-tools.policy.js";
import {
  assertRequiredParams,
  CLAUDE_PARAM_GROUPS,
  createKoLoReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.read.js";
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import { resolveProviderToolCapability, type ToolCapability } from "./tool-capability.js";
import {
  buildPluginToolGroups,
  collectExplicitAllowlist,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  stripPluginOnlyAllowlist,
} from "./tool-policy.js";

function isOpenAIProvider(provider?: string) {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) {
    return true;
  }
  const modelId = params.modelId?.trim();
  if (!modelId) {
    return false;
  }
  const normalizedModelId = modelId.toLowerCase();
  const provider = params.modelProvider?.trim().toLowerCase();
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

/**
 * Effective exec settings for one agent: `agents.list[].tools.exec` over `tools.exec`.
 * Host, node, paths and timings take the agent's value. Security and ask may only be tightened
 * by the agent entry (the stricter of the two wins), so a per-agent block can never loosen what
 * the global block enforces.
 */
export function resolveExecConfig(cfg: KoLoConfig | undefined, agentId?: string) {
  const globalExec = cfg?.tools?.exec;
  const agentExec = cfg && agentId ? resolveAgentConfig(cfg, agentId)?.tools?.exec : undefined;
  const pick = <K extends keyof NonNullable<typeof globalExec>>(key: K) =>
    agentExec?.[key] ?? globalExec?.[key];
  const security =
    agentExec?.security && globalExec?.security
      ? minSecurity(globalExec.security, agentExec.security)
      : (agentExec?.security ?? globalExec?.security);
  const ask =
    agentExec?.ask && globalExec?.ask
      ? maxAsk(globalExec.ask, agentExec.ask)
      : (agentExec?.ask ?? globalExec?.ask);
  return {
    host: pick("host"),
    unsandboxed: pick("unsandboxed"),
    security,
    ask,
    node: pick("node"),
    pathPrepend: pick("pathPrepend"),
    safeBins: pick("safeBins"),
    backgroundMs: pick("backgroundMs"),
    timeoutSec: pick("timeoutSec"),
    approvalRunningNoticeMs: pick("approvalRunningNoticeMs"),
    cleanupMs: pick("cleanupMs"),
    notifyOnExit: pick("notifyOnExit"),
    applyPatch: globalExec?.applyPatch,
  };
}

export const __testing = {
  cleanToolSchemaForGemini,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
  assertRequiredParams,
} as const;

export function createKoLoCodingTools(options?: {
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  sandbox?: SandboxContext | null;
  /**
   * The session had to be sandboxed but the container could not be started. Exec is refused
   * with this reason and file tools are confined to the workspace (never the whole host).
   */
  sandboxUnavailable?: { reason: string } | null;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: KoLoConfig;
  abortSignal?: AbortSignal;
  /**
   * Declared tool capability of the backend (M2a). Defaults to the provider's capability
   * (embedded providers: "gateway"). With "none" the list is empty and calls are rejected.
   */
  toolCapability?: ToolCapability;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** The prompt that started this run (memory provenance: external-content markers). */
  turnPrompt?: string;
}): AnyAgentTool[] {
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
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
  } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    spawnedBy: options?.spawnedBy,
    messageProvider: options?.messageProvider,
    groupId: options?.groupId,
    groupChannel: options?.groupChannel,
    groupSpace: options?.groupSpace,
    accountId: options?.agentAccountId,
    senderId: options?.senderId,
    senderName: options?.senderName,
    senderUsername: options?.senderUsername,
    senderE164: options?.senderE164,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

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
  const scopeKey = options?.exec?.scopeKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicy(options.config)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicyWithAlsoAllow,
    providerProfilePolicyWithAlsoAllow,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  const execConfig = resolveExecConfig(options?.config, agentId);
  const workspaceRoot = options?.workspaceDir ?? process.cwd();
  const sandboxUnavailable = !sandbox ? options?.sandboxUnavailable?.reason : undefined;
  // Degraded sandbox (container unavailable): keep the file tools inside the workspace.
  const sandboxRoot = sandbox?.workspaceDir ?? (sandboxUnavailable ? workspaceRoot : undefined);
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const applyPatchConfig = options?.config?.tools?.exec?.applyPatch;
  const applyPatchEnabled =
    !!applyPatchConfig?.enabled &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        return [createSandboxedReadTool(sandboxRoot)];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      return [createKoLoReadTool(freshReadTool)];
    }
    if (tool.name === "bash" || tool.name === execToolName) {
      return [];
    }
    if (tool.name === "write") {
      if (sandboxRoot) {
        return [];
      }
      // Wrap with param normalization for client compatibility
      return [
        wrapToolParamNormalization(createWriteTool(workspaceRoot), CLAUDE_PARAM_GROUPS.write),
      ];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) {
        return [];
      }
      // Wrap with param normalization for client compatibility
      return [wrapToolParamNormalization(createEditTool(workspaceRoot), CLAUDE_PARAM_GROUPS.edit)];
    }
    return [tool];
  });
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
  const execHost = options?.exec?.host ?? execConfig.host;
  const execTool = createExecTool({
    ...execDefaults,
    host: execHost,
    hostPinned: execHost !== undefined,
    unsandboxed: options?.exec?.unsandboxed ?? execConfig.unsandboxed,
    sandboxUnavailable,
    security: options?.exec?.security ?? execConfig.security,
    ask: options?.exec?.ask ?? execConfig.ask,
    node: options?.exec?.node ?? execConfig.node,
    pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
    safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
    agentId,
    cwd: options?.workspaceDir,
    // A caller may turn background continuation off (cron pre-steps run to completion).
    allowBackground: options?.exec?.allowBackground === false ? false : allowBackground,
    scopeKey,
    sessionKey: options?.sessionKey,
    messageProvider: options?.messageProvider,
    backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
    timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
    approvalRunningNoticeMs:
      options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
    notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });
  const processTool = createProcessTool({
    cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
    scopeKey,
    agentId,
    sessionKey: options?.sessionKey,
  });
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot,
          sandboxRoot: sandboxRoot && allowWorkspaceWrites ? sandboxRoot : undefined,
        });
  // M6: Code Mode runs one script over the agent's final tool list; the list is attached after
  // policy filtering below (finalizeCodeModeTool), so the same gates apply inside the script.
  const codeModeRef = { tools: [] as AnyAgentTool[] };
  const codeModeTool = createCodeModeTool({
    resolveTools: () => codeModeRef.tools,
    agentId,
    sessionKey: options?.sessionKey,
  });
  // M5b: KIP headless engine bridge — registered only when explicitly enabled in config
  // (kipEngine.enabled + baseUrl); classified under the exec class for permission globs.
  const kipEngineCfg = options?.config?.kipEngine;
  const kipEngineTool =
    kipEngineCfg?.enabled && kipEngineCfg.baseUrl?.trim()
      ? createKipEngineTaskTool({
          baseUrl: kipEngineCfg.baseUrl.trim().replace(/\/+$/, ""),
          tokenFile: kipEngineCfg.tokenFile,
          agentId,
          sessionKey: options?.sessionKey,
          defaultTimeoutMs: kipEngineCfg.taskTimeoutMs,
        })
      : null;
  // M15: factory cards (create, move, comment) — on unless factory.enabled is false; the exec
  // permission class gates them (targets factory_card:create|move|comment).
  const factoryCfg = options?.config?.factory;
  const factoryTools =
    factoryCfg?.enabled === false
      ? []
      : createFactoryTools({
          agentId: agentId ?? "main",
          sessionKey: options?.sessionKey,
          defaultBoard: factoryCfg?.defaultBoard,
          defaultRepo: factoryCfg?.defaultRepo,
        });
  // M9b: file-edit tools report language-server diagnostics for the touched file(s) after a
  // successful edit (bounded; no-op when disabled, no server matches or the command is absent).
  // M10: snapshot before the edit, format after it, then diagnostics on the formatted file.
  const withDiagnostics = (tool: AnyAgentTool) =>
    sandboxRoot
      ? tool
      : wrapToolWithLspDiagnostics(
          wrapToolWithFormatter(
            wrapToolWithSnapshots(tool, {
              config: options?.config,
              workspaceDir: workspaceRoot,
              sessionKey: options?.sessionKey,
            }),
            { config: options?.config, workspaceDir: workspaceRoot },
          ),
          { config: options?.config, workspaceDir: workspaceRoot },
        );
  const tools: AnyAgentTool[] = [
    ...base.map(withDiagnostics),
    codeModeTool,
    ...(kipEngineTool ? [kipEngineTool] : []),
    ...factoryTools,
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [createSandboxedEditTool(sandboxRoot), createSandboxedWriteTool(sandboxRoot)]
        : []
      : []),
    ...(applyPatchTool ? [withDiagnostics(applyPatchTool as unknown as AnyAgentTool)] : []),
    execTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...listChannelAgentTools({ cfg: options?.config }),
    ...createKoLoTools({
      sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
      allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : !sandboxUnavailable,
      agentSessionKey: options?.sessionKey,
      agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
      agentAccountId: options?.agentAccountId,
      agentTo: options?.messageTo,
      agentThreadId: options?.messageThreadId,
      agentGroupId: options?.groupId ?? null,
      agentGroupChannel: options?.groupChannel ?? null,
      agentGroupSpace: options?.groupSpace ?? null,
      agentDir: options?.agentDir,
      sandboxRoot,
      workspaceDir: options?.workspaceDir,
      sandboxed: !!sandbox,
      config: options?.config,
      pluginToolAllowlist: collectExplicitAllowlist([
        profilePolicy,
        providerProfilePolicy,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        sandbox?.tools,
        subagentPolicy,
      ]),
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
      modelHasVision: options?.modelHasVision,
      requesterAgentIdOverride: agentId,
    }),
  ];
  // Kurahi v0.3 projects: plugins the project's template enables for this project only (not for
  // the gateway). They pass through the same tool policies and the project permission guard
  // below as every other tool. Relative paths resolve against the same directory the guard uses,
  // so the guard always judges the path the tool will actually open.
  const projectRef = parseProjectSessionKey(options?.sessionKey);
  const project = projectRef ? getProject(projectRef.projectId) : null;
  if (project && !project.archived) {
    const scopedPluginIds = projectPluginIds(project);
    if (scopedPluginIds.length > 0) {
      tools.push(
        ...resolveProjectScopedPluginTools({
          pluginIds: scopedPluginIds,
          context: {
            config: options?.config,
            workspaceDir: workspaceRoot,
            agentDir: options?.agentDir,
            agentId,
            sessionKey: options?.sessionKey,
            messageChannel: resolveGatewayMessageChannel(options?.messageProvider),
            agentAccountId: options?.agentAccountId,
            sandboxed: false,
          },
          existingToolNames: new Set(tools.map((tool) => tool.name)),
        }),
      );
    }
  }
  const coreToolNames = new Set(
    tools
      .filter((tool) => !getPluginToolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools,
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
  const profilePolicyExpanded = resolvePolicy(
    profilePolicyWithAlsoAllow,
    profile ? `tools.profile (${profile})` : "tools.profile",
  );
  const providerProfileExpanded = resolvePolicy(
    providerProfilePolicyWithAlsoAllow,
    providerProfile ? `tools.byProvider.profile (${providerProfile})` : "tools.byProvider.profile",
  );
  const globalPolicyExpanded = resolvePolicy(globalPolicy, "tools.allow");
  const globalProviderExpanded = resolvePolicy(globalProviderPolicy, "tools.byProvider.allow");
  const agentPolicyExpanded = resolvePolicy(
    agentPolicy,
    agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
  );
  const agentProviderExpanded = resolvePolicy(
    agentProviderPolicy,
    agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
  );
  const groupPolicyExpanded = resolvePolicy(groupPolicy, "group tools.allow");
  const sandboxPolicyExpanded = expandPolicyWithPluginGroups(sandbox?.tools, pluginGroups);
  const subagentPolicyExpanded = expandPolicyWithPluginGroups(subagentPolicy, pluginGroups);

  const toolsFiltered = profilePolicyExpanded
    ? filterToolsByPolicy(tools, profilePolicyExpanded)
    : tools;
  const providerProfileFiltered = providerProfileExpanded
    ? filterToolsByPolicy(toolsFiltered, providerProfileExpanded)
    : toolsFiltered;
  const globalFiltered = globalPolicyExpanded
    ? filterToolsByPolicy(providerProfileFiltered, globalPolicyExpanded)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderExpanded
    ? filterToolsByPolicy(globalFiltered, globalProviderExpanded)
    : globalFiltered;
  const agentFiltered = agentPolicyExpanded
    ? filterToolsByPolicy(globalProviderFiltered, agentPolicyExpanded)
    : globalProviderFiltered;
  const agentProviderFiltered = agentProviderExpanded
    ? filterToolsByPolicy(agentFiltered, agentProviderExpanded)
    : agentFiltered;
  const groupFiltered = groupPolicyExpanded
    ? filterToolsByPolicy(agentProviderFiltered, groupPolicyExpanded)
    : agentProviderFiltered;
  const sandboxed = sandboxPolicyExpanded
    ? filterToolsByPolicy(groupFiltered, sandboxPolicyExpanded)
    : groupFiltered;
  const subagentFiltered = subagentPolicyExpanded
    ? filterToolsByPolicy(sandboxed, subagentPolicyExpanded)
    : sandboxed;
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  // ASI06: memory writes are tagged with this turn's trust and held for review when it read
  // untrusted input (src/memory/provenance-guard.ts). Innermost, so only calls every guard allowed.
  const memoryAgentId = agentId ?? resolveDefaultAgentId(options?.config ?? {});
  const memoryGuard = resolveMemoryGuardContext({
    config: options?.config,
    turn: createMemoryTurn({
      agentId: memoryAgentId,
      sessionKey: options?.sessionKey,
      senderId: options?.senderId,
      messageProvider: options?.messageProvider,
      prompt: options?.turnPrompt,
    }),
    root: sandboxRoot ?? workspaceRoot,
    workspaceDir: workspaceRoot,
    extraPaths: options?.config
      ? resolveMemorySearchConfig(options.config, memoryAgentId)?.extraPaths
      : undefined,
  });
  const normalized = subagentFiltered
    .map(normalizeToolParameters)
    .map((tool) => (memoryGuard ? wrapToolWithMemoryProvenance(tool, memoryGuard) : tool))
    // APPI / マイナンバー guard on tools that send or write outside (src/governance/outbound-guard.ts).
    // Innermost, with the final arguments, after every policy and approval guard allowed the call.
    .map((tool) =>
      wrapToolWithPersonalDataGuard(tool, {
        agentId: memoryAgentId,
        sessionKey: options?.sessionKey,
        config: options?.config,
      }),
    );
  const withHooks = normalized.map((tool) =>
    wrapToolWithBeforeToolCallHook(tool, {
      agentId,
      sessionKey: options?.sessionKey,
    }),
  );
  const withAbort = options?.abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : withHooks;

  // M5 permission globs: agents.list[].permissions (+ agents.defaults.permissions).
  // Inert unless at least one rule is configured; write/exec deny-by-default when active.
  const permissionSet = resolveToolPermissions({
    entry: options?.config?.agents?.list?.find((entry) => entry.id === agentId)?.permissions,
    defaults: options?.config?.agents?.defaults?.permissions,
    workspaceDir: workspaceRoot,
  });
  if (permissionSet.problems.length > 0) {
    logWarn(`tools: permissions: ${permissionSet.problems.join("; ")}`);
  }
  // M13: one guard for every tool call (core, MCP, and Code Mode scripts over this same list):
  // the policy engine decides first; the M5 rule set is one of its inputs, so precedence is
  // policy > agents.list[].permissions > defaults in a single place.
  const permissionGuarded = withAbort.map((tool) =>
    wrapToolWithPolicyGuard(tool, {
      agentId: agentId ?? resolveDefaultAgentId(options?.config ?? {}),
      workspaceDir: workspaceRoot,
      sessionKey: options?.sessionKey,
      legacyPermissions: permissionSet,
    }),
  );

  // Kurahi v0.3 projects: a project session may only reach the project's folder and data area
  // (read), its writable folders (write), and never exec. Same guard as the M5 rules, stricter
  // defaults. An unknown or archived project denies every file and exec call.
  const projectGuarded = projectRef
    ? permissionGuarded.map((tool) =>
        wrapToolWithPermissionGuard(tool, {
          permissionSet:
            project && !project.archived
              ? projectPermissionSet(project)
              : {
                  active: true,
                  rules: [],
                  problems: [],
                  denyByDefault: ["read", "write", "exec"],
                  label: "an unknown or archived project",
                },
          workspaceDir: workspaceRoot,
          agentId,
          sessionKey: options?.sessionKey,
        }),
      )
    : permissionGuarded;

  // Outermost gate: the backend's declared tool capability (enforced, not prompted).
  const capability =
    options?.toolCapability ??
    (options?.modelProvider
      ? resolveProviderToolCapability(options.modelProvider, options?.config)
      : "gateway");
  // Tools keep their identity on the default (gateway) path; plugin metadata is keyed by object.
  const capabilityGuarded =
    capability === "gateway"
      ? projectGuarded
      : filterToolsByCapability(projectGuarded, capability).map((tool) =>
          wrapToolWithCapabilityGuard(tool, {
            capability: () => capability,
            agentId,
            sessionKey: options?.sessionKey,
          }),
        );

  finalizeCodeModeTool(capabilityGuarded, codeModeRef);

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return capabilityGuarded;
}
