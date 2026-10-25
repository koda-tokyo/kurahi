// Earned autonomy: from recorded evidence only (run records and the work queue's person
// corrections), propose one level up or down per routine, from its EFFECTIVE level (the file's
// level lowered by an accepted level or a demotion, see autonomy-level.ts). A proposal is never
// applied here: the autopilot cannot raise its own level, so a person with authority accepts it
// (autonomy-level.ts; promotion to L3 also needs a standing approval, and nothing goes above the
// routine file's level). Too little evidence means no proposal, never a guess.
// A person may decline a proposal: that only records the decision (no level changes), and the
// same proposal stays marked declined for one policy window or until the evidence changes it.

import type { Project } from "../projects/types.js";
import type { ApprovalActor } from "./approvals.js";
import type { AutonomyDecline, AutonomyLevel, Routine, RunSummary } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { loadRoutines } from "./routines.js";
import {
  mutateAutonomyDeclines,
  readApprovals,
  readAutonomyDeclines,
  readRunSummaries,
  routineState,
} from "./store.js";
import {
  approvalState,
  AUTONOMY_LEVELS,
  AutopilotRefused,
  effectiveLevel,
  LEVEL_RANK,
} from "./types.js";
import { autopilotCorrections } from "./workitems-adapter.js";

export type AutonomyPolicy = {
  /** Look-back window for the evidence. */
  windowDays: number;
  /** Work items the routine must have produced before a promotion is proposed. */
  minItemsToPromote: number;
  /** Corrected share at or below which a promotion is proposed. */
  promoteAtOrBelow: number;
  /** Work items needed before a demotion is proposed (lower: safety acts on less evidence). */
  minItemsToDemote: number;
  /** Corrected share at or above which a demotion is proposed. */
  demoteAtOrAbove: number;
};

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  windowDays: 30,
  minItemsToPromote: 20,
  promoteAtOrBelow: 0.05,
  minItemsToDemote: 10,
  demoteAtOrAbove: 0.2,
};

export type AutonomyEvidence = {
  from: string;
  to: string;
  runs: number;
  failedRuns: number;
  /** Work items the routine created in the window. */
  workItems: number;
  /** Of those, the ones a person corrected. */
  corrected: number;
  /** corrected / workItems, null without work items. */
  correctionRate: number | null;
  escalated: number;
};

export type AutonomyProposal = {
  routineId: string;
  current: AutonomyLevel;
  kind: "promote" | "demote" | "hold";
  proposed: AutonomyLevel;
  reason:
    | "low_correction_rate"
    | "high_correction_rate"
    | "failed_runs"
    | "insufficient_evidence"
    | "at_top"
    | "within_band";
  /** A promotion to L3 is valid only with a standing approval a person creates. */
  needsStandingApproval: boolean;
  evidence: AutonomyEvidence;
};

/** Why a person cannot accept a promotion as it stands (null for demote and hold; a hold is never accepted). */
export type AcceptBlocker = "above_file_level" | "no_standing_approval";

export type AutonomyProposalView = AutonomyProposal & {
  /** The routine file's level: the maximum any accepted level can reach. */
  fileLevel: AutonomyLevel;
  /** Set when accepting a promotion would be refused (raise the file's level, or create the approval). Null for demote and hold (a hold is never accepted). */
  acceptBlocker: AcceptBlocker | null;
  /** Set while a person's decline of this same proposal holds. */
  declined: { by: string; at: string; reason: string } | null;
};

/** What stops a person from accepting `proposal` now, or null. */
export function acceptBlockerOf(
  proposal: Pick<AutonomyProposal, "kind" | "proposed" | "routineId">,
  fileLevel: AutonomyLevel,
  hasActiveApproval: boolean,
): AcceptBlocker | null {
  if (proposal.kind !== "promote") {
    return null;
  }
  if (LEVEL_RANK[proposal.proposed] > LEVEL_RANK[fileLevel]) {
    return "above_file_level";
  }
  if (proposal.proposed === "L3" && !hasActiveApproval) {
    return "no_standing_approval";
  }
  return null;
}

