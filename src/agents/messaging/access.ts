// Receiver-side access check for inter-agent messages (OWASP ASI07).
//
// The sending tools already gate cross-agent traffic (`sessions_send` on tools.agentToAgent,
// `sessions_spawn` on agents.list[].subagents.allowAgents). The gateway re-checks the same
// configuration when the message arrives, so a client or plugin that calls the `agent` method
// directly with a validly signed envelope still cannot reach an agent the configuration does
// not allow. A cross-agent message is allowed when one of these holds:
//
// - tools.agentToAgent is enabled and both agents match tools.agentToAgent.allow;
// - the recipient is a sub-agent session and the sender may spawn that agent
//   (sender's subagents.allowAgents), i.e. a sessions_spawn;
// - the sender is a sub-agent session and the recipient may spawn the sender's agent
//   (recipient's subagents.allowAgents), i.e. a sub-agent announce back to its parent.
import type { KoLoConfig } from "../../config/types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import { createAgentToAgentPolicy } from "../agent-to-agent-policy.js";

function mayRunSubagent(cfg: KoLoConfig, parentAgentId: string, childAgentId: string): boolean {
  const parent = normalizeAgentId(parentAgentId);
  const entry = (cfg.agents?.list ?? []).find((a) => normalizeAgentId(a.id) === parent);
  const allow = entry?.subagents?.allowAgents ?? [];
  const child = normalizeAgentId(childAgentId).toLowerCase();
  return allow.some((raw) => {
    const value = String(raw ?? "").trim();
    return value === "*" || (value !== "" && normalizeAgentId(value).toLowerCase() === child);
  });
}

/** Null when allowed; otherwise the reason (for the audit entry and the rejection). */
export function checkInterAgentAccess(params: {
  cfg: KoLoConfig;
  senderAgentId: string;
  senderSessionKey?: string;
  recipientAgentId: string;
  recipientSessionKey: string;
}): string | null {
  const sender = normalizeAgentId(params.senderAgentId);
  const recipient = normalizeAgentId(params.recipientAgentId);
  if (sender === recipient) {
    return null;
  }
  if (createAgentToAgentPolicy(params.cfg).isAllowed(sender, recipient)) {
    return null;
  }
  if (
    isSubagentSessionKey(params.recipientSessionKey) &&
    mayRunSubagent(params.cfg, sender, recipient)
  ) {
    return null;
  }
  if (
    params.senderSessionKey &&
    isSubagentSessionKey(params.senderSessionKey) &&
    mayRunSubagent(params.cfg, recipient, sender)
  ) {
    return null;
  }
  return (
    `not-allowed: agent "${sender}" may not message agent "${recipient}" ` +
    "(tools.agentToAgent.allow / subagents.allowAgents)"
  );
}
