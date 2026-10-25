// Autopilot (all Kurahi editions): routines that carry repetitive work end to end. A routine
// gathers through READ tools, a tool-less model reasons over the gathered data, and the engine
// executes the proposed actions itself, inside the routine's autonomy level, after the policy
// check (authorize.ts). The model never holds a tool that can send, pay or delete.
// See docs/autopilot.md.

import { DEPARTMENT_IDS, type DepartmentId } from "../workitems/types.js";

export const EDITIONS = ["industrial", "business", "scholars", "core"] as const;
export type Edition = (typeof EDITIONS)[number];

/** Work areas per edition. Business areas are the work queue's department ids. */
export const EDITION_AREAS = {
  industrial: ["modernisation", "analysis", "design-docs", "ot-monitoring", "quality"],
  business: DEPARTMENT_IDS,
  scholars: ["literature", "data", "writing", "grants", "lab"],
  core: ["platform-ops", "security", "backup", "integrity"],
} as const satisfies Record<Edition, readonly string[]>;

export function isEdition(v: unknown): v is Edition {
  return typeof v === "string" && (EDITIONS as readonly string[]).includes(v);
}

export function isAreaOf(edition: Edition, area: unknown): boolean {
  return typeof area === "string" && (EDITION_AREAS[edition] as readonly string[]).includes(area);
}

/** The business department of a routine (derived; other editions have none). */
export function departmentOf(r: { edition: Edition; area: string }): DepartmentId | null {
  return r.edition === "business" ? (r.area as DepartmentId) : null;
}

export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const LEVEL_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/**
 * The level a routine runs at: the routine file's level is the maximum, a person's accepted
 * level or an automatic demotion (the override in routine state) can only lower it.
 */
export function effectiveLevel(
  fileLevel: AutonomyLevel,
  override: { level: AutonomyLevel } | null | undefined,
): AutonomyLevel {
  if (!override || !(override.level in LEVEL_RANK)) {
    return fileLevel;
  }
  return LEVEL_RANK[override.level] < LEVEL_RANK[fileLevel] ? override.level : fileLevel;
}

/** One step down, never below L0 (the only direction the engine moves a level by itself). */
export function levelBelow(level: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_LEVELS[Math.max(0, LEVEL_RANK[level] - 1)];
}

/**
 * How consequential an action is. The level table works on this, never on action names:
 * L1 allows `prepare`, L2 adds `internal-reversible`, L3 adds `external` under a standing
 * approval, and `never` always goes to a person.
 */
export const ACTION_CLASSES = ["prepare", "internal-reversible", "external", "never"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Item flags that stop every action on the item (a person handles it). */
export const BLOCKING_FLAGS = [
  "suspected_fraud",
  "phishing",
  "prompt_injection",
  "unverified_sender",
  "unverified_citation",
  "malicious_attachment",
] as const;
export type BlockingFlag = (typeof BLOCKING_FLAGS)[number];
/** Informational flags the model may set (kept on the item, no effect on authorization). */
export const INFO_FLAGS = ["needs_review", "duplicate", "overdue", "missing_data"] as const;
export const ITEM_FLAGS = [...BLOCKING_FLAGS, ...INFO_FLAGS] as const;
export type ItemFlag = (typeof ITEM_FLAGS)[number];

/** Event sources a routine may react to (docs/autopilot.md#triggers). */
export const EVENT_SOURCES = ["m365.mail", "workitems", "deadline", "files"] as const;
export type EventSourceKind = (typeof EVENT_SOURCES)[number];
/** Work item changes a `workitems` trigger may filter on. */
export const WORKITEM_TRIGGER_ACTIONS = ["created", "changed", "decided", "flag.clear"] as const;
export type WorkItemTriggerAction = (typeof WORKITEM_TRIGGER_ACTIONS)[number];

export type EventSpec =
  | { source: "m365.mail"; folder: string }
  | { source: "workitems"; queue: string | null; actions: WorkItemTriggerAction[] }
  | { source: "deadline"; withinHours: number }
  | { source: "files"; folder: string };

export type EventTrigger = {
  sources: EventSpec[];
  /** Signals within this window after the first one coalesce into one run. */
  debounceSeconds: number;
  /** Event-triggered runs started per rolling hour (schedule and manual runs not counted). */
  maxRunsPerHour: number;
};

/**
 * When a routine runs: a schedule or an interval (a cron job), events (in-process watchers), or
 * both. An event-only routine has no cron job; its `tz` is the file's time zone.
 */
export type RoutineTrigger = (
  | { kind: "schedule"; expr: string; tz: string }
  | { kind: "interval"; minutes: number }
  | { kind: "event"; tz: string }
) & { events?: EventTrigger };

export type GatherStep = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Fan out over a previous step: every id the regex's first group matches in that step's
   * output (not seen in an earlier run) is passed to `tool` as `arg`, at most `max` times.
   */
  each?: { from: string; match: string; arg: string; max: number };
  /**
   * When the tool reports nothing to process (`details.noInput: true`, e.g. legacy_changes with
   * no change since the baseline), the run ends as no_input: no further gather, no model call.
   */
  gate?: true;
};

