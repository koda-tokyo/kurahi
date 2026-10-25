// Routines run as Kurahi cron jobs (src/cron): one isolated job per routine, named
// `autopilot:<projectId>:<routineId>`, registered idempotently by that name. The cron service
// owns the timing; when such a job fires, the gateway hands it to the autopilot engine instead
// of a model turn (server-cron.ts), so a scheduled run is exactly a manual run with
// trigger=schedule. A job only runs when its id is the one the engine registered for the routine,
// so a look-alike job added by hand cannot start a routine.

import type { CronService } from "../cron/service.js";
import type { CronJob, CronJobCreate, CronSchedule } from "../cron/types.js";
import type { Project } from "../projects/types.js";
import type { Routine, RoutineSet } from "./types.js";
import { getProject, loadProjects } from "../projects/store.js";
import { gatewayRunnerDeps } from "./gateway-deps.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./runner.js";
import { readState, updateRoutineState } from "./store.js";
import { AutopilotRefused } from "./types.js";

export type CronLike = Pick<CronService, "list" | "add" | "update" | "remove">;

const PREFIX = "autopilot:";
const NAME_RE = /^autopilot:(p[a-z0-9]{10}):([a-z0-9][a-z0-9-]{0,47})$/;

export function autopilotJobName(projectId: string, routineId: string): string {
  return `${PREFIX}${projectId}:${routineId}`;
}

export function parseAutopilotJobName(
  name: string,
): { projectId: string; routineId: string } | null {
  const m = NAME_RE.exec(name);
  return m ? { projectId: m[1], routineId: m[2] } : null;
}

export function isAutopilotJob(job: Pick<CronJob, "name">): boolean {
  return parseAutopilotJobName(job.name) !== null;
}

/** The routine's cron schedule, or null for an event-only routine (it has no cron job). */
export function scheduleOf(routine: Routine): CronSchedule | null {
  const t = routine.trigger;
  if (t.kind === "schedule") {
    return { kind: "cron", expr: t.expr, tz: t.tz };
  }
  return t.kind === "interval" ? { kind: "every", everyMs: t.minutes * 60_000 } : null;
}

export function jobSpecFor(project: Project, routine: Routine, enabled: boolean): CronJobCreate {
  const schedule = scheduleOf(routine);
  if (!schedule) {
    throw new Error(`routine ${routine.id} has no schedule (event triggers only)`);
  }
  return {
    name: autopilotJobName(project.id, routine.id),
    ...(routine.agentId ? { agentId: routine.agentId } : {}),
    description: `autopilot ${routine.edition}/${routine.area}: ${routine.id} (${routine.level}); executed by the engine, no model turn`,
    enabled,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: `autopilot routine ${routine.id}`, deliver: false },
    isolation: { postToMainMode: "none" },
  };
}

function same(job: CronJob, spec: CronJobCreate): boolean {
  return (
    job.enabled === spec.enabled &&
    job.description === spec.description &&
    (job.agentId ?? null) === (spec.agentId ?? null) &&
    JSON.stringify(job.schedule) === JSON.stringify(spec.schedule) &&
    job.sessionTarget === spec.sessionTarget &&
    JSON.stringify(job.payload) === JSON.stringify(spec.payload) &&
    job.isolation?.postToMainMode === "none"
  );
}

export type SyncResult = {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
};

/**
 * Make the Project's autopilot jobs match its routines: one job per routine (enabled only when
 * the routine is enabled, not paused and the file is valid), extra or orphaned jobs removed.
 * Running it twice changes nothing the second time.
 */
