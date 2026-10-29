// Who may see, change and decide work items. Identities are the gateway's own principals (the
// `actorOf` string of the connection: `device:<id>` for a paired device identity, `pair:<fp>`
// for a pairing credential, `owner` for the gateway token without a device). The Project's
// policy maps principals to roles and departments:
//
//   access:
//     fallback: none            # or any_approver: role stages accept any approver until members exist
//     members:
//       - { principal: device:abc123def456, name: 佐藤, roles: [approver], departments: [sales],
//           email: sato@example.co.jp }   # optional: where the autopilot morning brief draft goes
//     groups:                   # identity groups (role:, unit:, group:) → roles, via the resolver
//       "<group-id>": { roles: [finance] }
//
// Built-in roles: requester (implied for everyone), approver, finance, operator, admin. Custom
// role ids (e.g. director) are allowed for route stages. `operator` / `admin` in the Project, or
// the operator.admin gateway scope, make a principal privileged: it may read and update every
// item. Privilege never lets anyone decide a stage they are not an approver of.

import type { WorkQueuePolicy } from "./policy.js";
import type { Actor, WorkItem, WorkItemStage } from "./types.js";
import { WorkItemRefused } from "./errors.js";
import { ID_RE, PRINCIPAL_RE, strList } from "./parse-util.js";

export const BUILTIN_ROLES = ["requester", "approver", "finance", "operator", "admin"] as const;
const PRIVILEGED_ROLES = new Set(["operator", "admin"]);
const DEPT_RE = /^[^\s].{0,63}$/u;
const MAX_MEMBERS = 2000;

export type AccessMember = {
  principal: string;
  name: string | null;
  roles: string[];
  departments: string[];
  /** Optional work address: the autopilot morning brief is drafted to it (never sent). */
  email?: string;
};

const MEMBER_EMAIL_RE = /^[^\s@<>",;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export type AccessDef = {
  members: AccessMember[];
  groups: Record<string, { roles: string[]; departments: string[] }>;
  /** none (default): role stages need listed members; any_approver: fall back to any approver. */
  fallback: "none" | "any_approver";
};

function depts(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .filter((v): v is string => typeof v === "string" && DEPT_RE.test(v.trim()))
        .map((v) => v.trim())
    : [];
}

export function parseAccess(raw: unknown): AccessDef {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("access must be an object");
  }
  const members: AccessMember[] = [];
  const seen = new Set<string>();
  for (const [i, m] of (Array.isArray(a.members) ? a.members : [])
    .slice(0, MAX_MEMBERS)
    .entries()) {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.principal !== "string" || !PRINCIPAL_RE.test(r.principal)) {
      throw new Error(`access.members[${i}]: principal is required (e.g. device:abc123def456)`);
    }
    if (seen.has(r.principal)) {
      throw new Error(`access.members: ${r.principal} is listed twice`);
    }
    seen.add(r.principal);
    let email: string | undefined;
    if (r.email !== undefined) {
      const e = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
      if (e.length > 254 || !MEMBER_EMAIL_RE.test(e)) {
        throw new Error(`access.members[${i}]: email must be a plain address`);
      }
      email = e;
    }
    members.push({
      principal: r.principal,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 100) : null,
      roles: strList(r.roles, ID_RE),
      departments: depts(r.departments),
      ...(email ? { email } : {}),
    });
  }
  const groups: AccessDef["groups"] = {};
  if (a.groups && typeof a.groups === "object" && !Array.isArray(a.groups)) {
    for (const [g, v] of Object.entries(a.groups as Record<string, unknown>).slice(0, 500)) {
      const r = (v ?? {}) as Record<string, unknown>;
      groups[g.slice(0, 128)] = {
        roles: strList(r.roles, ID_RE),
        departments: depts(r.departments),
      };
    }
  }
  return { members, groups, fallback: a.fallback === "any_approver" ? "any_approver" : "none" };
}

/**
 * Resolver for a principal's identity groups, installed by enterprise identity at gateway start
 * (src/identity/hooks.ts). It returns ids such as `role:approver`, `unit:sales` and
 * `group:<provider>:<group>`; `access.groups` maps them to roles. None until identity installs it.
 */
export type PrincipalGroupResolver = (principal: string, projectId: string) => string[] | null;
let groupResolver: PrincipalGroupResolver | null = null;
export function setPrincipalGroupResolver(fn: PrincipalGroupResolver | null): void {
  groupResolver = fn;
}

export type PrincipalRoles = { roles: Set<string>; departments: Set<string>; listed: boolean };

export function rolesOf(
  policy: WorkQueuePolicy,
  principal: string,
  projectId: string,
): PrincipalRoles {
  const roles = new Set<string>(["requester"]);
  const departments = new Set<string>();
  const m = policy.access.members.find((x) => x.principal === principal);
  for (const r of m?.roles ?? []) {
    roles.add(r);
  }
  for (const d of m?.departments ?? []) {
    departments.add(d.toLowerCase());
  }
  let listed = Boolean(m);
  if (groupResolver && Object.keys(policy.access.groups).length > 0) {
    for (const g of groupResolver(principal, projectId) ?? []) {
      const def = policy.access.groups[g];
      if (def) {
        listed = true;
        def.roles.forEach((r) => roles.add(r));
        def.departments.forEach((d) => departments.add(d.toLowerCase()));
      }
    }
  }
  return { roles, departments, listed };
}

export function accessConfigured(policy: WorkQueuePolicy): boolean {
  return policy.access.members.length > 0 || Object.keys(policy.access.groups).length > 0;
}

export function isPrivileged(actor: Actor, policy: WorkQueuePolicy, projectId: string): boolean {
  if (actor.privileged) {
    return true;
  }
  const { roles } = rolesOf(policy, actor.id, projectId);
  return [...roles].some((r) => PRIVILEGED_ROLES.has(r));
}

