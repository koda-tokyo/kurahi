// Sub-agent announce delivery when the requester session is busy: steer the text into the
// active run, or queue it and send it once the run ends (src/agents/subagent-announce-queue.ts).
//
// Inter-agent signing (OWASP ASI07, docs/security/agent-message-signing.md):
// - Queued announces are signed at send time with the child session's key, like the direct
//   announce, so the gateway verifies and marks them. A collect batch only merges items from one
//   child session (mixed batches are sent one by one). The overflow summary ("N announces
//   dropped") is written by the queue itself from several children and goes out unsigned.
// - Steered announces never reach the gateway `agent` method (they are injected into the running
//   embedded session in this process), so there is nothing to verify. When the child is another
//   agent, the text is wrapped in the same untrusted-content boundary the gateway uses, naming
//   the child and saying it was not signature-checked.
import crypto from "node:crypto";
import { resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { wrapExternalContent } from "../security/external-content.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../utils/delivery-context.js";
import { signAgentMessageParams } from "./messaging/signing.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  // requesterOrigin (captured at spawn time) reflects the channel the user is
  // actually on and must take priority over the session entry, which may carry
  // stale lastChannel / lastTo values from a previous channel interaction.
  return mergeDeliveryContext(requesterOrigin, deliveryContextFromSession(entry));
}

export async function sendAnnounce(item: AnnounceQueueItem) {
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: origin?.channel,
      accountId: origin?.accountId,
      to: origin?.to,
      threadId,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
      ...(item.senderSessionKey
        ? signAgentMessageParams({
            senderSessionKey: item.senderSessionKey,
            recipientSessionKey: item.sessionKey,
            message: item.prompt,
          })
        : {}),
    },
    expectFinal: true,
    timeoutMs: 60_000,
  });
}

/** Steered text: wrapped as untrusted when the child is another agent (see the header). */
export function markSteeredAnnounce(params: {
  text: string;
  childSessionKey?: string;
  requesterSessionKey: string;
}): string {
  if (!params.childSessionKey) {
    return params.text;
  }
  const child = resolveAgentIdFromSessionKey(params.childSessionKey);
  if (child === resolveAgentIdFromSessionKey(params.requesterSessionKey)) {
    return params.text;
  }
  return wrapExternalContent(params.text, {
    source: "agent",
    sender: `agent "${child}" (session ${params.childSessionKey})`,
    trust: "sub-agent announce steered into the active run in-process (not signature-checked)",
    includeWarning: true,
  });
}

function resolveRequesterStoreKey(
  cfg: ReturnType<typeof loadConfig>,
  requesterSessionKey: string,
): string {
  const raw = requesterSessionKey.trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw);
  return `agent:${agentId}:${raw}`;
}

export function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

export async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  /** The announcing sub-agent session (signs queued sends, labels steered text). */
  childSessionKey?: string;
  triggerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
}): Promise<"steered" | "queued" | "none"> {
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel,
    sessionEntry: entry,
  });
  const isActive = isEmbeddedPiRunActive(sessionId);

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = queueEmbeddedPiMessage(
      sessionId,
      markSteeredAnnounce({
        text: params.triggerMessage,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: canonicalKey,
      }),
    );
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    enqueueAnnounce({
      key: canonicalKey,
      item: {
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
        ...(params.childSessionKey ? { senderSessionKey: params.childSessionKey } : {}),
      },
      settings: queueSettings,
      send: sendAnnounce,
    });
    return "queued";
  }

  return "none";
}