export type Routine = {
  id: string;
  edition: Edition;
  area: string;
  name: { ja?: string; en?: string };
  enabled: boolean;
  trigger: RoutineTrigger;
  /** Agent whose project session the gather tools run in (default: the default agent). */
  agentId: string | null;
  gather: GatherStep[];
  reasoning: {
    /** Built-in prompt id or null when `prompt` is inline text. */
    promptId: string | null;
    prompt: string;
    schemaId: string;
    backend: string | null;
    model: string | null;
    timeoutSeconds: number;
  };
  /** Actions the routine may propose (catalogue ids). The model can never add one. */
  actions: string[];
  /** Tool chosen per action where the catalogue offers several (e.g. a mail connector). */
  actionTools: Record<string, string>;
  level: AutonomyLevel;
  limits: { maxItemsPerRun: number; maxActionsPerDay: number };
  /** Scholars: every citation must name a source retrieved in gather (default true there). */
  requireCitations: boolean;
  /** Minutes a person spends per handled item without the autopilot (metrics only). */
  baselineMinutes: number | null;
  /** Work queue the escalations and intakes go to (default: the project's first queue). */
  queue: string | null;
  /**
   * Approved company knowledge: Project-relative files under a read-only folder of the Project,
   * given to the model as TRUSTED facts (bounded), apart from the untrusted gathered sources.
   */
  knowledge: string[];
  /**
   * Where office.create writes this routine's documents (a writable Project folder such as
   * output/literature); null = output/autopilot. Never watched by a files trigger.
   */
  outputFolder: string | null;
};

export type RoutineSet = {
  routines: Routine[];
  source: { kind: "project" | "admin" | "template" | "none"; path: string | null };
  digest: string;
  /** Set when the file is invalid: then no routine runs (fail closed). */
  error: string | null;
};

export type StandingApprovalScope = {
  /** Exact addresses (lower case) a send may go to. */
  addresses: string[];
  /** Domains (lower case, no @) a send may go to. */
  domains: string[];
  /** Other targets an external action may touch (repositories, endpoints …). */
  targets: string[];
  /** Template ids the action may use; empty = the action must not name a template. */
  templates: string[];
  maxPerDay: number;
};

/** A person declined one earned-autonomy proposal; it holds while the same proposal recurs. */
export type AutonomyDecline = {
  routineId: string;
  kind: "promote" | "demote";
  from: AutonomyLevel;
  proposed: AutonomyLevel;
  reason: string;
  declinedBy: string;
  declinedAt: string;
};

/** A level set below the routine file's level: accepted by a person or an automatic demotion. */
export type LevelOverride = {
  level: AutonomyLevel;
  kind: "accepted" | "demoted";
  by: string;
  at: string;
  reason: string;
  /** The autonomy change record (autonomy-changes.jsonl, with its evidence bundle). */
  changeId: string;
};

export type DemotionCause = "watchdog" | "reported_error";

