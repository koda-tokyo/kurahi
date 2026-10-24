// Signed envelope for inter-agent messages (OWASP ASI07).
//
// The sending side (sessions_send, the A2A ping-pong/announce steps, sessions_spawn, the sub-agent
// announce) signs { sender agent, recipient session, nonce, timestamp, payload hash } with the
// sender agent's Ed25519 key. The gateway verifies it before the message reaches the recipient:
// the sender must be in the owner-signed registry, the signature must verify, the payload hash
// must match the delivered message, the recipient must be the session the message is delivered
// to, the timestamp must be inside the window and the nonce must not have been seen before.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentRegistryEntry } from "./keys.js";
import { signDevicePayload, verifyDeviceSignature } from "../../infra/device-identity.js";
import { sha256Hex } from "../../policy/attestation.js";

export const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_DOMAIN = "kolo-agent-msg-v1";

export const AgentMessageEnvelopeSchema = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    alg: z.literal("ed25519"),
    senderAgentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    senderSessionKey: z.string().min(1).max(512).optional(),
    recipientSessionKey: z.string().min(1).max(512),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
    timestamp: z.number().int().nonnegative(),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
    keyId: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().min(1).max(512),
  })
  .strict();

export type AgentMessageEnvelope = z.infer<typeof AgentMessageEnvelopeSchema>;

/** The parts of an `agent` request the envelope covers. */
export type AgentMessagePayload = { message: string; extraSystemPrompt?: string };

export type EnvelopeFailure =
  | "schema"
  | "registry"
  | "unknown-sender"
  | "bad-signature"
  | "payload-mismatch"
  | "recipient-mismatch"
  | "stale"
  | "replay";

export type EnvelopeVerification =
  | { ok: true; senderAgentId: string; senderSessionKey?: string; keyId: string }
  | { ok: false; failure: EnvelopeFailure; reason: string; senderAgentId?: string };

export function payloadSha256(payload: AgentMessagePayload): string {
  return sha256Hex(
    JSON.stringify({
      message: payload.message,
      extraSystemPrompt: payload.extraSystemPrompt ?? null,
    }),
  );
}

function signingInput(env: Omit<AgentMessageEnvelope, "signature">): string {
  return `${ENVELOPE_DOMAIN}\n${JSON.stringify([
    env.version,
    env.alg,
    env.senderAgentId,
    env.senderSessionKey ?? null,
    env.recipientSessionKey,
    env.nonce,
    env.timestamp,
    env.payloadSha256,
    env.keyId,
  ])}`;
}

export function signAgentMessage(params: {
  key: { agentId: string; keyId: string; privateKeyPem: string };
  senderSessionKey?: string;
  recipientSessionKey: string;
  payload: AgentMessagePayload;
  now?: number;
  nonce?: string;
}): AgentMessageEnvelope {
  const unsigned = {
    version: ENVELOPE_VERSION,
    alg: "ed25519" as const,
    senderAgentId: params.key.agentId,
    ...(params.senderSessionKey ? { senderSessionKey: params.senderSessionKey } : {}),
    recipientSessionKey: params.recipientSessionKey,
    nonce: params.nonce ?? randomBytes(18).toString("base64url"),
    timestamp: params.now ?? Date.now(),
    payloadSha256: payloadSha256(params.payload),
    keyId: params.key.keyId,
  };
  return {
    ...unsigned,
    signature: signDevicePayload(params.key.privateKeyPem, signingInput(unsigned)),
  };
}

/** Records nonces; `remember` is true when the nonce is new, false on a replay. */
export interface ReplayGuard {
  remember(key: string, expiresAt: number, now: number): boolean;
}

/** Bounded in-memory nonce store; entries expire once their timestamp leaves the window. */
export class NonceCache implements ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly maxEntries = 20_000) {}

  /** True when the nonce is new (and records it); false on a replay. */
  remember(key: string, expiresAt: number, now: number): boolean {
    const known = this.seen.get(key);
    if (known !== undefined && known > now) {
      return false;
    }
    if (this.seen.size >= this.maxEntries) {
      for (const [k, exp] of this.seen) {
        if (exp <= now) {
          this.seen.delete(k);
        }
      }
      // Still full of live nonces: drop the oldest (insertion order) to stay bounded.
      for (const k of this.seen.keys()) {
        if (this.seen.size < this.maxEntries) {
          break;
        }
        this.seen.delete(k);
      }
    }
    this.seen.set(key, expiresAt);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

export function verifyAgentMessage(params: {
  envelope: unknown;
  payload: AgentMessagePayload;
  /** Keys the delivery session is known by (raw and canonical). */
  recipientSessionKeys: string[];
  registry: { ok: true; agents: Map<string, AgentRegistryEntry> } | { ok: false; reason: string };
  maxAgeMs: number;
  replay: ReplayGuard;
  now?: number;
}): EnvelopeVerification {
  const parsed = AgentMessageEnvelopeSchema.safeParse(params.envelope);
  if (!parsed.success) {
    return { ok: false, failure: "schema", reason: "malformed agent message envelope" };
  }
  const env = parsed.data;
  const sender = env.senderAgentId;
  if (!params.registry.ok) {
    return {
      ok: false,
      failure: "registry",
      reason: params.registry.reason,
      senderAgentId: sender,
    };
  }
  const entry = params.registry.agents.get(sender);
  if (!entry || entry.keyId !== env.keyId) {
    return {
      ok: false,
      failure: "unknown-sender",
      reason: entry ? "sender key is not the registered key" : "sender agent is not registered",
      senderAgentId: sender,
    };
  }
  const { signature, ...unsigned } = env;
  if (!verifyDeviceSignature(entry.publicKey, signingInput(unsigned), signature)) {
    return {
      ok: false,
      failure: "bad-signature",
      reason: "signature does not verify",
      senderAgentId: sender,
    };
  }
  if (env.payloadSha256 !== payloadSha256(params.payload)) {
    return {
      ok: false,
      failure: "payload-mismatch",
      reason: "message changed since it was signed",
      senderAgentId: sender,
    };
  }
  if (!params.recipientSessionKeys.includes(env.recipientSessionKey)) {
    return {
      ok: false,
      failure: "recipient-mismatch",
      reason: "envelope was signed for another session",
      senderAgentId: sender,
    };
  }
  const now = params.now ?? Date.now();
  if (Math.abs(now - env.timestamp) > params.maxAgeMs) {
    return {
      ok: false,
      failure: "stale",
      reason: "timestamp outside the accepted window",
      senderAgentId: sender,
    };
  }
  if (!params.replay.remember(`${sender}:${env.nonce}`, env.timestamp + params.maxAgeMs, now)) {
    return {
      ok: false,
      failure: "replay",
      reason: "nonce was already used",
      senderAgentId: sender,
    };
  }
  return {
    ok: true,
    senderAgentId: sender,
    ...(env.senderSessionKey ? { senderSessionKey: env.senderSessionKey } : {}),
    keyId: env.keyId,
  };
}
