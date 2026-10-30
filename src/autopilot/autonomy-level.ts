// Earned autonomy, the level side (docs/autopilot.md#earned-autonomy). A routine runs at its
// EFFECTIVE level: min(the routine file's level, the override in routine state). The override
// moves in two ways only:
//
//   up or down by a PERSON   autopilot.autonomy.accept: the earned-autonomy proposal is
//                            recomputed and must still match what the person saw; never above
//                            the file's level; a promotion to L3 also needs an active standing
//                            approval for the routine
//   down by itself           one step (never below L0) when the behaviour watchdog trips, or
//                            when a person reports an autopilot-created work item as a serious
//                            error (autopilot.reportError)
//
// The engine never raises a level. Every change is one line in autonomy-changes.jsonl with its
// own signed evidence bundle, is audited, and is written under the Project lock together with
// the routine's new override, so the record and the state never disagree.

import path from "node:path";
import type { Project } from "../projects/types.js";
import type { Actor } from "../workitems/types.js";
import type { ApprovalActor } from "./approvals.js";
import type { AutonomyPolicy, AutonomyProposalView } from "./earned-autonomy.js";
import type { RoutineState } from "./store.js";
import type { AutonomyChange, AutonomyLevel, DemotionCause, Routine } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { writeSealedBundle } from "../evidence/sealed-bundle.js";
import { canRead } from "../workitems/access.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { readWorkItem } from "../workitems/store.js";
import { autonomyProposals } from "./earned-autonomy.js";
import { loadRoutines } from "./routines.js";
import {
  appendAutonomyChangeLocked,
  autonomyChangeDir,
  autopilotDir,
  newId,
  readApprovals,
  readAutonomyChanges,
  updateRoutineState,
} from "./store.js";
import {
  approvalState,
  AutopilotRefused,
  effectiveLevel,
  LEVEL_RANK,
  levelBelow,
} from "./types.js";
import { autopilotActorId, isAutopilotActor } from "./workitems-adapter.js";

type Opts = { now?: Date; home?: string; env?: NodeJS.ProcessEnv };

const MIN_REASON = 4;

function cleanReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < MIN_REASON) {
    throw new AutopilotRefused("reason_required", "a written reason is required");
  }
  return reason.slice(0, 1000);
}

/** The routine's effective level from its state. */
export function routineLevel(
  routine: Pick<Routine, "level">,
  state: Pick<RoutineState, "override">,
): AutonomyLevel {
  return effectiveLevel(routine.level, state.override);
}

/** Seal one change as its own evidence bundle (ids, levels, who and why; no item content). */
function writeChangeEvidence(change: AutonomyChange, opts: Opts): { bundle: string; root: string } {
  const dir = path.join(autonomyChangeDir(change.projectId, change.id, opts.home), "evidence");
  const { root } = writeSealedBundle(
    dir,
    {
      jobId: `apc-${change.id}`,
      agent: change.kind === "accept" ? change.by : autopilotActorId(change.routineId),
      sessionKey: `autopilot:${change.projectId}:${change.routineId}`,
      kind: `autopilot.autonomy.${change.kind}`,
      status: "ok",
      startedAt: change.at,
      endedAt: change.at,
    },
    [
      {
        type: "job.start",
        ts: change.at,
        data: {
          kind: `autopilot.autonomy.${change.kind}`,
          projectId: change.projectId,
          routineId: change.routineId,
          fileLevel: change.fileLevel,
        },
      },
      {
        type: change.kind === "accept" ? "approval" : "audit",
        ts: change.at,
        data: {
          from: change.from,
          to: change.to,
          by: change.by,
          reason: change.reason,
          cause: change.cause,
          runId: change.runId,
          itemId: change.itemId,
          proposal: change.proposal,
          ...(change.authn ? { authn: change.authn } : {}),
        },
      },
      { type: "job.end", ts: change.at, data: { status: "ok" } },
    ],
    { env: opts.env },
  );
  return { bundle: path.relative(autopilotDir(change.projectId, opts.home), dir), root };
}

/** Seal and append the change. Callers hold the Project lock (inside updateRoutineState). */
function recordLocked(change: AutonomyChange, opts: Opts): AutonomyChange {
  const sealed: AutonomyChange = { ...change, evidence: writeChangeEvidence(change, opts) };
  appendAutonomyChangeLocked(sealed, opts.home);
  return sealed;
}

