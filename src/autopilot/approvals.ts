// Standing approvals: a person approves an external routine action once, inside a scope
// (known recipients or targets, templates, a daily maximum), for at most 90 days. Only people
// create and revoke them (the gateway refuses agent, cron and voice origins before this runs;
// these functions refuse non-person actors again). Every L3 action records the approval id.

import type { Project } from "../projects/types.js";
import type { StandingApproval, StandingApprovalScope } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { getProject } from "../projects/store.js";
import { getActionDef } from "./actions.js";
import { scopeMiss } from "./authorize.js";
import { loadRoutines } from "./routines.js";
import {
  mutateApprovals,
  newId,
  readApprovals,
  readApprovalUses,
  routineState,
  withAutopilotLock,
  writeApprovalUsesLocked,
} from "./store.js";
import { approvalState, AutopilotRefused, effectiveLevel, LEVEL_RANK } from "./types.js";

export const MAX_APPROVAL_DAYS = 90;
const DAY_MS = 86_400_000;
const EMAIL_RE = /^[^\s@<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const TARGET_RE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/;
const TEMPLATE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ApprovalActor = { id: string; kind: "person" | "agent" | "system" };

export type CreateApprovalInput = {
  routineId: string;
  action: string;
  scope: Partial<Record<keyof StandingApprovalScope, unknown>>;
  reason: string;
  expiresAt: string;
};

function list(raw: unknown, re: RegExp, what: string, max = 200): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > max) {
    throw new AutopilotRefused("invalid_scope", `scope.${what} must be a list (at most ${max})`);
  }
  return [
    ...new Set(
      raw.map((v) => {
        const s = typeof v === "string" ? v.trim().toLowerCase() : "";
        if (!re.test(s)) {
          throw new AutopilotRefused("invalid_scope", `scope.${what}: ${String(v)} is not valid`);
        }
        return s;
      }),
    ),
  ];
}

function personOnly(actor: ApprovalActor, what: string): void {
  if (actor.kind !== "person") {
    throw new AutopilotRefused("not_a_person", `only a person may ${what} a standing approval`);
  }
}

function cleanReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 4) {
    throw new AutopilotRefused("reason_required", "a written reason is required");
  }
  return reason.slice(0, 1000);
}

