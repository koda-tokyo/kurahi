// Linked cases across departments: a parent case whose steps are child items in other queues,
// with dependencies between steps. Pure plan validation and progress; no storage. A step is
// opened only when every step it depends on is done; the parent completes only when all steps
// are done ("all children done"). A cancelled step never counts as done.

import type { DepartmentId, WorkItemStatus, WorkItemText } from "./types.js";
import { isDepartmentId } from "./types.js";

export const LINKED_PLAN_MAX_STEPS = 32;

export type LinkedCaseStep = {
  /** Stable key within the plan (lowercase letters, digits, "-"). */
  key: string;
  department: DepartmentId;
  title: WorkItemText;
  /** Keys of steps that must be done before this one is opened. */
  dependsOn: string[];
};

export type LinkedCasePlan = { steps: LinkedCaseStep[] };

export type LinkedPlanProblem =
  | { code: "empty" }
  | { code: "bad_step"; index: number }
  | { code: "bad_dependencies"; key: string }
  | { code: "too_many_steps"; max: number }
  | { code: "bad_key"; key: string }
  | { code: "duplicate_key"; key: string }
  | { code: "bad_department"; key: string }
  | { code: "unknown_dependency"; key: string; dependsOn: string }
  | { code: "self_dependency"; key: string }
  | { code: "cycle"; keys: string[] };

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateLinkedPlan(plan: LinkedCasePlan): LinkedPlanProblem[] {
  const problems: LinkedPlanProblem[] = [];
  const steps = plan.steps;
  if (!steps.length) {
    return [{ code: "empty" }];
  }
  if (steps.length > LINKED_PLAN_MAX_STEPS) {
    problems.push({ code: "too_many_steps", max: LINKED_PLAN_MAX_STEPS });
  }
  // Shape first: a step that is not an object or has no readable title, or dependencies that are
  // not a list of keys, is refused rather than read as "no dependencies" (which would open the
  // step early) or rendered without a title.
  const shapeProblems: LinkedPlanProblem[] = [];
  steps.forEach((s: unknown, index) => {
    if (!s || typeof s !== "object") {
      shapeProblems.push({ code: "bad_step", index });
      return;
    }
    const step = s as Partial<LinkedCaseStep>;
    if (!isStepTitle(step.title)) {
      shapeProblems.push({ code: "bad_step", index });
      return;
    }
    if (!Array.isArray(step.dependsOn) || !step.dependsOn.every((d) => typeof d === "string")) {
      shapeProblems.push({
        code: "bad_dependencies",
        key: typeof step.key === "string" ? step.key : String(index),
      });
    }
  });
  if (shapeProblems.length) {
    return [...problems, ...shapeProblems];
  }
  const keys = new Set<string>();
  for (const s of steps) {
    if (typeof s.key !== "string" || !KEY_RE.test(s.key)) {
      problems.push({ code: "bad_key", key: s.key });
    }
    if (keys.has(s.key)) {
      problems.push({ code: "duplicate_key", key: s.key });
    }
    keys.add(s.key);
    if (!isDepartmentId(s.department)) {
      problems.push({ code: "bad_department", key: s.key });
    }
  }
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (d === s.key) {
        problems.push({ code: "self_dependency", key: s.key });
      } else if (!keys.has(d)) {
        problems.push({ code: "unknown_dependency", key: s.key, dependsOn: d });
      }
    }
  }
  const cycle = findCycle(steps, keys);
  if (cycle) {
    problems.push({ code: "cycle", keys: cycle });
  }
  return problems;
}

/** A title is an object whose ja/en, when present, are strings; it may be empty (the key is shown). */
function isStepTitle(t: unknown): t is WorkItemText {
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    return false;
  }
  const { ja, en } = t as Record<string, unknown>;
  return (
    (ja === undefined || typeof ja === "string") && (en === undefined || typeof en === "string")
  );
}

/** First dependency cycle (in plan order) among known keys, or null. Self-loops are reported separately. */
function findCycle(steps: LinkedCaseStep[], keys: Set<string>): string[] | null {
  const deps = new Map<string, string[]>();
  for (const s of steps) {
    if (!deps.has(s.key)) {
      deps.set(
        s.key,
        s.dependsOn.filter((d) => d !== s.key && keys.has(d)),
      );
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    const st = state.get(k);
    if (st === "done") {
      return null;
    }
    if (st === "visiting") {
      return [...stack.slice(stack.indexOf(k)), k];
    }
    state.set(k, "visiting");
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      const found = visit(d);
      if (found) {
        return found;
      }
    }
    stack.pop();
    state.set(k, "done");
    return null;
  };
  for (const k of deps.keys()) {
    const found = visit(k);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * - waiting: a dependency is not done yet (and none is cancelled)
 * - ready: every dependency is done and no child item exists yet; open it now
 * - open: child item exists and is not terminal
 * - done / cancelled: child item is terminal
 * - stuck: a dependency was cancelled, so this step can never open without a plan change
 */
export type LinkedStepState = "waiting" | "ready" | "open" | "done" | "cancelled" | "stuck";

export type LinkedCaseProgress = {
  steps: Array<{ key: string; department: DepartmentId; state: LinkedStepState }>;
  /** Steps to open now, in plan order. */
  ready: string[];
  done: number;
  total: number;
  /** All steps done. */
  complete: boolean;
  /** Some step is cancelled or stuck: the parent cannot complete as planned. */
  blocked: boolean;
};

/**
 * Progress of a valid plan given the status of each step's child item (absent = not yet
 * created). Call validateLinkedPlan first; an invalid plan throws.
 */
export function linkedCaseProgress(
  plan: LinkedCasePlan,
  childStatus: Readonly<Record<string, WorkItemStatus | undefined>>,
): LinkedCaseProgress {
  const problems = validateLinkedPlan(plan);
  if (problems.length) {
    throw new Error(`invalid linked case plan: ${problems.map((p) => p.code).join(", ")}`);
  }
  const byKey = new Map(plan.steps.map((s) => [s.key, s]));
  const memo = new Map<string, LinkedStepState>();
  const stateOf = (key: string): LinkedStepState => {
    const known = memo.get(key);
    if (known) {
      return known;
    }
    const step = byKey.get(key)!;
    const status = Object.hasOwn(childStatus, key) ? childStatus[key] : undefined;
    let st: LinkedStepState;
    if (status !== undefined) {
      st = status === "done" ? "done" : status === "cancelled" ? "cancelled" : "open";
    } else {
      const depStates = step.dependsOn.map(stateOf);
      st = depStates.some((d) => d === "cancelled" || d === "stuck")
        ? "stuck"
        : depStates.every((d) => d === "done")
          ? "ready"
          : "waiting";
    }
    memo.set(key, st);
    return st;
  };
  const steps = plan.steps.map((s) => ({
    key: s.key,
    department: s.department,
    state: stateOf(s.key),
  }));
  const done = steps.filter((s) => s.state === "done").length;
  return {
    steps,
    ready: steps.filter((s) => s.state === "ready").map((s) => s.key),
    done,
    total: steps.length,
    complete: done === steps.length,
    blocked: steps.some((s) => s.state === "cancelled" || s.state === "stuck"),
  };
}
