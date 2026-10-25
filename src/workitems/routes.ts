// 稟議 (staged approval) routes. A route is an ordered list of stages for a queue / item type;
// each stage names its approvers (roles, named principals, or the department read from a form
// field), how many approvals it needs, when it is due, where a send back goes, whether its
// approvers may delegate, and an escalation. Stages can be included conditionally:
//
//   routes:
//     - id: ringi
//       queues: [fin-ringi]
//       stages:
//         - id: manager
//           name: { ja: 所属長承認, en: Manager approval }
//           approvers: { roles: [approver], departmentField: department }
//           dueHours: 24
//           delegation: true
//           escalation: { afterHours: 48, to: { roles: [director] } }
//         - id: finance
//           when: [{ field: amount, gte: 100000 }]
//           approvers: { roles: [finance] }
//           onReturn: previous
//
// The route is fixed on the item when it is (re)submitted, so a policy change never moves an
// item that is already in review. Items without a matching route get one `single` stage that
// anyone with approval permission may decide, needing `requiredApprovals` people (the
// behaviour before routes existed).

import type { WorkQueuePolicy } from "./policy.js";
import type {
  WorkItem,
  WorkItemApproval,
  WorkItemRoute,
  WorkItemStage,
  WorkItemStageSummary,
} from "./types.js";
import {
  FIELD_RE,
  ID_RE,
  num,
  PRINCIPAL_RE,
  strList,
  text,
  types,
  type Text,
} from "./parse-util.js";

const OPS = ["gte", "gt", "lte", "lt", "eq", "ne", "in", "present"] as const;
type Op = (typeof OPS)[number];
export type Condition = { field: string; op: Op; value: unknown };

export type StageDef = {
  id: string;
  name: Text;
  approvers: { roles: string[]; principals: string[]; departmentField: string | null };
  minApprovals: number;
  dueHours: number | null;
  onReturn: "requester" | "previous";
  delegation: boolean;
  escalation: WorkItemStage["escalation"];
  when: Condition[];
};

export type RouteDef = {
  id: string;
  name: Text;
  queues: string[];
  types: WorkItem["type"][];
  when: Condition[];
  stages: StageDef[];
};

const MAX_STAGES = 12;

function parseConditions(raw: unknown, where: string): Condition[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c, i) => {
    const r = (c ?? {}) as Record<string, unknown>;
    if (typeof r.field !== "string" || !FIELD_RE.test(r.field)) {
      throw new Error(`${where}.when[${i}]: field is required`);
    }
    const ops = OPS.filter((o) => o in r);
    if (ops.length !== 1) {
      throw new Error(`${where}.when[${i}]: use exactly one of ${OPS.join(", ")}`);
    }
    const op = ops[0];
    const value = r[op];
    if (["gte", "gt", "lte", "lt"].includes(op) && num(value) === null) {
      throw new Error(`${where}.when[${i}]: ${op} needs a number`);
    }
    if (op === "in" && !Array.isArray(value)) {
      throw new Error(`${where}.when[${i}]: in needs a list`);
    }
    if (op === "present" && typeof value !== "boolean") {
      throw new Error(`${where}.when[${i}]: present needs true or false`);
    }
    return { field: r.field, op, value };
  });
}

function positive(raw: unknown): number | null {
  const n = num(raw);
  return n !== null && n > 0 ? n : null;
}

function parseStage(raw: unknown, where: string): StageDef {
  const s = (raw ?? {}) as Record<string, unknown>;
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) {
    throw new Error(`${where}: id is required`);
  }
  const a = (s.approvers ?? {}) as Record<string, unknown>;
  const approvers = {
    roles: strList(a.roles ?? (typeof a.role === "string" ? [a.role] : []), ID_RE),
    principals: strList(a.principals, PRINCIPAL_RE),
    departmentField:
      typeof a.departmentField === "string" && FIELD_RE.test(a.departmentField)
        ? a.departmentField
        : null,
  };
  if (!approvers.roles.length && !approvers.principals.length) {
    throw new Error(`${where} (${s.id}): approvers needs roles or principals`);
  }
  const min = num(s.minApprovals) ?? 1;
  if (!Number.isInteger(min) || min < 1 || min > 10) {
    throw new Error(`${where} (${s.id}): minApprovals must be 1–10`);
  }
  let escalation: StageDef["escalation"] = null;
  if (s.escalation) {
    const e = s.escalation as Record<string, unknown>;
    const to = (e.to ?? {}) as Record<string, unknown>;
    const after = positive(e.afterHours);
    const target = {
      roles: strList(to.roles ?? (typeof to.role === "string" ? [to.role] : []), ID_RE),
      principals: strList(to.principals, PRINCIPAL_RE),
    };
    if (after === null || (!target.roles.length && !target.principals.length)) {
      throw new Error(
        `${where} (${s.id}): escalation needs afterHours and to.roles or to.principals`,
      );
    }
    escalation = { afterHours: after, to: target };
  }
  return {
    id: s.id,
    name: text(s.name ?? s.id),
    approvers,
    minApprovals: min,
    dueHours: positive(s.dueHours),
    onReturn: s.onReturn === "previous" ? "previous" : "requester",
    delegation: s.delegation === true,
    escalation,
    when: parseConditions(s.when, `${where} (${s.id})`),
  };
}

