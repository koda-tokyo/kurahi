// Autopilot protocol (all editions): routines, runs, standing approvals, metrics, earned
// autonomy (proposals, accept, decline, demotions) and the morning brief.
// See docs/autopilot.md.
import { Type, type TSchema } from "@sinclair/typebox";
import {
  ACTION_CLASSES,
  AUTONOMY_LEVELS,
  EDITIONS,
  ITEM_FLAGS,
  WORKITEM_TRIGGER_ACTIONS,
} from "../../../autopilot/types.js";
import { NonEmptyString } from "./primitives.js";

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

const ProjectId = Type.String({ pattern: "^p[a-z0-9]{10}$" });
const RoutineId = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,47}$" });
const RunId = Type.String({ pattern: "^r[a-z0-9]{14}$" });
const ApprovalId = Type.String({ pattern: "^s[a-z0-9]{14}$" });
const WorkItemId = Type.String({ pattern: "^w[a-z0-9]{12}$" });
const Text = Type.Object({ ja: Type.Optional(Type.String()), en: Type.Optional(Type.String()) });

export const AutopilotEditionSchema = lit(EDITIONS);
export const AutopilotLevelSchema = lit(AUTONOMY_LEVELS);
export const AutopilotActionClassSchema = lit(ACTION_CLASSES);
const RunStatus = lit(["ok", "escalated", "no_input", "failed", "skipped"] as const);
const Decision = lit(["allow", "needs_person", "refuse"] as const);

export const AutopilotActionDefSchema = Type.Object({
  id: Type.String(),
  class: AutopilotActionClassSchema,
  editions: Type.Array(AutopilotEditionSchema),
  label: Text,
  executor: lit(["tool", "workitem", "proposal", "office", "brief", "none"] as const),
  tools: Type.Array(Type.String()),
  source: Type.String(),
});

const WatchdogMetrics = Type.Object({
  gatherCalls: Type.Number(),
  bytesRead: Type.Number(),
  items: Type.Number(),
  actions: Type.Number(),
  durationMs: Type.Number(),
});

/** Behaviour watchdog state of a routine (baseline, thresholds, last trip). */
export const AutopilotWatchdogSchema = Type.Object({
  /** What runs are compared with: the routine's own baseline (>= 5 runs) or static caps. */
  baseline: lit(["baseline", "static"] as const),
  /** Normal runs in the baseline. */
  runs: Type.Integer(),
  /** A run above any of these is not executed and pauses the routine. */
  thresholds: WatchdogMetrics,
  p95: Nullable(WatchdogMetrics),
  lastTrip: Nullable(
    Type.Object({ at: Type.String(), runId: Type.String(), reasons: Type.Array(Type.String()) }),
  ),
  trips: Type.Integer(),
  toolUseStreak: Type.Integer(),
});

/** The global kill switch (autopilot.stopAll / startAll, and the STOP file). */
export const AutopilotGlobalControlSchema = Type.Object({
  stopped: Type.Boolean(),
  by: Nullable(Type.String()),
  at: Nullable(Type.String()),
  reason: Nullable(Type.String()),
  /** `<KOLO_HOME>/autopilot/STOP` exists: no routine runs, whatever `stopped` says. */
  emergencyStop: Type.Boolean(),
});

/** A level below the routine file's level: a person's accept, or an automatic demotion. */
export const AutopilotLevelOverrideSchema = Type.Object({
  level: AutopilotLevelSchema,
  kind: lit(["accepted", "demoted"] as const),
  by: Type.String(),
  at: Type.String(),
  reason: Type.String(),
  changeId: Type.String(),
});

const DemotionCause = lit(["watchdog", "reported_error"] as const);

/** The last automatic one-step demotion (watchdog trip or a reported serious error). */
export const AutopilotDemotionSchema = Type.Object({
  at: Type.String(),
  from: AutopilotLevelSchema,
  to: AutopilotLevelSchema,
  cause: DemotionCause,
  /** `watchdog`, or the person who reported the error. */
  by: Type.String(),
  reason: Type.String(),
  runId: Nullable(Type.String()),
  itemId: Nullable(Type.String()),
  changeId: Type.String(),
});

