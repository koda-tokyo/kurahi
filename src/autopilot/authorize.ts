// The autonomy check: one pure function decides every action a routine's model proposes.
//
//   L0 observe   nothing is executed
//   L1 prepare   + actions classified `prepare` (drafts, documents, work items, proposals)
//   L2 internal  + `internal-reversible` actions
//   L3 external  + `external` actions, only under a valid standing approval whose scope covers
//                  every recipient / target, the template and the daily maximum
//   never        always a person, whatever the level
//
// The routine (set by an administrator) is the only input that carries authority. The proposal
// comes from a model reading untrusted content: it can name an action and its arguments, never
// a level, an approval or an action the routine does not list. Order matters: unknown and
// flagged come first so nothing about a suspicious item is ever executed.

import type {
  ActionClass,
  Decision,
  ProposedAction,
  Routine,
  StandingApproval,
  StandingApprovalScope,
} from "./types.js";
import { cleanActionArgs, getActionDef } from "./actions.js";
import { approvalState, BLOCKING_FLAGS, LEVEL_RANK } from "./types.js";

export type AuthorizeRoutine = Pick<Routine, "id" | "edition" | "level" | "actions" | "limits">;

export type AuthorizeContext = {
  now: Date;
  /** Flags on the item the action is for. */
  flags: readonly string[];
  /** The Project's standing approvals (any state; only active ones count). */
  approvals: readonly StandingApproval[];
  /** Actions this routine executed today (all classes). */
  actionsToday: number;
  /** Uses per standing approval today. */
  approvalUsesToday: Readonly<Record<string, number>>;
};

const BLOCKING = new Set<string>(BLOCKING_FLAGS);
const EMAIL_RE = /^[^\s@<>]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/;

function needs(cls: ActionClass | null, code: string, reason: string): Decision {
  return { decision: "needs_person", class: cls, code, reason };
}
function refuse(cls: ActionClass | null, code: string, reason: string): Decision {
  return { decision: "refuse", class: cls, code, reason };
}

/** Why a scope does not cover a send, or null when it does. */
export function scopeMiss(
  scope: StandingApprovalScope,
  t: { recipients: string[]; targets: string[]; templateId: string | null },
): { code: string; reason: string } | null {
  if (t.recipients.length === 0 && t.targets.length === 0) {
    return { code: "no_target", reason: "the action names no recipient or target" };
  }
  for (const r of t.recipients) {
    const m = EMAIL_RE.exec(r);
    if (!m) {
      return { code: "recipient_out_of_scope", reason: `${r} is not a plain address` };
    }
    const domain = m[1];
    if (!scope.addresses.includes(r) && !scope.domains.includes(domain)) {
      return {
        code: "recipient_out_of_scope",
        reason: `${r} is not covered by the standing approval`,
      };
    }
  }
  for (const target of t.targets) {
    if (!scope.targets.includes(target)) {
      return {
        code: "target_out_of_scope",
        reason: `${target} is not covered by the standing approval`,
      };
    }
  }
  if (scope.templates.length > 0 && (!t.templateId || !scope.templates.includes(t.templateId))) {
    return {
      code: "template_out_of_scope",
      reason: t.templateId
        ? `template ${t.templateId} is not covered by the standing approval`
        : "the standing approval requires a template",
    };
  }
  return null;
}

export function authorizeAction(
  routine: AuthorizeRoutine,
  action: ProposedAction,
  ctx: AuthorizeContext,
): Decision {
  const def = getActionDef(action.kind);
  if (!def) {
    return refuse(null, "unknown_action", `${action.kind} is not in the action catalogue`);
  }
  const cls = def.class;
  if (!def.editions.includes(routine.edition)) {
    return refuse(cls, "edition_mismatch", `${def.id} is not available in ${routine.edition}`);
  }
  const flagged = ctx.flags.filter((f) => BLOCKING.has(f));
  if (flagged.length > 0) {
    return refuse(cls, "flagged", `the item is flagged (${flagged.join(", ")}); a person decides`);
  }
  if (cls === "never") {
    return needs(cls, "never_autonomous", `${def.id} is never done by the autopilot`);
  }
  if (!routine.actions.includes(def.id)) {
    return refuse(cls, "not_in_routine", `routine ${routine.id} does not allow ${def.id}`);
  }
  const cleaned = cleanActionArgs(def, action.args ?? {});
  if (!cleaned.ok) {
    return refuse(cls, "invalid_args", cleaned.error);
  }
  const rank = LEVEL_RANK[routine.level];
  if (rank === 0) {
    return refuse(cls, "level_observe", "L0 routines observe and report only");
  }
  if (ctx.actionsToday >= routine.limits.maxActionsPerDay) {
    return needs(
      cls,
      "daily_limit",
      `the routine reached ${routine.limits.maxActionsPerDay} today`,
    );
  }
  if (cls === "prepare") {
    return { decision: "allow", class: cls, approvalId: null };
  }
  if (cls === "internal-reversible") {
    return rank >= 2
      ? { decision: "allow", class: cls, approvalId: null }
      : needs(cls, "level_too_low", `${def.id} needs L2; the routine is ${routine.level}`);
  }
  // external
  const targets = def.targetsOf?.(cleaned.args) ?? {
    recipients: [],
    targets: [],
    templateId: null,
  };
  const mine = ctx.approvals.filter((a) => a.routineId === routine.id && a.action === def.id);
  const active = mine.filter((a) => approvalState(a, ctx.now) === "active");
  if (rank < 3) {
    return needs(cls, "level_too_low", `${def.id} needs L3; the routine is ${routine.level}`);
  }
  if (active.length === 0) {
    if (mine.some((a) => approvalState(a, ctx.now) === "revoked")) {
      return needs(cls, "approval_revoked", "the standing approval was revoked");
    }
    if (mine.length > 0) {
      return needs(cls, "approval_expired", "the standing approval has expired");
    }
    return needs(cls, "no_standing_approval", `${def.id} needs a standing approval`);
  }
  let miss: { code: string; reason: string } | null = null;
  for (const a of active) {
    const m = scopeMiss(a.scope, targets);
    if (m) {
      miss ??= m;
      continue;
    }
    if ((ctx.approvalUsesToday[a.id] ?? 0) >= a.scope.maxPerDay) {
      miss ??= {
        code: "approval_daily_limit",
        reason: `standing approval ${a.id} reached ${a.scope.maxPerDay} today`,
      };
      continue;
    }
    return { decision: "allow", class: cls, approvalId: a.id };
  }
  return needs(cls, miss!.code, miss!.reason);
}
