// Stub: gateway-v3 routing consciousness-adapter
// Per-agent dispatcher registry for v3 consciousness ticking.

import type { ReasoningLevel } from "../../consciousness/adaptive-reasoning.js";
import type { LLMCallFn } from "../../consciousness/engine.js";
import { getReplyFromConfig } from "../../auto-reply/reply.js";

export interface AgentDispatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly agentId: string;
}

const dispatchers = new Map<string, AgentDispatcher>();

export function createConsciousnessDispatcher(opts: {
  agentId: string;
  tripThreshold?: number;
  memoryBudget?: number;
}): AgentDispatcher {
  const dispatcher: AgentDispatcher = {
    agentId: opts.agentId,
    async start() {},
    async stop() {},
  };
  dispatchers.set(opts.agentId, dispatcher);
  return dispatcher;
}

export function setV3AgentDispatcher(agentId: string, dispatcher: AgentDispatcher): void {
  dispatchers.set(agentId, dispatcher);
}

export function getV3AgentDispatcher(agentId: string): AgentDispatcher | undefined {
  return dispatchers.get(agentId);
}

export function getAllV3AgentDispatchers(): AgentDispatcher[] {
  return Array.from(dispatchers.values());
}

export function clearAllV3AgentDispatchers(): void {
  dispatchers.clear();
}

export function createConsciousnessAdapterForAgent(_opts: { agentId: string }): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  return {
    async start() {},
    async stop() {},
  };
}

/**
 * Wrap the (currently no-op) v3 AgentDispatcher as a real LLMCallFn.
 *
 * HISTORY:
 * This function was a stub returning `{ content: "" }` since Sep 3. With
 * `gateway.v3.enabled=true`, every agent's consciousness ticks
 * went hollow (root-caused 2026-09-25, three independent proofs). The full
 * archived implementation routed
 * through an LlmDispatcher state machine (idempotency, per-agent circuit
 * isolation, memory budget) — but LlmDispatcher, isolation/memory-budget and
 * gateway-v2 CircuitBreakerRegistry are NOT present in this tree, so a full
 * restore is a larger follow-up (27/09 table item).
 *
 * This implementation makes the v3 path REAL by calling the same pipeline the
 * v2 fallback in src/consciousness/llm-adapter.ts uses: getReplyFromConfig
 * with isHeartbeat:true. It keeps the per-call outcome logging as the
 * verification hook. NOT a stop-gap: identical code path
 * to the proven v2 fallback; the dispatcher param is kept for interface
 * compatibility and future state-machine routing.
 */
export function createV3ConsciousnessLLMAdapter(
  _dispatcher: AgentDispatcher,
  opts: { userId: string; sessionKey: string },
): LLMCallFn {
  return async ({ systemPrompt, userMessage, maxTokens, thinkLevel }) => {
    // Combine system instruction with user message — getReplyFromConfig
    // manages its own system prompt, so the tick instruction rides in Body.
    // (Exact same shape as the v2 fallback path in consciousness/llm-adapter.ts.)
    const body = [
      "--- CONSCIOUSNESS TICK INSTRUCTION ---",
      systemPrompt,
      "--- END INSTRUCTION ---",
      "",
      userMessage,
    ].join("\n");

    const ctx = {
      Body: body,
      From: opts.userId,
      To: opts.userId,
      Provider: "consciousness",
      SessionKey: opts.sessionKey,
    };

    // Do NOT pass a cfg snapshot — getReplyFromConfig reloads config so
    // hot-reload model changes take effect immediately (v2-path parity).
    // maxTokens/thinkLevel ride along for v2-path parity (declared as a typed
    // variable, exactly like consciousness/llm-adapter.ts does).
    const heartbeatOptions: {
      isHeartbeat: boolean;
      maxTokens?: number;
      thinkLevel?: ReasoningLevel;
    } = {
      isHeartbeat: true,
      maxTokens,
      thinkLevel,
    };

    let result;
    const startedAt = Date.now();
    try {
      result = await getReplyFromConfig(ctx, heartbeatOptions);
    } catch (err) {
      // Name the swallowed exception.
      console.error(
        `[v3-consciousness-adapter] getReplyFromConfig THREW (session=${opts.sessionKey}):`,
        err instanceof Error ? err.stack : err,
      );
      throw err;
    }

    const content = extractV3ReplyText(result);
    // Name the outcome of every model call so a silent
    // empty reply is visible in the gateway log, not only in the diary.
    console.warn(
      `[v3-consciousness-adapter] reply for ${opts.userId} (session=${opts.sessionKey}): ${Date.now() - startedAt} ms, ${content.length} chars, payloads=${Array.isArray(result) ? result.length : result ? 1 : 0}`,
    );

    if (!content.trim()) {
      console.warn(
        `[v3-consciousness-adapter] getReplyFromConfig returned EMPTY content (session=${opts.sessionKey}) - result=${JSON.stringify(result) ?? "undefined"}`,
      );
    }

    return {
      content,
      // Usage is not directly available from getReplyFromConfig; the
      // consciousness engine handles missing usage gracefully.
      usage: undefined,
    };
  };
}

/** Extract text content from a ReplyPayload or array of ReplyPayloads. */
function extractV3ReplyText(
  result: { text?: string } | Array<{ text?: string }> | undefined,
): string {
  if (!result) return "";
  if (Array.isArray(result)) {
    return result
      .map((r) => r.text ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return result.text ?? "";
}
