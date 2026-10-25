// Queue overview: counts and approval times computed server-side over every item the viewer may
// read (all items for privileged viewers), never over a page.

import type { WorkItem, WorkItemStatus, WorkItemText } from "./types.js";
import { stageSummary } from "./routes.js";
import { isOverdue } from "./store.js";
import { WORK_ITEM_STATUSES } from "./types.js";

export const STATS_DEFAULT_WINDOW_DAYS = 30;
export const STATS_MAX_WINDOW_DAYS = 365;

export type WorkItemStats = {
  total: number;
  byStatus: Record<WorkItemStatus, number>;
  byQueue: Record<string, { total: number; byStatus: Record<WorkItemStatus, number> }>;
  /** Open items past their SLA due date. */
  overdue: number;
  /** Items whose active stage is past its own due time. */
  stageOverdue: number;
  stages: Array<{
    routeId: string;
    stageId: string;
    /** Position of the stage in its route (0-based). */
    index: number;
    name: WorkItemText;
    waiting: number;
    overdue: number;
    escalated: number;
  }>;
  timeToApprove: {
    windowDays: number;
    count: number;
    medianHours: number | null;
    p90Hours: number | null;
  };
  computedAt: string;
};

function zero(): Record<WorkItemStatus, number> {
  return Object.fromEntries(WORK_ITEM_STATUSES.map((s) => [s, 0])) as Record<
    WorkItemStatus,
    number
  >;
}

/** Median: mean of the two middle values; p90: nearest rank. Input sorted ascending. */
export function median(sorted: number[]): number | null {
  if (!sorted.length) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Hours from first submission (→ awaiting_review) to approval, when approved in the window. */
function approvalHours(item: WorkItem, from: number, to: number): number | null {
  const approved = item.history.findLast((h) => h.to === "approved");
  const submitted = item.history.find((h) => h.to === "awaiting_review");
  if (!approved || !submitted) {
    return null;
  }
  const at = Date.parse(approved.at);
  if (at < from || at > to) {
    return null;
  }
  return Math.max(0, (at - Date.parse(submitted.at)) / 3_600_000);
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

export function computeStats(
  items: WorkItem[],
  opts: { queue?: string; windowDays?: number; now?: Date } = {},
): WorkItemStats {
  const now = opts.now ?? new Date();
  const windowDays = Math.min(
    STATS_MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(opts.windowDays ?? STATS_DEFAULT_WINDOW_DAYS)),
  );
  const from = now.getTime() - windowDays * 86_400_000;
  const byStatus = zero();
  const byQueue: WorkItemStats["byQueue"] = {};
  const stages = new Map<string, WorkItemStats["stages"][number]>();
  const hours: number[] = [];
  let total = 0;
  let overdue = 0;
  let stageOverdue = 0;
  for (const item of items) {
    if (opts.queue && item.queue !== opts.queue) {
      continue;
    }
    total += 1;
    byStatus[item.status] += 1;
    const q = (byQueue[item.queue] ??= { total: 0, byStatus: zero() });
    q.total += 1;
    q.byStatus[item.status] += 1;
    if (isOverdue(item, now)) {
      overdue += 1;
    }
    const s = stageSummary(item, now);
    if (s && item.route) {
      const key = `${item.route.id}\u0000${s.id}`;
      const row = stages.get(key) ?? {
        routeId: item.route.id,
        stageId: s.id,
        index: s.index,
        name: s.name,
        waiting: 0,
        overdue: 0,
        escalated: 0,
      };
      row.waiting += 1;
      row.overdue += s.overdue ? 1 : 0;
      row.escalated += s.escalated ? 1 : 0;
      stageOverdue += s.overdue ? 1 : 0;
      stages.set(key, row);
    }
    const h = approvalHours(item, from, now.getTime());
    if (h !== null) {
      hours.push(h);
    }
  }
  hours.sort((a, b) => a - b);
  return {
    total,
    byStatus,
    byQueue,
    overdue,
    stageOverdue,
    stages: [...stages.values()].toSorted(
      (a, b) => a.routeId.localeCompare(b.routeId) || a.index - b.index,
    ),
    timeToApprove: {
      windowDays,
      count: hours.length,
      medianHours: round(median(hours)),
      p90Hours: round(percentile(hours, 90)),
    },
    computedAt: now.toISOString(),
  };
}
