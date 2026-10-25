import type { AnyAgentTool } from "../agents/tools/common.js";
import type { KoLoPluginToolContext } from "./types.js";
import { normalizeToolName } from "../agents/tool-policy.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadKoLoPlugins, loadScopedKoLoPlugins } from "./loader.js";

const log = createSubsystemLogger("plugins");

type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

/** Carry a plugin tool's origin over to a wrapper (a guard wrapper is a new object). */
export function copyPluginToolMeta(from: AnyAgentTool, to: AnyAgentTool): AnyAgentTool {
  const meta = pluginToolMeta.get(from);
  if (meta) {
    pluginToolMeta.set(to, meta);
  }
  return to;
}

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

function normalizeAllowlist(list?: string[]) {
  return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.allowlist.has("group:plugins");
}

const pluginLogger = {
  info: (msg: string) => log.info(msg),
  warn: (msg: string) => log.warn(msg),
  error: (msg: string) => log.error(msg),
  debug: (msg: string) => log.debug(msg),
};

export function resolvePluginTools(params: {
  context: KoLoPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
}): AnyAgentTool[] {
  const registry = loadKoLoPlugins({
    config: params.context.config,
    workspaceDir: params.context.workspaceDir,
    logger: pluginLogger,
  });
  return collectRegistryTools(registry, params);
}

/**
 * Tools of plugins enabled for one project only (a project template's `plugins`), from a private
 * registry (see loadScopedKoLoPlugins). The caller still wraps every tool in the project's
 * permission guard, with the same `context.workspaceDir` for relative paths.
 */
export function resolveProjectScopedPluginTools(params: {
  pluginIds: string[];
  context: KoLoPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
}): AnyAgentTool[] {
  if (params.pluginIds.length === 0) {
    return [];
  }
  const registry = loadScopedKoLoPlugins({
    config: params.context.config,
    pluginIds: params.pluginIds,
    logger: pluginLogger,
  });
  return collectRegistryTools(registry, params);
}

function collectRegistryTools(
  registry: ReturnType<typeof loadKoLoPlugins>,
  params: {
    context: KoLoPluginToolContext;
    existingToolNames?: Set<string>;
    toolAllowlist?: string[];
  },
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();

  for (const entry of registry.tools) {
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      log.error(message);
      registry.diagnostics.push({
        level: "error",
        pluginId: entry.pluginId,
        source: entry.source,
        message,
      });
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
    try {
      resolved = entry.factory(params.context);
    } catch (err) {
      log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
      continue;
    }
    if (!resolved) {
      continue;
    }
    const listRaw = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: tool.name,
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : listRaw;
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const tool of list) {
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        log.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      tools.push(tool);
    }
  }

  return tools;
}