export function createStandingApproval(
  project: Pick<Project, "id" | "folder" | "templateId" | "archived">,
  input: CreateApprovalInput,
  actor: ApprovalActor,
  opts: { now?: Date; home?: string; authn?: Record<string, unknown> | null } = {},
): StandingApproval {
  personOnly(actor, "create");
  if (project.archived) {
    throw new AutopilotRefused("archived", "project is archived");
  }
  const now = opts.now ?? new Date();
  const reason = cleanReason(input.reason);
  const set = loadRoutines(project, opts.home);
  if (set.error) {
    throw new AutopilotRefused("routines_invalid", `the routines file is invalid: ${set.error}`);
  }
  const routine = set.routines.find((r) => r.id === input.routineId);
  if (!routine) {
    throw new AutopilotRefused("routine_not_found", "routine not found");
  }
  const def = getActionDef(input.action);
  if (!def || def.class !== "external") {
    throw new AutopilotRefused(
      "not_external",
      "standing approvals cover external actions only (prepare and internal actions need none; never actions cannot be approved in advance)",
    );
  }
  if (!routine.actions.includes(def.id)) {
    throw new AutopilotRefused("not_in_routine", `routine ${routine.id} does not list ${def.id}`);
  }
  const s = input.scope ?? {};
  const scope: StandingApprovalScope = {
    addresses: list(s.addresses, EMAIL_RE, "addresses"),
    domains: list(s.domains, DOMAIN_RE, "domains"),
    targets: list(s.targets, TARGET_RE, "targets"),
    templates: list(s.templates, TEMPLATE_RE, "templates", 50),
    maxPerDay:
      typeof s.maxPerDay === "number" && Number.isInteger(s.maxPerDay) && s.maxPerDay >= 1
        ? Math.min(s.maxPerDay, 500)
        : 0,
  };
  if (scope.maxPerDay < 1) {
    throw new AutopilotRefused("invalid_scope", "scope.maxPerDay must be an integer from 1 to 500");
  }
  const sendsMail = "to" in def.args;
  if (sendsMail && scope.addresses.length + scope.domains.length === 0) {
    throw new AutopilotRefused("invalid_scope", "name the known recipients (addresses or domains)");
  }
  if (!sendsMail && scope.targets.length === 0) {
    throw new AutopilotRefused("invalid_scope", "name the targets the action may reach");
  }
  if ("templateId" in def.args && scope.templates.length === 0) {
    throw new AutopilotRefused("invalid_scope", "name the templates the routine may send");
  }
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    throw new AutopilotRefused("invalid_expiry", "expiresAt must be a future ISO time");
  }
  if (expires > now.getTime() + MAX_APPROVAL_DAYS * DAY_MS) {
    throw new AutopilotRefused(
      "invalid_expiry",
      `expiresAt is at most ${MAX_APPROVAL_DAYS} days ahead`,
    );
  }
  const approval: StandingApproval = {
    id: newId("s"),
    projectId: project.id,
    routineId: routine.id,
    action: def.id,
    scope,
    reason,
    createdBy: actor.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(expires).toISOString(),
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...(opts.authn ? { authn: opts.authn } : {}),
  };
  mutateApprovals(project.id, (all) => all.push(approval), opts.home);
  void auditSafe({
    identity: actor.id,
    scope: project.id,
    action: "autopilot.approval.create",
    outcome: "ok",
    source: "gateway.autopilot",
    detail: {
      id: approval.id,
      routineId: routine.id,
      action: def.id,
      expiresAt: approval.expiresAt,
      maxPerDay: scope.maxPerDay,
      addresses: scope.addresses.length,
      domains: scope.domains,
      templates: scope.templates,
      ...(opts.authn ? { authn: opts.authn } : {}),
    },
  });
  return approval;
}

export function revokeStandingApproval(
  project: Pick<Project, "id">,
  id: string,
  reason: unknown,
  actor: ApprovalActor,
  opts: { now?: Date; home?: string; authn?: Record<string, unknown> | null } = {},
): StandingApproval {
  personOnly(actor, "revoke");
  const why = cleanReason(reason);
  const now = opts.now ?? new Date();
  const out = mutateApprovals(
    project.id,
    (all) => {
      const a = all.find((x) => x.id === id);
      if (!a) {
        throw new AutopilotRefused("approval_not_found", "standing approval not found");
      }
      if (a.revokedAt) {
        throw new AutopilotRefused("already_revoked", "the standing approval is already revoked");
      }
      a.revokedAt = now.toISOString();
      a.revokedBy = actor.id;
      a.revokeReason = why;
      if (opts.authn) {
        a.revokeAuthn = opts.authn;
      }
      return { ...a };
    },
    opts.home,
  );
  void auditSafe({
    identity: actor.id,
    scope: project.id,
    action: "autopilot.approval.revoke",
    outcome: "ok",
    source: "gateway.autopilot",
    detail: {
      id,
      routineId: out.routineId,
      action: out.action,
      ...(opts.authn ? { authn: opts.authn } : {}),
    },
  });
  return out;
}

