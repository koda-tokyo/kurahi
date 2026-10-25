// Global autopilot kill switch (docs/autopilot.md#stopping-every-routine).
//
//   <KOLO_HOME>/autopilot/control.json   set by autopilot.stopAll / startAll (a person, with a
//                                        reason): while stopped, no routine of any Project runs
//   <KOLO_HOME>/autopilot/STOP           emergency stop file: while it exists, no routine runs.
//                                        Works without the gateway API (create it with any
//                                        tool that can make a file); remove it to allow runs.
//
// stopAll also pauses every routine of every Project (`pausedBy: "stopAll"`), so cron jobs are
// switched off on the next sync; startAll resumes only the routines stopAll paused (a routine a
// person or the watchdog paused stays paused).

import fs from "node:fs";
import path from "node:path";
import { resolveKoloHome } from "../config/kolo-home.js";
import { loadProjects } from "../projects/store.js";
import { loadRoutines } from "./routines.js";
import { readState, updateRoutineState, writeAtomic } from "./store.js";

export const STOP_ALL_PAUSED_BY = "stopAll";

export type GlobalControl = {
  stopped: boolean;
  by: string | null;
  at: string | null;
  reason: string | null;
  /** The STOP file exists (blocks every run whatever `stopped` says). */
  emergencyStop: boolean;
};

export function autopilotHomeDir(home: string = resolveKoloHome()): string {
  return path.join(home, "autopilot");
}

export function emergencyStopFile(home?: string): string {
  return path.join(autopilotHomeDir(home), "STOP");
}

function controlFile(home?: string): string {
  return path.join(autopilotHomeDir(home), "control.json");
}

export function readGlobalControl(home?: string): GlobalControl {
  let doc: Partial<GlobalControl> = {};
  try {
    doc = JSON.parse(fs.readFileSync(controlFile(home), "utf8")) as Partial<GlobalControl>;
  } catch {
    doc = {};
  }
  return {
    stopped: doc.stopped === true,
    by: typeof doc.by === "string" ? doc.by : null,
    at: typeof doc.at === "string" ? doc.at : null,
    reason: typeof doc.reason === "string" ? doc.reason : null,
    emergencyStop: fs.existsSync(emergencyStopFile(home)),
  };
}

/** Why no routine may run now, or null. Checked before every run and again before actions. */
export function globalStopRefusal(home?: string): { code: string; reason: string } | null {
  const c = readGlobalControl(home);
  if (c.emergencyStop) {
    return { code: "emergency_stop", reason: "the emergency STOP file is present" };
  }
  if (c.stopped) {
    return { code: "stopped_all", reason: `every routine is stopped (by ${c.by ?? "?"})` };
  }
  return null;
}

export type ControlChange = { projectId: string; routineIds: string[] };

function eachRoutine(
  home: string | undefined,
  fn: (projectId: string, routineId: string) => boolean,
): ControlChange[] {
  const out: ControlChange[] = [];
  for (const project of loadProjects(home ?? resolveKoloHome())) {
    const ids = new Set<string>();
    const set = loadRoutines(project, home);
    for (const r of set.routines) {
      ids.add(r.id);
    }
    // Routines with state but no longer in the file (or an invalid file) are covered too.
    for (const id of Object.keys(readState(project.id, home).routines)) {
      ids.add(id);
    }
    const changed = [...ids].filter((id) => fn(project.id, id));
    out.push({ projectId: project.id, routineIds: changed });
  }
  return out;
}

export function stopAllRoutines(
  by: string,
  reason: string,
  home?: string,
  now: Date = new Date(),
): { control: GlobalControl; paused: ControlChange[]; alreadyStopped: boolean } {
  const at = now.toISOString();
  // A second stopAll keeps who stopped everything first, when and why; it still pauses any
  // routine that is not paused yet.
  const alreadyStopped = readGlobalControl(home).stopped;
  if (!alreadyStopped) {
    writeAtomic(
      controlFile(home),
      `${JSON.stringify({ version: 1, stopped: true, by, at, reason }, null, 2)}\n`,
    );
  }
  const paused = eachRoutine(home, (projectId, routineId) => {
    let changed = false;
    updateRoutineState(
      projectId,
      routineId,
      (cur) => {
        if (cur.paused) {
          return cur;
        }
        changed = true;
        return {
          ...cur,
          paused: true,
          pausedBy: STOP_ALL_PAUSED_BY,
          pausedAt: at,
          pauseReason: `stopAll by ${by}: ${reason}`.slice(0, 1000),
        };
      },
      home,
    );
    return changed;
  });
  return { control: readGlobalControl(home), paused, alreadyStopped };
}

export function startAllRoutines(
  by: string,
  reason: string,
  home?: string,
  now: Date = new Date(),
): { control: GlobalControl; resumed: ControlChange[]; alreadyStarted: boolean } {
  // Nothing stopped: keep the record of who lifted the last stop, when and why; still resume a
  // routine stopAll left paused (for example after control.json was removed by hand).
  const alreadyStarted = !readGlobalControl(home).stopped;
  if (!alreadyStarted) {
    writeAtomic(
      controlFile(home),
      `${JSON.stringify(
        { version: 1, stopped: false, by, at: now.toISOString(), reason },
        null,
        2,
      )}\n`,
    );
  }
  const resumed = eachRoutine(home, (projectId, routineId) => {
    let changed = false;
    updateRoutineState(
      projectId,
      routineId,
      (cur) => {
        if (!cur.paused || cur.pausedBy !== STOP_ALL_PAUSED_BY) {
          return cur;
        }
        changed = true;
        return { ...cur, paused: false, pausedBy: null, pausedAt: null, pauseReason: null };
      },
      home,
    );
    return changed;
  });
  return { control: readGlobalControl(home), resumed, alreadyStarted };
}
