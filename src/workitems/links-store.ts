// Linked case persistence: one record per parent case, `<parent dir>/linked-case.json`, written
// atomically under the parent's own lock file, so attaching a step and editing the parent never
// interleave. The record holds the plan and which child item fills each step; child statuses are
// always read live from the children, never cached here.
//
// Attaching is gated by the plan: a step takes a child only when it is ready (every dependency
// done), the child sits in a queue of the step's department, and the child fills no other step.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LinkedCasePlan, LinkedCaseProgress, LinkedCaseStep } from "./links.js";
import type { Actor, DepartmentId, WorkItemStatus } from "./types.js";
import { WorkItemRefused } from "./errors.js";
import { linkedCaseProgress, validateLinkedPlan } from "./links.js";
import { isWorkItemId, readWorkItem, withItemLock, workItemDir, workItemsRoot } from "./store.js";
import { TERMINAL_STATUSES } from "./types.js";

export type LinkedCaseEvent =
  | { at: string; actor: string; event: "created" }
  | { at: string; actor: string; event: "attached"; stepKey: string; childId: string };

export type LinkedCaseRecord = {
  parentId: string;
  plan: LinkedCasePlan;
  /** Step key → child work item id. */
  children: Record<string, string>;
  history: LinkedCaseEvent[];
};

export type LinkedCaseStatus = LinkedCaseProgress & {
  children: Record<string, string>;
  /** Attached children whose item can no longer be read; counted as cancelled. */
  missing: string[];
};

/** Department of a queue in the current work-queue policy (undefined = unmapped). */
export type QueueDepartment = (queueId: string) => DepartmentId | undefined;

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new WorkItemRefused(code, message, details);
}

function caseFile(projectId: string, parentId: string, home?: string): string {
  if (!isWorkItemId(parentId)) {
    refuse("linked_case_not_found", "invalid work item id");
  }
  return path.join(workItemDir(projectId, parentId, home), "linked-case.json");
}

function writeAtomic(file: string, rec: LinkedCaseRecord): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Keep only the plan fields; anything else in the request is dropped, not stored. */
function cleanPlan(plan: LinkedCasePlan): LinkedCasePlan {
  const text = (t: LinkedCaseStep["title"] | undefined): LinkedCaseStep["title"] => ({
    ...(typeof t?.ja === "string" ? { ja: t.ja.slice(0, 200) } : {}),
    ...(typeof t?.en === "string" ? { en: t.en.slice(0, 200) } : {}),
  });
  return {
    steps: (Array.isArray(plan?.steps) ? plan.steps : []).map((s) => ({
      key: String(s?.key),
      department: s?.department,
      title: text(s?.title),
      // Not coerced: a malformed list must fail validation, not become "no dependencies".
      dependsOn: s?.dependsOn,
    })),
  };
}

/**
 * Only a missing file is "no linked case". A record that does not parse, names another parent,
 * holds an invalid plan or attaches a child to an unknown step refuses rather than reading as
 * absent: absent would let a second plan be created over it.
 */
export function readLinkedCase(
  projectId: string,
  parentId: string,
  home?: string,
): LinkedCaseRecord | null {
  const file = caseFile(projectId, parentId, home);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
  const corrupt = (): never =>
    refuse("linked_case_corrupt", "the linked case record cannot be read", { parentId });
  let rec: LinkedCaseRecord;
  try {
    rec = JSON.parse(raw) as LinkedCaseRecord;
  } catch {
    return corrupt();
  }
  if (
    !rec ||
    typeof rec !== "object" ||
    rec.parentId !== parentId ||
    !rec.plan ||
    !Array.isArray(rec.plan.steps) ||
    validateLinkedPlan(rec.plan).length ||
    !rec.children ||
    typeof rec.children !== "object" ||
    !Array.isArray(rec.history)
  ) {
    return corrupt();
  }
  // Each child fills exactly one step and is never the parent itself, as attach enforces; a
  // record that breaks this would let one done child complete several steps.
  const keys = new Set(rec.plan.steps.map((s) => s.key));
  const used = new Set<string>();
  for (const [k, id] of Object.entries(rec.children)) {
    if (!keys.has(k) || !isWorkItemId(id) || id === parentId || used.has(id)) {
      return corrupt();
    }
    used.add(id);
  }
  return rec;
}

function readParent(projectId: string, parentId: string, home?: string) {
  const parent = readWorkItem(projectId, parentId, home);
  if (!parent) {
    refuse("linked_case_not_found", "work item not found", { parentId });
  }
  if (TERMINAL_STATUSES.has(parent.status)) {
    refuse("linked_case_closed", "the parent case is closed", { parentId, status: parent.status });
  }
  return parent;
}