/** The last automatic one-step demotion of a routine. */
export type AutonomyDemotion = {
  at: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  cause: DemotionCause;
  by: string;
  reason: string;
  runId: string | null;
  itemId: string | null;
  changeId: string;
};

/** One recorded level change (a person's accept, or an automatic demotion). */
export type AutonomyChange = {
  id: string;
  projectId: string;
  routineId: string;
  kind: "accept" | "demotion";
  fileLevel: AutonomyLevel;
  from: AutonomyLevel;
  to: AutonomyLevel;
  by: string;
  at: string;
  reason: string;
  cause: DemotionCause | null;
  runId: string | null;
  itemId: string | null;
  /** accept: the proposal the person saw (recomputed and matched). */
  proposal: { kind: "promote" | "demote"; proposed: AutonomyLevel } | null;
  evidence: { bundle: string; root: string } | null;
};

export type StandingApproval = {
  id: string;
  projectId: string;
  routineId: string;
  action: string;
  scope: StandingApprovalScope;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
};

export type ApprovalState = "active" | "expired" | "revoked";

export function approvalState(a: StandingApproval, now: Date): ApprovalState {
  if (a.revokedAt) {
    return "revoked";
  }
  return Date.parse(a.expiresAt) > now.getTime() ? "active" : "expired";
}

/** One action the model proposed for one item. */
export type ProposedAction = { kind: string; args: Record<string, unknown> };

export type PlanItem = {
  ref: string;
  title: string;
  summary: string;
  category: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  flags: ItemFlag[];
  sources: string[];
  actions: ProposedAction[];
};

export type Decision =
  | { decision: "allow"; class: ActionClass; approvalId: string | null }
  | { decision: "needs_person"; class: ActionClass | null; code: string; reason: string }
  | { decision: "refuse"; class: ActionClass | null; code: string; reason: string };

export type RunTrigger = "schedule" | "manual" | "event";
export type RunStatus = "ok" | "escalated" | "no_input" | "failed" | "skipped";

export type ActionOutcome = {
  item: string;
  kind: string;
  class: ActionClass | null;
  decision: Decision["decision"];
  code: string | null;
  /** allow: executed / failed. */
  executed: boolean;
  error: string | null;
  approvalId: string | null;
  /** What the action produced (work item id, draft id, artifact id …). */
  ref: string | null;
};

export type RunCounts = {
  items: number;
  prepared: number;
  acted: number;
  escalated: number;
  refused: number;
  failed: number;
  /** Items handled without a person (at least one executed action, nothing escalated). */
  handled: number;
  deferred: number;
};

export type RunRecord = {
  id: string;
  projectId: string;
  routineId: string;
  edition: Edition;
  area: string;
  level: AutonomyLevel;
  trigger: RunTrigger;
  triggeredBy: string;
  /** Event runs: the sources whose signals the run coalesced (e.g. `m365.mail:inbox`). */
  triggerSources?: string[];
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  reason: string | null;
  routineDigest: string;
  gather: Array<{ id: string; tool: string; calls: number; bytes: number; error: string | null }>;
  reasoning: {
    backend: string | null;
    model: string | null;
    ms: number;
    outputSha256: string | null;
    /** The first reply was malformed and the reasoner was asked once more. */
    retried?: boolean;
  };
  counts: RunCounts;
  actions: ActionOutcome[];
  /** Work items created for a person (escalations and intakes). */
  workItems: string[];
  evidence: { bundle: string; root: string } | null;
  /** Behaviour watchdog verdict (watchdog.ts); absent on runs recorded before it existed. */
  watchdog?: RunWatchdog | null;
};

export type RunWatchdog = {
  tripped: boolean;
  reasons: string[];
  /** What the metrics were compared with. */
  baseline: "baseline" | "static";
  /** Measured before any action ran (null when the run did not reach the model). */
  metrics: {
    gatherCalls: number;
    bytesRead: number;
    items: number;
    actions: number;
    durationMs: number;
  } | null;
};

export type RunSummary = Omit<RunRecord, "actions" | "gather">;

export class AutopilotRefused extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
