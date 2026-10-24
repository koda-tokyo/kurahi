// Signed `sibling.send` (peer chat between agents on one gateway; OWASP ASI07).
//
// Without an envelope the gateway can only take the sender from the connecting client's id,
// which the client declares. A signing client attaches the same Ed25519 envelope the `agent`
// method uses, over:
//   - recipient: the synthetic key `sibling:<to>` (so an envelope for one peer, or one made for
//     the `agent` method, cannot be replayed to another), and
//   - payload: the text, plus a SHA-256 of the attachments when there are any.
// The gateway verifies it with the shared registry and replay guard. The verified agent id then
// replaces the client-declared sender. Unsigned or failing sends follow
// agents.messaging.signing.mode: enforce rejects, warn delivers with the client-declared sender
// and a flagged audit entry, off skips every check (the pre-signing behaviour).
import type { KoLoConfig } from "../../config/types.js";
import { type AuditInput, auditSafe } from "../../audit/index.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sha256Hex } from "../../policy/attestation.js";
import {
  type AgentMessageEnvelope,
  type AgentMessagePayload,
  type ReplayGuard,
  signAgentMessage,
  verifyAgentMessage,
} from "./envelope.js";
import {
  type AgentKeyLocations,
  ensureAgentSigningKey,
  resolveAgentKeyLocations,
  verifyAgentRegistryCached,
} from "./keys.js";
import { sharedReplayGuard } from "./nonce-store.js";
import { resolveAgentMessageSigning } from "./signing.js";

const log = createSubsystemLogger("agents/messaging");

export type SiblingAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
};

export function siblingRecipientKey(to: string): string {
  return `sibling:${to.trim().toLowerCase()}`;
}

export function siblingPayload(
  text: string,
  attachments?: SiblingAttachment[],
): AgentMessagePayload {
  return {
    message: text,
    ...(attachments && attachments.length > 0
      ? {
          extraSystemPrompt: `sibling-attachments-sha256:${sha256Hex(JSON.stringify(attachments))}`,
        }
      : {}),
  };
}

/**
 * Envelope to merge into `sibling.send` params, signed with `fromAgentId`'s key. Empty when
 * signing is off or the key is not available to this process (the gateway then treats the send
 * as unsigned). Only a process that can read `<KOLO_HOME>/secrets/agent-keys` can sign.
 */
export function signSiblingSendParams(params: {
  cfg?: KoLoConfig;
  fromAgentId: string;
  to: string;
  text: string;
  attachments?: SiblingAttachment[];
  loc?: AgentKeyLocations;
  now?: number;
}): { agentEnvelope?: AgentMessageEnvelope } {
  if (resolveAgentMessageSigning(params.cfg).mode === "off") {
    return {};
  }
  try {
    const key = ensureAgentSigningKey(params.fromAgentId.trim().toLowerCase(), { loc: params.loc });
    return {
      agentEnvelope: signAgentMessage({
        key,
        recipientSessionKey: siblingRecipientKey(params.to),
        payload: siblingPayload(params.text, params.attachments),
        now: params.now,
      }),
    };
  } catch (err) {
    log.warn(
      `cannot sign sibling.send for agent ${params.fromAgentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

export type SiblingSendDecision =
  | { kind: "deliver"; from: string; verified: boolean; flagged: string[] }
  | { kind: "reject"; error: string; reasons: string[] };

export function checkSiblingSend(params: {
  cfg?: KoLoConfig;
  /** Sender derived from the connecting client's declared id (unauthenticated). */
  claimedFrom: string;
  to: string;
  text: string;
  attachments?: SiblingAttachment[];
  agentEnvelope?: unknown;
  loc?: AgentKeyLocations;
  replay?: ReplayGuard;
  now?: number;
  audit?: (input: AuditInput) => void;
}): SiblingSendDecision {
  const settings = resolveAgentMessageSigning(params.cfg);
  if (settings.mode === "off") {
    return { kind: "deliver", from: params.claimedFrom, verified: false, flagged: [] };
  }
  const recipient = siblingRecipientKey(params.to);
  const reasons: string[] = [];
  let verifiedSender: string | undefined;
  let keyId: string | undefined;
  if (params.agentEnvelope === undefined) {
    reasons.push("unsigned: sibling.send has no envelope");
  } else {
    const verification = verifyAgentMessage({
      envelope: params.agentEnvelope,
      payload: siblingPayload(params.text, params.attachments),
      recipientSessionKeys: [recipient],
      registry: verifyAgentRegistryCached(params.loc ?? resolveAgentKeyLocations()),
      maxAgeMs: settings.maxAgeMs,
      replay: params.replay ?? sharedReplayGuard(),
      now: params.now,
    });
    if (verification.ok) {
      verifiedSender = verification.senderAgentId;
      keyId = verification.keyId;
    } else {
      reasons.push(`${verification.failure}: ${verification.reason}`);
    }
  }
  const from = verifiedSender ?? params.claimedFrom;
  const nonce = (params.agentEnvelope as { nonce?: unknown } | undefined)?.nonce;
  const outcome = reasons.length === 0 ? "ok" : settings.mode === "enforce" ? "denied" : "flagged";
  (params.audit ?? ((input: AuditInput) => void auditSafe(input)))({
    identity: from,
    scope: recipient,
    action: "sibling.message.verify",
    outcome,
    source: "gateway.sibling",
    detail: {
      mode: settings.mode,
      verified: verifiedSender !== undefined,
      claimedFrom: params.claimedFrom,
      reasons,
      keyId,
      nonce: typeof nonce === "string" ? nonce : undefined,
    },
  });
  if (outcome === "denied") {
    log.warn(`rejected sibling.send to ${params.to}: ${reasons.join("; ")}`);
    return {
      kind: "reject",
      error: `sibling message rejected (agents.messaging.signing.mode=enforce): ${reasons.join("; ")}`,
      reasons,
    };
  }
  if (outcome === "flagged") {
    log.warn(`flagged sibling.send from ${from} to ${params.to}: ${reasons.join("; ")}`);
  }
  return { kind: "deliver", from, verified: verifiedSender !== undefined, flagged: reasons };
}
