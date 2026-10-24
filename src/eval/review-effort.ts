// Workflow Evaluator: correction effort (design §4.3, §5.2).
//
// A pass/fail score says whether the agent's output met the spec. It does not say what the output
// cost a person to check and fix before it could be used, and productivity claims that leave review
// and fix time out overstate the gain. Each human review records the minutes spent reviewing, the
// minutes spent correcting, a diff size between the agent's output and the accepted output, and a
// verdict. The scorecard aggregates them per task (fixture) and per suite (run).
//
// Aggregates are per task and per suite only, never per reviewer (design §1.6: no surveillance).
import fs from "node:fs";
import { sha256Hex } from "../continuity-suite/manifest.js";

export const REVIEW_VERDICTS = ["accepted-as-is", "accepted-after-edits", "rejected"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** CLI spelling → stored verdict. */
export const VERDICT_ALIASES: Record<string, ReviewVerdict> = {
  "as-is": "accepted-as-is",
  edited: "accepted-after-edits",
  rejected: "rejected",
};

/** Line-level diff size between the agent's output and the accepted output. */
export type DiffSize = {
  unit: "line";
  fromSha256: string;
  toSha256: string;
  fromLines: number;
  toLines: number;
  added: number;
  removed: number;
  /** Insertions + deletions (shortest edit script, Myers). */
  editDistance: number;
  /** editDistance ÷ (fromLines + toLines), 0..1; 0 when both are empty. */
  changeRatio: number;
  /** false when the diff was too large to solve exactly; editDistance is then a lower bound. */
  exact: boolean;
};

export type HumanReview = {
  /** rv-<n>, sequential within the scorecard. */
  id: string;
  /** Task id: the fixture (replay) the review is about. */
  fixture: string;
  attempt: number;
  reviewer: string;
  recordedAt: string;
  minutesReview: number;
  minutesFix: number;
  verdict: ReviewVerdict;
  reason?: string;
  diff: DiffSize | null;
  /** SHA-256 of the scorecard.json this review amended: links the revisions into a chain. */
  priorScorecardSha256: string;
};

export type CorrectionEffortTargets = {
  medianMinutes?: number;
  p90Minutes?: number;
  minAcceptedUnchanged?: number;
};

export type CorrectionEffortStats = {
  reviews: number;
  /** Review + fix minutes per review. */
  medianMinutes: number | null;
  p90Minutes: number | null;
  medianReviewMinutes: number | null;
  medianFixMinutes: number | null;
  totalMinutes: number;
  acceptedUnchangedShare: number | null;
  acceptedEditedShare: number | null;
  rejectedShare: number | null;
  /** Over reviews that recorded a diff. */
  medianEditDistance: number | null;
};

export type CorrectionEffort = {
  method: "median; p90 nearest-rank; minutes = review + fix";
  suite: CorrectionEffortStats;
  tasks: Record<string, CorrectionEffortStats>;
  targets: CorrectionEffortTargets | null;
  /** null when there are no targets or no reviews. */
  meetsTargets: boolean | null;
};

const round = (x: number, places = 4) => Math.round(x * 10 ** places) / 10 ** places;

export function median(xs: number[]): number | null {
  if (xs.length === 0) {
    return null;
  }
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** Nearest-rank percentile: the smallest value with at least p% of the values at or below it. */
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) {
    return null;
  }
  const s = xs.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return round(s[rank - 1]);
}

export function effortStatsOf(reviews: HumanReview[]): CorrectionEffortStats {
  const n = reviews.length;
  const share = (v: ReviewVerdict) =>
    n === 0 ? null : round(reviews.filter((r) => r.verdict === v).length / n);
  const totals = reviews.map((r) => r.minutesReview + r.minutesFix);
  const diffs = reviews.flatMap((r) => (r.diff ? [r.diff.editDistance] : []));
  return {
    reviews: n,
    medianMinutes: median(totals),
    p90Minutes: percentile(totals, 90),
    medianReviewMinutes: median(reviews.map((r) => r.minutesReview)),
    medianFixMinutes: median(reviews.map((r) => r.minutesFix)),
    totalMinutes: round(totals.reduce((a, b) => a + b, 0)),
    acceptedUnchangedShare: share("accepted-as-is"),
    acceptedEditedShare: share("accepted-after-edits"),
    rejectedShare: share("rejected"),
    medianEditDistance: median(diffs),
  };
}

