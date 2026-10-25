// The connector side of an L3 send under a standing approval (docs/autopilot.md#l3-sends).
//
// A mail connector's send tool always asks a person. It skips the ask only when ALL hold:
//   - the call runs under an autopilot ENGINE invocation (engine-origin.ts), which only engine
//     code can set: a model or agent session cannot (there is no tool argument for it);
//   - the invocation is for this very tool and this tool instance's session (no reuse of the
//     context by another tool or session), and has not been used already (one send per call);
//   - the invocation names a standing approval, and consumeStandingApproval() verifies it now,
//     from the store (active, unexpired, unrevoked, routine L3 + action listed, scope covers every
//     recipient including cc and the template), and atomically takes one of the day's uses.
// Anything else → the connector asks a person as it always does (and is refused when nobody
// approves, e.g. no person channel). Every verification is audited with the approval id.

import { consumeStandingApproval } from "./approvals.js";
import { currentEngineInvocation } from "./engine-origin.js";

export type StandingSendCheck =
  /** Not an engine call (agent session, HTTP, CLI): ask a person, say nothing about approvals. */
  | { kind: "not_engine" }
  /** Engine call that cannot use a standing approval: ask a person (reason recorded). */
  | { kind: "fallback"; code: string; reason: string }
  /** Verified and counted: send without the interactive ask. */
  | { kind: "approved"; approvalId: string; routineId: string; runId: string; usesToday: number };

export function dayIn(now: Date, tz: string): string {
  try {
    return now.toLocaleDateString("sv-SE", { timeZone: tz });
  } catch {
    return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  }
}

/**
 * Decide whether `tool` may send to `recipients` under the current engine invocation's standing
 * approval. Call it right before the send, with the recipients exactly as they will be sent.
 */
export function checkStandingSend(params: {
  tool: string;
  connector: string;
  /** The session the tool instance was created for (its ctx.sessionKey). */
  sessionKey: string | undefined;
  recipients: string[];
  now?: Date;
}): StandingSendCheck {
  const inv = currentEngineInvocation();
  if (!inv || inv.origin !== "autopilot") {
    return { kind: "not_engine" };
  }
  const fallback = (code: string, reason: string): StandingSendCheck => {
    inv.fallback = { code, reason };
    return { kind: "fallback", code, reason };
  };
  if (inv.tool !== params.tool) {
    return fallback("tool_mismatch", `the engine call is for ${inv.tool}, not ${params.tool}`);
  }
  if (!params.sessionKey || params.sessionKey !== inv.sessionKey) {
    return fallback("session_mismatch", "the tool runs in another session than the engine call");
  }
  if (!inv.approvalId || inv.action === null) {
    return fallback("no_standing_approval", "the engine call names no standing approval");
  }
  if (inv.used) {
    return fallback("approval_already_used", "this engine call already sent once");
  }
  const now = params.now ?? new Date();
  const res = consumeStandingApproval({
    projectId: inv.projectId,
    approvalId: inv.approvalId,
    routineId: inv.routineId,
    action: inv.action,
    recipients: params.recipients,
    templateId: inv.templateId,
    day: dayIn(now, inv.tz),
    now,
    home: inv.home,
    runId: inv.runId,
    connector: params.connector,
  });
  if (!res.ok) {
    return fallback(res.code, res.reason);
  }
  inv.used = { approvalId: res.approval.id, usesToday: res.usesToday };
  return {
    kind: "approved",
    approvalId: res.approval.id,
    routineId: inv.routineId,
    runId: inv.runId,
    usesToday: res.usesToday,
  };
}