export async function syncRoutineJobs(
  cron: CronLike,
  project: Project,
  set: RoutineSet = loadRoutines(project),
  home?: string,
): Promise<SyncResult> {
  const out: SyncResult = { added: [], updated: [], removed: [], unchanged: [] };
  const jobs = (await cron.list({ includeDisabled: true })).filter(
    (j) => parseAutopilotJobName(j.name)?.projectId === project.id,
  );
  const states = readState(project.id, home).routines;
  // An invalid file disables every routine of the Project (fail closed), it does not delete them.
  const wanted = new Map(set.routines.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const routine of set.routines) {
    if (!scheduleOf(routine)) {
      // Event-only: the trigger dispatcher runs it; a job left from an earlier file is removed.
      if (states[routine.id]?.cronJobId) {
        updateRoutineState(project.id, routine.id, (cur) => ({ ...cur, cronJobId: null }), home);
      }
      continue;
    }
    const name = autopilotJobName(project.id, routine.id);
    const enabled =
      routine.enabled && !states[routine.id]?.paused && !set.error && !project.archived;
    const spec = jobSpecFor(project, routine, enabled);
    const mine = jobs.filter((j) => j.name === name);
    const registered = mine.find((j) => j.id === states[routine.id]?.cronJobId) ?? mine[0];
    let id: string;
    if (!registered) {
      id = (await cron.add(spec)).id;
      out.added.push(routine.id);
    } else if (!same(registered, spec)) {
      id = (await cron.update(registered.id, spec)).id;
      out.updated.push(routine.id);
    } else {
      id = registered.id;
      out.unchanged.push(routine.id);
    }
    keep.add(id);
    if (states[routine.id]?.cronJobId !== id) {
      updateRoutineState(project.id, routine.id, (cur) => ({ ...cur, cronJobId: id }), home);
    }
  }
  for (const j of jobs) {
    const ref = parseAutopilotJobName(j.name);
    if (keep.has(j.id)) {
      continue;
    }
    if (set.error && ref && wanted.size === 0) {
      // Invalid file: keep the jobs but switch them off.
      if (j.enabled) {
        await cron.update(j.id, { enabled: false });
        out.updated.push(ref.routineId);
      } else {
        out.unchanged.push(ref.routineId);
      }
      continue;
    }
    await cron.remove(j.id);
    out.removed.push(ref?.routineId ?? j.name);
  }
  return out;
}

/** Sync every Project (gateway start). Errors are per Project and never stop the gateway. */
export async function syncAllAutopilotJobs(
  cron: CronLike,
  log: { warn: (msg: string) => void } = console,
): Promise<void> {
  for (const project of loadProjects()) {
    try {
      const set = loadRoutines(project);
      if (set.source.kind === "none") {
        continue;
      }
      await syncRoutineJobs(cron, project, set);
    } catch (err) {
      log.warn(`autopilot: job sync failed for ${project.id}: ${String(err)}`);
    }
  }
}

/** Run a fired autopilot cron job through the engine (no model turn). */
export async function runAutopilotCronJob(job: CronJob): Promise<{
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
}> {
  const ref = parseAutopilotJobName(job.name);
  const project = ref ? getProject(ref.projectId) : null;
  if (!ref || !project) {
    return { status: "error", error: "autopilot job names no known project" };
  }
  const state = readState(project.id).routines[ref.routineId];
  if (state?.cronJobId !== job.id) {
    return { status: "skipped", summary: "not the job the autopilot registered for this routine" };
  }
  try {
    const run = await runRoutine(gatewayRunnerDeps(), project, ref.routineId, {
      kind: "schedule",
      by: `cron:${job.id}`,
    });
    const c = run.counts;
    const summary = `autopilot ${ref.routineId}: ${run.status} items=${c.items} prepared=${c.prepared} acted=${c.acted} escalated=${c.escalated}${run.reason ? ` (${run.reason})` : ""}`;
    return run.status === "failed"
      ? { status: "error", error: run.reason ?? "run failed", summary }
      : { status: run.status === "skipped" ? "skipped" : "ok", summary };
  } catch (err) {
    if (err instanceof AutopilotRefused) {
      return { status: "skipped", summary: `autopilot ${ref.routineId}: ${err.code}` };
    }
    return { status: "error", error: String(err instanceof Error ? err.message : err) };
  }
}