function auditChange(change: AutonomyChange): void {
  void auditSafe({
    identity: change.kind === "accept" ? change.by : autopilotActorId(change.routineId),
    scope: change.projectId,
    action: change.kind === "accept" ? "autopilot.autonomy.accept" : "autopilot.autonomy.demote",
    outcome: "ok",
    source: "gateway.autopilot",
    detail: {
      changeId: change.id,
      routineId: change.routineId,
      from: change.from,
      to: change.to,
      fileLevel: change.fileLevel,
      cause: change.cause,
      runId: change.runId,
      itemId: change.itemId,
      ...(change.cause === "reported_error" ? { reportedBy: change.by } : {}),
      ...(change.authn ? { authn: change.authn } : {}),
    },
  });
}

export type DemotionInput = {
  cause: DemotionCause;
  /** Who caused it: `watchdog`, or the person who reported the error. */
  by: string;
  reason: string;
  runId: string | null;
  itemId: string | null;
};

/**
 * One step down from the routine's current effective level (L0 stays L0), applied to `cur`
 * while the caller holds the lock: the change is sealed and recorded, and the next state carries
 * the override and the last demotion. Pure apart from that record.
 */
export function demoteLocked(
  projectId: string,
  routine: Pick<Routine, "id" | "level">,
  cur: RoutineState,
  input: DemotionInput,
  opts: Opts & { at: string },
): { next: RoutineState; change: AutonomyChange } {
  const from = routineLevel(routine, cur);
  const to = levelBelow(from);
  const id = newId("c");
  const change = recordLocked(
    {
      id,
      projectId,
      routineId: routine.id,
      kind: "demotion",
      fileLevel: routine.level,
      from,
      to,
      by: input.by,
      at: opts.at,
      reason: input.reason.slice(0, 1000),
      cause: input.cause,
      runId: input.runId,
      itemId: input.itemId,
      proposal: null,
      evidence: null,
    },
    opts,
  );
  return {
    change,
    next: {
      ...cur,
      override: {
        level: to,
        kind: "demoted",
        by: input.by,
        at: opts.at,
        reason: change.reason,
        changeId: id,
      },
      lastDemotion: {
        at: opts.at,
        from,
        to,
        cause: input.cause,
        by: input.by,
        reason: change.reason,
        runId: input.runId,
        itemId: input.itemId,
        changeId: id,
      },
    },
  };
}

/** Audit a demotion applied with demoteLocked (after the lock is released). */
export function auditDemotion(change: AutonomyChange): void {
  auditChange(change);
}

export type AcceptAutonomyInput = {
  routineId: string;
  kind: "promote" | "demote";
  proposed: AutonomyLevel;
  reason: string;
};

/**
 * A person accepts the routine's current earned-autonomy proposal. The proposal is recomputed
 * and must still be the one the person saw. The accepted level becomes the routine's override:
 * never above the routine file's level (that is the maximum, set by an administrator), and a
 * promotion to L3 needs an active standing approval for the routine. Accepting the file's own
 * level clears the override (the routine follows its file again).
 */