/** Attach a plan to an open parent case. One plan per parent; a plan is never replaced here. */
export function createLinkedCase(
  projectId: string,
  parentId: string,
  plan: LinkedCasePlan,
  actor: Actor,
  now: Date,
  home?: string,
): LinkedCaseRecord {
  const file = caseFile(projectId, parentId, home);
  readParent(projectId, parentId, home);
  const clean = cleanPlan(plan);
  const problems = validateLinkedPlan(clean);
  if (problems.length) {
    refuse("linked_plan_invalid", "the linked case plan is not valid", { problems });
  }
  return withItemLock(path.dirname(file), () => {
    readParent(projectId, parentId, home);
    if (readLinkedCase(projectId, parentId, home)) {
      refuse("linked_case_exists", "this case already has a linked plan", { parentId });
    }
    const rec: LinkedCaseRecord = {
      parentId,
      plan: clean,
      children: {},
      history: [{ at: now.toISOString(), actor: actor.id, event: "created" }],
    };
    writeAtomic(file, rec);
    return rec;
  });
}

function childStatuses(
  projectId: string,
  rec: LinkedCaseRecord,
  home?: string,
): { status: Record<string, WorkItemStatus>; missing: string[] } {
  const status: Record<string, WorkItemStatus> = {};
  const missing: string[] = [];
  for (const [key, id] of Object.entries(rec.children)) {
    const child = readWorkItem(projectId, id, home);
    if (child) {
      status[key] = child.status;
    } else {
      // Conservative: a vanished child never completes the parent.
      status[key] = "cancelled";
      missing.push(key);
    }
  }
  return { status, missing };
}

/**
 * Linked cases with `childId` attached to a step. There is no reverse index, so this lists the
 * store; callers use it only when a child reaches a terminal status. A case record that cannot
 * be read is reported through `onUnreadable` and skipped.
 */
export function linkedCasesWithChild(
  projectId: string,
  childId: string,
  opts: { home?: string; onUnreadable?: (parentId: string, err: unknown) => void } = {},
): LinkedCaseRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(workItemsRoot(projectId, opts.home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: LinkedCaseRecord[] = [];
  for (const parentId of names) {
    if (!isWorkItemId(parentId) || parentId === childId) {
      continue;
    }
    try {
      const rec = readLinkedCase(projectId, parentId, opts.home);
      if (rec && Object.values(rec.children).includes(childId)) {
        out.push(rec);
      }
    } catch (err) {
      opts.onUnreadable?.(parentId, err);
    }
  }
  return out;
}

/** Progress with the given child statuses substituted for the live ones. */
export function linkedCaseProgressWith(
  projectId: string,
  rec: LinkedCaseRecord,
  override: Record<string, WorkItemStatus>,
  home?: string,
): LinkedCaseProgress {
  const { status } = childStatuses(projectId, rec, home);
  return linkedCaseProgress(rec.plan, { ...status, ...override });
}

/** Progress with live child statuses, or null when the case has no linked plan. */
export function linkedCaseStatus(
  projectId: string,
  parentId: string,
  home?: string,
): LinkedCaseStatus | null {
  const rec = readLinkedCase(projectId, parentId, home);
  if (!rec) {
    return null;
  }
  const { status, missing } = childStatuses(projectId, rec, home);
  return { ...linkedCaseProgress(rec.plan, status), children: { ...rec.children }, missing };
}

/** Record that `childId` fills the ready step `stepKey`. */
export function attachLinkedStep(
  projectId: string,
  parentId: string,
  stepKey: string,
  childId: string,
  departmentOf: QueueDepartment,
  actor: Actor,
  now: Date,
  home?: string,
): LinkedCaseRecord {
  const file = caseFile(projectId, parentId, home);
  return withItemLock(path.dirname(file), () => {
    readParent(projectId, parentId, home);
    const rec = readLinkedCase(projectId, parentId, home);
    if (!rec) {
      refuse("linked_case_not_found", "this case has no linked plan", { parentId });
    }
    const step = rec.plan.steps.find((s) => s.key === stepKey);
    if (!step) {
      refuse("linked_step_unknown", "the plan has no such step", { stepKey });
    }
    if (Object.hasOwn(rec.children, stepKey)) {
      refuse("linked_step_attached", "the step already has a child item", {
        stepKey,
        childId: rec.children[stepKey],
      });
    }
    if (childId === parentId || Object.values(rec.children).includes(childId)) {
      refuse("linked_child_in_use", "the item already belongs to this case", { childId });
    }
    const child = isWorkItemId(childId) ? readWorkItem(projectId, childId, home) : null;
    if (!child) {
      refuse("linked_child_not_found", "child work item not found", { childId });
    }
    if (TERMINAL_STATUSES.has(child.status)) {
      refuse("linked_child_closed", "the child item is already closed", { childId });
    }
    const department = departmentOf(child.queue);
    if (department !== step.department) {
      refuse("linked_child_wrong_department", "the child item is in another department's queue", {
        stepKey,
        expected: step.department,
        actual: department ?? null,
      });
    }
    const progress = linkedCaseProgress(rec.plan, childStatuses(projectId, rec, home).status);
    if (!progress.ready.includes(stepKey)) {
      const state = progress.steps.find((s) => s.key === stepKey)?.state;
      refuse("linked_step_not_ready", "the step's dependencies are not all done", {
        stepKey,
        state,
      });
    }
    rec.children[stepKey] = childId;
    rec.history.push({
      at: now.toISOString(),
      actor: actor.id,
      event: "attached",
      stepKey,
      childId,
    });
    writeAtomic(file, rec);
    return rec;
  });
}
