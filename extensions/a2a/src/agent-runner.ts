import { randomUUID } from "node:crypto";
import type { KoLoConfig } from "../../../src/config/config.js";
import type { AgentDefaultsConfig } from "../../../src/config/types.js";
import type { RunAgent } from "./task-runner.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
} from "../../../src/agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../src/agents/defaults.js";
import { runWithModelFallback } from "../../../src/agents/model-fallback.js";
import { isCliProvider, resolveConfiguredModelRef } from "../../../src/agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../../src/agents/pi-embedded.js";
import { ensureAgentWorkspace } from "../../../src/agents/workspace.js";
import {
  loadSessionStore,
  resolveSessionTranscriptPath,
  resolveStorePath,
  updateSessionStore,
} from "../../../src/config/sessions.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../../src/routing/session-key.js";

// Binds A2A tasks to the embedded agent runtime. Loaded lazily by the plugin so the server code
// (and its tests) do not pull the agent runtime in.
//
// - Session: `agent:<agentId>:a2a:<client>:<context>`, its own transcript, reused for follow-up
//   tasks in the same context. The agent's main session is never touched.
// - Tools: off unless the operator set allowTools; when on, the embedded runtime builds the
//   agent's normal tool set, every call wrapped by the policy guard (approvals included).
// - CLI-backed providers are refused: their tools run outside the guarded tool set.
// - Nothing is delivered to a channel: the reply only becomes the task result.

export function createEmbeddedRunAgent(loadConfig: () => KoLoConfig): RunAgent {
  return async (params) => {
    const cfg = loadConfig();
    const agentId = normalizeAgentId(params.agentId);
    if (!listAgentIds(cfg).includes(agentId)) {
      return { text: "", error: `agent ${agentId} is not configured` };
    }
    const { model: overrideModel, ...agentOverrideRest } = resolveAgentConfig(cfg, agentId) ?? {};
    const agentCfg: AgentDefaultsConfig = Object.assign(
      {},
      cfg.agents?.defaults,
      agentOverrideRest as Partial<AgentDefaultsConfig>,
    );
    if (typeof overrideModel === "string") {
      agentCfg.model = { primary: overrideModel };
    } else if (overrideModel) {
      agentCfg.model = overrideModel;
    }
    const runCfg: KoLoConfig = {
      ...cfg,
      agents: Object.assign({}, cfg.agents, { defaults: agentCfg }),
    };
    const { provider, model } = resolveConfiguredModelRef({
      cfg: runCfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    const workspace = await ensureAgentWorkspace({
      dir: resolveAgentWorkspaceDir(cfg, agentId),
      ensureBootstrapFiles: !agentCfg.skipBootstrap,
    });
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionKey = buildAgentMainSessionKey({ agentId, mainKey: params.sessionMainKey });
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const existing = loadSessionStore(storePath)[sessionKey];
    const sessionId = existing?.sessionId ?? randomUUID();
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = { ...store[sessionKey], sessionId, updatedAt: Date.now() };
    });
    const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);

    const { result } = await runWithModelFallback({
      cfg: runCfg,
      provider,
      model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(cfg, agentId),
      run: async (providerOverride, modelOverride) => {
        if (isCliProvider(providerOverride, runCfg)) {
          throw new Error(`A2A sessions do not run on CLI provider ${providerOverride}`);
        }
        return await runEmbeddedPiAgent({
          sessionId,
          sessionKey,
          messageProvider: "a2a",
          messageChannel: "a2a",
          senderId: `a2a:${params.clientId}`,
          sessionFile,
          workspaceDir: workspace.dir,
          agentDir,
          config: runCfg,
          prompt: params.prompt,
          extraSystemPrompt: params.extraSystemPrompt,
          disableTools: !params.allowTools,
          provider: providerOverride,
          model: modelOverride,
          verboseLevel: "off",
          timeoutMs: params.timeoutMs,
          runId: params.runId,
          abortSignal: params.abortSignal,
          lane: "a2a",
        });
      },
    });

    if (result.meta?.aborted) {
      return { text: "", error: "aborted" };
    }
    const text = (result.payloads ?? [])
      .filter((p) => !p.isError && typeof p.text === "string" && p.text.trim())
      .map((p) => (p.text ?? "").trim())
      .join("\n\n");
    const failed = (result.payloads ?? []).find((p) => p.isError);
    return text ? { text } : { text: "", error: failed?.text ?? "agent returned no text" };
  };
}