export function acceptAutonomyProposal(
  project: Pick<Project, "id" | "folder" | "templateId" | "archived">,
  input: AcceptAutonomyInput,
  actor: ApprovalActor,
  opts: Opts & {
    policy?: AutonomyPolicy;
    /** Step-up evidence for the deciding person (recorded in the sealed change and audit). */
    authn?: Record<string, unknown> | null;
  } = {},
): { proposal: AutonomyProposalView; change: AutonomyChange; effectiveLevel: AutonomyLevel } {
  if (actor.kind !== "person") {
    throw new AutopilotRefused("not_a_person", "only a person may accept an autonomy proposal");
  }
  if (project.archived) {
    throw new AutopilotRefused("archived", "project is archived");
  }
  const reason = cleanReason(input.reason);
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
    throw new AutopilotRefused("nothing_to_accept", "there is no proposal to accept");
  }
  if (current.kind !== input.kind || current.proposed !== input.proposed) {
    throw new AutopilotRefused(
      "proposal_changed",
      "the proposal is no longer the one shown; reload it before deciding",
      { kind: current.kind, proposed: current.proposed },
    );
  }
  if (LEVEL_RANK[current.proposed] > LEVEL_RANK[routine.level]) {
    throw new AutopilotRefused(
      "above_file_level",
      `the routine file allows at most ${routine.level}; an administrator raises it in the file`,
      { fileLevel: routine.level },
    );
  }
  if (current.kind === "promote" && current.proposed === "L3") {
    const active = readApprovals(project.id, opts.home).some(
      (a) => a.routineId === routine.id && approvalState(a, now) === "active",
    );
    if (!active) {
      throw new AutopilotRefused(
        "no_standing_approval",
        "a promotion to L3 needs an active standing approval for the routine",
      );
    }
  }
  const at = now.toISOString();
  const done: { change?: AutonomyChange } = {};
  updateRoutineState(
    project.id,
    routine.id,
    (cur) => {
      // A demotion (or another accept) may have landed since the proposal was computed.
      if (routineLevel(routine, cur) !== current.current) {
        throw new AutopilotRefused(
          "proposal_changed",
          "the routine's level changed; reload the proposal before deciding",
          { kind: current.kind, proposed: current.proposed },
        );
      }
      const id = newId("c");
      done.change = recordLocked(
        {
          id,
          projectId: project.id,
          routineId: routine.id,
          kind: "accept",
          fileLevel: routine.level,
          from: current.current,
          to: current.proposed,
          by: actor.id,
          at,
          reason,
          cause: null,
          runId: null,
          itemId: null,
          proposal: { kind: current.kind as "promote" | "demote", proposed: current.proposed },
          ...(opts.authn ? { authn: opts.authn } : {}),
          evidence: null,
        },
        opts,
      );
      return {
        ...cur,
        override:
          current.proposed === routine.level
            ? null
            : { level: current.proposed, kind: "accepted", by: actor.id, at, reason, changeId: id },
      };
    },
    opts.home,
  );
  const change = done.change!;
  auditChange(change);
  return {
    proposal: autonomyProposals(project.id, [routine], { ...opts, now })[0],
    change,
    effectiveLevel: current.proposed,
  };
}

export type ReportErrorInput = { itemId: string; reason: string };

/**
 * A person marks an autopilot-created work item as a serious error: the routine that created
 * it drops one level now (never below L0). Only a person who may read the item; one report per
 * item. The report is linked to the item and to the run that produced it.
 */
export function reportAutopilotError(
  project: Pick<Project, "id" | "folder" | "templateId" | "archived">,
  input: ReportErrorInput,
  actor: Actor,
  opts: Opts = {},
): { change: AutonomyChange; routineId: string; effectiveLevel: AutonomyLevel } {
  if (actor.kind !== "person") {
    throw new AutopilotRefused("not_a_person", "only a person may report an autopilot error");
  }
  if (project.archived) {
    throw new AutopilotRefused("archived", "project is archived");
  }
  const reason = cleanReason(input.reason);
  const now = opts.now ?? new Date();
  const item = readWorkItem(project.id, input.itemId, opts.home);
  const policy = item ? loadWorkQueuePolicy(project, opts.home) : null;
  // An item the person cannot read answers like a missing one (no existence oracle).
  if (!item || !policy || !canRead(item, actor, policy, now)) {
    throw new AutopilotRefused("item_not_found", "work item not found");
  }
  if (!isAutopilotActor(item.createdBy)) {
    throw new AutopilotRefused("not_autopilot_item", "the work item was not created by a routine");
  }
  const routineId = item.createdBy.slice("autopilot:".length);
  const runField = item.source.fields.autopilotRun;
  const runId = typeof runField === "string" && /^r[a-z0-9]{14}$/.test(runField) ? runField : null;
  const set = loadRoutines(project, opts.home);
  if (set.error) {
    throw new AutopilotRefused("routines_invalid", `the routines file is invalid: ${set.error}`);
  }
  const routine = set.routines.find((r) => r.id === routineId);
  if (!routine) {
    throw new AutopilotRefused("routine_not_found", "the routine is no longer in the file");
  }
  const done: { change?: AutonomyChange } = {};
  updateRoutineState(
    project.id,
    routine.id,
    (cur) => {
      // One report per item (checked under the lock: two clicks never demote twice).
      if (
        readAutonomyChanges(project.id, opts.home).some(
          (c) => c.cause === "reported_error" && c.itemId === item.id,
        )
      ) {
        throw new AutopilotRefused("already_reported", "this work item was already reported");
      }
      const out = demoteLocked(
        project.id,
        routine,
        cur,
        { cause: "reported_error", by: actor.id, reason, runId, itemId: item.id },
        { ...opts, at: now.toISOString() },
      );
      done.change = out.change;
      return out.next;
    },
    opts.home,
  );
  const change = done.change!;
  auditChange(change);
  return { change, routineId: routine.id, effectiveLevel: change.to };
}