/** One recorded level change, with its own signed evidence bundle. */
export const AutopilotAutonomyChangeSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  routineId: Type.String(),
  kind: lit(["accept", "demotion"] as const),
  fileLevel: AutopilotLevelSchema,
  from: AutopilotLevelSchema,
  to: AutopilotLevelSchema,
  by: Type.String(),
  at: Type.String(),
  reason: Type.String(),
  cause: Nullable(DemotionCause),
  runId: Nullable(Type.String()),
  itemId: Nullable(Type.String()),
  proposal: Nullable(
    Type.Object({ kind: lit(["promote", "demote"] as const), proposed: AutopilotLevelSchema }),
  ),
  evidence: Nullable(Type.Object({ bundle: Type.String(), root: Type.String() })),
});

/** One event source of a routine (docs/autopilot.md#triggers). */
export const AutopilotEventSourceSchema = Type.Union([
  Type.Object({ source: Type.Literal("m365.mail"), folder: Type.String() }),
  Type.Object({
    source: Type.Literal("workitems"),
    queue: Nullable(Type.String()),
    actions: Type.Array(lit(WORKITEM_TRIGGER_ACTIONS)),
  }),
  Type.Object({ source: Type.Literal("deadline"), withinHours: Type.Integer() }),
  Type.Object({ source: Type.Literal("files"), folder: Type.String() }),
]);

export const AutopilotEventTriggerSchema = Type.Object({
  sources: Type.Array(AutopilotEventSourceSchema),
  debounceSeconds: Type.Integer(),
  maxRunsPerHour: Type.Integer(),
});

/** Health of one event source: `degraded` = the watcher has a problem (lastError), retried. */
export const AutopilotTriggerHealthSchema = Type.Object({
  /** `m365.mail:<folder>`, `workitems:<queue|*>`, `deadline:<n>h`, `files:<folder>`. */
  source: Type.String(),
  status: lit(["active", "degraded", "disabled"] as const),
  lastSignalAt: Nullable(Type.String()),
  /** Safe code only (`reauth_required`, `rate_limited`, `folder_missing`, `paused_by_…` …). */
  lastError: Nullable(Type.String()),
});

export const AutopilotRoutineStateSchema = Type.Object({
  paused: Type.Boolean(),
  pausedBy: Nullable(Type.String()),
  pausedAt: Nullable(Type.String()),
  pauseReason: Nullable(Type.String()),
  cronJobId: Nullable(Type.String()),
  lastRunId: Nullable(Type.String()),
  lastRunAt: Nullable(Type.String()),
  lastStatus: Nullable(Type.String()),
  actionsToday: Type.Integer(),
  watchdog: AutopilotWatchdogSchema,
  /** One entry per event source of the routine (empty for schedule-only routines). */
  triggers: Type.Array(AutopilotTriggerHealthSchema),
});

