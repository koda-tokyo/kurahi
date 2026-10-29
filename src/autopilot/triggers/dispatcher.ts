// Event trigger dispatcher (docs/autopilot.md#triggers). Deterministic and model-free: watchers
// turn events into signals, the dispatcher turns signals into routine runs.
//
//   m365.mail   a mail watch provider per connector sign-in (mail-source.ts) says "new mail"
//   workitems   every work item write in this process (src/workitems/events.ts), filtered by
//               queue and action; changes made by the routine itself are ignored
//   deadline    every 5 min: open items whose dueAt falls within withinHours, once per window
//   files       fs watch (polling fallback) on a Project folder, outside output/autopilot
//
// Per routine: signals within debounceSeconds after the first one coalesce into ONE run; at most
// maxRunsPerHour event runs per rolling hour (later signals wait for a slot); while a run is in
// progress (any trigger) one follow-up run is queued, never more. The global stopAll / STOP file
// and a paused routine drop signals (the routine's slow safety schedule catches up once resumed).
// A routine triggered by its own outputs more than TRIGGER_LOOP_MAX times in 10 minutes is paused
// by the watchdog with reason `trigger_loop`.

import type { Project } from "../../projects/types.js";
import type { RunTriggerInput } from "../runner.js";
import type {
  EventSpec,
  EventTrigger,
  Routine,
  RunRecord,
  WorkItemTriggerAction,
} from "../types.js";
import type { MailWatchProvider } from "./mail-source.js";
import { auditSafe } from "../../audit/audit-log.js";
import { loadProjects } from "../../projects/store.js";
import { onWorkItemChange, type WorkItemChange } from "../../workitems/events.js";
import { readAllWorkItems } from "../../workitems/store.js";
import { globalStopRefusal } from "../control.js";
import { loadRoutines } from "../routines.js";
import { routineRunInProgress } from "../runner.js";
import { routineState, updateRoutineState } from "../store.js";
import { AutopilotRefused } from "../types.js";
import { autopilotActorId } from "../workitems-adapter.js";
import { FilesWatcher } from "./files-watch.js";
import { getMailWatchProvider, onMailWatchProvidersChanged } from "./mail-source.js";
import { addDeadlineSignalled, mailDeltaStore, readDeadlineSignalled } from "./state.js";

/** Own-output triggered runs allowed per TRIGGER_LOOP_WINDOW_MS before the routine pauses. */
export const TRIGGER_LOOP_MAX = 5;
export const TRIGGER_LOOP_WINDOW_MS = 10 * 60_000;
/** A files change this soon after the routine's run ended counts as its own output. */
export const OWN_OUTPUT_GRACE_MS = 15_000;
export const DEADLINE_INTERVAL_MS = 5 * 60_000;
export const REFRESH_INTERVAL_MS = 60_000;
export const TRIGGER_LOOP_PAUSED_BY = "watchdog";
const HOUR_MS = 3_600_000;
const OUTPUTS_MAX = 500;
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

export type TriggerStatus = "active" | "degraded" | "disabled";
export type TriggerHealth = {
  source: string;
  status: TriggerStatus;
  lastSignalAt: string | null;
  lastError: string | null;
};

/** The source key shown in the console and recorded on runs (`m365.mail:inbox` …). */
export function sourceKey(spec: EventSpec): string {
  switch (spec.source) {
    case "m365.mail":
      return `m365.mail:${spec.folder}`;
    case "workitems":
      return `workitems:${spec.queue ?? "*"}`;
    case "deadline":
      return `deadline:${spec.withinHours}h`;
    case "files":
      return `files:${spec.folder}`;
  }
}

/** Map a work item history action to the trigger's action vocabulary. */
export function workItemTriggerAction(action: string): WorkItemTriggerAction {
  if (action === "create") {
    return "created";
  }
  if (action.startsWith("decide.")) {
    return "decided";
  }
  if (action === "supplier.select") {
    return "supplier.selected";
  }
  return action === "flag.clear" ? "flag.clear" : "changed";
}