export function parseRoutes(raw: unknown): RouteDef[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("routes must be a list");
  }
  const ids = new Set<string>();
  return raw.map((r0, i) => {
    const r = (r0 ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID_RE.test(r.id) || ids.has(r.id)) {
      throw new Error(`route ${i + 1}: a unique id is required`);
    }
    ids.add(r.id);
    const list = Array.isArray(r.stages) ? r.stages : [];
    if (list.length === 0 || list.length > MAX_STAGES) {
      throw new Error(`route ${r.id}: 1–${MAX_STAGES} stages are required`);
    }
    const routeId = r.id;
    const stages = list.map((s, j) => parseStage(s, `route ${routeId} stage ${j + 1}`));
    const sids = new Set(stages.map((s) => s.id));
    if (sids.size !== stages.length) {
      throw new Error(`route ${r.id}: stage ids must be unique`);
    }
    return {
      id: r.id,
      name: text(r.name ?? r.id),
      queues: strList(r.queues, ID_RE),
      types: types(r.types),
      when: parseConditions(r.when, `route ${r.id}`),
      stages,
    };
  });
}

// ---- evaluation ----

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function asNumber(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
}

/** Null when the condition holds, else a readable reason. */
export function conditionFails(c: Condition, fields: WorkItem["source"]["fields"]): string | null {
  const v = fields[c.field];
  const shown = isEmpty(v) ? "missing" : JSON.stringify(v);
  let ok: boolean;
  switch (c.op) {
    case "present":
      ok = !isEmpty(v) === c.value;
      break;
    case "in":
      ok = !isEmpty(v) && (c.value as unknown[]).some((x) => String(x) === String(v));
      break;
    case "eq":
    case "ne": {
      const same =
        !isEmpty(v) &&
        (Number.isFinite(asNumber(v)) && typeof c.value === "number"
          ? asNumber(v) === c.value
          : String(v) === String(c.value));
      ok = c.op === "eq" ? same : !same;
      break;
    }
    default: {
      const n = asNumber(v);
      const t = c.value as number;
      ok =
        Number.isFinite(n) &&
        (c.op === "gte" ? n >= t : c.op === "gt" ? n > t : c.op === "lte" ? n <= t : n < t);
    }
  }
  return ok ? null : `${c.field} ${c.op} ${JSON.stringify(c.value)} not met (value: ${shown})`;
}

function allHold(list: Condition[], fields: WorkItem["source"]["fields"]): string | null {
  for (const c of list) {
    const why = conditionFails(c, fields);
    if (why) {
      return why;
    }
  }
  return null;
}

export function matchRoute(
  policy: WorkQueuePolicy,
  item: Pick<WorkItem, "queue" | "type" | "source">,
): RouteDef | null {
  if (policy.error) {
    return null;
  }
  return (
    policy.routes.find(
      (r) =>
        (r.queues.length === 0 || r.queues.includes(item.queue)) &&
        (r.types.length === 0 || r.types.includes(item.type)) &&
        allHold(r.when, item.source.fields) === null,
    ) ?? null
  );
}

function emptyStage(
  def: Omit<
    WorkItemStage,
    | "status"
    | "approvals"
    | "delegations"
    | "activatedAt"
    | "dueAt"
    | "completedAt"
    | "overdueAt"
    | "escalatedAt"
  >,
): WorkItemStage {
  return {
    ...def,
    status: "pending",
    approvals: [],
    delegations: [],
    activatedAt: null,
    dueAt: null,
    completedAt: null,
    overdueAt: null,
    escalatedAt: null,
  };
}