export const AutopilotRoutineSchema = Type.Object({
  id: Type.String(),
  edition: AutopilotEditionSchema,
  area: Type.String(),
  /** Business routines: the department id (= area); null in the other editions. */
  department: Nullable(Type.String()),
  name: Text,
  enabled: Type.Boolean(),
  /** Time trigger (schedule / interval; `event` = events only, no cron job) plus event sources. */
  trigger: Type.Union([
    Type.Object({
      kind: Type.Literal("schedule"),
      expr: Type.String(),
      tz: Type.String(),
      events: Type.Optional(AutopilotEventTriggerSchema),
    }),
    Type.Object({
      kind: Type.Literal("interval"),
      minutes: Type.Integer(),
      events: Type.Optional(AutopilotEventTriggerSchema),
    }),
    Type.Object({
      kind: Type.Literal("event"),
      tz: Type.String(),
      events: Type.Optional(AutopilotEventTriggerSchema),
    }),
  ]),
  agentId: Nullable(Type.String()),
  gather: Type.Array(
    Type.Object({
      id: Type.String(),
      tool: Type.String(),
      each: Type.Optional(
        Type.Object({
          from: Type.String(),
          match: Type.String(),
          arg: Type.String(),
          max: Type.Integer(),
        }),
      ),
      /** A tool reporting nothing to process ends the run as no_input. */
      gate: Type.Optional(Type.Boolean()),
    }),
  ),
  reasoning: Type.Object({
    promptId: Nullable(Type.String()),
    schemaId: Type.String(),
    backend: Nullable(Type.String()),
    model: Nullable(Type.String()),
    timeoutSeconds: Type.Integer(),
  }),
  actions: Type.Array(
    Type.Object({ id: Type.String(), class: AutopilotActionClassSchema, label: Text }),
  ),
  /** The routine file's level: the maximum. */
  level: AutopilotLevelSchema,
  /** What actions are authorized against: min(level, override.level). */
  effectiveLevel: AutopilotLevelSchema,
  override: Nullable(AutopilotLevelOverrideSchema),
  lastDemotion: Nullable(AutopilotDemotionSchema),
  limits: Type.Object({ maxItemsPerRun: Type.Integer(), maxActionsPerDay: Type.Integer() }),
  requireCitations: Type.Boolean(),
  baselineMinutes: Nullable(Type.Number()),
  queue: Nullable(Type.String()),
  /** Approved company knowledge files (Project-relative, under a read-only folder). */
  knowledge: Type.Array(Type.String()),
  state: AutopilotRoutineStateSchema,
});

export const AutopilotRunCountsSchema = Type.Object({
  items: Type.Integer(),
  prepared: Type.Integer(),
  acted: Type.Integer(),
  escalated: Type.Integer(),
  refused: Type.Integer(),
  failed: Type.Integer(),
  handled: Type.Integer(),
  deferred: Type.Integer(),
});

const runSummaryProps = {
  id: Type.String(),
  projectId: Type.String(),
  routineId: Type.String(),
  edition: AutopilotEditionSchema,
  area: Type.String(),
  level: AutopilotLevelSchema,
  trigger: lit(["schedule", "manual", "event"] as const),
  triggeredBy: Type.String(),
  /** Event runs: the sources whose signals the run coalesced. */
  triggerSources: Type.Optional(Type.Array(Type.String())),
  startedAt: Type.String(),
  endedAt: Type.String(),
  status: RunStatus,
  reason: Nullable(Type.String()),
  routineDigest: Type.String(),
  reasoning: Type.Object({
    backend: Nullable(Type.String()),
    model: Nullable(Type.String()),
    ms: Type.Integer(),
    outputSha256: Nullable(Type.String()),
    retried: Type.Optional(Type.Boolean()),
  }),
  counts: AutopilotRunCountsSchema,
  workItems: Type.Array(Type.String()),
  evidence: Nullable(Type.Object({ bundle: Type.String(), root: Type.String() })),
  /** Behaviour watchdog verdict, measured before any action ran (absent on older runs). */
  watchdog: Type.Optional(
    Nullable(
      Type.Object({
        tripped: Type.Boolean(),
        reasons: Type.Array(Type.String()),
        baseline: lit(["baseline", "static"] as const),
        metrics: Nullable(WatchdogMetrics),
      }),
    ),
  ),
};
export const AutopilotRunSummarySchema = Type.Object(runSummaryProps);

export const AutopilotActionOutcomeSchema = Type.Object({
  item: Type.String(),
  kind: Type.String(),
  class: Nullable(AutopilotActionClassSchema),
  decision: Decision,
  code: Nullable(Type.String()),
  executed: Type.Boolean(),
  error: Nullable(Type.String()),
  /** L3: the standing approval the action ran under. */
  approvalId: Nullable(Type.String()),
  ref: Nullable(Type.String()),
});