export type DispatcherDeps = {
  home?: string;
  now?: () => number;
  /** Start a run (gateway: runRoutine with the gateway runner deps). */
  run: (project: Project, routineId: string, trigger: RunTriggerInput) => Promise<RunRecord>;
  projects?: () => Project[];
  /** A run finished (broadcast, cron resync after a watchdog trip). */
  onRun?: (project: Project, routineId: string, run: RunRecord) => void;
  /** Trigger health changed, or the loop guard paused a routine. */
  onChanged?: (projectId: string, routineId: string | null, kind: "trigger" | "watchdog") => void;
  /** The loop guard paused a routine (cron jobs must be switched off). */
  onPaused?: (project: Project, routineId: string) => void | Promise<void>;
  log?: { warn: (msg: string) => void };
  deadlineIntervalMs?: number;
  refreshIntervalMs?: number;
  filesPollMs?: number;
  filesMode?: "auto" | "poll";
};

type Slot = {
  project: Project;
  routine: Routine;
  events: EventTrigger;
  pending: Set<string>;
  ownPending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  waiting: boolean;
  running: boolean;
  runStarts: number[];
  loopRuns: number[];
  lastRunEndedAt: number | null;
  /** Work items this routine's runs produced (their later changes are its own output). */
  outputs: Set<string>;
  health: Map<string, TriggerHealth>;
};

type Shared = { close: () => void; slots: Set<string> };

export class TriggerDispatcher {
  private readonly slots = new Map<string, Slot>();
  /** `<projectId>:mail:<folder>` / `<projectId>:files:<folder>` → the shared watcher. */
  private readonly shared = new Map<string, Shared>();
  private unsubWorkItems: (() => void) | null = null;
  private unsubProviders: (() => void) | null = null;
  private deadlineTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: DispatcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    this.unsubWorkItems = onWorkItemChange((c) => this.onWorkItem(c));
    this.unsubProviders = onMailWatchProvidersChanged(() => this.refreshMail());
    this.refresh();
    const d = setInterval(
      () => this.checkDeadlines(),
      this.deps.deadlineIntervalMs ?? DEADLINE_INTERVAL_MS,
    );
    d.unref?.();
    this.deadlineTimer = d;
    const r = setInterval(() => this.refresh(), this.deps.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
    r.unref?.();
    this.refreshTimer = r;
    this.checkDeadlines();
  }

  stop(): void {
    this.stopped = true;
    this.unsubWorkItems?.();
    this.unsubProviders?.();
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    for (const s of this.slots.values()) {
      if (s.timer) {
        clearTimeout(s.timer);
      }
    }
    for (const w of this.shared.values()) {
      w.close();
    }
    this.shared.clear();
    this.slots.clear();
  }

  // ---- reconcile routines → slots and watchers ----

