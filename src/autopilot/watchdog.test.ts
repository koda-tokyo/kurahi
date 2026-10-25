import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Project } from "../projects/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { flushAudit } from "../audit/audit-log.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { readWorkItem } from "../workitems/store.js";
import {
  emergencyStopFile,
  readGlobalControl,
  startAllRoutines,
  stopAllRoutines,
} from "./control.js";
import { runEvidenceDir } from "./evidence.js";
import { ReasonerToolUse } from "./reasoner.js";
import { runRoutine } from "./runner.js";
import { routineState, updateRoutineState } from "./store.js";
import { AutopilotRefused } from "./types.js";
import {
  evaluateWatchdog,
  p95,
  staticCaps,
  watchdogThresholds,
  type RunMetrics,
} from "./watchdog.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-wd-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

let calls: ToolCall[] = [];
let ids: string[] = [];
let attachmentVerdict: "accepted" | "refused" = "accepted";
const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool === "m365_mail_list") {
    return {
      ok: true,
      text: ids
        .map((id, i) => `${i + 1}. id: ${id}\n   from: A <a@client.example.jp>\n   subject: s\n`)
        .join(""),
      pluginId: "microsoft-365",
    };
  }
  if (call.tool === "m365_mail_read") {
    const id = String(call.args.id);
    return {
      ok: true,
      text: `body of ${id}\nattachment: ${id}|A1 | name: x.pdf | size: 10 | contentType: application/pdf`,
      pluginId: "microsoft-365",
    };
  }
  if (call.tool === "m365_mail_attachment_fetch") {
    const [messageId, attachmentId] = String(call.args.ref).split("|");
    return {
      ok: true,
      text: attachmentVerdict === "accepted" ? "stored: inbox-attachments/x.pdf" : "refused",
      pluginId: "microsoft-365",
      details: {
        attachment:
          attachmentVerdict === "accepted"
            ? { status: "accepted", messageId, attachmentId, path: "inbox-attachments/x.pdf" }
            : { status: "refused", code: "infected", stage: "scan", messageId, attachmentId },
      },
    };
  }
  if (call.tool === "m365_mail_create_draft") {
    return {
      ok: true,
      text: "Created draft",
      details: { id: `d-${calls.length}` },
      pluginId: "microsoft-365",
    };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};

let reply: Json | (() => Promise<Json>) = { items: [] };
const reasoner: Reasoner = {
  async reason() {
    const r = typeof reply === "function" ? await reply() : reply;
    return { text: JSON.stringify(r), backend: "fake", model: null };
  },
};

let project: Project;
const deps = () => ({
  cfg: {},
  reasoner,
  tools,
  workItems: defaultWorkItemSink(),
  defaultAgentId: "main",
});
const manual = { kind: "manual" as const, by: "device:person" };
const draft = (to = "a@client.example.jp") => ({
  kind: "mail.draft",
  args: { to: [to], subject: "Re", body: "ok" },
});

const ROUTINE = {
  id: "inbox",
  edition: "business",
  area: "secretariat",
  trigger: { schedule: "*/15 * * * *", tz: "Asia/Tokyo" },
  gather: [
    { id: "list", tool: "m365_mail_list", args: { top: 25 } },
    {
      id: "mail",
      tool: "m365_mail_read",
      each: { from: "list", match: "id: (\\S+)", arg: "id", max: 10 },
    },
  ],
  reasoning: { prompt: "mail-triage" },
  actions: ["workitem.intake", "mail.draft"],
  level: "L1",
  queue: "ga-requests",
  limits: { maxItemsPerRun: 10, maxActionsPerDay: 500 },
};

function writeRoutines(routines: Array<Record<string, unknown>>) {
  fs.writeFileSync(
    path.join(project.folder, "context", "autopilot.yaml"),
    YAML.stringify({ version: 1, routines }),
  );
}
function resetState(routineId = "inbox") {
  updateRoutineState(project.id, routineId, () => ({ ...routineState(project.id, "__none__") }));
}
let n = 0;
const fresh = (count: number) => {
  ids = Array.from({ length: count }, () => `w${++n}`);
  return ids;
};

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
  writeRoutines([ROUTINE]);
});