export function listStandingApprovals(
  projectId: string,
  filter: { routineId?: string; includeInactive?: boolean } = {},
  opts: { now?: Date; home?: string } = {},
): Array<StandingApproval & { state: ReturnType<typeof approvalState> }> {
  const now = opts.now ?? new Date();
  return readApprovals(projectId, opts.home)
    .filter((a) => !filter.routineId || a.routineId === filter.routineId)
    .map((a) => ({ ...a, state: approvalState(a, now) }))
    .filter((a) => filter.includeInactive || a.state === "active")
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type ConsumeApprovalInput = {
  projectId: string;
  approvalId: string;
  routineId: string;
  action: string;
  /** Every recipient of the send (to and cc), exactly as the connector will send it. */
  recipients: string[];
  targets?: string[];
  templateId: string | null;
  /** Day key (YYYY-MM-DD, routine timezone) the use counts against. */
  day: string;
  now?: Date;
  home?: string;
  /** Audit context. */
  runId?: string;
  connector?: string;
};

export type ConsumeApprovalResult =
  | { ok: true; approval: StandingApproval; usesToday: number }
  | { ok: false; code: string; reason: string };

/**
 * Verify a standing approval for ONE external action and count the use, atomically (under the
 * Project's autopilot lock, so two sends never both take the last use of the day). Checks: the
 * Project and the routine exist, the routine is enabled, effectively L3 (file level and override)
 * and lists the action; the approval
 * exists, is active (not expired, not revoked) and belongs to this routine and action; the scope
 * covers every recipient / target and the template (the same scopeMiss the engine's authorize
 * step uses); the day's uses are below maxPerDay. Every verification is audited with the
 * approval id, used or refused.
 */
export function consumeStandingApproval(input: ConsumeApprovalInput): ConsumeApprovalResult {
  const now = input.now ?? new Date();
  const audit = (outcome: "ok" | "denied", detail: Record<string, unknown>) =>
    void auditSafe({
      identity: `autopilot:${input.routineId}`,
      scope: input.projectId,
      action: "autopilot.approval.use",
      outcome,
      source: input.connector ? `connector.${input.connector}` : "autopilot",
      detail: { id: input.approvalId, action: input.action, runId: input.runId ?? null, ...detail },
    });
  const refuse = (code: string, reason: string): ConsumeApprovalResult => {
    audit("denied", { code });
    return { ok: false, code, reason };
  };
  const project = getProject(input.projectId, input.home);
  if (!project || project.archived) {
    return refuse("project_unavailable", "the Project does not exist or is archived");
  }
  const set = loadRoutines(project, input.home);
  const routine = set.error ? null : set.routines.find((r) => r.id === input.routineId);
  if (!routine || !routine.enabled) {
    return refuse("routine_unavailable", "the routine is missing, invalid or disabled");
  }
  // The effective level: an accepted lower level or a demotion ends L3 sends at once.
  const level = effectiveLevel(
    routine.level,
    routineState(input.projectId, routine.id, input.home).override,
  );
  if (LEVEL_RANK[level] < 3 || !routine.actions.includes(input.action)) {
    return refuse("level_too_low", `the routine is not L3 with ${input.action}`);
  }
  const out = withAutopilotLock(
    input.projectId,
    (): ConsumeApprovalResult => {
      const approval = readApprovals(input.projectId, input.home).find(
        (a) => a.id === input.approvalId,
      );
      if (!approval) {
        return { ok: false, code: "approval_not_found", reason: "standing approval not found" };
      }
      const state = approvalState(approval, now);
      if (state !== "active") {
        return {
          ok: false,
          code: `approval_${state}`,
          reason: `the standing approval is ${state}`,
        };
      }
      if (approval.routineId !== input.routineId || approval.action !== input.action) {
        return {
          ok: false,
          code: "approval_mismatch",
          reason: "the standing approval is for another routine or action",
        };
      }
      const miss = scopeMiss(approval.scope, {
        recipients: input.recipients.map((r) => r.trim().toLowerCase()),
        targets: input.targets ?? [],
        templateId: input.templateId,
      });
      if (miss) {
        return { ok: false, ...miss };
      }
      const uses = readApprovalUses(input.projectId, input.home);
      const days = uses[approval.id] ?? {};
      uses[approval.id] = days;
      const n = days[input.day] ?? 0;
      if (n >= approval.scope.maxPerDay) {
        return {
          ok: false,
          code: "approval_daily_limit",
          reason: `standing approval ${approval.id} reached ${approval.scope.maxPerDay} today`,
        };
      }
      days[input.day] = n + 1;
      writeApprovalUsesLocked(input.projectId, uses, input.home);
      return { ok: true, approval, usesToday: n + 1 };
    },
    input.home,
  );
  if (!out.ok) {
    return refuse(out.code, out.reason);
  }
  audit("ok", {
    recipients: input.recipients.length,
    usesToday: out.usesToday,
    maxPerDay: out.approval.scope.maxPerDay,
  });
  return out;
}