const DAY_MS = 86_400_000;

const step = (level: AutonomyLevel, by: 1 | -1): AutonomyLevel =>
  AUTONOMY_LEVELS[Math.min(AUTONOMY_LEVELS.length - 1, Math.max(0, LEVEL_RANK[level] + by))];

/** Pure decision over the evidence of one routine. */
export function decideAutonomy(
  routineId: string,
  current: AutonomyLevel,
  evidence: AutonomyEvidence,
  policy: AutonomyPolicy = DEFAULT_AUTONOMY_POLICY,
): AutonomyProposal {
  const out = (
    kind: AutonomyProposal["kind"],
    proposed: AutonomyLevel,
    reason: AutonomyProposal["reason"],
  ): AutonomyProposal => ({
    routineId,
    current,
    kind,
    proposed,
    reason,
    needsStandingApproval: kind === "promote" && proposed === "L3",
    evidence,
  });
  const rate = evidence.correctionRate;
  // Demotion first: a routine that people keep correcting loses autonomy even if it could rise.
  if (
    current !== "L0" &&
    rate !== null &&
    evidence.workItems >= policy.minItemsToDemote &&
    rate >= policy.demoteAtOrAbove
  ) {
    return out("demote", step(current, -1), "high_correction_rate");
  }
  if (evidence.workItems < policy.minItemsToPromote || rate === null) {
    return out("hold", current, "insufficient_evidence");
  }
  if (evidence.failedRuns > 0) {
    return out("hold", current, "failed_runs");
  }
  if (rate > policy.promoteAtOrBelow) {
    return out("hold", current, "within_band");
  }
  if (current === "L3") {
    return out("hold", current, "at_top");
  }
  return out("promote", step(current, 1), "low_correction_rate");
}

/** The decline that still holds for this proposal: same routine, level and change, in the window. */
function holdingDecline(
  proposal: AutonomyProposal,
  declines: AutonomyDecline[],
  now: Date,
  policy: AutonomyPolicy,
): AutonomyDecline | undefined {
  if (proposal.kind === "hold") {
    return undefined;
  }
  const since = now.getTime() - policy.windowDays * DAY_MS;
  return declines.find(
    (d) =>
      d.routineId === proposal.routineId &&
      d.kind === proposal.kind &&
      d.from === proposal.current &&
      d.proposed === proposal.proposed &&
      Date.parse(d.declinedAt) >= since,
  );
}

/** Proposals for every configured routine of a project, over the policy window ending `now`. */
export function autonomyProposals(
  projectId: string,
  routines: Routine[],
  opts: { now?: Date; home?: string; policy?: AutonomyPolicy } = {},
): AutonomyProposalView[] {
  const policy = opts.policy ?? DEFAULT_AUTONOMY_POLICY;
  const to = opts.now ?? new Date();
  const from = new Date(to.getTime() - policy.windowDays * DAY_MS);
  const declines = readAutonomyDeclines(projectId, opts.home);
  const inRange = (r: RunSummary) => {
    const at = Date.parse(r.startedAt);
    return at >= from.getTime() && at <= to.getTime();
  };
  const runs = readRunSummaries(projectId, opts.home).filter(inRange);
  const corrections = autopilotCorrections(projectId, { home: opts.home, since: from, until: to });
  const approvals = readApprovals(projectId, opts.home);
  const files = new Map(routines.map((r) => [r.id, r.level]));
  return routines
    .map((routine) => {
      const own = runs.filter((r) => r.routineId === routine.id);
      const c = corrections.get(routine.id) ?? { items: 0, corrected: 0 };
      return decideAutonomy(
        routine.id,
        effectiveLevel(routine.level, routineState(projectId, routine.id, opts.home).override),
        {
          from: from.toISOString(),
          to: to.toISOString(),
          runs: own.length,
          failedRuns: own.filter((r) => r.status === "failed").length,
          workItems: c.items,
          corrected: c.corrected,
          correctionRate: c.items > 0 ? c.corrected / c.items : null,
          escalated: own.reduce((n, r) => n + r.counts.escalated, 0),
        },
        policy,
      );
    })
    .map((proposal) => {
      const d = holdingDecline(proposal, declines, to, policy);
      const fileLevel = files.get(proposal.routineId) ?? proposal.current;
      const active = approvals.some(
        (a) => a.routineId === proposal.routineId && approvalState(a, to) === "active",
      );
      return {
        ...proposal,
        fileLevel,
        acceptBlocker: acceptBlockerOf(proposal, fileLevel, active),
        declined: d ? { by: d.declinedBy, at: d.declinedAt, reason: d.reason } : null,
      };
    })
    .toSorted((a, b) => a.routineId.localeCompare(b.routineId));
}

