// Stage delegation and escalation (稟議).
//
// Delegation: an approver of the current stage hands their decision on THIS stage of THIS item
// to another principal, with a reason and an expiry (at most 30 days). The delegate decides "on
// behalf of" the approver; the delegation is a transition with its own evidence and audit entry.
//
// Escalation: deterministic, from the stage timers alone. When a stage passes its dueAt it is
// marked overdue (stage.overdueAt); when it has been active for escalation.afterHours its
// escalation targets may decide it as well (stage.escalatedAt). The check runs when items are
// read or listed and on the gateway's maintenance tick; each mark is written once, as a system
// transition with evidence, so the outcome does not depend on which of those ran first.

import type { Project } from "../projects/types.js";
import type { Actor, WorkItem, WorkItemStage } from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { loadProjects } from "../projects/store.js";
import { currentStage, isStageApprover, actedInStage } from "./access.js";
import { WorkItemRefused } from "./errors.js";
import { applyTransition, type LifecycleOpts } from "./lifecycle.js";
import { PRINCIPAL_RE } from "./parse-util.js";
import { loadWorkQueuePolicy } from "./policy.js";
import { readWorkItemsDueForMarks } from "./store.js";

export const MAX_DELEGATION_DAYS = 30;
export const MIN_DELEGATION_REASON = 5;
const SYSTEM: Actor = { id: "system", kind: "system" };

export type DelegateInput = { to?: unknown; reason?: unknown; expiresAt?: unknown };

export function delegateStage(
  project: Project,
  id: string,
  input: DelegateInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  if (actor.kind !== "person") {
    throw new WorkItemRefused("not_a_person", "only a person may delegate a decision");
  }
  if (project.archived) {
    throw new Error("project is archived");
  }
  const home = opts.home ?? resolveKoloHome();
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  const expires = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
  return applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      const stage = currentStage(cur);
      if (cur.status !== "awaiting_review" || !stage) {
        throw new WorkItemRefused("not_awaiting_review", `the item is ${cur.status}`);
      }
      if (!stage.delegation) {
        throw new WorkItemRefused(
          "delegation_not_allowed",
          `stage ${stage.id} does not allow delegation`,
          { stage: stage.id },
        );
      }
      const policy = loadWorkQueuePolicy(project, home);
      if (!isStageApprover(stage, actor.id, policy, project.id)) {
        throw new WorkItemRefused(
          "not_an_approver",
          `only an approver of stage ${stage.id} may delegate it`,
          { stage: stage.id },
        );
      }
      if (actedInStage(stage, actor.id)) {
        throw new WorkItemRefused("already_approved", "you have already approved this stage");
      }
      if (!PRINCIPAL_RE.test(to) || to === actor.id) {
        throw new WorkItemRefused("invalid_delegate", "to must be another principal");
      }
      if (to === cur.requestedBy) {
        throw new WorkItemRefused("invalid_delegate", "the requester cannot decide their own item");
      }
      if (reason.length < MIN_DELEGATION_REASON) {
        throw new WorkItemRefused(
          "reason_required",
          `a delegation needs a reason (at least ${MIN_DELEGATION_REASON} characters)`,
        );
      }
      const max = now.getTime() + MAX_DELEGATION_DAYS * 86_400_000;
      if (!Number.isFinite(expires) || expires <= now.getTime() || expires > max) {
        throw new WorkItemRefused(
          "invalid_expiry",
          `expiresAt must be in the future and within ${MAX_DELEGATION_DAYS} days`,
        );
      }
      const expiresAt = new Date(expires).toISOString();
      const replaced = stage.delegations.filter((d) => d.from === actor.id).map((d) => d.to);
      stage.delegations = stage.delegations.filter((d) => d.from !== actor.id);
      stage.delegations.push({ from: actor.id, to, reason, at: now.toISOString(), expiresAt });
      return {
        next: cur,
        spec: {
          action: "delegate",
          actor,
          comment: reason,
          detail: { stage: stage.id, from: actor.id, to, expiresAt, replaced },
        },
      };
    },
    opts,
  );
}

export type WithdrawDelegationInput = { reason?: unknown };

/**
 * The approver who delegated the current stage takes the decision back before the delegate has
 * used it. Expired delegations may be withdrawn too (a cleanup with the same evidence trail).
 */
