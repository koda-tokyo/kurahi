// Autopilot persistence per Project, under its data area:
//
//   <KOLO_HOME>/projects/<projectId>/autopilot/
//     approvals.json            standing approvals (created and revoked by people only)
//     autonomy-declines.json    per routine: the earned-autonomy proposal a person declined
//     approval-uses.json        per standing approval and day: sends made under it (the one
//                               counter maxPerDay is checked against; see consumeStandingApproval)
//     state.json                per routine: paused, cron job id, seen inputs, daily counters,
//                               level override (accepted or demoted) and the last demotion
//     autonomy-changes.jsonl    one line per level change (accept, demotion)
//     autonomy/<changeId>/evidence/  the signed evidence bundle of that change
//     runs.jsonl                one summary line per run (lists and stats)
//     runs/<runId>/record.json  the full run record
//     runs/<runId>/evidence/    the signed evidence bundle of the run
//
// Writes are atomic (tmp + rename) under one lock file per Project, so a scheduled run and a
// person revoking an approval never interleave.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AutonomyChange,
  AutonomyDecline,
  AutonomyDemotion,
  LevelOverride,
  RunRecord,
  RunSummary,
  StandingApproval,
} from "./types.js";
import type { WatchdogState } from "./watchdog.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { projectDataDir } from "../projects/store.js";
import { emptyWatchdogState } from "./watchdog.js";

const LOCK_STALE_MS = 60_000;
const LOCK_DEADLINE_MS = 10_000;
const SEEN_MAX = 2000;
const DAYS_KEPT = 14;

export type RoutineState = {
  paused: boolean;
  pausedBy: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  cronJobId: string | null;
  seen: string[];
  /** Day (routine timezone, YYYY-MM-DD) → actions executed (standing approval uses are kept in
   *  approval-uses.json, incremented by whoever verifies the approval at send time). */
  days: Record<string, { actions: number }>;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  /**
   * When the last successful run (ok, escalated or nothing new) started; the `lastRun` gather
   * variable (args.ts). Held, stopped and failed runs do not move it.
   */
  lastSuccessAt: string | null;
  /** Behaviour watchdog: baseline of recent runs, last trip (watchdog.ts). */
  watchdog: WatchdogState;
  /** Level below the file's level (a person's accept or a demotion); null = the file's level. */
  override: LevelOverride | null;
  lastDemotion: AutonomyDemotion | null;
};

export type AutopilotState = { version: 1; routines: Record<string, RoutineState> };

export function autopilotDir(projectId: string, home: string = resolveKoloHome()): string {
  return path.join(projectDataDir(projectId, home), "autopilot");
}

export function runDir(projectId: string, runId: string, home?: string): string {
  if (!/^r[a-z0-9]{14}$/.test(runId)) {
    throw new Error("invalid run id");
  }
  return path.join(autopilotDir(projectId, home), "runs", runId);
}

export function newId(prefix: "r" | "s" | "c"): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = prefix;
  for (const b of randomBytes(14)) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

export function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Run `fn` holding the Project's autopilot lock (O_EXCL lock file, stale after 60 s). */
export function withAutopilotLock<T>(projectId: string, fn: () => T, home?: string): T {
  const dir = autopilotDir(projectId, home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("autopilot store is busy", { cause: err });
      }
      Atomics.wait(sleepCell, 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// ---- state ----

export function emptyRoutineState(): RoutineState {
  return {
    paused: false,
    pausedBy: null,
    pausedAt: null,
    pauseReason: null,
    cronJobId: null,
    seen: [],
    days: {},
    lastRunId: null,
    lastRunAt: null,
    lastStatus: null,
    lastSuccessAt: null,
    watchdog: emptyWatchdogState(),
    override: null,
    lastDemotion: null,
  };
}

export function readState(projectId: string, home?: string): AutopilotState {
  const s = readJson<AutopilotState>(path.join(autopilotDir(projectId, home), "state.json"), {
    version: 1,
    routines: {},
  });
  return s && typeof s === "object" && s.routines ? s : { version: 1, routines: {} };
}

export function routineState(projectId: string, routineId: string, home?: string): RoutineState {
  const cur = { ...emptyRoutineState(), ...readState(projectId, home).routines[routineId] };
  return { ...cur, watchdog: { ...emptyWatchdogState(), ...cur.watchdog } };
}

/** Read-modify-write one routine's state under the lock. */
export function updateRoutineState(
  projectId: string,
  routineId: string,
  fn: (cur: RoutineState) => RoutineState,
  home?: string,
): RoutineState {
  return withAutopilotLock(
    projectId,
    () => {
      const state = readState(projectId, home);
      const cur = { ...emptyRoutineState(), ...state.routines[routineId] };
      const next = fn({ ...cur, watchdog: { ...emptyWatchdogState(), ...cur.watchdog } });
      next.seen = next.seen.slice(-SEEN_MAX);
      const days = Object.keys(next.days).toSorted();
      for (const d of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) {
        delete next.days[d];
      }
      state.routines[routineId] = next;
      writeAtomic(
        path.join(autopilotDir(projectId, home), "state.json"),
        `${JSON.stringify(state, null, 2)}\n`,
      );
      return next;
    },
    home,
  );
}

// ---- declined earned-autonomy proposals ----

function declinesFile(projectId: string, home?: string): string {
  return path.join(autopilotDir(projectId, home), "autonomy-declines.json");
}

export function readAutonomyDeclines(projectId: string, home?: string): AutonomyDecline[] {
  const doc = readJson<{ declines?: AutonomyDecline[] }>(declinesFile(projectId, home), {});
  return Array.isArray(doc.declines) ? doc.declines : [];
}

export function mutateAutonomyDeclines<T>(
  projectId: string,
  fn: (list: AutonomyDecline[]) => T,
  home?: string,
): T {
  return withAutopilotLock(
    projectId,
    () => {
      const list = readAutonomyDeclines(projectId, home);
      const out = fn(list);
      writeAtomic(
        declinesFile(projectId, home),
        `${JSON.stringify({ version: 1, declines: list }, null, 2)}\n`,
      );
      return out;
    },
    home,
  );
}

// ---- autonomy level changes (accept, demotion) ----

export function autonomyChangeDir(projectId: string, changeId: string, home?: string): string {
  if (!/^c[a-z0-9]{14}$/.test(changeId)) {
    throw new Error("invalid change id");
  }
  return path.join(autopilotDir(projectId, home), "autonomy", changeId);
}

/**
 * Append one level change. Callers hold the Project lock (inside updateRoutineState), so the
 * change and the routine's new override are written together.
 */
export function appendAutonomyChangeLocked(change: AutonomyChange, home?: string): void {
  const dir = autopilotDir(change.projectId, home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, "autonomy-changes.jsonl"), `${JSON.stringify(change)}\n`, {
    mode: 0o600,
  });
}

/** Every recorded level change of the Project, oldest first (malformed lines are skipped). */
export function readAutonomyChanges(projectId: string, home?: string): AutonomyChange[] {
  let text = "";
  try {
    text = fs.readFileSync(
      path.join(autopilotDir(projectId, home), "autonomy-changes.jsonl"),
      "utf8",
    );
  } catch {
    return [];
  }
  const out: AutonomyChange[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as AutonomyChange);
    } catch {
      // A torn last line from a crash.
    }
  }
  return out;
}

