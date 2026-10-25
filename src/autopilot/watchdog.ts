// Autopilot behaviour watchdog (docs/autopilot.md#behaviour-watchdog). Every run's volume is
// measured BEFORE its actions execute: gather calls, bytes read, items and actions the model
// proposed (in total and per kind) and the time spent so far. Each metric is compared with the
// routine's own baseline once it has at least WATCHDOG_MIN_RUNS normal runs (threshold:
// max(3 × p95, static cap)), else with static caps derived from the routine's limits. The run
// also trips on a burst of refusals (more than 5), on any proposal of an action the routine does
// not list (or no catalogue knows), and on repeated reasoner tool-call attempts.
//
// A trip executes nothing: the run's allowed actions wait for a person, the routine is paused
// (`pausedBy: "watchdog"`, resumed only by a person with a written reason), and one work item
// carries the anomaly summary. Tripped runs never enter the baseline.

import type { Decision, PlanItem, ProposedAction, Routine, RunRecord } from "./types.js";

export const WATCHDOG_MIN_RUNS = 5;
export const WATCHDOG_HISTORY_MAX = 50;
export const WATCHDOG_FACTOR = 3;
/** More refusals than this in one run trip the watchdog. */
export const WATCHDOG_REFUSAL_BURST = 5;
/** Consecutive runs whose reasoner reported a tool call that trip the watchdog. */
export const WATCHDOG_TOOL_USE_REPEAT = 2;
/** Characters of one gather tool result the engine keeps (runner.ts). */
export const GATHER_TEXT_MAX = 12_000;
/** Authorization codes that mean the model proposed something outside the routine. */
export const OFF_ROUTINE_CODES = new Set(["not_in_routine", "unknown_action", "edition_mismatch"]);
/**
 * Refusal codes that are the system working as designed (not counted in the burst). A routine
 * demoted to L0 refuses every action it lists with `level_observe`: that is the demotion
 * working, not an anomaly.
 */
export const EXPECTED_REFUSAL_CODES = new Set(["flagged", "already_handled", "level_observe"]);

export const WATCHDOG_METRICS = [
  "gatherCalls",
  "bytesRead",
  "items",
  "actions",
  "durationMs",
] as const;
export type WatchdogMetric = (typeof WATCHDOG_METRICS)[number];

export type RunMetrics = {
  runId: string;
  at: string;
  gatherCalls: number;
  bytesRead: number;
  items: number;
  actions: number;
  actionsByKind: Record<string, number>;
  durationMs: number;
};

export type WatchdogTrip = { at: string; runId: string; reasons: string[] };

export type WatchdogState = {
  /** Metrics of recent normal (untripped) runs that reached the model, oldest first. */
  history: RunMetrics[];
  lastTrip: WatchdogTrip | null;
  trips: number;
  /** Consecutive runs whose reasoner reported a tool call. */
  toolUseStreak: number;
};

export function emptyWatchdogState(): WatchdogState {
  return { history: [], lastTrip: null, trips: 0, toolUseStreak: 0 };
}

export type WatchdogThresholds = {
  source: "baseline" | "static";
  runs: number;
  values: Record<WatchdogMetric, number>;
  /** Per proposed action kind. */
  perKind: Record<string, number>;
  p95: Record<WatchdogMetric, number> | null;
};

/** Caps a well-behaved run of this routine stays within, from its file alone. */
export function staticCaps(routine: Pick<Routine, "gather" | "limits" | "actions" | "reasoning">): {
  values: Record<WatchdogMetric, number>;
  perKind: number;
} {
  const gatherCalls = routine.gather.reduce((n, s) => n + (s.each ? s.each.max : 1), 0);
  // A plan has about one item per gathered input; items over maxItemsPerRun are deferred, so
  // the cap is the larger of the two.
  const fanOut = routine.gather.reduce((n, s) => n + (s.each ? s.each.max : 0), 0);
  const items = Math.max(routine.limits.maxItemsPerRun, fanOut);
  return {
    values: {
      gatherCalls,
      bytesRead: gatherCalls * GATHER_TEXT_MAX,
      items,
      actions: items * Math.max(1, routine.actions.length),
      durationMs: routine.reasoning.timeoutSeconds * 1000 + gatherCalls * 60_000,
    },
    perKind: items,
  };
}

/** Nearest-rank 95th percentile. */
export function p95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

export function watchdogThresholds(
  routine: Pick<Routine, "gather" | "limits" | "actions" | "reasoning">,
  history: readonly RunMetrics[],
  kinds: Iterable<string> = [],
): WatchdogThresholds {
  const caps = staticCaps(routine);
  const allKinds = new Set<string>([...routine.actions, ...kinds]);
  if (history.length < WATCHDOG_MIN_RUNS) {
    return {
      source: "static",
      runs: history.length,
      values: caps.values,
      perKind: Object.fromEntries([...allKinds].map((k) => [k, caps.perKind])),
      p95: null,
    };
  }
  const p = Object.fromEntries(
    WATCHDOG_METRICS.map((m) => [m, p95(history.map((h) => h[m]))]),
  ) as Record<WatchdogMetric, number>;
  const values = Object.fromEntries(
    WATCHDOG_METRICS.map((m) => [m, Math.max(WATCHDOG_FACTOR * p[m], caps.values[m])]),
  ) as Record<WatchdogMetric, number>;
  const perKind = Object.fromEntries(
    [...allKinds].map((k) => [
      k,
      Math.max(WATCHDOG_FACTOR * p95(history.map((h) => h.actionsByKind[k] ?? 0)), caps.perKind),
    ]),
  );
  return { source: "baseline", runs: history.length, values, perKind, p95: p };
}