  /** Re-read every Project's routines and (un)subscribe watchers to match. Idempotent. */
  refresh(): void {
    if (this.stopped) {
      return;
    }
    const wanted = new Map<string, { project: Project; routine: Routine; events: EventTrigger }>();
    let projects: Project[] = [];
    try {
      projects = (this.deps.projects ?? (() => loadProjects(this.deps.home)))();
    } catch (err) {
      this.deps.log?.warn(`autopilot triggers: projects unreadable: ${String(err)}`);
    }
    for (const project of projects) {
      if (project.archived) {
        continue;
      }
      const set = loadRoutines(project, this.deps.home);
      if (set.error) {
        continue;
      }
      for (const routine of set.routines) {
        // A paused routine is not watched (no polling for it); resume resyncs and re-subscribes.
        if (
          routine.enabled &&
          routine.trigger.events &&
          !routineState(project.id, routine.id, this.deps.home).paused
        ) {
          wanted.set(`${project.id}/${routine.id}`, {
            project,
            routine,
            events: routine.trigger.events,
          });
        }
      }
    }
    for (const [key, slot] of this.slots) {
      if (!wanted.has(key)) {
        if (slot.timer) {
          clearTimeout(slot.timer);
        }
        this.slots.delete(key);
      }
    }
    for (const [key, w] of wanted) {
      const cur = this.slots.get(key);
      if (cur) {
        cur.project = w.project;
        cur.routine = w.routine;
        cur.events = w.events;
        const keys = new Set(w.events.sources.map(sourceKey));
        for (const k of cur.health.keys()) {
          if (!keys.has(k)) {
            cur.health.delete(k);
          }
        }
      } else {
        this.slots.set(key, {
          ...w,
          pending: new Set(),
          ownPending: false,
          timer: null,
          waiting: false,
          running: false,
          runStarts: [],
          loopRuns: [],
          lastRunEndedAt: null,
          outputs: new Set(),
          health: new Map(),
        });
      }
      const slot = this.slots.get(key)!;
      for (const spec of w.events.sources) {
        const k = sourceKey(spec);
        if (!slot.health.has(k)) {
          const watched = spec.source === "workitems" || spec.source === "deadline";
          slot.health.set(k, {
            source: k,
            status: watched ? "active" : "disabled",
            lastSignalAt: null,
            lastError: null,
          });
        }
      }
    }
    this.reconcileShared();
  }

  private refreshMail(): void {
    // A provider came or went: rebuild the mail subscriptions.
    for (const [k, w] of this.shared) {
      if (k.includes(":mail:")) {
        w.close();
        this.shared.delete(k);
      }
    }
    this.reconcileShared();
  }

  private reconcileShared(): void {
    const want = new Map<string, Set<string>>();
    const specOf = new Map<string, { project: Project; spec: EventSpec }>();
    for (const [slotKey, slot] of this.slots) {
      for (const spec of slot.events.sources) {
        if (spec.source !== "m365.mail" && spec.source !== "files") {
          continue;
        }
        const kind = spec.source === "m365.mail" ? "mail" : "files";
        const k = `${slot.project.id}:${kind}:${spec.folder}`;
        if (!want.has(k)) {
          want.set(k, new Set());
          specOf.set(k, { project: slot.project, spec });
        }
        want.get(k)!.add(slotKey);
      }
    }
    for (const [k, w] of this.shared) {
      if (!want.has(k)) {
        w.close();
        this.shared.delete(k);
      }
    }
    for (const [k, slotKeys] of want) {
      const cur = this.shared.get(k);
      if (cur) {
        cur.slots = slotKeys;
        this.replayHealth(k);
        continue;
      }
      const { project, spec } = specOf.get(k)!;
      const shared: Shared = { close: () => {}, slots: slotKeys };
      this.shared.set(k, shared);
      if (spec.source === "m365.mail") {
        shared.close = this.startMail(k, project, spec.folder, getMailWatchProvider("m365.mail"));
      } else if (spec.source === "files") {
        shared.close = this.startFiles(k, project, spec.folder);
      }
    }
  }

  /** Last health a shared watcher reported, for slots that joined it later. */
  private readonly sharedHealth = new Map<
    string,
    { status: TriggerStatus; error: string | null }
  >();

  private replayHealth(sharedKey: string): void {
    const h = this.sharedHealth.get(sharedKey);
    if (h) {
      this.setSharedHealth(sharedKey, h.status, h.error);
    }
  }

  private setSharedHealth(sharedKey: string, status: TriggerStatus, error: string | null): void {
    this.sharedHealth.set(sharedKey, { status, error });
    const w = this.shared.get(sharedKey);
    if (!w) {
      return;
    }
    const [, kind, ...rest] = sharedKey.split(":");
    const k = `${kind === "mail" ? "m365.mail" : "files"}:${rest.join(":")}`;
    for (const slotKey of w.slots) {
      const slot = this.slots.get(slotKey);
      const h = slot?.health.get(k);
      if (slot && h && (h.status !== status || h.lastError !== error)) {
        h.status = status;
        h.lastError = error;
        this.deps.onChanged?.(slot.project.id, slot.routine.id, "trigger");
      }
    }
  }

