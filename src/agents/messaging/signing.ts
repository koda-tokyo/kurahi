// Settings for signed inter-agent messages and the sending side (OWASP ASI07).
import type { AgentMessageSigningMode } from "../../config/types.agents.js";
import type { KoLoConfig } from "../../config/types.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { type AgentMessageEnvelope, signAgentMessage } from "./envelope.js";
import { type AgentKeyLocations, ensureAgentSigningKey } from "./keys.js";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "./payload.js";

const log = createSubsystemLogger("agents/messaging");

export const DEFAULT_MAX_AGE_SECONDS = 300;
/** Runtime fallback when `agents.messaging.signing.mode` is unset (existing installs). */
export const LEGACY_SIGNING_MODE: AgentMessageSigningMode = "warn";
/** What new installations get (src/config/secure-defaults.ts). */
export const SECURE_SIGNING_MODE: AgentMessageSigningMode = "enforce";

export type AgentMessageSigningSettings = {
  mode: AgentMessageSigningMode;
  /** True when the mode is set in the config (not the legacy fallback). */
  configured: boolean;
  maxAgeMs: number;
  maxPayloadBytes: number;
};

export function resolveAgentMessageSigning(cfg?: KoLoConfig): AgentMessageSigningSettings {
  const raw = cfg?.agents?.messaging?.signing;
  const mode =
    raw?.mode === "off" || raw?.mode === "warn" || raw?.mode === "enforce" ? raw.mode : undefined;
  const maxAge =
    typeof raw?.maxAgeSeconds === "number" && raw.maxAgeSeconds > 0
      ? raw.maxAgeSeconds
      : DEFAULT_MAX_AGE_SECONDS;
  const maxBytes =
    typeof raw?.maxPayloadBytes === "number" && raw.maxPayloadBytes > 0
      ? raw.maxPayloadBytes
      : DEFAULT_MAX_PAYLOAD_BYTES;
  return {
    mode: mode ?? LEGACY_SIGNING_MODE,
    configured: mode !== undefined,
    maxAgeMs: Math.floor(maxAge * 1000),
    maxPayloadBytes: Math.floor(maxBytes),
  };
}

const reportedFailures = new Set<string>();

/**
 * Envelope fields to merge into an inter-agent `agent` gateway request. Empty when signing is
 * off or the key cannot be prepared (logged once per agent; the gateway then treats the message
 * as unsigned, which enforce mode rejects).
 */
export function signAgentMessageParams(params: {
  cfg?: KoLoConfig;
  senderSessionKey?: string;
  recipientSessionKey: string;
  message: string;
  extraSystemPrompt?: string;
  loc?: AgentKeyLocations;
  now?: number;
}): { agentEnvelope?: AgentMessageEnvelope } {
  const settings = resolveAgentMessageSigning(params.cfg ?? loadConfig());
  if (settings.mode === "off") {
    return {};
  }
  const senderAgentId = resolveAgentIdFromSessionKey(params.senderSessionKey);
  try {
    const key = ensureAgentSigningKey(senderAgentId, { loc: params.loc });
    if (key.registered) {
      log.info(
        `registered message signing key for agent ${senderAgentId} (key ${key.keyId.slice(0, 12)})`,
      );
    }
    return {
      agentEnvelope: signAgentMessage({
        key,
        senderSessionKey: params.senderSessionKey,
        recipientSessionKey: params.recipientSessionKey,
        payload: {
          message: params.message,
          ...(params.extraSystemPrompt !== undefined
            ? { extraSystemPrompt: params.extraSystemPrompt }
            : {}),
        },
        now: params.now,
      }),
    };
  } catch (err) {
    if (!reportedFailures.has(senderAgentId)) {
      reportedFailures.add(senderAgentId);
      log.warn(
        `cannot sign inter-agent messages for agent ${senderAgentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {};
  }
}