export function correctionEffortOf(
  reviews: HumanReview[],
  targets: CorrectionEffortTargets | undefined,
): CorrectionEffort {
  const byTask = new Map<string, HumanReview[]>();
  for (const r of reviews) {
    byTask.set(r.fixture, [...(byTask.get(r.fixture) ?? []), r]);
  }
  const suite = effortStatsOf(reviews);
  const tasks = Object.fromEntries(
    [...byTask.keys()].toSorted().map((id) => [id, effortStatsOf(byTask.get(id) ?? [])]),
  );
  const t = targets && Object.keys(targets).length > 0 ? targets : null;
  let meetsTargets: boolean | null = null;
  if (t && suite.reviews > 0) {
    meetsTargets =
      (t.medianMinutes === undefined || (suite.medianMinutes ?? 0) <= t.medianMinutes) &&
      (t.p90Minutes === undefined || (suite.p90Minutes ?? 0) <= t.p90Minutes) &&
      (t.minAcceptedUnchanged === undefined ||
        (suite.acceptedUnchangedShare ?? 0) >= t.minAcceptedUnchanged);
  }
  return {
    method: "median; p90 nearest-rank; minutes = review + fix",
    suite,
    tasks,
    targets: t,
    meetsTargets,
  };
}

/** Σ review + fix minutes ÷ distinct reviewed items (fixture × attempt); null without reviews. */
export function reviewerMinutesPerItem(reviews: HumanReview[]): number | null {
  if (reviews.length === 0) {
    return null;
  }
  const items = new Set(reviews.map((r) => `${r.fixture}#${r.attempt}`));
  const total = reviews.reduce((a, r) => a + r.minutesReview + r.minutesFix, 0);
  return round(total / items.size);
}

export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Length of the shortest edit script (insertions + deletions) between two line arrays, by Myers'
 * O((N+M)·D) algorithm after trimming the common prefix and suffix. Returns null when D would
 * exceed `maxD`.
 */
export function editDistance(a: string[], b: string[], maxD = 20_000): number | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) {
    return n + m;
  }
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return d;
      }
    }
  }
  return null;
}

/** Lower bound on the edit distance from line multisets (used only when Myers gives up). */
function multisetDistance(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const l of a) {
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  let common = 0;
  for (const l of b) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      common += 1;
      counts.set(l, c - 1);
    }
  }
  return a.length + b.length - 2 * common;
}

export function diffSize(from: string, to: string): DiffSize {
  const a = splitLines(from);
  const b = splitLines(to);
  const exactD = editDistance(a, b);
  const d = exactD ?? multisetDistance(a, b);
  // added − removed = |b| − |a| and added + removed = d.
  const added = (d + (b.length - a.length)) / 2;
  const removed = (d - (b.length - a.length)) / 2;
  const total = a.length + b.length;
  return {
    unit: "line",
    fromSha256: sha256Hex(from),
    toSha256: sha256Hex(to),
    fromLines: a.length,
    toLines: b.length,
    added,
    removed,
    editDistance: d,
    changeRatio: total === 0 ? 0 : round(d / total),
    exact: exactD !== null,
  };
}

export const MAX_DIFF_FILE_BYTES = 16 * 1_048_576;

export function diffSizeOfFiles(fromFile: string, toFile: string): DiffSize {
  for (const f of [fromFile, toFile]) {
    const size = fs.statSync(f).size;
    if (size > MAX_DIFF_FILE_BYTES) {
      throw new Error(`${f} is larger than ${MAX_DIFF_FILE_BYTES} bytes`);
    }
  }
  return diffSize(fs.readFileSync(fromFile, "utf8"), fs.readFileSync(toFile, "utf8"));
}