export const AutopilotRunRecordSchema = Type.Object({
  ...runSummaryProps,
  gather: Type.Array(
    Type.Object({
      id: Type.String(),
      tool: Type.String(),
      calls: Type.Integer(),
      bytes: Type.Integer(),
      error: Nullable(Type.String()),
    }),
  ),
  actions: Type.Array(AutopilotActionOutcomeSchema),
});

export const AutopilotApprovalScopeSchema = Type.Object({
  addresses: Type.Array(Type.String()),
  domains: Type.Array(Type.String()),
  targets: Type.Array(Type.String()),
  templates: Type.Array(Type.String()),
  maxPerDay: Type.Integer(),
});

export const AutopilotApprovalSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  routineId: Type.String(),
  action: Type.String(),
  scope: AutopilotApprovalScopeSchema,
  reason: Type.String(),
  createdBy: Type.String(),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  revokedAt: Nullable(Type.String()),
  revokedBy: Nullable(Type.String()),
  revokeReason: Nullable(Type.String()),
  state: lit(["active", "expired", "revoked"] as const),
});

const StatsRow = {
  runs: Type.Integer(),
  failedRuns: Type.Integer(),
  items: Type.Integer(),
  prepared: Type.Integer(),
  acted: Type.Integer(),
  escalated: Type.Integer(),
  handled: Type.Integer(),
  correctedByPerson: Type.Integer(),
  /** Only when the routine sets metrics.baselineMinutes; never estimated. */
  minutesSaved: Nullable(Type.Number()),
};

// ---- methods ----

export const AutopilotRoutinesListParamsSchema = strict({ projectId: ProjectId });
export const AutopilotRoutinesListResultSchema = Type.Object({
  routines: Type.Array(AutopilotRoutineSchema),
  source: Type.Object({
    kind: lit(["project", "admin", "template", "none"] as const),
    path: Nullable(Type.String()),
  }),
  digest: Type.String(),
  /** Set when the routines file is invalid: no routine of the Project runs (fail closed). */
  error: Nullable(Type.String()),
  catalogue: Type.Array(AutopilotActionDefSchema),
  editions: Type.Record(Type.String(), Type.Array(Type.String())),
  flags: Type.Array(lit(ITEM_FLAGS)),
  control: AutopilotGlobalControlSchema,
});

export const AutopilotRoutinesSyncParamsSchema = strict({ projectId: ProjectId });
export const AutopilotRoutinesSyncResultSchema = Type.Object({
  added: Type.Array(Type.String()),
  updated: Type.Array(Type.String()),
  removed: Type.Array(Type.String()),
  unchanged: Type.Array(Type.String()),
});

