// Autopilot gateway methods (all editions). Reads are observe. autopilot.run is attach
// (operator.write): an operator may trigger a routine by hand; it runs exactly as a scheduled
// run does. autopilot.pause / resume are attach and person-only. autopilot.approvals.create /
// revoke, autopilot.autonomy.accept / decline and autopilot.reportError are approval methods
// (operator.approvals, voice refused) and person-only: agent tool
// connections, cron sessions (they reach the gateway as backend clients) and calls without a
// connection are refused before anything is read. autopilot.stopAll / startAll (the global kill
// switch, control.ts) are approval methods too: person-only, operator.approvals, voice refused,
// a written reason. autopilot.routines.sync rewrites cron jobs and stays admin. Every change
// emits `autopilot.changed`. autopilot.brief.get is observe and person-only: a person reads
// their own brief, built from items they can already read.
import type { Project } from "../../projects/types.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { listActionDefs, getActionDef } from "../../autopilot/actions.js";
import {
  createStandingApproval,
  listStandingApprovals,
  revokeStandingApproval,
} from "../../autopilot/approvals.js";
import {
  acceptAutonomyProposal,
  reportAutopilotError,
  routineLevel,
} from "../../autopilot/autonomy-level.js";
import { buildBrief } from "../../autopilot/brief.js";
import {
  globalStopRefusal,
  readGlobalControl,
  STOP_ALL_PAUSED_BY,
  startAllRoutines,
  stopAllRoutines,
} from "../../autopilot/control.js";
import { syncRoutineJobs } from "../../autopilot/cron.js";
import {
  autonomyProposals,
  declineAutonomyProposal,
  DEFAULT_AUTONOMY_POLICY,
} from "../../autopilot/earned-autonomy.js";
import { runEvidenceDir } from "../../autopilot/evidence.js";
import { gatewayRunnerDeps } from "../../autopilot/gateway-deps.js";
import { loadRoutines } from "../../autopilot/routines.js";
import { dayKey, routineTimezone, runRoutine } from "../../autopilot/runner.js";
import { autopilotStats } from "../../autopilot/stats.js";
import {
  readRun,
  readRunSummaries,
  routineState,
  summaryOf,
  updateRoutineState,
} from "../../autopilot/store.js";
import { getTriggerDispatcher, triggerHealthView } from "../../autopilot/triggers/dispatcher.js";
import {
  AutopilotRefused,
  departmentOf,
  EDITION_AREAS,
  ITEM_FLAGS,
  type Routine,
} from "../../autopilot/types.js";
import { watchdogView } from "../../autopilot/watchdog.js";
import { verifyEvidenceBundle } from "../../evidence/verify.js";
import { SSO_PERSON_DECISIONS } from "../../identity/connect.js";
import { getProject } from "../../projects/store.js";
import { autopilotValidators, type AutopilotMethod } from "../protocol/autopilot-validators.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { actorFor, nonPersonOrigin } from "./workitems-shared.js";

export const AUTOPILOT_EVENT = "autopilot.changed";

export const AUTOPILOT_READ_METHODS = [
  "autopilot.routines.list",
  "autopilot.runs.list",
  "autopilot.runs.get",
  "autopilot.approvals.list",
  "autopilot.stats",
  "autopilot.autonomy.proposals",
  "autopilot.brief.get",
] as const;
/** operator.write (attach). pause / resume additionally refuse non-person origins. */
export const AUTOPILOT_WRITE_METHODS = [
  "autopilot.run",
  "autopilot.pause",
  "autopilot.resume",
] as const;
/** operator.approvals; person-only. */
export const AUTOPILOT_APPROVAL_METHODS = [
  "autopilot.approvals.create",
  "autopilot.approvals.revoke",
  "autopilot.autonomy.accept",
  "autopilot.autonomy.decline",
  "autopilot.reportError",
  "autopilot.stopAll",
  "autopilot.startAll",
] as const;
/** Admin (default scope): rewrites the routine's cron jobs. */
export const AUTOPILOT_ADMIN_METHODS = ["autopilot.routines.sync"] as const;

const RUNS_DEFAULT = 50;

function refuse(
  respond: RespondFn,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, message, { details: { code, ...details } }),
  );
}

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof AutopilotRefused) {
    refuse(respond, err.code, err.message, err.details);
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
  );
}