  private signalShared(sharedKey: string, source: string): void {
    const w = this.shared.get(sharedKey);
    for (const slotKey of w?.slots ?? []) {
      const slot = this.slots.get(slotKey);
      if (slot) {
        const own =
          source.startsWith("files:") &&
          (slot.running ||
            (slot.lastRunEndedAt !== null &&
              this.now() - slot.lastRunEndedAt < OWN_OUTPUT_GRACE_MS));
        this.signal(slot, source, own);
      }
    }
  }

  private startMail(
    sharedKey: string,
    project: Project,
    folder: string,
    provider: MailWatchProvider | null,
  ): () => void {
    if (!provider) {
      this.setSharedHealth(sharedKey, "disabled", "connector_not_enabled");
      return () => {};
    }
    const unsub = provider.subscribe({
      key: `${project.id}:${folder}`,
      folder,
      store: mailDeltaStore(project.id, folder, this.deps.home),
      onNewMail: () => this.signalShared(sharedKey, `m365.mail:${folder}`),
      onHealth: (h) => this.setSharedHealth(sharedKey, h.status, h.error),
    });
    return () => {
      unsub();
      this.sharedHealth.delete(sharedKey);
    };
  }

  private startFiles(sharedKey: string, project: Project, folder: string): () => void {
    const w = new FilesWatcher({
      projectFolder: project.folder,
      folder,
      pollMs: this.deps.filesPollMs,
      mode: this.deps.filesMode,
      onChange: () => this.signalShared(sharedKey, `files:${folder}`),
      onHealth: (h) => this.setSharedHealth(sharedKey, h.status, h.error),
    });
    w.start();
    return () => {
      w.close();
      this.sharedHealth.delete(sharedKey);
    };
  }

  /** The files watcher of a Project folder (tests drive its polling). */
  filesWatcherKey(projectId: string, folder: string): string {
    return `${projectId}:files:${folder}`;
  }

  // ---- in-process sources ----

  private onWorkItem(c: WorkItemChange): void {
    const action = workItemTriggerAction(c.action);
    for (const slot of this.slots.values()) {
      if (slot.project.id !== c.projectId) {
        continue;
      }
      // Changes the routine made itself never trigger it (no self-trigger loops).
      if (c.actor === autopilotActorId(slot.routine.id)) {
        continue;
      }
      for (const spec of slot.events.sources) {
        if (
          spec.source === "workitems" &&
          (spec.queue === null || spec.queue === c.queue) &&
          spec.actions.includes(action)
        ) {
          this.signal(slot, sourceKey(spec), slot.outputs.has(c.id));
        }
      }
    }
  }

  /** One deadline pass (every 5 minutes; exposed for tests). */
  checkDeadlines(): void {
    if (this.stopped) {
      return;
    }
    const byProject = new Map<string, Slot[]>();
    for (const slot of this.slots.values()) {
      if (slot.events.sources.some((s) => s.source === "deadline")) {
        const list = byProject.get(slot.project.id) ?? [];
        list.push(slot);
        byProject.set(slot.project.id, list);
      }
    }
    const now = this.now();
    for (const [projectId, slots] of byProject) {
      let items: ReturnType<typeof readAllWorkItems> = [];
      try {
        items = readAllWorkItems(projectId, { home: this.deps.home });
      } catch {
        items = [];
      }
      const open = items.filter((i) => i.dueAt && !CLOSED_STATUSES.has(i.status));
      for (const slot of slots) {
        const done = readDeadlineSignalled(projectId, slot.routine.id, this.deps.home);
        for (const spec of slot.events.sources) {
          if (spec.source !== "deadline") {
            continue;
          }
          const fresh: string[] = [];
          for (const item of open) {
            const due = Date.parse(item.dueAt!);
            const key = `${item.id}@${item.dueAt}`;
            if (Number.isFinite(due) && due - now <= spec.withinHours * HOUR_MS && !done.has(key)) {
              fresh.push(key);
              done.add(key);
            }
          }
          if (fresh.length > 0) {
            addDeadlineSignalled(projectId, slot.routine.id, fresh, this.deps.home);
            this.signal(slot, sourceKey(spec), false);
          }
        }
      }
    }
  }

