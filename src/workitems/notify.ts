// Who to tell about a work item write: a pure diff of two revisions of the same item. The push
// counterpart of the console's "Awaiting me" list, so "awaiting" is awaitsPrincipal's answer and
// nothing else; routing, delegation, escalation and separation of duties are not re-implemented.
//
// Candidates are principals the policy or the item names (access members, explicit approvers and
// escalation targets, delegations, the requester). Group-only members cannot be listed (groups
// resolve principal → groups) and are not notified until a directory provides the reverse lookup.
//
// Recipients carry ids and a reason only; delivery (in-app record, then channels) is separate.
//
// Linked cases: a child step reaching done or cancelled changes its parent's progress, so the
// parent's requester hears when that opens a step, completes the case or blocks it.

import type { LinkedCaseProgress } from "./links.js";
import type { WorkQueuePolicy } from "./policy.js";
import type { WorkItem, WorkItemStatus } from "./types.js";
import { awaitsPrincipal, currentStage } from "./access.js";

export type NotificationReason =
  | "awaiting_you"
  | "delegated_to_you"
  | "escalated_to_you"
  | "delegation_withdrawn"
  | "decided"
  | "linked_step_ready"
  | "linked_case_complete"
  | "linked_case_blocked";

export type NotificationRecipient = { principal: string; reason: NotificationReason };

/** Statuses the requester hears about when someone else moves the item there. */
const DECIDED: ReadonlySet<WorkItemStatus> = new Set([
  "approved",
  "sent_back",
  "done",
  "cancelled",
]);

/** Principals named by the policy or the item that could be told about it. */
export function notificationCandidates(items: WorkItem[], policy: WorkQueuePolicy): string[] {
  const out = new Set<string>(policy.access.members.map((m) => m.principal));
  for (const item of items) {
    out.add(item.requestedBy);
    for (const s of item.route?.stages ?? []) {
      s.approvers.principals.forEach((p) => out.add(p));
      s.escalation?.to.principals.forEach((p) => out.add(p));
      for (const d of s.delegations) {
        out.add(d.from);
        out.add(d.to);
      }
    }
  }
  return [...out];
}

/**
 * Recipients for the write that turned `before` (null on create) into `after`. Only principals
 * newly able to act are told they are awaited, so rewrites at the same revision and stages that
 * do not move notify nobody. The actor is never notified of their own change.
 */
export function notificationRecipients(
  before: WorkItem | null,
  after: WorkItem,
  policy: WorkQueuePolicy,
  now: Date,
): NotificationRecipient[] {
  if (before && before.revision === after.revision) {
    return [];
  }
  const last = after.history.at(-1);
  const actor = last?.by ?? after.createdBy;
  const action = last?.action ?? "update";
  const out = new Map<string, NotificationReason>();
  const add = (principal: string, reason: NotificationReason) => {
    if (principal !== actor && !out.has(principal)) {
      out.set(principal, reason);
    }
  };

  const stage = currentStage(after);
  for (const p of notificationCandidates(before ? [before, after] : [after], policy)) {
    if (!awaitsPrincipal(after, p, policy, now)) {
      continue;
    }
    if (before && awaitsPrincipal(before, p, policy, now)) {
      continue;
    }
    if (action === "delegate" && stage?.delegations.some((d) => d.to === p)) {
      add(p, "delegated_to_you");
    } else if (action === "stage.escalate") {
      add(p, "escalated_to_you");
    } else {
      add(p, "awaiting_you");
    }
  }

  if (action === "delegate.withdraw" && before) {
    const was = currentStage(before)?.delegations ?? [];
    const still = new Set((stage?.delegations ?? []).map((d) => `${d.from}\u0000${d.to}`));
    for (const d of was) {
      if (!still.has(`${d.from}\u0000${d.to}`)) {
        add(d.to, "delegation_withdrawn");
      }
    }
  }

  if (DECIDED.has(after.status) && before?.status !== after.status) {
    add(after.requestedBy, "decided");
  }

  return [...out].map(([principal, reason]) => ({ principal, reason }));
}

/**
 * The parent requester's reason, if any, when a child's status change moved a linked case from
 * `before` to `after` progress: complete wins over blocked, and blocked over a newly ready step;
 * blocked means this change cancelled a step of a blocked case. The actor who moved the child is
 * not told.
 */
export function linkedCaseReason(
  parent: Pick<WorkItem, "requestedBy">,
  before: LinkedCaseProgress,
  after: LinkedCaseProgress,
  actor: string,
): (NotificationRecipient & { stepKeys?: string[] }) | null {
  if (parent.requestedBy === actor) {
    return null;
  }
  let reason: NotificationReason | null = null;
  if (after.complete && !before.complete) {
    reason = "linked_case_complete";
  } else if (
    // A step this change cancelled, not "newly blocked": two steps cancelled at the same moment
    // each see the case already blocked by the other. Stored once per case.
    after.blocked &&
    after.steps.some((s, i) => s.state === "cancelled" && before.steps[i]?.state !== "cancelled")
  ) {
    reason = "linked_case_blocked";
  } else {
    // Two dependencies finishing at once each see the step newly ready: stored once per step.
    const opened = after.ready.filter((k) => !before.ready.includes(k));
    if (opened.length) {
      return { principal: parent.requestedBy, reason: "linked_step_ready", stepKeys: opened };
    }
  }
  return reason ? { principal: parent.requestedBy, reason } : null;
}