beforeEach(() => {
  calls = [];
  attachmentVerdict = "accepted";
  fs.rmSync(emergencyStopFile(), { force: true });
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

const metric = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  runId: "r",
  at: "",
  gatherCalls: 3,
  bytesRead: 300,
  items: 2,
  actions: 2,
  actionsByKind: { "mail.draft": 2 },
  durationMs: 100,
  ...over,
});

describe("watchdog thresholds", () => {
  const routine = {
    gather: [
      { id: "a", tool: "x", args: {} },
      { id: "b", tool: "y", args: {}, each: { from: "a", match: "(x)", arg: "id", max: 4 } },
    ],
    limits: { maxItemsPerRun: 3, maxActionsPerDay: 100 },
    actions: ["mail.draft", "workitem.intake"],
    reasoning: {
      promptId: null,
      prompt: "",
      schemaId: "autopilot.plan.v1",
      backend: null,
      model: null,
      timeoutSeconds: 60,
    },
  };

  it("static caps come from the routine file", () => {
    expect(staticCaps(routine)).toEqual({
      values: { gatherCalls: 5, bytesRead: 60_000, items: 4, actions: 8, durationMs: 360_000 },
      perKind: 4,
    });
    expect(watchdogThresholds(routine, [metric(), metric()]).source).toBe("static");
  });

  it("after 5 runs: max(3 x p95, static cap)", () => {
    expect(p95([1, 2, 3, 4, 100])).toBe(100);
    const history = Array.from({ length: 6 }, () => metric({ items: 3, actions: 4 }));
    const t = watchdogThresholds(routine, history);
    expect(t.source).toBe("baseline");
    expect(t.values.items).toBe(9);
    expect(t.values.actions).toBe(12);
    expect(t.values.gatherCalls).toBe(9);
    expect(t.values.durationMs).toBe(360_000);
    const v = evaluateWatchdog(routine, history, metric({ items: 10 }), {
      refusals: 0,
      offRoutine: [],
      toolUseStreak: 0,
    });
    expect(v.tripped).toBe(true);
    expect(v.reasons[0]).toMatch(/^items 10 > 9 \(baseline\)/);
  });

  it("trips on a refusal burst, an off-routine action and repeated tool use", () => {
    const quiet = { refusals: 0, offRoutine: [], toolUseStreak: 0 };
    expect(evaluateWatchdog(routine, [], metric(), quiet).tripped).toBe(false);
    expect(evaluateWatchdog(routine, [], metric(), { ...quiet, refusals: 6 }).reasons).toEqual([
      "refusal burst: 6 refusals in one run",
    ]);
    expect(
      evaluateWatchdog(routine, [], metric(), { ...quiet, offRoutine: ["mail.send"] }).reasons[0],
    ).toMatch(/outside the routine.*mail\.send/);
    expect(evaluateWatchdog(routine, [], null, { ...quiet, toolUseStreak: 1 }).tripped).toBe(false);
    expect(evaluateWatchdog(routine, [], null, { ...quiet, toolUseStreak: 2 }).tripped).toBe(true);
  });
});