// ---- standing approvals ----

function approvalsFile(projectId: string, home?: string): string {
  return path.join(autopilotDir(projectId, home), "approvals.json");
}

export function readApprovals(projectId: string, home?: string): StandingApproval[] {
  const doc = readJson<{ approvals?: StandingApproval[] }>(approvalsFile(projectId, home), {});
  return Array.isArray(doc.approvals) ? doc.approvals : [];
}

export function mutateApprovals<T>(
  projectId: string,
  fn: (list: StandingApproval[]) => T,
  home?: string,
): T {
  return withAutopilotLock(
    projectId,
    () => {
      const list = readApprovals(projectId, home);
      const out = fn(list);
      writeAtomic(
        approvalsFile(projectId, home),
        `${JSON.stringify({ version: 1, approvals: list }, null, 2)}\n`,
      );
      return out;
    },
    home,
  );
}

// ---- standing approval uses (day → count, per approval) ----

export type ApprovalUses = Record<string, Record<string, number>>;

function usesFile(projectId: string, home?: string): string {
  return path.join(autopilotDir(projectId, home), "approval-uses.json");
}

export function readApprovalUses(projectId: string, home?: string): ApprovalUses {
  const doc = readJson<{ uses?: ApprovalUses }>(usesFile(projectId, home), {});
  return doc.uses && typeof doc.uses === "object" ? doc.uses : {};
}

/** Uses per approval on `day` (YYYY-MM-DD in the routine's timezone). */
export function approvalUsesOn(
  projectId: string,
  day: string,
  home?: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, days] of Object.entries(readApprovalUses(projectId, home))) {
    const n = days?.[day];
    if (typeof n === "number" && n > 0) {
      out[id] = n;
    }
  }
  return out;
}

/** Write the uses file. Callers hold the Project lock (consumeStandingApproval). */
export function writeApprovalUsesLocked(
  projectId: string,
  uses: ApprovalUses,
  home?: string,
): void {
  for (const days of Object.values(uses)) {
    const keys = Object.keys(days).toSorted();
    for (const d of keys.slice(0, Math.max(0, keys.length - DAYS_KEPT))) {
      delete days[d];
    }
  }
  writeAtomic(usesFile(projectId, home), `${JSON.stringify({ version: 1, uses }, null, 2)}\n`);
}

// ---- runs ----

export function summaryOf(r: RunRecord): RunSummary {
  const { actions: _a, gather: _g, ...rest } = r;
  return rest;
}

export function writeRun(record: RunRecord, home?: string): void {
  writeAtomic(
    path.join(runDir(record.projectId, record.id, home), "record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  withAutopilotLock(
    record.projectId,
    () => {
      fs.appendFileSync(
        path.join(autopilotDir(record.projectId, home), "runs.jsonl"),
        `${JSON.stringify(summaryOf(record))}\n`,
        { mode: 0o600 },
      );
    },
    home,
  );
}

export function readRun(projectId: string, runId: string, home?: string): RunRecord | null {
  return readJson<RunRecord | null>(path.join(runDir(projectId, runId, home), "record.json"), null);
}

/** Every run summary of the Project, oldest first (malformed lines are skipped). */
export function readRunSummaries(projectId: string, home?: string): RunSummary[] {
  let text = "";
  try {
    text = fs.readFileSync(path.join(autopilotDir(projectId, home), "runs.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as RunSummary);
    } catch {
      // A torn last line from a crash; the record.json of that run is still authoritative.
    }
  }
  return out;
}