  // ---- signals → runs ----

  /** Signal a routine directly (tests, and every watcher above). */
  signalRoutine(projectId: string, routineId: string, source: string, own = false): boolean {
    const slot = this.slots.get(`${projectId}/${routineId}`);
    if (!slot) {
      return false;
    }
    this.signal(slot, source, own);
    return true;
  }

  private signal(slot: Slot, source: string, own: boolean): void {
    if (this.stopped) {
      return;
    }
    const h = slot.health.get(source);
    if (h) {
      h.lastSignalAt = new Date(this.now()).toISOString();
    }
    slot.pending.add(source);
    slot.ownPending ||= own;
    // While a run is in progress the signal waits: one follow-up run after it.
    if (!slot.timer && !slot.running && !slot.waiting) {
      this.schedule(slot, slot.events.debounceSeconds * 1000);
    }
  }

  private schedule(slot: Slot, ms: number): void {
    if (slot.timer) {
      clearTimeout(slot.timer);
    }
    const t = setTimeout(
      () => {
        slot.timer = null;
        void this.fire(slot);
      },
      Math.max(0, ms),
    );
    t.unref?.();
    slot.timer = t;
  }

  private drop(slot: Slot): void {
    slot.pending.clear();
    slot.ownPending = false;
  }

  private async fire(slot: Slot): Promise<void> {
    if (this.stopped || slot.pending.size === 0 || slot.running) {
      return;
    }
    const { project, routine } = slot;
    // stopAll / STOP file and a paused routine drop the signals (nothing is queued for later).
    if (
      globalStopRefusal(this.deps.home) ||
      routineState(project.id, routine.id, this.deps.home).paused
    ) {
      this.drop(slot);
      return;
    }
    // A run in progress (schedule, manual or event): queue ONE follow-up run after it.
    const inProgress = routineRunInProgress(project.id, routine.id);
    if (inProgress) {
      this.waitFor(slot, inProgress);
      return;
    }
    const now = this.now();
    slot.runStarts = slot.runStarts.filter((t) => now - t < HOUR_MS);
    if (slot.runStarts.length >= slot.events.maxRunsPerHour) {
      // Wait for the oldest run of the hour to leave the window; the signals stay pending.
      this.schedule(slot, slot.runStarts[0] + HOUR_MS - now);
      return;
    }
    if (slot.ownPending) {
      slot.loopRuns = slot.loopRuns.filter((t) => now - t < TRIGGER_LOOP_WINDOW_MS);
      if (slot.loopRuns.length >= TRIGGER_LOOP_MAX) {
        this.drop(slot);
        await this.pauseForLoop(slot);
        return;
      }
      slot.loopRuns.push(now);
    }
    const sources = [...slot.pending].toSorted();
    this.drop(slot);
    slot.runStarts.push(now);
    slot.running = true;
    try {
      const run = await this.deps.run(project, routine.id, {
        kind: "event",
        by: `trigger:${sources.join(",")}`.slice(0, 200),
        sources,
      });
      for (const id of run.workItems) {
        slot.outputs.add(id);
      }
      if (slot.outputs.size > OUTPUTS_MAX) {
        slot.outputs = new Set([...slot.outputs].slice(-OUTPUTS_MAX));
      }
      this.deps.onRun?.(project, routine.id, run);
    } catch (err) {
      if (err instanceof AutopilotRefused && err.code === "already_running") {
        // Lost a race with a run started elsewhere: keep the signals for one follow-up.
        slot.runStarts.pop();
        for (const s of sources) {
          slot.pending.add(s);
        }
        const p = routineRunInProgress(project.id, routine.id);
        if (p) {
          slot.running = false;
          this.waitFor(slot, p);
          return;
        }
      } else if (!(err instanceof AutopilotRefused)) {
        this.deps.log?.warn(`autopilot trigger run ${project.id}/${routine.id}: ${String(err)}`);
      }
    } finally {
      slot.running = false;
      slot.lastRunEndedAt = this.now();
    }
    if (slot.pending.size > 0 && !slot.timer && !slot.waiting) {
      this.schedule(slot, slot.events.debounceSeconds * 1000);
    }
  }