export function withdrawDelegation(
  project: Project,
  id: string,
  input: WithdrawDelegationInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  if (actor.kind !== "person") {
    throw new WorkItemRefused("not_a_person", "only a person may withdraw a delegation");
  }
  if (project.archived) {
    throw new Error("project is archived");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  return applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      const stage = currentStage(cur);
      if (cur.status !== "awaiting_review" || !stage) {
        throw new WorkItemRefused("not_awaiting_review", `the item is ${cur.status}`);
      }
      const mine = stage.delegations.find((d) => d.from === actor.id);
      if (!mine) {
        throw new WorkItemRefused(
          "no_delegation",
          `you have no delegation on stage ${stage.id} to withdraw`,
          { stage: stage.id },
        );
      }
      if (actedInStage(stage, actor.id)) {
        throw new WorkItemRefused(
          "already_approved",
          "this stage already has your approval (directly or through your delegate); it stands",
        );
      }
      stage.delegations = stage.delegations.filter((d) => d.from !== actor.id);
      return {
        next: cur,
        spec: {
          action: "delegate.withdraw",
          actor,
          comment: reason || undefined,
          detail: {
            stage: stage.id,
            from: actor.id,
            to: mine.to,
            expiresAt: mine.expiresAt,
            expired: Date.parse(mine.expiresAt) <= now.getTime(),
          },
        },
      };
    },
    opts,
  );
}

/** What the stage's timers call for at `now` (nothing already recorded is repeated). */
export function dueMarks(stage: WorkItemStage, now: Date): { overdue: boolean; escalate: boolean } {
  const t = now.getTime();
  const overdue = stage.dueAt !== null && stage.overdueAt === null && Date.parse(stage.dueAt) <= t;
  const escalate =
    stage.escalation !== null &&
    stage.escalatedAt === null &&
    stage.activatedAt !== null &&
    Date.parse(stage.activatedAt) + stage.escalation.afterHours * 3_600_000 <= t;
  return { overdue, escalate };
}

function needsMark(item: WorkItem, now: Date): boolean {
  const stage = item.status === "awaiting_review" ? currentStage(item) : null;
  if (!stage) {
    return false;
  }
  const m = dueMarks(stage, now);
  return m.overdue || m.escalate;
}

class NothingToMark extends Error {}

/** Record overdue / escalation on the current stage when due. Returns the item (updated or not). */
export function escalateIfDue(
  project: Pick<Project, "id" | "folder" | "templateId">,
  item: WorkItem,
  opts: LifecycleOpts & { onChange?: (item: WorkItem) => void } = {},
): WorkItem {
  const now = opts.now ?? new Date();
  if (!needsMark(item, now)) {
    return item;
  }
  try {
    const next = applyTransition(
      project,
      item.id,
      undefined,
      (cur) => {
        const stage = cur.status === "awaiting_review" ? currentStage(cur) : null;
        const m = stage ? dueMarks(stage, now) : { overdue: false, escalate: false };
        if (!stage || (!m.overdue && !m.escalate)) {
          throw new NothingToMark();
        }
        const at = now.toISOString();
        if (m.overdue) {
          stage.overdueAt = at;
        }
        if (m.escalate) {
          stage.escalatedAt = at;
        }
        return {
          next: cur,
          spec: {
            action: m.escalate ? "stage.escalate" : "stage.overdue",
            actor: SYSTEM,
            detail: {
              stage: stage.id,
              dueAt: stage.dueAt,
              overdue: stage.overdueAt !== null,
              ...(m.escalate ? { escalatedTo: stage.escalation!.to } : {}),
            },
          },
        };
      },
      { ...opts, now },
    );
    opts.onChange?.(next);
    return next;
  } catch (err) {
    if (err instanceof NothingToMark) {
      return item;
    }
    // Busy or removed: the next read or tick records it.
    return item;
  }
}

/** Check the items of one Project whose marks may be due (through the list index). Returns the items that changed. */
export function sweepEscalations(
  project: Pick<Project, "id" | "folder" | "templateId">,
  opts: LifecycleOpts & { onChange?: (item: WorkItem) => void } = {},
): WorkItem[] {
  const now = opts.now ?? new Date();
  const changed: WorkItem[] = [];
  for (const item of readWorkItemsDueForMarks(project.id, now, { home: opts.home })) {
    const next = escalateIfDue(project, item, { ...opts, now });
    if (next !== item) {
      changed.push(next);
    }
  }
  return changed;
}

/** The maintenance tick: every active Project. Never throws. */
export function sweepAllEscalations(
  opts: LifecycleOpts & { onChange?: (item: WorkItem) => void } = {},
): number {
  let n = 0;
  try {
    for (const p of loadProjects(opts.home ?? resolveKoloHome())) {
      if (!p.archived) {
        n += sweepEscalations(p, opts).length;
      }
    }
  } catch {
    // best effort
  }
  return n;
}

/** Payload of the `workitems.changed` event (no titles or field values). */
export function changedEventPayload(item: WorkItem) {
  const last = item.history.at(-1);
  return {
    projectId: item.projectId,
    id: item.id,
    queue: item.queue,
    action: last?.action ?? "update",
    status: item.status,
    revision: item.revision,
    updatedAt: item.updatedAt,
  };
}