function valid(method: AutopilotMethod, params: unknown, respond: RespondFn): boolean {
  const validate = autopilotValidators[method];
  if (validate(params)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
  return false;
}

function projectOf(id: unknown): Project {
  const project = typeof id === "string" ? getProject(id) : null;
  if (!project) {
    throw new AutopilotRefused("project_not_found", "project not found");
  }
  return project;
}

/** Person-only gate shared by pause / resume / approvals; refusals are audited. */
function personGate(
  method: string,
  client: GatewayClient | null | undefined,
  params: Record<string, unknown> | undefined,
  respond: RespondFn,
): boolean {
  const origin = nonPersonOrigin(client, { decision: SSO_PERSON_DECISIONS.has(method) });
  if (!origin) {
    return true;
  }
  void auditSafe({
    identity: actorOf(client),
    scope: typeof params?.projectId === "string" ? params.projectId : null,
    action: method,
    outcome: "denied",
    source: "gateway.autopilot",
    detail: { routineId: params?.routineId, id: params?.id, reason: origin },
  });
  refuse(respond, "not_a_person", `only a person may call ${method} (${origin})`);
  return false;
}

function emit(
  context: GatewayRequestContext | undefined,
  payload: { projectId: string; routineId: string | null; kind: string; runId?: string },
) {
  context?.broadcast?.(
    AUTOPILOT_EVENT,
    { ...payload, at: new Date().toISOString() },
    { dropIfSlow: true },
  );
}

/** The console view of a routine (no prompt text, no gather args). */
export function routineView(project: Project, r: Routine) {
  const s = routineState(project.id, r.id);
  return {
    id: r.id,
    edition: r.edition,
    area: r.area,
    department: departmentOf(r),
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger,
    agentId: r.agentId,
    gather: r.gather.map((g) => ({
      id: g.id,
      tool: g.tool,
      ...(g.each ? { each: g.each } : {}),
      ...(g.gate ? { gate: true } : {}),
    })),
    reasoning: {
      promptId: r.reasoning.promptId,
      schemaId: r.reasoning.schemaId,
      backend: r.reasoning.backend,
      model: r.reasoning.model,
      timeoutSeconds: r.reasoning.timeoutSeconds,
    },
    actions: r.actions.map((id) => {
      const def = getActionDef(id);
      return { id, class: def?.class ?? "never", label: def?.label ?? { en: id } };
    }),
    level: r.level,
    /** What actions are authorized against: min(file level, override). */
    effectiveLevel: routineLevel(r, s),
    override: s.override,
    lastDemotion: s.lastDemotion,
    limits: r.limits,
    requireCitations: r.requireCitations,
    baselineMinutes: r.baselineMinutes,
    queue: r.queue,
    knowledge: r.knowledge,
    state: {
      paused: s.paused,
      pausedBy: s.pausedBy,
      pausedAt: s.pausedAt,
      pauseReason: s.pauseReason,
      cronJobId: s.cronJobId,
      lastRunId: s.lastRunId,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      actionsToday: s.days[dayKey(new Date(), routineTimezone(r))]?.actions ?? 0,
      watchdog: watchdogView(r, s.watchdog),
      triggers: triggerHealthView(project.id, r, triggerBlocked(project, r, s)),
    },
  };
}

/** Why the routine's event triggers cannot start a run now (shown as `disabled`), or null. */
function triggerBlocked(
  project: Project,
  r: Routine,
  s: { paused: boolean; pausedBy: string | null },
): string | null {
  const stop = globalStopRefusal();
  if (stop) {
    return stop.code;
  }
  if (project.archived) {
    return "archived";
  }
  if (!r.enabled) {
    return "routine_disabled";
  }
  return s.paused ? `paused_by_${s.pausedBy ?? "person"}` : null;
}

function findRoutine(project: Project, routineId: string): Routine {
  const set = loadRoutines(project);
  if (set.error) {
    throw new AutopilotRefused("routines_invalid", `the routines file is invalid: ${set.error}`);
  }
  const r = set.routines.find((x) => x.id === routineId);
  if (!r) {
    throw new AutopilotRefused("routine_not_found", "routine not found");
  }
  return r;
}

async function resync(context: GatewayRequestContext | undefined, project: Project) {
  // Event triggers follow the same routine states as the cron jobs.
  getTriggerDispatcher()?.refresh();
  if (context?.cron) {
    await syncRoutineJobs(context.cron, project);
  }
}

type P = Record<string, unknown> & { projectId: string };

export const autopilotHandlers: GatewayRequestHandlers = {
  "autopilot.routines.list": ({ params, respond }) => {
    if (!valid("autopilot.routines.list", params, respond)) {
      return;
    }
    try {
      const project = projectOf((params as P).projectId);
      const set = loadRoutines(project);
      respond(true, {
        routines: set.routines.map((r) => routineView(project, r)),
        source: set.source,
        digest: set.digest,
        error: set.error,
        catalogue: listActionDefs().map((d) => ({
          id: d.id,
          class: d.class,
          editions: [...d.editions],
          label: d.label,
          executor: d.executor,
          tools: [...d.tools],
          source: d.source,
        })),
        editions: Object.fromEntries(Object.entries(EDITION_AREAS).map(([k, v]) => [k, [...v]])),
        flags: [...ITEM_FLAGS],
        control: readGlobalControl(),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.routines.sync": async ({ params, respond, client, context }) => {
    if (!valid("autopilot.routines.sync", params, respond)) {
      return;
    }
    try {
      const project = projectOf((params as P).projectId);
      if (!context?.cron) {
        throw new AutopilotRefused("cron_unavailable", "the cron service is not running");
      }
      const result = await syncRoutineJobs(context.cron, project);
      getTriggerDispatcher()?.refresh();
      void auditSafe({
        identity: actorOf(client),
        scope: project.id,
        action: "autopilot.routines.sync",
        outcome: "ok",
        source: "gateway.autopilot",
        detail: result,
      });
      emit(context, { projectId: project.id, routineId: null, kind: "sync" });
      respond(true, result);
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.runs.list": ({ params, respond }) => {
    if (!valid("autopilot.runs.list", params, respond)) {
      return;
    }
    const p = params as P & {
      routineId?: string;
      edition?: string;
      area?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    };
    try {
      const project = projectOf(p.projectId);
      const all = readRunSummaries(project.id)
        .filter(
          (r) =>
            (!p.routineId || r.routineId === p.routineId) &&
            (!p.edition || r.edition === p.edition) &&
            (!p.area || r.area === p.area) &&
            (!p.status || r.status === p.status),
        )
        .toReversed();
      const offset = p.cursor && /^\d{1,7}$/.test(p.cursor) ? Number(p.cursor) : 0;
      const limit = p.limit ?? RUNS_DEFAULT;
      const runs = all.slice(offset, offset + limit);
      respond(true, {
        runs,
        total: all.length,
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.runs.get": async ({ params, respond }) => {
    if (!valid("autopilot.runs.get", params, respond)) {
      return;
    }
    const p = params as P & { id: string };
    try {
      const project = projectOf(p.projectId);
      const run = readRun(project.id, p.id);
      if (!run) {
        throw new AutopilotRefused("run_not_found", "run not found");
      }
      const v = await verifyEvidenceBundle(runEvidenceDir(project.id, run.id));
      const rootOk = v.manifest?.events.root === run.evidence?.root;
      respond(true, {
        run,
        evidence: {
          ok: v.ok && rootOk,
          problems: rootOk ? v.problems : [...v.problems, "root does not match the run record"],
        },
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.run": async ({ params, respond, client, context }) => {
    if (!valid("autopilot.run", params, respond)) {
      return;
    }
    const p = params as P & { routineId: string };
    try {
      const project = projectOf(p.projectId);
      const by = nonPersonOrigin(client) ? `agent:${actorOf(client)}` : actorOf(client);
      const run = await runRoutine(gatewayRunnerDeps(), project, p.routineId, {
        kind: "manual",
        by,
      });
      void auditSafe({
        identity: actorOf(client),
        scope: project.id,
        action: "autopilot.run",
        outcome: "ok",
        source: "gateway.autopilot",
        detail: { routineId: p.routineId, runId: run.id, status: run.status, counts: run.counts },
      });
      emit(context, { projectId: project.id, routineId: p.routineId, kind: "run", runId: run.id });
      if (run.watchdog?.tripped) {
        await resync(context, project);
        emit(context, {
          projectId: project.id,
          routineId: p.routineId,
          kind: "watchdog",
          runId: run.id,
        });
        // A trip also lowered the routine's level one step.
        emit(context, {
          projectId: project.id,
          routineId: p.routineId,
          kind: "autonomy",
          runId: run.id,
        });
      }
      respond(true, { run: summaryOf(run) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.pause": async ({ params, respond, client, context }) => {
    if (!personGate("autopilot.pause", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.pause", params, respond)) {
      return;
    }
    const p = params as P & { routineId: string; reason: string };
    try {
      const project = projectOf(p.projectId);
      const routine = findRoutine(project, p.routineId);
      const by = actorOf(client);
      if (!p.reason.trim()) {
        throw new AutopilotRefused("reason_required", "pausing a routine needs a written reason");
      }
      // Re-pausing would overwrite who paused it and lift the watchdog/stopAll resume rules.
      const before = routineState(project.id, routine.id);
      if (before.paused) {
        throw new AutopilotRefused(
          "already_paused",
          `the routine is already paused by ${before.pausedBy}`,
          {
            pausedBy: before.pausedBy,
          },
        );
      }
      updateRoutineState(project.id, routine.id, (cur) => ({
        ...cur,
        paused: true,
        pausedBy: by,
        pausedAt: new Date().toISOString(),
        pauseReason: p.reason.trim().slice(0, 1000),
      }));
      await resync(context, project);
      void auditSafe({
        identity: by,
        scope: project.id,
        action: "autopilot.pause",
        outcome: "ok",
        source: "gateway.autopilot",
        detail: { routineId: routine.id },
      });
      emit(context, { projectId: project.id, routineId: routine.id, kind: "paused" });
      respond(true, { routine: routineView(project, routine) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.resume": async ({ params, respond, client, context }) => {
    if (!personGate("autopilot.resume", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.resume", params, respond)) {
      return;
    }
    const p = params as P & { routineId: string; reason?: string };
    try {
      const project = projectOf(p.projectId);
      const routine = findRoutine(project, p.routineId);
      const before = routineState(project.id, routine.id);
      const reason = p.reason?.trim() ?? "";
      // Resuming a running routine would audit and announce a resume that never happened.
      if (!before.paused) {
        throw new AutopilotRefused("not_paused", "the routine is not paused");
      }
      // No routine is resumed while a global stop holds, whoever paused it; only startAll
      // (or removing the STOP file) lifts it.
      const stop = globalStopRefusal();
      if (stop) {
        throw new AutopilotRefused(
          stop.code,
          stop.code === "stopped_all"
            ? "every routine is stopped; autopilot.startAll lifts the global stop"
            : stop.reason,
        );
      }
      // A watchdog or stopAll pause is lifted only by a person who says why.
      if (
        (before.pausedBy === "watchdog" || before.pausedBy === STOP_ALL_PAUSED_BY) &&
        reason.length < 4
      ) {
        throw new AutopilotRefused(
          "reason_required",
          `the routine was paused by ${before.pausedBy}; resuming it needs a written reason`,
        );
      }
      updateRoutineState(project.id, routine.id, (cur) => ({
        ...cur,
        paused: false,
        pausedBy: null,
        pausedAt: null,
        pauseReason: null,
      }));
      await resync(context, project);
      void auditSafe({
        identity: actorOf(client),
        scope: project.id,
        action: "autopilot.resume",
        outcome: "ok",
        source: "gateway.autopilot",
        detail: {
          routineId: routine.id,
          pausedBy: before.pausedBy,
          ...(reason ? { reason: reason.slice(0, 1000) } : {}),
        },
      });
      emit(context, { projectId: project.id, routineId: routine.id, kind: "resumed" });
      respond(true, { routine: routineView(project, routine) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.approvals.create": ({ params, respond, client, context }) => {
    if (!personGate("autopilot.approvals.create", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.approvals.create", params, respond)) {
      return;
    }
    const p = params as P & {
      routineId: string;
      action: string;
      scope: Record<string, unknown>;
      reason: string;
      expiresAt: string;
    };
    try {
      const project = projectOf(p.projectId);
      const approval = createStandingApproval(
        project,
        {
          routineId: p.routineId,
          action: p.action,
          scope: p.scope,
          reason: p.reason,
          expiresAt: p.expiresAt,
        },
        { id: actorOf(client), kind: "person" },
      );
      emit(context, { projectId: project.id, routineId: approval.routineId, kind: "approval" });
      respond(true, { approval: { ...approval, state: "active" } });
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "autopilot.approval.create",
        outcome: "denied",
        source: "gateway.autopilot",
        detail: {
          routineId: p.routineId,
          action: p.action,
          code: err instanceof AutopilotRefused ? err.code : "error",
        },
      });
      fail(respond, err);
    }
  },

  "autopilot.approvals.list": ({ params, respond }) => {
    if (!valid("autopilot.approvals.list", params, respond)) {
      return;
    }
    const p = params as P & { routineId?: string; includeInactive?: boolean };
    try {
      const project = projectOf(p.projectId);
      respond(true, {
        approvals: listStandingApprovals(project.id, {
          routineId: p.routineId,
          includeInactive: p.includeInactive === true,
        }),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.approvals.revoke": ({ params, respond, client, context }) => {
    if (!personGate("autopilot.approvals.revoke", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.approvals.revoke", params, respond)) {
      return;
    }
    const p = params as P & { id: string; reason: string };
    try {
      const project = projectOf(p.projectId);
      const approval = revokeStandingApproval(project, p.id, p.reason, {
        id: actorOf(client),
        kind: "person",
      });
      emit(context, { projectId: project.id, routineId: approval.routineId, kind: "approval" });
      respond(true, { approval: { ...approval, state: "revoked" } });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.stats": ({ params, respond }) => {
    if (!valid("autopilot.stats", params, respond)) {
      return;
    }
    const p = params as P & { from?: string; to?: string };
    try {
      const project = projectOf(p.projectId);
      const date = (v: string | undefined, name: string) => {
        if (v === undefined) {
          return undefined;
        }
        const t = Date.parse(v);
        if (!Number.isFinite(t)) {
          throw new AutopilotRefused("invalid_range", `${name} must be an ISO time`);
        }
        return new Date(t);
      };
      const routines = loadRoutines(project).routines;
      const stats = autopilotStats(project.id, routines, {
        from: date(p.from, "from"),
        to: date(p.to, "to"),
      });
      const known = new Map(routines.map((r) => [r.id, r]));
      respond(true, {
        ...stats,
        routines: stats.routines.map((row) => {
          const def = known.get(row.routineId);
          return {
            ...row,
            watchdog: def ? watchdogView(def, routineState(project.id, def.id).watchdog) : null,
          };
        }),
        control: readGlobalControl(),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Proposals only: nothing here changes a level; a person decides. */
  "autopilot.autonomy.proposals": ({ params, respond }) => {
    if (!valid("autopilot.autonomy.proposals", params, respond)) {
      return;
    }
    try {
      const project = projectOf((params as P).projectId);
      const routines = loadRoutines(project).routines;
      respond(true, {
        policy: DEFAULT_AUTONOMY_POLICY,
        proposals: autonomyProposals(project.id, routines),
      });
    } catch (err) {
      fail(respond, err);
    }
  },
  /**
   * A person accepts a proposal: recomputed and matched, never above the routine file's level,
   * L3 only with an active standing approval. Recorded with evidence and audited.
   */
  "autopilot.autonomy.accept": ({ params, respond, client, context }) => {
    if (!personGate("autopilot.autonomy.accept", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.autonomy.accept", params, respond)) {
      return;
    }
    const p = params as P & {
      routineId: string;
      kind: "promote" | "demote";
      proposed: Routine["level"];
      reason: string;
    };
    try {
      const project = projectOf(p.projectId);
      const out = acceptAutonomyProposal(
        project,
        { routineId: p.routineId, kind: p.kind, proposed: p.proposed, reason: p.reason },
        { id: actorOf(client), kind: "person" },
      );
      emit(context, { projectId: project.id, routineId: p.routineId, kind: "autonomy" });
      respond(true, {
        proposal: out.proposal,
        change: out.change,
        routine: routineView(project, findRoutine(project, p.routineId)),
      });
    } catch (err) {
      fail(respond, err);
    }
  },
  /**
   * A person reports an autopilot-created work item as a serious error: the routine that made
   * it drops one level now. Only on items the person can read; one report per item.
   */
  "autopilot.reportError": ({ params, respond, client, context }) => {
    if (!personGate("autopilot.reportError", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.reportError", params, respond)) {
      return;
    }
    const p = params as P & { itemId: string; reason: string };
    try {
      const project = projectOf(p.projectId);
      const out = reportAutopilotError(
        project,
        { itemId: p.itemId, reason: p.reason },
        actorFor(client),
      );
      emit(context, {
        projectId: project.id,
        routineId: out.routineId,
        kind: "autonomy",
        ...(out.change.runId ? { runId: out.change.runId } : {}),
      });
      respond(true, {
        change: out.change,
        routine: routineView(project, findRoutine(project, out.routineId)),
      });
    } catch (err) {
      fail(respond, err);
    }
  },
  /** The caller's own morning brief (observe; only items the caller can already read). */
  "autopilot.brief.get": ({ params, respond, client }) => {
    if (!personGate("autopilot.brief.get", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.brief.get", params, respond)) {
      return;
    }
    const p = params as P & { from?: string; to?: string };
    try {
      const project = projectOf(p.projectId);
      const date = (v: string | undefined, name: string) => {
        if (v === undefined) {
          return undefined;
        }
        const t = Date.parse(v);
        if (!Number.isFinite(t)) {
          throw new AutopilotRefused("invalid_range", `${name} must be an ISO time`);
        }
        return new Date(t);
      };
      const from = date(p.from, "from");
      const to = date(p.to, "to");
      if (from && to && from.getTime() > to.getTime()) {
        throw new AutopilotRefused("invalid_range", "from must not be after to");
      }
      const scopes = client?.connect?.scopes ?? [];
      respond(true, {
        brief: buildBrief(project, actorFor(client), {
          from,
          to,
          mayAcceptProposals:
            scopes.includes("operator.approvals") || scopes.includes("operator.admin"),
        }),
      });
    } catch (err) {
      fail(respond, err);
    }
  },
  /** A person declines a proposal: recorded and audited, the routine's level never changes. */
  "autopilot.autonomy.decline": ({ params, respond, client, context }) => {
    if (!personGate("autopilot.autonomy.decline", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.autonomy.decline", params, respond)) {
      return;
    }
    const p = params as P & {
      routineId: string;
      kind: "promote" | "demote";
      proposed: Routine["level"];
      reason: string;
    };
    try {
      const project = projectOf(p.projectId);
      const proposal = declineAutonomyProposal(
        project,
        { routineId: p.routineId, kind: p.kind, proposed: p.proposed, reason: p.reason },
        { id: actorOf(client), kind: "person" },
      );
      emit(context, { projectId: project.id, routineId: proposal.routineId, kind: "autonomy" });
      respond(true, { proposal });
    } catch (err) {
      fail(respond, err);
    }
  },
  "autopilot.stopAll": async ({ params, respond, client, context }) => {
    if (!personGate("autopilot.stopAll", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.stopAll", params, respond)) {
      return;
    }
    const p = params as { reason: string };
    try {
      const by = actorOf(client);
      const result = stopAllRoutines(by, p.reason.trim().slice(0, 1000));
      for (const change of result.paused) {
        const project = getProject(change.projectId);
        if (project) {
          await resync(context, project).catch(() => {});
        }
        emit(context, { projectId: change.projectId, routineId: null, kind: "stopAll" });
      }
      void auditSafe({
        identity: by,
        scope: null,
        action: "autopilot.stopAll",
        outcome: "ok",
        source: "gateway.autopilot",
        detail: {
          reason: p.reason.trim().slice(0, 1000),
          paused: result.paused.reduce((n, c) => n + c.routineIds.length, 0),
          projects: result.paused.length,
          alreadyStopped: result.alreadyStopped,
        },
      });
      respond(true, {
        control: result.control,
        changed: result.paused,
        alreadyStopped: result.alreadyStopped,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "autopilot.startAll": async ({ params, respond, client, context }) => {
    if (!personGate("autopilot.startAll", client, params, respond)) {
      return;
    }
    if (!valid("autopilot.startAll", params, respond)) {
      return;
    }
    const p = params as { reason: string };
    try {
      const by = actorOf(client);
      const result = startAllRoutines(by, p.reason.trim().slice(0, 1000));
      for (const change of result.resumed) {
        const project = getProject(change.projectId);
        if (project) {
          await resync(context, project).catch(() => {});
        }
        emit(context, { projectId: change.projectId, routineId: null, kind: "startAll" });
      }
      void auditSafe({
        identity: by,
        scope: null,
        action: "autopilot.startAll",
        outcome: "ok",
        source: "gateway.autopilot",
        detail: {
          reason: p.reason.trim().slice(0, 1000),
          resumed: result.resumed.reduce((n, c) => n + c.routineIds.length, 0),
          emergencyStop: result.control.emergencyStop,
          alreadyStarted: result.alreadyStarted,
        },
      });
      respond(true, {
        control: result.control,
        changed: result.resumed,
        alreadyStarted: result.alreadyStarted,
      });
    } catch (err) {
      fail(respond, err);
    }
  },
};
