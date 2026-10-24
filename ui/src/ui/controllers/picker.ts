// Agent and model picker in the chat box (v0.3). Shows only what this user may use here:
// agents from the gateway's agent list, narrowed to the project's allowed agents; models from
// the configuration (default model, fallbacks and configured providers), narrowed to the
// project's allowed models. Nothing is hard-coded.
import type { Project } from "./projects";

export type AgentOption = { id: string; label: string };

export function allowedAgents(
  agents: Array<{ id: string; name?: string; identity?: { name?: string } }>,
  defaultId: string,
  project: Pick<Project, "allowedAgents"> | null,
): AgentOption[] {
  const all = agents.map((a) => ({ id: a.id, label: a.identity?.name || a.name || a.id }));
  if (!project) {
    return all;
  }
  const allowed =
    project.allowedAgents.length > 0 ? new Set(project.allowedAgents) : new Set([defaultId]);
  return all.filter((a) => allowed.has(a.id));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Model refs (`provider/model`) the configuration names. */
export function configuredModels(config: unknown): string[] {
  const out: string[] = [];
  const add = (ref: unknown) => {
    if (typeof ref === "string" && ref.includes("/") && !out.includes(ref)) {
      out.push(ref);
    }
  };
  const defaults =
    isRecord(config) && isRecord(config.agents) && isRecord(config.agents.defaults)
      ? config.agents.defaults.model
      : undefined;
  if (typeof defaults === "string") {
    add(defaults);
  } else if (isRecord(defaults)) {
    add(defaults.primary);
    if (Array.isArray(defaults.fallbacks)) {
      defaults.fallbacks.forEach(add);
    }
  }
  const providers =
    isRecord(config) && isRecord(config.models) && isRecord(config.models.providers)
      ? config.models.providers
      : {};
  for (const [provider, p] of Object.entries(providers)) {
    if (isRecord(p) && Array.isArray(p.models)) {
      for (const m of p.models) {
        if (isRecord(m) && typeof m.id === "string") {
          add(`${provider}/${m.id}`);
        }
      }
    }
  }
  return out;
}

export function allowedModels(
  config: unknown,
  project: Pick<Project, "allowedModels"> | null,
): string[] {
  const all = configuredModels(config);
  if (!project || project.allowedModels.length === 0) {
    return all;
  }
  return all.filter((m) => project.allowedModels.includes(m));
}

/** The session key to switch to when another agent is picked (outside projects). */
export function sessionKeyForAgent(currentKey: string, agentId: string): string {
  const m = /^agent:([^:]+):(.+)$/.exec(currentKey);
  if (!m) {
    return `agent:${agentId}:main`;
  }
  return `agent:${agentId}:${m[2]}`;
}

/**
 * Display name for a model ref: the alias from `agents.defaults.models["<ref>"].alias` when the
 * configuration sets one (for example 「ローカルモデル / Local model」), else the ref itself.
 */
export function modelLabel(config: unknown, ref: string): string {
  const models =
    isRecord(config) && isRecord(config.agents) && isRecord(config.agents.defaults)
      ? config.agents.defaults.models
      : undefined;
  const entry = isRecord(models) ? models[ref] : undefined;
  const alias = isRecord(entry) && typeof entry.alias === "string" ? entry.alias.trim() : "";
  return alias || ref;
}