export const AutopilotRunsListParamsSchema = strict({
  projectId: ProjectId,
  routineId: Type.Optional(RoutineId),
  edition: Type.Optional(AutopilotEditionSchema),
  area: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(RunStatus),
  /** Opaque cursor from the previous page (newest first). */
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const AutopilotRunsListResultSchema = Type.Object({
  runs: Type.Array(AutopilotRunSummarySchema),
  /** Server total for the filter (all pages). */
  total: Type.Integer(),
  nextCursor: Nullable(Type.String()),
});

export const AutopilotRunsGetParamsSchema = strict({ projectId: ProjectId, id: RunId });
export const AutopilotRunsGetResultSchema = Type.Object({
  run: AutopilotRunRecordSchema,
  evidence: Type.Object({ ok: Type.Boolean(), problems: Type.Array(Type.String()) }),
});

export const AutopilotRunParamsSchema = strict({ projectId: ProjectId, routineId: RoutineId });
export const AutopilotRunResultSchema = Type.Object({ run: AutopilotRunSummarySchema });

export const AutopilotPauseParamsSchema = strict({
  projectId: ProjectId,
  routineId: RoutineId,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
export const AutopilotPauseResultSchema = Type.Object({ routine: AutopilotRoutineSchema });
export const AutopilotResumeParamsSchema = strict({
  projectId: ProjectId,
  routineId: RoutineId,
  /** Required (at least 4 characters) when the watchdog or stopAll paused the routine. */
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const AutopilotResumeResultSchema = Type.Object({ routine: AutopilotRoutineSchema });

export const AutopilotApprovalsCreateParamsSchema = strict({
  projectId: ProjectId,
  routineId: RoutineId,
  /** An external action the routine lists (e.g. mail.send). */
  action: NonEmptyString,
  scope: strict({
    addresses: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
    domains: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
    targets: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
    templates: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
    maxPerDay: Type.Integer({ minimum: 1, maximum: 500 }),
  }),
  /** Written reason (required, audited). */
  reason: Type.String({ minLength: 4, maxLength: 1000 }),
  /** ISO time, at most 90 days ahead. */
  expiresAt: NonEmptyString,
});
export const AutopilotApprovalsCreateResultSchema = Type.Object({
  approval: AutopilotApprovalSchema,
});

export const AutopilotApprovalsListParamsSchema = strict({
  projectId: ProjectId,
  routineId: Type.Optional(RoutineId),
  includeInactive: Type.Optional(Type.Boolean()),
});
export const AutopilotApprovalsListResultSchema = Type.Object({
  approvals: Type.Array(AutopilotApprovalSchema),
});

export const AutopilotApprovalsRevokeParamsSchema = strict({
  projectId: ProjectId,
  id: ApprovalId,
  reason: Type.String({ minLength: 4, maxLength: 1000 }),
});
export const AutopilotApprovalsRevokeResultSchema = Type.Object({
  approval: AutopilotApprovalSchema,
});

const AutopilotAutonomyProposalSchema = Type.Object({
  routineId: Type.String(),
  /** The routine's effective level (the proposal moves it one step). */
  current: AutopilotLevelSchema,
  kind: lit(["promote", "demote", "hold"] as const),
  proposed: AutopilotLevelSchema,
  reason: lit([
    "low_correction_rate",
    "high_correction_rate",
    "failed_runs",
    "insufficient_evidence",
    "at_top",
    "within_band",
  ] as const),
  needsStandingApproval: Type.Boolean(),
  evidence: Type.Object({
    from: Type.String(),
    to: Type.String(),
    runs: Type.Integer(),
    failedRuns: Type.Integer(),
    workItems: Type.Integer(),
    corrected: Type.Integer(),
    correctionRate: Nullable(Type.Number()),
    escalated: Type.Integer(),
  }),
  /** The routine file's level: no accepted level goes above it. */
  fileLevel: AutopilotLevelSchema,
  /**
   * Why autopilot.autonomy.accept would refuse a promotion now. Always null for demote and
   * hold, so null alone does not mean acceptable: a hold is refused (nothing_to_accept).
   */
  acceptBlocker: Nullable(lit(["above_file_level", "no_standing_approval"] as const)),
  /** Set while a person's decline of this same proposal holds (one policy window). */
  declined: Nullable(Type.Object({ by: Type.String(), at: Type.String(), reason: Type.String() })),
});

/** Earned-autonomy proposals (read): one level up or down per routine, never applied. */
export const AutopilotAutonomyProposalsParamsSchema = strict({ projectId: ProjectId });
export const AutopilotAutonomyProposalsResultSchema = Type.Object({
  policy: Type.Object({
    windowDays: Type.Integer(),
    minItemsToPromote: Type.Integer(),
    promoteAtOrBelow: Type.Number(),
    minItemsToDemote: Type.Integer(),
    demoteAtOrAbove: Type.Number(),
  }),
  proposals: Type.Array(AutopilotAutonomyProposalSchema),
});

/** A person declines the routine's current proposal (recorded and audited; no level changes). */
export const AutopilotAutonomyDeclineParamsSchema = strict({
  projectId: ProjectId,
  routineId: RoutineId,
  kind: lit(["promote", "demote"] as const),
  proposed: AutopilotLevelSchema,
  reason: Type.String({ minLength: 4, maxLength: 1000 }),
});
export const AutopilotAutonomyDeclineResultSchema = Type.Object({
  proposal: AutopilotAutonomyProposalSchema,
});

/**
 * A person accepts the routine's current proposal (recomputed; `proposal_changed` when it no
 * longer matches). The level becomes the routine's override: never above the file's level, L3
 * only with an active standing approval.
 */
export const AutopilotAutonomyAcceptParamsSchema = strict({
  projectId: ProjectId,
  routineId: RoutineId,
  kind: lit(["promote", "demote"] as const),
  proposed: AutopilotLevelSchema,
  reason: Type.String({ minLength: 4, maxLength: 1000 }),
});
export const AutopilotAutonomyAcceptResultSchema = Type.Object({
  /** The proposal recomputed after the change. */
  proposal: AutopilotAutonomyProposalSchema,
  change: AutopilotAutonomyChangeSchema,
  routine: AutopilotRoutineSchema,
});

/** A person marks an autopilot-created work item as a serious error: one level down now. */
export const AutopilotReportErrorParamsSchema = strict({
  projectId: ProjectId,
  itemId: WorkItemId,
  reason: Type.String({ minLength: 4, maxLength: 1000 }),
});
export const AutopilotReportErrorResultSchema = Type.Object({
  change: AutopilotAutonomyChangeSchema,
  routine: AutopilotRoutineSchema,
});

const BriefItem = {
  projectId: Type.String(),
  /** Deep link: open with workitems.get. */
  itemId: Type.String(),
  title: Type.String(),
  queue: Type.String(),
  status: Type.String(),
  priority: Type.String(),
  dueAt: Nullable(Type.String()),
  overdue: Type.Boolean(),
};
const BriefCounts = {
  runs: Type.Integer(),
  items: Type.Integer(),
  prepared: Type.Integer(),
  acted: Type.Integer(),
  escalated: Type.Integer(),
  handled: Type.Integer(),
};

/** One person's morning brief, built from recorded data only. */
export const AutopilotBriefSchema = Type.Object({
  version: Type.Literal(1),
  projectId: Type.String(),
  projectName: Type.String(),
  principal: Type.String(),
  name: Nullable(Type.String()),
  window: Type.Object({ from: Type.String(), to: Type.String() }),
  generatedAt: Type.String(),
  handled: Type.Object({
    ...BriefCounts,
    failedRuns: Type.Integer(),
    drafts: Type.Integer(),
    areas: Type.Array(
      Type.Object({
        ...BriefCounts,
        edition: AutopilotEditionSchema,
        area: Type.String(),
        department: Nullable(Type.String()),
      }),
    ),
  }),
  documents: Type.Array(
    Type.Object({
      runId: Type.String(),
      routineId: Type.String(),
      path: Type.String(),
      at: Type.String(),
    }),
  ),
  waiting: Type.Object({
    decisions: Type.Array(Type.Object(BriefItem)),
    flagged: Type.Array(Type.Object({ ...BriefItem, flags: Type.Array(Type.String()) })),
    proposals: Type.Array(
      Type.Object({
        routineId: Type.String(),
        kind: lit(["promote", "demote"] as const),
        current: AutopilotLevelSchema,
        proposed: AutopilotLevelSchema,
        reason: Type.String(),
        needsStandingApproval: Type.Boolean(),
        acceptBlocker: Nullable(lit(["above_file_level", "no_standing_approval"] as const)),
      }),
    ),
  }),
  commitments: Type.Array(Type.Object(BriefItem)),
  /** A list was cut at its cap (optional: briefs delivered before the flag existed lack it). */
  truncated: Type.Optional(
    Type.Object({
      documents: Type.Boolean(),
      decisions: Type.Boolean(),
      flagged: Type.Boolean(),
      commitments: Type.Boolean(),
    }),
  ),
  problems: Type.Object({
    watchdog: Type.Array(
      Type.Object({
        routineId: Type.String(),
        runId: Type.String(),
        at: Type.String(),
        reasons: Type.Array(Type.String()),
      }),
    ),
    runs: Type.Array(
      Type.Object({
        routineId: Type.String(),
        runId: Type.String(),
        at: Type.String(),
        status: lit(["failed", "skipped"] as const),
        reason: Nullable(Type.String()),
      }),
    ),
    demotions: Type.Array(
      Type.Object({
        routineId: Type.String(),
        at: Type.String(),
        from: AutopilotLevelSchema,
        to: AutopilotLevelSchema,
        cause: Type.String(),
      }),
    ),
    paused: Type.Array(
      Type.Object({
        routineId: Type.String(),
        pausedBy: Nullable(Type.String()),
        pausedAt: Nullable(Type.String()),
        reason: Nullable(Type.String()),
      }),
    ),
    routinesError: Nullable(Type.String()),
    control: Type.Object({ stopped: Type.Boolean(), emergencyStop: Type.Boolean() }),
  }),
});

/** The caller's own brief (person only); default window: the 24 h before now. */
export const AutopilotBriefGetParamsSchema = strict({
  projectId: ProjectId,
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
});
export const AutopilotBriefGetResultSchema = Type.Object({ brief: AutopilotBriefSchema });

export const AutopilotStatsParamsSchema = strict({
  projectId: ProjectId,
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
});
export const AutopilotStatsResultSchema = Type.Object({
  from: Nullable(Type.String()),
  to: Nullable(Type.String()),
  routines: Type.Array(
    Type.Object({
      ...StatsRow,
      routineId: Type.String(),
      edition: AutopilotEditionSchema,
      area: Type.String(),
      department: Nullable(Type.String()),
      baselineMinutes: Nullable(Type.Number()),
      lastRunAt: Nullable(Type.String()),
      lastStatus: Nullable(Type.String()),
      /** Null for a routine that is no longer in the routines file. */
      watchdog: Nullable(AutopilotWatchdogSchema),
    }),
  ),
  areas: Type.Array(
    Type.Object({
      ...StatsRow,
      edition: AutopilotEditionSchema,
      area: Type.String(),
      department: Nullable(Type.String()),
    }),
  ),
  totals: Type.Object(StatsRow),
  control: AutopilotGlobalControlSchema,
});

const ControlChange = Type.Object({
  projectId: Type.String(),
  routineIds: Type.Array(Type.String()),
});
const ControlReason = Type.String({ minLength: 4, maxLength: 1000 });

/** Stop every routine in every Project (person only, operator.approvals, written reason). */
export const AutopilotStopAllParamsSchema = strict({ reason: ControlReason });
export const AutopilotStopAllResultSchema = Type.Object({
  control: AutopilotGlobalControlSchema,
  /** Routines this call paused, per Project. */
  changed: Type.Array(ControlChange),
  /** Everything was already stopped: `control` keeps the first stop's by, at and reason. */
  alreadyStopped: Type.Boolean(),
});
/** Lift the global stop; resumes only the routines stopAll paused. */
export const AutopilotStartAllParamsSchema = strict({ reason: ControlReason });
export const AutopilotStartAllResultSchema = Type.Object({
  control: AutopilotGlobalControlSchema,
  /** Routines this call resumed, per Project. */
  changed: Type.Array(ControlChange),
  /** Nothing was stopped: `control` keeps the last start's by, at and reason. */
  alreadyStarted: Type.Boolean(),
});

export const AutopilotChangedEventSchema = Type.Object({
  projectId: Type.String(),
  routineId: Nullable(Type.String()),
  kind: lit([
    "run",
    "paused",
    "resumed",
    "approval",
    "autonomy",
    "sync",
    "watchdog",
    "trigger",
    "stopAll",
    "startAll",
  ] as const),
  runId: Type.Optional(Type.String()),
  at: Type.String(),
});
