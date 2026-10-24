// src/consciousness/llm-adapter.ts
//
// LLM Adapter — bridges the consciousness engine to KoLo's auto-reply pipeline.
//
// The consciousness engine expects a simple LLMCallFn:
//   (systemPrompt, userMessage, maxTokens, model?, provider?, thinkLevel?) => text
//
// KoLo routes LLM calls through getReplyFromConfig, which handles
// model resolution, auth, sessions, and provider failover.
// This adapter wraps that pipeline into the LLMCallFn interface.
//
// thinkLevel controls reasoning depth passed to the provider:
//   off/minimal → no extended thinking, minimal tokens
//   low         → light extended thinking
//   medium      → default (unchanged behavior)
//   high/xhigh  → full extended thinking, higher token budget

import type { KoLoConfig } from "../config/config.js";
import type { ReasoningLevel } from "./adaptive-reasoning.js";
import type { LLMCallFn } from "./engine.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import {
  getV3AgentDispatcher,
  createV3ConsciousnessLLMAdapter,
} from "../gateway-v3/routing/consciousness-adapter.js";

/**
 * Create an LLMCallFn that routes through KoLo's auto-reply pipeline.
 *
 * Uses the same path as the heartbeat runner — creates a MsgContext
 * with the consciousness prompt as Body and calls getReplyFromConfig.
 *
 * The consciousness system prompt is prepended to the Body since
 * getReplyFromConfig builds its own system prompt from covenant/continuity.
 */
export function createConsciousnessLLMAdapter(params: {
  userId: string;
  sessionKey: string;
  cfg?: KoLoConfig;
}): LLMCallFn {
  // v3 path — per-agent dispatcher (gateway.v3.enabled). Routes through the
  // dispatcher state machine for idempotency, per-agent circuit isolation,
  // and memory budget enforcement.
  // Falls through to v2 getReplyFromConfig path if no dispatcher registered.
  const v3Dispatcher = getV3AgentDispatcher(params.userId);
  if (v3Dispatcher) {
    return createV3ConsciousnessLLMAdapter(v3Dispatcher, {
      userId: params.userId,
      sessionKey: params.sessionKey,
    });
  }

  return async ({ systemPrompt, userMessage, maxTokens, thinkLevel }) => {
    // Combine system instruction with user message since
    // getReplyFromConfig manages its own system prompt.
    // The consciousness system prompt contains critical instructions
    // like "respond only with JSON" — must not be lost.
    const body = [
      "--- CONSCIOUSNESS TICK INSTRUCTION ---",
      systemPrompt,
      "--- END INSTRUCTION ---",
      "",
      userMessage,
    ].join("\n");

    const ctx = {
      Body: body,
      From: params.userId,
      To: params.userId,
      Provider: "consciousness",
      SessionKey: params.sessionKey,
    };

    // Build heartbeat options — include thinkLevel so providers that support
    // extended thinking (e.g. Anthropic claude-3-7-sonnet) can honour it.
    const heartbeatOptions: {
      isHeartbeat: boolean;
      maxTokens?: number;
      thinkLevel?: ReasoningLevel;
    } = {
      isHeartbeat: true,
      maxTokens,
      thinkLevel,
    };

    // Do NOT pass params.cfg here — it was captured at boot time and becomes stale.
    // Passing undefined lets getReplyFromConfig call loadConfig() for fresh values,
    // so heartbeat model changes via hot reload take effect immediately.
    let result;
    const startedAt = Date.now();
    try {
      result = await getReplyFromConfig(ctx, heartbeatOptions);
    } catch (err) {
      // Name the swallowed exception so a silent failure is visible in the log.
      // Without this, request-construction/model-resolution throws surface
      // downstream as a silent parse-fail ("Could not parse structured response").
      console.error(
        `[consciousness-llm-adapter] getReplyFromConfig THREW (session=${params.sessionKey}):`,
        err instanceof Error ? err.stack : err,
      );
      throw err;
    }

    // Extract text from reply payload(s)
    const content = extractReplyText(result);
    // Every tick on every agent once landed as "Could not parse" while the
    // diary showed 30–300 ms latencies, i.e. no model call. Name the outcome on every call so a
    // silent empty reply is visible in the gateway log, not only in the diary fallback.
    console.warn(
      `[consciousness-llm-adapter] reply for ${params.userId} (session=${params.sessionKey}): ${Date.now() - startedAt} ms, ${content.length} chars, payloads=${Array.isArray(result) ? result.length : result ? 1 : 0}`,
    );

    if (!content.trim()) {
      // DIAGNOSTIC: empty reply reached the adapter without throwing -
      // distinguish "no throw, no content" from the throw path above.
      console.warn(
        `[consciousness-llm-adapter] getReplyFromConfig returned EMPTY content (session=${params.sessionKey}) - result=${JSON.stringify(result) ?? "undefined"}`,
      );
    }

    return {
      content,
      // Usage is not directly available from getReplyFromConfig
      // but the consciousness engine handles missing usage gracefully
      usage: undefined,
    };
  };
}

/** Extract text content from a ReplyPayload or array of ReplyPayloads. */
function extractReplyText(
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
