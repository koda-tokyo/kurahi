// Autopilot metrics from recorded events only: run records (runs, prepared, acted, escalated,
// handled) and the work queue's own history (corrected by a person). Minutes saved appear only
// when the routine's file sets `metrics.baselineMinutes` (what the customer measured per item);
// otherwise they are null, never an estimate.

import type { Edition, Routine, RunSummary } from "./types.js";
import { readRunSummaries } from "./store.js";
import { departmentOf } from "./types.js";
import { autopilotCorrections } from "./workitems-adapter.js";

export type StatsRow = {
  runs: number;
  failedRuns: number;
  items: number;
  prepared: number;
  acted: number;
  escalated: number;
  handled: number;
  correctedByPerson: number;
  minutesSaved: number | null;
};

export type RoutineStats = StatsRow & {
  routineId: string;
  edition: Edition;
  area: string;
  department: string | null;
  baselineMinutes: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
};

export type AreaStats = StatsRow & { edition: Edition; area: string; department: string | null };

export type AutopilotStats = {
  from: string | null;
  to: string | null;
  routines: RoutineStats[];
  areas: AreaStats[];
  totals: StatsRow;
};

function zero(): StatsRow {
  return {
    runs: 0,
    failedRuns: 0,
    items: 0,
    prepared: 0,
    acted: 0,
    escalated: 0,
    handled: 0,
    correctedByPerson: 0,
    minutesSaved: null,
  };
}

function add(into: StatsRow, from: StatsRow): void {
  into.runs += from.runs;
  into.failedRuns += from.failedRuns;
  into.items += from.items;
  into.prepared += from.prepared;
  into.acted += from.acted;
  into.escalated += from.escalated;
  into.handled += from.handled;
  into.correctedByPerson += from.correctedByPerson;
  if (from.minutesSaved !== null) {
    into.minutesSaved = (into.minutesSaved ?? 0) + from.minutesSaved;
  }
}

export function autopilotStats(
  projectId: string,
  routines: Routine[],
  opts: { from?: Date; to?: Date; home?: string } = {},
): AutopilotStats {
  const inRange = (r: RunSummary) => {
    const at = Date.parse(r.startedAt);
    return (!opts.from || at >= opts.from.getTime()) && (!opts.to || at <= opts.to.getTime());
  };
  const runs = readRunSummaries(projectId, opts.home).filter(inRange);
  const corrections = autopilotCorrections(projectId, {
    home: opts.home,
    since: opts.from,
    until: opts.to,
  });
  const byRoutine = new Map<string, RoutineStats>();
  const known = new Map(routines.map((r) => [r.id, r]));
  const rowFor = (id: string, edition: Edition, area: string): RoutineStats => {
    let row = byRoutine.get(id);
    if (!row) {
      const def = known.get(id);
      row = {
        ...zero(),
        routineId: id,
        edition: def?.edition ?? edition,
        area: def?.area ?? area,
        department: def ? departmentOf(def) : edition === "business" ? area : null,
        baselineMinutes: def?.baselineMinutes ?? null,
        lastRunAt: null,
        lastStatus: null,
      };
      byRoutine.set(id, row);
    }
    return row;
  };
  for (const r of routines) {
    rowFor(r.id, r.edition, r.area);
  }
  for (const run of runs) {
    const row = rowFor(run.routineId, run.edition, run.area);
    row.runs++;
    if (run.status === "failed") {
      row.failedRuns++;
    }
    row.items += run.counts.items;
    row.prepared += run.counts.prepared;
    row.acted += run.counts.acted;
    row.escalated += run.counts.escalated;
    row.handled += run.counts.handled;
    if (!row.lastRunAt || run.startedAt > row.lastRunAt) {
      row.lastRunAt = run.startedAt;
      row.lastStatus = run.status;
    }
  }
  for (const [id, c] of corrections) {
    const row = byRoutine.get(id);
    if (row) {
      row.correctedByPerson += c.corrected;
    }
  }
  for (const row of byRoutine.values()) {
    // Only items the autopilot carried alone count, minus the ones a person had to correct.
    row.minutesSaved =
      row.baselineMinutes === null
        ? null
        : Math.round(Math.max(0, row.handled - row.correctedByPerson) * row.baselineMinutes);
  }
  const areas = new Map<string, AreaStats>();
  const totals = zero();
  const list = [...byRoutine.values()].toSorted((a, b) => a.routineId.localeCompare(b.routineId));
  for (const row of list) {
    const key = `${row.edition}/${row.area}`;
    const area = areas.get(key) ?? {
      ...zero(),
      edition: row.edition,
      area: row.area,
      department: row.department,
    };
    add(area, row);
    areas.set(key, area);
    add(totals, row);
  }
  return {
    from: opts.from?.toISOString() ?? null,
    to: opts.to?.toISOString() ?? null,
    routines: list,
    areas: [...areas.values()],
    totals,
  };
}
