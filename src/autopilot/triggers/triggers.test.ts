import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { Project } from "../../projects/types.js";
import type { WorkItem } from "../../workitems/types.js";
import type { Reasoner } from "../reasoner.js";
import type { RunTriggerInput } from "../runner.js";
import type { RunRecord } from "../types.js";
import type { MailSubscription } from "./mail-source.js";
import { flushAudit } from "../../audit/audit-log.js";
import { createProject } from "../../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../../projects/templates.js";
import { emitWorkItemChange } from "../../workitems/events.js";
import { insertWorkItem, writeWorkItem } from "../../workitems/store.js";
import { emergencyStopFile, startAllRoutines, stopAllRoutines } from "../control.js";
import { syncRoutineJobs, type CronLike } from "../cron.js";
import { runEvidenceDir } from "../evidence.js";
import { filesFolderError, loadRoutines, parseRoutines } from "../routines.js";
import { runRoutine } from "../runner.js";
import { readRunSummaries, routineState, updateRoutineState } from "../store.js";
import { defaultWorkItemSink } from "../workitems-adapter.js";
import {
  sourceKey,
  startTriggerDispatcher,
  stopTriggerDispatcher,
  TRIGGER_LOOP_MAX,
  type TriggerDispatcher,
  triggerHealthView,
  workItemTriggerAction,
} from "./dispatcher.js";
import { FilesWatcher, ignoredFileChange } from "./files-watch.js";
import { registerMailWatchProvider, resetMailWatchProvidersForTests } from "./mail-source.js";
import { mailDeltaStore } from "./state.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-triggers-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const BASE = {
  id: "r1",
  edition: "business",
  area: "secretariat",
  gather: [],
  reasoning: { prompt: "mail-triage" },
  actions: ["workitem.intake"],
  level: "L1",
};
const doc = (routines: Array<Record<string, unknown>>) => YAML.stringify({ version: 1, routines });
const parseTrigger = (trigger: unknown) => parseRoutines(doc([{ ...BASE, trigger }]))[0].trigger;

let project: Project;
function writeRoutines(routines: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(project.folder, "context", "autopilot.yaml"), doc(routines));
}
function resetState(routineId: string) {
  updateRoutineState(project.id, routineId, () => ({ ...routineState(project.id, "__none__") }));
}

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-general-affairs",
  )!;
  project = createProject(
    { name: "GA", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
});

