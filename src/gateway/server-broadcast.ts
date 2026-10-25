import type { GatewayWsClient } from "./server/ws-types.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { sessionAllowed, sessionIdentityFromKey } from "./session-allowlist.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
  // Sent per owner by src/gateway/terminal-broker.ts; never to a non-admin if broadcast.
  "terminal.event": [ADMIN_SCOPE],
  // Work queue changes (ids and status only) go to operators who can read.
  "workitems.changed": ["operator.read", "operator.write"],
  "autopilot.changed": ["operator.read", "operator.write"],
};

function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  if (!required) {
    return true;
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return false;
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  return required.some((scope) => scopes.includes(scope));
}

/**
 * M3b: `agent`, `chat` and (M14) `channel.inbound` events carry the session they belong to. A paired client bound to
 * a session allowlist only receives events of sessions it may see; everyone else receives the
 * full stream (every attached client sees the same events).
 */
function maySeeSessionEvent(client: GatewayWsClient, event: string, payload: unknown): boolean {
  const allowlist = client.pairing?.sessions;
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  if (event !== "agent" && event !== "chat" && event !== "channel.inbound") {
    return true;
  }
  const sessionKey = (payload as { sessionKey?: unknown } | undefined)?.sessionKey;
  if (typeof sessionKey !== "string" || !sessionKey) {
    // No session on the event: fail closed for a restricted credential.
    return false;
  }
  return sessionAllowed(allowlist, sessionIdentityFromKey(sessionKey));
}

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;
  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq,
      clients: params.clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    logWs("out", "event", logMeta);
    for (const c of params.clients) {
      if (!hasEventScope(c, event) || !maySeeSessionEvent(c, event, payload)) {
        continue;
      }
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        continue;
      }
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };
  /**
   * One event to one connection (voice transcripts and audio are private to the socket that
   * captured them). A slow consumer drops the frame rather than closing the socket.
   */
  const sendToConn = (connId: string, event: string, payload: unknown) => {
    for (const c of params.clients) {
      if (c.connId !== connId) {
        continue;
      }
      if (c.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        return;
      }
      try {
        c.socket.send(JSON.stringify({ type: "event", event, payload }));
      } catch {
        /* ignore */
      }
      return;
    }
  };
  return { broadcast, sendToConn };
}