function singleStage(minApprovals: number): WorkItemStage {
  return emptyStage({
    id: "review",
    name: { ja: "承認", en: "Approval" },
    approvers: { any: true, roles: [], principals: [], departmentField: null, department: null },
    minApprovals: Math.max(1, minApprovals),
    dueHours: null,
    onReturn: "requester",
    delegation: false,
    escalation: null,
  });
}

/** Build the item's route from the policy (stages pending; nothing active yet). */
export function buildRoute(
  policy: WorkQueuePolicy,
  item: Pick<WorkItem, "queue" | "type" | "source" | "requiredApprovals">,
): WorkItemRoute {
  const def = matchRoute(policy, item);
  if (!def) {
    return {
      id: "single",
      kind: "single",
      policyDigest: policy.digest,
      stages: [singleStage(item.requiredApprovals)],
      skipped: [],
      current: null,
    };
  }
  const stages: WorkItemStage[] = [];
  const skipped: WorkItemRoute["skipped"] = [];
  for (const s of def.stages) {
    const why = allHold(s.when, item.source.fields);
    if (why) {
      skipped.push({ id: s.id, name: s.name, reason: why });
      continue;
    }
    const deptRaw = s.approvers.departmentField
      ? item.source.fields[s.approvers.departmentField]
      : null;
    stages.push(
      emptyStage({
        id: s.id,
        name: s.name,
        approvers: {
          any: false,
          roles: s.approvers.roles,
          principals: s.approvers.principals,
          departmentField: s.approvers.departmentField,
          department: isEmpty(deptRaw) ? null : String(deptRaw).trim().slice(0, 64),
        },
        minApprovals: s.minApprovals,
        dueHours: s.dueHours,
        onReturn: s.onReturn,
        delegation: s.delegation,
        escalation: s.escalation,
      }),
    );
  }
  if (stages.length === 0) {
    stages.push(singleStage(item.requiredApprovals));
  }
  return {
    id: def.id,
    kind: "staged",
    policyDigest: policy.digest,
    stages,
    skipped,
    current: null,
  };
}

/** Make stage `index` the active one (fresh approvals, delegations and timers). */
export function activateStage(route: WorkItemRoute, index: number, now: Date): void {
  const s = route.stages[index];
  s.status = "active";
  s.approvals = [];
  s.delegations = [];
  s.activatedAt = now.toISOString();
  s.dueAt = s.dueHours ? new Date(now.getTime() + s.dueHours * 3_600_000).toISOString() : null;
  s.completedAt = null;
  s.overdueAt = null;
  s.escalatedAt = null;
  route.current = index;
}

export function resetStage(s: WorkItemStage): void {
  s.status = "pending";
  s.approvals = [];
  s.delegations = [];
  s.activatedAt = s.dueAt = s.completedAt = s.overdueAt = s.escalatedAt = null;
}

/** All approvals of the route, in stage order (the item's `approvals` mirror). */
export function routeApprovals(route: WorkItemRoute): WorkItemApproval[] {
  return route.stages.flatMap((s) => s.approvals);
}

/** Keep `requiredApprovals` and the single stage in step (single: rules decide; staged: sum). */
export function syncRouteApprovals(item: WorkItem): void {
  const r = item.route;
  if (!r) {
    return;
  }
  if (r.kind === "single") {
    r.stages[0].minApprovals = Math.max(1, item.requiredApprovals);
  } else {
    item.requiredApprovals = r.stages.reduce((n, s) => n + s.minApprovals, 0);
  }
}

/** (Re)build the route; activate its first stage when the item is in review. */
export function startRoute(
  item: WorkItem,
  policy: WorkQueuePolicy,
  now: Date,
  activate: boolean,
): void {
  item.route = buildRoute(policy, item);
  syncRouteApprovals(item);
  if (activate) {
    activateStage(item.route, 0, now);
  }
  item.approvals = [];
}

export function stageSummary(
  item: Pick<WorkItem, "route" | "status">,
  now: Date,
): WorkItemStageSummary | null {
  const r = item.route;
  if (!r || r.current === null || item.status !== "awaiting_review") {
    return null;
  }
  const s = r.stages[r.current];
  return {
    id: s.id,
    name: s.name,
    index: r.current,
    count: r.stages.length,
    dueAt: s.dueAt,
    overdue: s.dueAt !== null && Date.parse(s.dueAt) < now.getTime(),
    escalated: s.escalatedAt !== null,
    approvals: s.approvals.length,
    minApprovals: s.minApprovals,
  };
}
