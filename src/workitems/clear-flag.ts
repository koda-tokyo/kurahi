// workitems.clearFlag: a PERSON clears one risk flag with a written reason (see flags.ts).

import type { Project } from "../projects/types.js";
import type { WorkQueuePolicy } from "./policy.js";
import type { Actor, WorkItem } from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { canRead, deciderVia, isPrivileged, isStageApprover } from "./access.js";
import { WorkItemRefused } from "./errors.js";
import { isWorkItemFlag } from "./flags.js";
import { applyTransition, type LifecycleOpts } from "./lifecycle.js";
import { loadWorkQueuePolicy } from "./policy.js";
import { TERMINAL_STATUSES, WORK_ITEM_FLAGS } from "./types.js";

export const MIN_CLEAR_REASON = 10;
export const CLEAR_REASON_MAX = 2000;

export type ClearFlagInput = { flag?: unknown; reason?: unknown };

/**
 * True when `actor` may clear flags on `item`: a privileged operator, or a person who approves
 * this item and may read it (an approver of any stage of its route once it is routed to them, or
 * of the current stage via delegation or escalation). Also used by the morning brief.
 */
export function mayClearFlags(
  item: WorkItem,
  actor: Actor,
  policy: WorkQueuePolicy,
  now: Date,
): boolean {
  return (
    isPrivileged(actor, policy, item.projectId) ||
    deciderVia(item, actor.id, policy, now) !== null ||
    (canRead(item, actor, policy, now) &&
      (item.route?.stages ?? []).some((s) => isStageApprover(s, actor.id, policy, item.projectId)))
  );
}

/**
 * A person clears one flag with a written reason. Allowed for privileged operators and for
 * people who approve this item and may read it (an approver of any stage of its route once it is
 * routed to them, or of the current stage via delegation or escalation). The clearance is kept
 * on the item, in the evidence bundle and in the audit log (with the reason).
 */
export function clearWorkItemFlag(
  project: Project,
  id: string,
  input: ClearFlagInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  if (actor.kind !== "person") {
    throw new WorkItemRefused("not_a_person", "only a person may clear a flag on a work item");
  }
  if (project.archived) {
    throw new Error("project is archived");
  }
  if (!isWorkItemFlag(input.flag)) {
    throw new WorkItemRefused("invalid_flag", `flag must be one of ${WORK_ITEM_FLAGS.join(", ")}`);
  }
  const flag = input.flag;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MIN_CLEAR_REASON) {
    throw new WorkItemRefused(
      "reason_required",
      `clearing a flag needs a written reason (at least ${MIN_CLEAR_REASON} characters)`,
    );
  }
  const home = opts.home ?? resolveKoloHome();
  return applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      if (TERMINAL_STATUSES.has(cur.status)) {
        throw new WorkItemRefused("terminal", `work item is already ${cur.status}`);
      }
      if (!cur.flags?.includes(flag)) {
        throw new WorkItemRefused("flag_not_set", `the item is not flagged ${flag}`, { flag });
      }
      const policy = loadWorkQueuePolicy(project, home);
      // Approvers act on items routed to them: the item must be readable by them as well.
      if (!mayClearFlags(cur, actor, policy, now)) {
        throw new WorkItemRefused(
          "not_authorised",
          "only an operator or an approver of this item may clear its flags",
        );
      }
      const text = reason.slice(0, CLEAR_REASON_MAX);
      cur.flags = cur.flags.filter((f) => f !== flag);
      cur.flagClearances = [
        ...(cur.flagClearances ?? []),
        { flag, by: actor.id, at: now.toISOString(), reason: text },
      ];
      if (cur.flags.length === 0) {
        delete cur.flags;
        delete cur.flagReason;
      }
      return {
        next: cur,
        spec: {
          action: "flag.clear",
          actor,
          comment: text,
          // The reason is in `detail` too, so the audit entry carries it.
          detail: { flag, reason: text, remaining: cur.flags ?? [] },
        },
      };
    },
    opts,
  );
}