/** True when `principal` is one of the stage's own approvers (not via delegation/escalation). */
export function isStageApprover(
  stage: Pick<WorkItemStage, "approvers">,
  principal: string,
  policy: WorkQueuePolicy,
  projectId: string,
): boolean {
  const a = stage.approvers;
  if (a.any || a.principals.includes(principal)) {
    return true;
  }
  if (a.roles.length === 0) {
    return false;
  }
  if (!accessConfigured(policy)) {
    return policy.access.fallback === "any_approver";
  }
  const me = rolesOf(policy, principal, projectId);
  if (!a.roles.some((r) => me.roles.has(r))) {
    return false;
  }
  if (a.departmentField) {
    return a.department !== null && me.departments.has(a.department.toLowerCase());
  }
  return true;
}

function matchesTarget(
  to: { roles: string[]; principals: string[] },
  principal: string,
  policy: WorkQueuePolicy,
  projectId: string,
): boolean {
  if (to.principals.includes(principal)) {
    return true;
  }
  if (to.roles.length === 0) {
    return false;
  }
  if (!accessConfigured(policy)) {
    return policy.access.fallback === "any_approver";
  }
  const me = rolesOf(policy, principal, projectId);
  return to.roles.some((r) => me.roles.has(r));
}

/** Principals that acted in the stage (approved themselves or were approved for). */
export function actedInStage(stage: WorkItemStage, principal: string): boolean {
  return stage.approvals.some((a) => a.by === principal || a.onBehalfOf === principal);
}

export type DeciderVia = {
  via: "approver" | "delegation" | "escalation";
  onBehalfOf: string | null;
};

/**
 * How `principal` may decide the item's current stage right now, or null. Does not look at
 * separation of duties or earlier approvals (decide reports those with their own codes).
 */
export function deciderVia(
  item: Pick<WorkItem, "status" | "route" | "projectId">,
  principal: string,
  policy: WorkQueuePolicy,
  now: Date,
): DeciderVia | null {
  if (item.status !== "awaiting_review") {
    return null;
  }
  const stage = currentStage(item);
  if (!stage) {
    // Submitted before routes existed: the single-stage review, open to any approver.
    return item.route ? null : { via: "approver", onBehalfOf: null };
  }
  if (isStageApprover(stage, principal, policy, item.projectId)) {
    return { via: "approver", onBehalfOf: null };
  }
  const d = stage.delegations.find(
    (x) => x.to === principal && Date.parse(x.expiresAt) > now.getTime(),
  );
  if (d && !actedInStage(stage, d.from)) {
    return { via: "delegation", onBehalfOf: d.from };
  }
  if (
    stage.escalatedAt &&
    stage.escalation &&
    matchesTarget(stage.escalation.to, principal, policy, item.projectId)
  ) {
    return { via: "escalation", onBehalfOf: null };
  }
  return null;
}

export function currentStage(item: Pick<WorkItem, "route">): WorkItemStage | null {
  const r = item.route;
  return r && r.current !== null ? (r.stages[r.current] ?? null) : null;
}

/** True when the principal could approve the current stage now ("awaiting me"). */
export function awaitsPrincipal(
  item: WorkItem,
  principal: string,
  policy: WorkQueuePolicy,
  now: Date,
): boolean {
  if (!deciderVia(item, principal, policy, now)) {
    return false;
  }
  const sod = policy.separationOfDuties || item.route?.kind === "staged";
  if (sod && principal === item.requestedBy) {
    return false;
  }
  const stage = currentStage(item);
  if (stage ? actedInStage(stage, principal) : item.approvals.some((a) => a.by === principal)) {
    return false;
  }
  return !(
    item.route?.kind === "staged" && item.route.stages.some((s) => actedInStage(s, principal))
  );
}

function participated(item: WorkItem, principal: string): boolean {
  return (
    (item.route?.stages ?? []).some(
      (s) =>
        actedInStage(s, principal) ||
        s.delegations.some((d) => d.to === principal || d.from === principal),
    ) || item.approvals.some((a) => a.by === principal)
  );
}

export function canRead(item: WorkItem, actor: Actor, policy: WorkQueuePolicy, now: Date): boolean {
  return (
    isPrivileged(actor, policy, item.projectId) ||
    item.requestedBy === actor.id ||
    participated(item, actor.id) ||
    deciderVia(item, actor.id, policy, now) !== null
  );
}

export function assertCanRead(
  item: WorkItem,
  actor: Actor,
  policy: WorkQueuePolicy,
  now: Date,
): void {
  if (!canRead(item, actor, policy, now)) {
    throw new WorkItemRefused("not_authorised", "you are not authorised to read this work item");
  }
}

/** Requesters change only their own items; privileged principals change any. */
export function assertCanUpdate(item: WorkItem, actor: Actor, policy: WorkQueuePolicy): void {
  if (item.requestedBy !== actor.id && !isPrivileged(actor, policy, item.projectId)) {
    throw new WorkItemRefused(
      "not_authorised",
      "only the requester or an operator may change this work item",
    );
  }
}

/** The list predicate for one viewer: visibility, then `mine` / `awaitingMe`. */
export function viewerFilter(
  actor: Actor,
  policy: WorkQueuePolicy,
  projectId: string,
  opts: { mine?: boolean; awaitingMe?: boolean; now: Date },
): (item: WorkItem) => boolean {
  const privileged = isPrivileged(actor, policy, projectId);
  return (item) => {
    if (opts.mine && item.requestedBy !== actor.id) {
      return false;
    }
    if (opts.awaitingMe && !awaitsPrincipal(item, actor.id, policy, opts.now)) {
      return false;
    }
    return privileged || canRead(item, actor, policy, opts.now);
  };
}