export type DeclineAutonomyInput = {
  routineId: string;
  kind: "promote" | "demote";
  proposed: AutonomyLevel;
  reason: string;
};

/**
 * A person declines the routine's current proposal. The proposal is recomputed first and must
 * still be the one the person saw (kind and proposed level), so a stale screen cannot decline a
 * different change. Nothing about the routine changes; the decision is recorded and audited.
 */
export function declineAutonomyProposal(
  project: Pick<Project, "id" | "folder" | "templateId" | "archived">,
  input: DeclineAutonomyInput,
  actor: ApprovalActor,
  opts: { now?: Date; home?: string; policy?: AutonomyPolicy } = {},
): AutonomyProposalView {
  if (actor.kind !== "person") {
    throw new AutopilotRefused("not_a_person", "only a person may decline an autonomy proposal");
  }
  if (project.archived) {
    throw new AutopilotRefused("archived", "project is archived");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 4) {
    throw new AutopilotRefused("reason_required", "a written reason is required");
  }
  const set = loadRoutines(project, opts.home);
  if (set.error) {
    throw new AutopilotRefused("routines_invalid", `the routines file is invalid: ${set.error}`);
  }
  const routine = set.routines.find((r) => r.id === input.routineId);
  if (!routine) {
    throw new AutopilotRefused("routine_not_found", "routine not found");
  }
  const now = opts.now ?? new Date();
  const current = autonomyProposals(project.id, [routine], { ...opts, now })[0];
  if (current.kind === "hold") {
    throw new AutopilotRefused("nothing_to_decline", "there is no proposal to decline");
  }
  if (current.kind !== input.kind || current.proposed !== input.proposed) {
    throw new AutopilotRefused(
      "proposal_changed",
      "the proposal is no longer the one shown; reload it before deciding",
      { kind: current.kind, proposed: current.proposed },
    );
  }
  const decline: AutonomyDecline = {
    routineId: routine.id,
    kind: current.kind,
    from: current.current,
    proposed: current.proposed,
    reason: reason.slice(0, 1000),
    declinedBy: actor.id,
    declinedAt: now.toISOString(),
  };
  mutateAutonomyDeclines(
    project.id,
    (all) => {
      // One decision per routine: the newest replaces the previous one.
      const i = all.findIndex((d) => d.routineId === routine.id);
      if (i >= 0) {
        all.splice(i, 1);
      }
      all.push(decline);
    },
    opts.home,
  );
  void auditSafe({
    identity: actor.id,
    scope: project.id,
    action: "autopilot.autonomy.decline",
    outcome: "ok",
    source: "gateway.autopilot",
    detail: {
      routineId: routine.id,
      kind: decline.kind,
      from: decline.from,
      proposed: decline.proposed,
      correctionRate: current.evidence.correctionRate,
      workItems: current.evidence.workItems,
    },
  });
  return {
    ...current,
    declined: { by: decline.declinedBy, at: decline.declinedAt, reason: decline.reason },
  };
}