describe("watchdog in runs", () => {
  async function baseline(runs: number) {
    for (let i = 0; i < runs; i++) {
      const [a] = fresh(1);
      reply = { items: [{ ref: a, title: "t", summary: "", actions: [draft()] }] };
      const run = await runRoutine(deps(), project, "inbox", manual);
      expect(run.watchdog?.tripped).toBe(false);
    }
  }

  it("builds a baseline, then a volume spike executes nothing, pauses and escalates", async () => {
    resetState();
    await baseline(5);
    const s = routineState(project.id, "inbox");
    expect(s.watchdog.history).toHaveLength(5);
    expect(s.paused).toBe(false);
    // 5 messages, each with 4 drafts: actions 20 > max(3 x 1, 10 x 2) and mail.draft 20 > 10.
    const many = fresh(5);
    reply = {
      items: many.map((id) => ({
        ref: id,
        title: "t",
        summary: "",
        actions: [draft(), draft(), draft(), draft()],
      })),
    };
    calls = [];
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.watchdog).toMatchObject({ tripped: true, baseline: "baseline" });
    expect(run.watchdog?.reasons.join(" ")).toMatch(/mail\.draft 20 > 10/);
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    expect(run.actions.every((a) => !a.executed)).toBe(true);
    expect(run.actions.every((a) => a.code === "watchdog_hold")).toBe(true);
    expect(run.status).toBe("escalated");
    const state = routineState(project.id, "inbox");
    expect(state).toMatchObject({ paused: true, pausedBy: "watchdog" });
    expect(state.watchdog.lastTrip?.runId).toBe(run.id);
    expect(state.watchdog.history).toHaveLength(5);
    const anomaly = readWorkItem(project.id, run.workItems.at(-1)!)!;
    expect(anomaly.title).toMatch(/watchdog paused routine inbox/);
    expect(String(anomaly.source.fields.awaitingPerson)).toMatch(/behaviour watchdog/);
    const v = await verifyEvidenceBundle(runEvidenceDir(project.id, run.id));
    expect(v.ok).toBe(true);
    const events = fs
      .readFileSync(path.join(runEvidenceDir(project.id, run.id), "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      events.some((e) => e.type === "loop_guard" && e.data.guard === "autopilot.watchdog"),
    ).toBe(true);
    // Paused: the next run is refused until a person resumes.
    await expect(runRoutine(deps(), project, "inbox", manual)).rejects.toMatchObject({
      code: "paused",
    });
  });

  it("trips on a refusal burst (no baseline needed) and executes nothing", async () => {
    resetState();
    const [a] = fresh(1);
    reply = {
      items: [
        {
          ref: a,
          title: "t",
          summary: "",
          actions: [
            draft(),
            ...Array.from({ length: 6 }, () => ({ kind: "mail.draft", args: { to: "bad" } })),
          ],
        },
      ],
    };
    calls = [];
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.watchdog?.reasons.join(" ")).toMatch(/refusal burst: 6/);
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    expect(routineState(project.id, "inbox").pausedBy).toBe("watchdog");
  });

  it("trips on repeated reasoner tool-call attempts", async () => {
    resetState();
    reply = async () => {
      throw new ReasonerToolUse("reasoning backend reported tool use (exec); output discarded");
    };
    fresh(1);
    const first = await runRoutine(deps(), project, "inbox", manual);
    expect(first.status).toBe("failed");
    expect(first.watchdog?.tripped).toBe(false);
    expect(routineState(project.id, "inbox").watchdog.toolUseStreak).toBe(1);
    fresh(1);
    const second = await runRoutine(deps(), project, "inbox", manual);
    expect(second.watchdog?.tripped).toBe(true);
    expect(routineState(project.id, "inbox")).toMatchObject({ paused: true, pausedBy: "watchdog" });
    expect(second.workItems).toHaveLength(1);
  });
});

