// The trigger dispatcher inside the gateway: event runs go through runRoutine with the gateway
// runner deps (exactly as a scheduled run, trigger=event), every run and health change emits
// `autopilot.changed`, and a watchdog pause (run trip or trigger loop) resyncs the cron jobs.

import type { CronLike } from "../cron.js";
import { syncRoutineJobs } from "../cron.js";
import { gatewayRunnerDeps } from "../gateway-deps.js";
import { runRoutine } from "../runner.js";
import {
  startTriggerDispatcher,
  stopTriggerDispatcher,
  type TriggerDispatcher,
} from "./dispatcher.js";

export const AUTOPILOT_CHANGED_EVENT = "autopilot.changed";

export function startGatewayTriggers(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  cron: CronLike | null;
  log: { warn: (msg: string) => void };
}): { stop: () => void; dispatcher: TriggerDispatcher } {
  const emit = (payload: {
    projectId: string;
    routineId: string | null;
    kind: string;
    runId?: string;
  }) =>
    params.broadcast(
      AUTOPILOT_CHANGED_EVENT,
      { ...payload, at: new Date().toISOString() },
      { dropIfSlow: true },
    );
  const dispatcher = startTriggerDispatcher({
    run: (project, routineId, trigger) =>
      runRoutine(gatewayRunnerDeps(), project, routineId, trigger),
    onRun: (project, routineId, run) => {
      emit({ projectId: project.id, routineId, kind: "run", runId: run.id });
      if (run.watchdog?.tripped) {
        emit({ projectId: project.id, routineId, kind: "watchdog", runId: run.id });
        if (params.cron) {
          void syncRoutineJobs(params.cron, project).catch((err) =>
            params.log.warn(`autopilot: cron resync failed: ${String(err)}`),
          );
        }
      }
    },
    onChanged: (projectId, routineId, kind) => emit({ projectId, routineId, kind }),
    onPaused: async (project) => {
      if (params.cron) {
        await syncRoutineJobs(params.cron, project);
      }
    },
    log: params.log,
  });
  return { stop: stopTriggerDispatcher, dispatcher };
}