afterAll(async () => {
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("event trigger validation (fail closed)", () => {
  it("parses events with defaults, alongside a schedule or alone", () => {
    expect(
      parseTrigger({ schedule: "0 * * * *", tz: "Asia/Tokyo", event: [{ source: "m365.mail" }] }),
    ).toEqual({
      kind: "schedule",
      expr: "0 * * * *",
      tz: "Asia/Tokyo",
      events: {
        sources: [{ source: "m365.mail", folder: "inbox" }],
        debounceSeconds: 30,
        maxRunsPerHour: 12,
      },
    });
    expect(
      parseTrigger({
        event: [
          { source: "workitems", queue: "ga-requests", actions: ["created", "decided"] },
          { source: "workitems" },
          { source: "deadline", withinHours: 24 },
          { source: "files", folder: "inbox/scans/" },
        ],
        debounceSeconds: 5,
        maxRunsPerHour: 60,
      }),
    ).toEqual({
      kind: "event",
      tz: "Asia/Tokyo",
      events: {
        sources: [
          { source: "workitems", queue: "ga-requests", actions: ["created", "decided"] },
          {
            source: "workitems",
            queue: null,
            actions: ["created", "changed", "decided", "flag.clear"],
          },
          { source: "deadline", withinHours: 24 },
          { source: "files", folder: "inbox/scans" },
        ],
        debounceSeconds: 5,
        maxRunsPerHour: 60,
      },
    });
    expect(parseTrigger({ interval: 30 })).toEqual({ kind: "interval", minutes: 30 });
  });

  it.each([
    ["empty event list", { event: [] }, /1 to 8 sources/],
    ["unknown source", { event: [{ source: "slack" }] }, /source must be one of/],
    ["unknown key", { event: [{ source: "m365.mail", query: "x" }] }, /unknown key query/],
    ["folder traversal", { event: [{ source: "m365.mail", folder: "../x" }] }, /mail folder/],
    ["queue id", { event: [{ source: "workitems", queue: "Bad Queue" }] }, /queue/],
    ["unknown action", { event: [{ source: "workitems", actions: ["deleted"] }] }, /actions/],
    ["no actions", { event: [{ source: "workitems", actions: [] }] }, /actions/],
    ["deadline needs hours", { event: [{ source: "deadline" }] }, /withinHours is required/],
    ["deadline above a week", { event: [{ source: "deadline", withinHours: 169 }] }, /1 to 168/],
    ["deadline zero", { event: [{ source: "deadline", withinHours: 0 }] }, /1 to 168/],
    ["files absolute", { event: [{ source: "files", folder: "/etc" }] }, /Project-relative/],
    ["files traversal", { event: [{ source: "files", folder: "a/../../b" }] }, /Project-relative/],
    ["files missing", { event: [{ source: "files" }] }, /Project-relative/],
    ["debounce too short", { event: [{ source: "m365.mail" }], debounceSeconds: 4 }, /5 to 600/],
    ["debounce too long", { event: [{ source: "m365.mail" }], debounceSeconds: 601 }, /5 to 600/],
    ["runs per hour", { event: [{ source: "m365.mail" }], maxRunsPerHour: 61 }, /1 to 60/],
    ["debounce without events", { schedule: "0 * * * *", debounceSeconds: 30 }, /need an event/],
    ["nothing at all", {}, /schedule \(cron\), interval \(minutes\) or event/],
    [
      "too many sources",
      { event: Array.from({ length: 9 }, () => ({ source: "m365.mail" })) },
      /1 to 8/,
    ],
  ])("%s", (_name, trigger, re) => {
    expect(() => parseTrigger(trigger)).toThrow(re);
  });

  it("a files trigger must watch a read-only or writable Project folder, never the output", () => {
    const rules = { readOnly: ["context"], writable: ["output"] };
    expect(filesFolderError(rules, "context/inbox")).toBeNull();
    expect(filesFolderError(rules, "output/scans")).toBeNull();
    expect(filesFolderError(rules, "secrets")).toMatch(/not a read-only or writable folder/);
    expect(filesFolderError(rules, "output/autopilot")).toMatch(/own output/);
    expect(filesFolderError(rules, "output/autopilot/run1")).toMatch(/own output/);
    expect(filesFolderError({ readOnly: ["."], writable: [] }, "anything")).toBeNull();
    // loadRoutines checks it against the Project's own rules: the whole file is invalid.
    writeRoutines([
      { ...BASE, trigger: { event: [{ source: "files", folder: "not-a-project-folder" }] } },
    ]);
    const set = loadRoutines(project);
    expect(set.routines).toEqual([]);
    expect(set.error).toMatch(/files: not-a-project-folder is not a read-only or writable folder/);
  });

  it("an event-only routine gets no cron job (a job left from a scheduled version is removed)", async () => {
    const jobs: Array<{ id: string; name: string; enabled: boolean }> = [];
    const cron = {
      async list() {
        return jobs.map((j) => ({ ...j }));
      },
      async add(spec: { name: string; enabled: boolean }) {
        const job = { id: `job-${jobs.length + 1}`, name: spec.name, enabled: spec.enabled };
        jobs.push(job);
        return job;
      },
      async update(id: string) {
        return jobs.find((j) => j.id === id);
      },
      async remove(id: string) {
        jobs.splice(
          jobs.findIndex((j) => j.id === id),
          1,
        );
        return { ok: true, removed: true };
      },
    } as unknown as CronLike;
    writeRoutines([{ ...BASE, trigger: { schedule: "0 * * * *" } }]);
    expect((await syncRoutineJobs(cron, project)).added).toEqual(["r1"]);
    writeRoutines([{ ...BASE, trigger: { event: [{ source: "m365.mail" }] } }]);
    const res = await syncRoutineJobs(cron, project);
    expect(res.removed).toEqual(["r1"]);
    expect(jobs).toEqual([]);
    expect(routineState(project.id, "r1").cronJobId).toBeNull();
  });

  it("maps work item history actions and names sources", () => {
    expect(workItemTriggerAction("create")).toBe("created");
    expect(workItemTriggerAction("decide.approve")).toBe("decided");
    expect(workItemTriggerAction("flag.clear")).toBe("flag.clear");
    expect(workItemTriggerAction("draft")).toBe("changed");
    expect(sourceKey({ source: "workitems", queue: null, actions: ["created"] })).toBe(
      "workitems:*",
    );
    expect(sourceKey({ source: "deadline", withinHours: 4 })).toBe("deadline:4h");
  });
});

// ---- dispatcher ----

type RunCall = { routineId: string; trigger: RunTriggerInput };

function fakeRun(workItems: string[] = []) {
  const calls: RunCall[] = [];
  let gate: Promise<void> | null = null;
  const run = async (_p: Project, routineId: string, trigger: RunTriggerInput) => {
    calls.push({ routineId, trigger });
    if (gate) {
      await gate;
    }
    return { id: `r${calls.length}`, workItems } as unknown as RunRecord;
  };
  return {
    run,
    calls,
    hold() {
      let release!: () => void;
      gate = new Promise((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

let dispatcher: TriggerDispatcher | null = null;
function startDispatcher(run: ReturnType<typeof fakeRun>["run"], extra: object = {}) {
  dispatcher = startTriggerDispatcher({
    run,
    projects: () => [project],
    deadlineIntervalMs: 3_600_000,
    refreshIntervalMs: 3_600_000,
    ...extra,
  });
  return dispatcher;
}

function item(over: Partial<WorkItem> & { by?: string; action?: string }): WorkItem {
  const { by = "device:person", action = "create", ...rest } = over;
  return {
    id: "w000000000001",
    projectId: project.id,
    queue: "ga-requests",
    type: "request",
    title: "t",
    status: "new",
    dueAt: null,
    createdBy: by,
    revision: 1,
    history: [{ at: new Date().toISOString(), by, actorKind: "person", action }],
    ...rest,
  } as unknown as WorkItem;
}

describe("trigger dispatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState("r1");
    resetState("r2");
    fs.rmSync(emergencyStopFile(), { force: true });
  });
  afterEach(() => {
    stopTriggerDispatcher();
    dispatcher = null;
    vi.useRealTimers();
    resetMailWatchProvidersForTests();
    startAllRoutines("device:person", "test cleanup");
  });

  it("debounces a burst into ONE run that names every source", async () => {
    writeRoutines([
      {
        ...BASE,
        trigger: {
          schedule: "0 * * * *",
          event: [{ source: "workitems" }, { source: "deadline", withinHours: 2 }],
          debounceSeconds: 30,
        },
      },
    ]);
    const f = fakeRun();
    const d = startDispatcher(f.run);
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(10_000);
    d.signalRoutine(project.id, "r1", "deadline:2h");
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(19_000);
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].trigger).toEqual({
      kind: "event",
      by: "trigger:deadline:2h,workitems:*",
      sources: ["deadline:2h", "workitems:*"],
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls).toHaveLength(1);
  });

  it("respects maxRunsPerHour: later signals wait for a free slot, then coalesce", async () => {
    writeRoutines([
      {
        ...BASE,
        trigger: { event: [{ source: "workitems" }], debounceSeconds: 5, maxRunsPerHour: 2 },
      },
    ]);
    const f = fakeRun();
    const d = startDispatcher(f.run);
    for (let i = 0; i < 2; i++) {
      d.signalRoutine(project.id, "r1", "workitems:*");
      await vi.advanceTimersByTimeAsync(6_000);
    }
    expect(f.calls).toHaveLength(2);
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(6_000);
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.calls).toHaveLength(2);
    expect(d.pendingOf(project.id, "r1")).toEqual(["workitems:*"]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.calls).toHaveLength(3);
  });

  it("filters work item events by queue and action, and ignores the routine's own changes", async () => {
    writeRoutines([
      {
        ...BASE,
        trigger: {
          event: [{ source: "workitems", queue: "ga-requests", actions: ["created", "decided"] }],
          debounceSeconds: 5,
        },
      },
    ]);
    const f = fakeRun();
    const d = startDispatcher(f.run);
    emitWorkItemChange(item({ by: "autopilot:r1" }));
    emitWorkItemChange(item({ queue: "other-queue" }));
    emitWorkItemChange(item({ action: "draft" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls).toHaveLength(0);
    // A real write through the store reaches the trigger too.
    insertWorkItem(item({ id: "w000000000009", by: "device:person", action: "decide.approve" }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].trigger.sources).toEqual(["workitems:ga-requests"]);
    const h = triggerHealthView(project.id, loadRoutines(project).routines[0], null);
    expect(h).toEqual([
      expect.objectContaining({ source: "workitems:ga-requests", status: "active" }),
    ]);
    expect(h[0].lastSignalAt).not.toBeNull();
    void d;
  });

  it("pauses a routine triggered by its own outputs too often (trigger_loop)", async () => {
    writeRoutines([
      {
        ...BASE,
        trigger: { event: [{ source: "workitems" }], debounceSeconds: 5, maxRunsPerHour: 60 },
      },
    ]);
    const f = fakeRun(["w000000000001"]);
    const paused: string[] = [];
    const changed: string[] = [];
    startDispatcher(f.run, {
      onPaused: (_p: Project, id: string) => void paused.push(id),
      onChanged: (_p: string, _r: string | null, kind: string) => void changed.push(kind),
    });
    // A person's change starts the first run; the run "produces" w000000000001.
    emitWorkItemChange(item({ id: "w000000000002" }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(1);
    // Every later change of that output (by the system sweep) counts as the routine's own.
    for (let i = 0; i < TRIGGER_LOOP_MAX + 1; i++) {
      emitWorkItemChange(item({ by: "system", action: "stage.overdue" }));
      await vi.advanceTimersByTimeAsync(6_000);
    }
    expect(f.calls).toHaveLength(1 + TRIGGER_LOOP_MAX);
    const s = routineState(project.id, "r1");
    expect(s).toMatchObject({ paused: true, pausedBy: "watchdog" });
    expect(s.pauseReason).toMatch(/^trigger_loop/);
    expect(paused).toEqual(["r1"]);
    expect(changed).toContain("watchdog");
    // Paused: signals are dropped.
    emitWorkItemChange(item({ id: "w000000000003" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls).toHaveLength(1 + TRIGGER_LOOP_MAX);
    const view = triggerHealthView(
      project.id,
      loadRoutines(project).routines[0],
      "paused_by_watchdog",
    );
    expect(view[0]).toMatchObject({ status: "disabled", lastError: "paused_by_watchdog" });
  });

  it("the STOP file and stopAll block event runs (signals are dropped, not queued)", async () => {
    writeRoutines([{ ...BASE, trigger: { event: [{ source: "workitems" }], debounceSeconds: 5 } }]);
    const f = fakeRun();
    const d = startDispatcher(f.run);
    fs.mkdirSync(path.dirname(emergencyStopFile()), { recursive: true });
    fs.writeFileSync(emergencyStopFile(), "");
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls).toHaveLength(0);
    expect(d.pendingOf(project.id, "r1")).toEqual([]);
    fs.rmSync(emergencyStopFile());
    stopAllRoutines("device:person", "incident");
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls).toHaveLength(0);
    startAllRoutines("device:person", "over");
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls).toHaveLength(1);
  });

  it("queues ONE follow-up run while the routine is running (never drops, never doubles)", async () => {
    writeRoutines([{ ...BASE, trigger: { event: [{ source: "workitems" }], debounceSeconds: 5 } }]);
    const f = fakeRun();
    const d = startDispatcher(f.run);
    const release = f.hold();
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      d.signalRoutine(project.id, "r1", "workitems:*");
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(f.calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls).toHaveLength(2);
  });

  it("waits for a run started elsewhere (already_running) and then runs once", async () => {
    writeRoutines([
      {
        ...BASE,
        trigger: { schedule: "0 * * * *", event: [{ source: "workitems" }], debounceSeconds: 5 },
      },
    ]);
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const reasoner: Reasoner = {
      async reason() {
        await blocked;
        return { text: JSON.stringify({ items: [] }), backend: "fake", model: null };
      },
    };
    const runnerDeps = {
      cfg: {},
      reasoner,
      tools: async () => ({ ok: false as const, error: "no tools" }),
      workItems: defaultWorkItemSink(),
      defaultAgentId: "main",
    };
    const scheduled = runRoutine(runnerDeps, project, "r1", { kind: "schedule", by: "cron:x" });
    const f = fakeRun();
    const d = startDispatcher(f.run);
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(6_000);
    d.signalRoutine(project.id, "r1", "workitems:*");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(0);
    release();
    await scheduled;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.calls).toHaveLength(1);
  });

  it("records trigger=event and the sources on the run record and its evidence", async () => {
    writeRoutines([{ ...BASE, trigger: { event: [{ source: "workitems" }], debounceSeconds: 5 } }]);
    vi.useRealTimers();
    const reasoner: Reasoner = {
      async reason() {
        return { text: JSON.stringify({ items: [] }), backend: "fake", model: null };
      },
    };
    const run = await runRoutine(
      {
        cfg: {},
        reasoner,
        tools: async () => ({ ok: false as const, error: "no tools" }),
        workItems: defaultWorkItemSink(),
        defaultAgentId: "main",
      },
      project,
      "r1",
      { kind: "event", by: "trigger:workitems:*", sources: ["workitems:*"] },
    );
    expect(run).toMatchObject({ trigger: "event", triggerSources: ["workitems:*"] });
    expect(readRunSummaries(project.id).at(-1)).toMatchObject({
      trigger: "event",
      triggerSources: ["workitems:*"],
    });
    const events = fs.readFileSync(
      path.join(runEvidenceDir(project.id, run.id), "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"triggerSources":["workitems:*"]');
  });

  it("signals a deadline once per item window", async () => {
    writeRoutines([
      { ...BASE, trigger: { event: [{ source: "deadline", withinHours: 1 }], debounceSeconds: 5 } },
    ]);
    const now = Date.now();
    const soon = new Date(now + 30 * 60_000).toISOString();
    const later = new Date(now + 5 * 3_600_000).toISOString();
    insertWorkItem(item({ id: "w0000000000d1", dueAt: soon }));
    insertWorkItem(item({ id: "w0000000000d2", dueAt: later }));
    insertWorkItem(item({ id: "w0000000000d3", dueAt: soon, status: "done" }));
    const f = fakeRun();
    const d = startDispatcher(f.run);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].trigger.sources).toEqual(["deadline:1h"]);
    d.checkDeadlines();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(1);
    // A new due date is a new window.
    writeWorkItem(item({ id: "w0000000000d2", dueAt: soon, revision: 2 }));
    d.checkDeadlines();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls).toHaveLength(2);
    // A restarted dispatcher remembers the windows it signalled.
    d.stop();
    const f2 = fakeRun();
    startDispatcher(f2.run);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f2.calls).toHaveLength(0);
  });

  it("m365.mail: subscribes once per Project folder, signals on new mail, surfaces degraded", async () => {
    writeRoutines([
      {
        ...BASE,
        trigger: { schedule: "0 * * * *", event: [{ source: "m365.mail" }], debounceSeconds: 5 },
      },
      {
        ...BASE,
        id: "r2",
        trigger: { event: [{ source: "m365.mail", folder: "inbox" }], debounceSeconds: 5 },
      },
    ]);
    const f = fakeRun();
    const changed: string[] = [];
    const d = startDispatcher(f.run, {
      onChanged: (_p: string, r: string | null, kind: string) => void changed.push(`${kind}:${r}`),
    });
    const routines = loadRoutines(project).routines;
    expect(triggerHealthView(project.id, routines[0], null)[0]).toMatchObject({
      source: "m365.mail:inbox",
      status: "disabled",
      lastError: "connector_not_enabled",
    });
    const subs: MailSubscription[] = [];
    registerMailWatchProvider({
      source: "m365.mail",
      connector: "microsoft-365",
      subscribe: (s) => {
        subs.push(s);
        s.onHealth({ status: "active", error: null });
        return () => {};
      },
    });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ key: `${project.id}:inbox`, folder: "inbox" });
    expect(triggerHealthView(project.id, routines[1], null)[0].status).toBe("active");
    subs[0].onNewMail(3);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.calls.map((c) => c.routineId).toSorted()).toEqual(["r1", "r2"]);
    subs[0].onHealth({ status: "degraded", error: "reauth_required" });
    expect(triggerHealthView(project.id, routines[0], null)[0]).toMatchObject({
      status: "degraded",
      lastError: "reauth_required",
    });
    expect(changed).toContain("trigger:r1");
    // The delta link lives in the Project data dir, nothing else.
    subs[0].store.write("https://graph.microsoft.com/v1.0/x?$deltatoken=1");
    expect(mailDeltaStore(project.id, "inbox").read()).toMatch(/deltatoken=1/);
    void d;
  });
});