describe("malicious attachments in autopilot runs", () => {
  const WITH_ATTACHMENTS = {
    ...ROUTINE,
    gather: [
      ...ROUTINE.gather,
      {
        id: "att",
        tool: "m365_mail_attachment_fetch",
        each: { from: "mail", match: "attachment: (\\S+)", arg: "ref", max: 10 },
      },
    ],
  };

  it("a refused attachment flags the item malicious_attachment; nothing is drafted", async () => {
    writeRoutines([WITH_ATTACHMENTS]);
    resetState();
    attachmentVerdict = "refused";
    const [a] = fresh(1);
    reply = { items: [{ ref: a, title: "Invoice", summary: "see attached", actions: [draft()] }] };
    calls = [];
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(calls.map((c) => c.tool)).toContain("m365_mail_attachment_fetch");
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    expect(run.actions[0]).toMatchObject({ decision: "refuse", code: "flagged" });
    const item = readWorkItem(project.id, run.workItems[0])!;
    expect(item.flags).toEqual(["malicious_attachment"]);
    writeRoutines([ROUTINE]);
  });

  it("a message with a refused attachment that no item covers still reaches a person", async () => {
    writeRoutines([WITH_ATTACHMENTS]);
    resetState();
    attachmentVerdict = "refused";
    fresh(1);
    reply = { items: [] };
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.workItems).toHaveLength(1);
    const item = readWorkItem(project.id, run.workItems[0])!;
    expect(item.flags).toEqual(["malicious_attachment"]);
    expect(item.title).toMatch(/Attachment refused/);
    writeRoutines([ROUTINE]);
  });

  it("an accepted attachment adds no flag", async () => {
    writeRoutines([WITH_ATTACHMENTS]);
    resetState();
    const [a] = fresh(1);
    reply = { items: [{ ref: a, title: "Invoice", summary: "", actions: [draft()] }] };
    calls = [];
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(true);
    expect(run.actions[0].executed).toBe(true);
    writeRoutines([ROUTINE]);
  });
});

describe("global kill switch", () => {
  it("stopAll pauses every routine and blocks runs; startAll resumes only what it paused", async () => {
    writeRoutines([ROUTINE, { ...ROUTINE, id: "other" }]);
    resetState("inbox");
    resetState("other");
    updateRoutineState(project.id, "other", (cur) => ({
      ...cur,
      paused: true,
      pausedBy: "device:person",
      pauseReason: "holiday",
    }));
    const stopped = stopAllRoutines("device:person", "incident drill");
    expect(stopped.control).toMatchObject({ stopped: true, by: "device:person" });
    expect(stopped.paused.find((c) => c.projectId === project.id)?.routineIds).toEqual(["inbox"]);
    expect(routineState(project.id, "inbox")).toMatchObject({ paused: true, pausedBy: "stopAll" });
    // Even an unpaused routine is blocked while the global stop holds.
    resetState("inbox");
    await expect(runRoutine(deps(), project, "inbox", manual)).rejects.toMatchObject({
      code: "stopped_all",
    });
    updateRoutineState(project.id, "inbox", (cur) => ({
      ...cur,
      paused: true,
      pausedBy: "stopAll",
    }));
    const started = startAllRoutines("device:person", "drill over");
    expect(started.control.stopped).toBe(false);
    expect(routineState(project.id, "inbox").paused).toBe(false);
    expect(routineState(project.id, "other")).toMatchObject({
      paused: true,
      pausedBy: "device:person",
    });
    writeRoutines([ROUTINE]);
  });

  it("the STOP file blocks every run without the gateway", async () => {
    resetState();
    fs.mkdirSync(path.dirname(emergencyStopFile()), { recursive: true });
    fs.writeFileSync(emergencyStopFile(), "");
    expect(readGlobalControl().emergencyStop).toBe(true);
    fresh(1);
    const err = await runRoutine(deps(), project, "inbox", manual).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutopilotRefused);
    expect((err as AutopilotRefused).code).toBe("emergency_stop");
    fs.rmSync(emergencyStopFile());
  });

  it("a stop set while the model reasons: the run executes nothing", async () => {
    resetState();
    const [a] = fresh(1);
    reply = async () => {
      fs.mkdirSync(path.dirname(emergencyStopFile()), { recursive: true });
      fs.writeFileSync(emergencyStopFile(), "");
      return { items: [{ ref: a, title: "t", summary: "", actions: [draft()] }] };
    };
    calls = [];
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.status).toBe("skipped");
    expect(run.reason).toMatch(/emergency_stop/);
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    fs.rmSync(emergencyStopFile());
    // Nothing was acted on: the message is read again next time.
    reply = { items: [] };
    calls = [];
    await runRoutine(deps(), project, "inbox", manual);
    expect(calls.filter((c) => c.tool === "m365_mail_read")).toHaveLength(1);
  });
});