export type WatchdogSignals = {
  /** Refusals in the run's authorization, without the expected ones (flagged, handled). */
  refusals: number;
  /** Proposals of actions outside the routine (not listed, unknown, other edition). */
  offRoutine: string[];
  /** Consecutive runs (this one included) whose reasoner reported a tool call. */
  toolUseStreak: number;
};

export type WatchdogVerdict = {
  tripped: boolean;
  reasons: string[];
  thresholds: WatchdogThresholds;
};

export function evaluateWatchdog(
  routine: Pick<Routine, "gather" | "limits" | "actions" | "reasoning">,
  history: readonly RunMetrics[],
  metrics: RunMetrics | null,
  signals: WatchdogSignals,
): WatchdogVerdict {
  const thresholds = watchdogThresholds(
    routine,
    history,
    metrics ? Object.keys(metrics.actionsByKind) : [],
  );
  const reasons: string[] = [];
  if (metrics) {
    for (const m of WATCHDOG_METRICS) {
      if (metrics[m] > thresholds.values[m]) {
        reasons.push(`${m} ${metrics[m]} > ${thresholds.values[m]} (${thresholds.source})`);
      }
    }
    for (const [kind, n] of Object.entries(metrics.actionsByKind)) {
      const cap = thresholds.perKind[kind] ?? 0;
      if (n > cap) {
        reasons.push(`actions ${kind} ${n} > ${cap} (${thresholds.source})`);
      }
    }
  }
  if (signals.refusals > WATCHDOG_REFUSAL_BURST) {
    reasons.push(`refusal burst: ${signals.refusals} refusals in one run`);
  }
  if (signals.offRoutine.length > 0) {
    reasons.push(
      `actions outside the routine proposed: ${[...new Set(signals.offRoutine)].slice(0, 5).join(", ")}`,
    );
  }
  if (signals.toolUseStreak >= WATCHDOG_TOOL_USE_REPEAT) {
    reasons.push(`the reasoner attempted tool calls in ${signals.toolUseStreak} consecutive runs`);
  }
  return { tripped: reasons.length > 0, reasons, thresholds };
}

/** What the console shows per routine. */
export type WatchdogView = {
  baseline: "baseline" | "static";
  runs: number;
  thresholds: Record<WatchdogMetric, number>;
  p95: Record<WatchdogMetric, number> | null;
  lastTrip: WatchdogTrip | null;
  trips: number;
  toolUseStreak: number;
};

export function watchdogView(
  routine: Pick<Routine, "gather" | "limits" | "actions" | "reasoning">,
  state: WatchdogState | undefined,
): WatchdogView {
  const s = { ...emptyWatchdogState(), ...state };
  const t = watchdogThresholds(routine, s.history);
  return {
    baseline: t.source,
    runs: s.history.length,
    thresholds: t.values,
    p95: t.p95,
    lastTrip: s.lastTrip,
    trips: s.trips,
    toolUseStreak: s.toolUseStreak,
  };
}

/**
 * The run's volume and refusal signals from its plan, before anything executes. `authorize` is
 * the same pure check the act step makes (nothing is executed here).
 */
export function measurePlan(p: {
  items: readonly PlanItem[];
  gather: RunRecord["gather"];
  flagsOf: (item: PlanItem) => PlanItem["flags"];
  authorize: (action: ProposedAction, flags: PlanItem["flags"]) => Decision;
  runId: string;
  startedAt: Date;
  now: Date;
}): { metrics: RunMetrics; refusals: number; offRoutine: string[] } {
  let refusals = 0;
  const offRoutine: string[] = [];
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const item of p.items) {
    const flags = p.flagsOf(item);
    for (const action of item.actions) {
      total++;
      byKind[action.kind] = (byKind[action.kind] ?? 0) + 1;
      const d = p.authorize(action, flags);
      if (d.decision !== "refuse") {
        continue;
      }
      if (OFF_ROUTINE_CODES.has(d.code)) {
        offRoutine.push(action.kind);
      }
      if (!EXPECTED_REFUSAL_CODES.has(d.code)) {
        refusals++;
      }
    }
  }
  // Approved knowledge is trusted local text, not gathered input.
  const rows = p.gather.filter((g) => g.id !== "knowledge");
  return {
    metrics: {
      runId: p.runId,
      at: p.startedAt.toISOString(),
      gatherCalls: rows.reduce((n, g) => n + g.calls, 0),
      bytesRead: rows.reduce((n, g) => n + g.bytes, 0),
      items: p.items.length,
      actions: total,
      actionsByKind: byKind,
      durationMs: Math.max(0, p.now.getTime() - p.startedAt.getTime()),
    },
    refusals,
    offRoutine,
  };
}