describe("files watcher", () => {
  it("ignores the routines' output folder, hidden files and temporaries", () => {
    expect(ignoredFileChange("output/autopilot/r1/1/a.docx")).toBe(true);
    expect(ignoredFileChange("output/autopilot")).toBe(true);
    expect(ignoredFileChange("docs/.git/index")).toBe(true);
    expect(ignoredFileChange("docs/~$report.docx")).toBe(true);
    expect(ignoredFileChange("docs/a.tmp")).toBe(true);
    expect(ignoredFileChange("docs/report.docx")).toBe(false);
    expect(ignoredFileChange("output/report.docx")).toBe(false);
  });

  it("polling fallback signals changes but not writes to output/autopilot", () => {
    const folder = fs.mkdtempSync(path.join(root, "files-"));
    fs.mkdirSync(path.join(folder, "output", "autopilot"), { recursive: true });
    fs.mkdirSync(path.join(folder, "docs"));
    let changes = 0;
    const health: string[] = [];
    const w = new FilesWatcher({
      projectFolder: folder,
      folder: ".",
      mode: "poll",
      pollMs: 3_600_000,
      onChange: () => changes++,
      onHealth: (h) => health.push(h.status),
    });
    w.start();
    expect(w.polling).toBe(true);
    expect(health).toEqual(["active"]);
    fs.writeFileSync(path.join(folder, "output", "autopilot", "a.docx"), "x");
    expect(w.poll()).toBe(false);
    fs.writeFileSync(path.join(folder, "docs", "in.pdf"), "x");
    expect(w.poll()).toBe(true);
    expect(w.poll()).toBe(false);
    fs.rmSync(path.join(folder, "docs", "in.pdf"));
    expect(w.poll()).toBe(true);
    expect(changes).toBe(2);
    w.close();
  });

  it("a missing folder is degraded, not a crash", () => {
    const health: Array<string | null> = [];
    const w = new FilesWatcher({
      projectFolder: root,
      folder: "does-not-exist",
      onChange: () => {},
      onHealth: (h) => health.push(h.error),
    });
    w.start();
    expect(health).toEqual(["folder_missing"]);
    w.close();
  });
});