  private waitFor(slot: Slot, p: Promise<void>): void {
    if (slot.waiting) {
      return;
    }
    slot.waiting = true;
    void p.then(() => {
      slot.waiting = false;
      slot.lastRunEndedAt = this.now();
      if (!this.stopped && slot.pending.size > 0) {
        this.schedule(slot, 0);
      }
    });
  }

  private async pauseForLoop(slot: Slot): Promise<void> {
    const { project, routine } = slot;
    const at = new Date(this.now()).toISOString();
    const reason = `trigger_loop: triggered by its own outputs more than ${TRIGGER_LOOP_MAX} times in ${TRIGGER_LOOP_WINDOW_MS / 60_000} minutes`;
    let paused = false;
    updateRoutineState(
      project.id,
      routine.id,
      (cur) => {
        if (cur.paused) {
          return cur;
        }
        paused = true;
        return {
          ...cur,
          paused: true,
          pausedBy: TRIGGER_LOOP_PAUSED_BY,
          pausedAt: at,
          pauseReason: reason,
        };
      },
      this.deps.home,
    );
    if (!paused) {
      return;
    }
    slot.loopRuns = [];
    void auditSafe({
      identity: `autopilot:${routine.id}`,
      scope: project.id,
      action: "autopilot.watchdog.trip",
      outcome: "denied",
      source: "autopilot.triggers",
      detail: { routineId: routine.id, reasons: ["trigger_loop"] },
    });
    this.deps.onChanged?.(project.id, routine.id, "watchdog");
    this.refresh();
    try {
      await this.deps.onPaused?.(project, routine.id);
    } catch (err) {
      this.deps.log?.warn(`autopilot trigger pause resync: ${String(err)}`);
    }
  }

  // ---- views ----

  /** Health of the routine's event sources as the dispatcher sees them (null: not watched). */
  health(projectId: string, routineId: string): TriggerHealth[] | null {
    const slot = this.slots.get(`${projectId}/${routineId}`);
    return slot ? [...slot.health.values()].map((h) => ({ ...h })) : null;
  }

  /** Pending signals and timers (tests). */
  pendingOf(projectId: string, routineId: string): string[] {
    return [...(this.slots.get(`${projectId}/${routineId}`)?.pending ?? [])];
  }
}

let current: TriggerDispatcher | null = null;

export function startTriggerDispatcher(deps: DispatcherDeps): TriggerDispatcher {
  current?.stop();
  current = new TriggerDispatcher(deps);
  current.start();
  return current;
}

export function stopTriggerDispatcher(): void {
  current?.stop();
  current = null;
}

export function getTriggerDispatcher(): TriggerDispatcher | null {
  return current;
}

/**
 * The console's view of a routine's event triggers: the dispatcher's health, `disabled` when
 * the routine cannot run (paused, disabled, stopped) or no dispatcher runs in this process.
 */
export function triggerHealthView(
  projectId: string,
  routine: Routine,
  blocked: string | null,
): TriggerHealth[] {
  const specs = routine.trigger.events?.sources ?? [];
  const live = current?.health(projectId, routine.id) ?? null;
  return specs.map((spec) => {
    const key = sourceKey(spec);
    const h = live?.find((x) => x.source === key);
    if (blocked) {
      return {
        source: key,
        status: "disabled",
        lastSignalAt: h?.lastSignalAt ?? null,
        lastError: blocked,
      };
    }
    return (
      h ?? {
        source: key,
        status: "disabled",
        lastSignalAt: null,
        lastError: "trigger_dispatcher_not_running",
      }
    );
  });
}
