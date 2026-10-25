import { Value } from "@sinclair/typebox/value";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { Project } from "../projects/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import { AutopilotAutonomyChangeSchema } from "../gateway/protocol/schema/autopilot.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { createWorkItem } from "../workitems/lifecycle.js";
import { createStandingApproval } from "./approvals.js";
import { acceptAutonomyProposal, reportAutopilotError } from "./autonomy-level.js";
import { autonomyProposals } from "./earned-autonomy.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./runner.js";
import {
  autonomyChangeDir,
  readAutonomyChanges,
  routineState,
  updateRoutineState,
} from "./store.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const mocks = vi.hoisted(() => ({
  corrections: new Map<string, { items: number; corrected: number }>(),
  audit: vi.fn(async (_e: { action: string }) => {}),
}));
vi.mock("./workitems-adapter.js", async (orig) => ({
  ...(await orig<typeof import("./workitems-adapter.js")>()),
  autopilotCorrections: () => mocks.corrections,
}));
vi.mock("../audit/audit-log.js", async (orig) => ({
  ...(await orig<typeof import("../audit/audit-log.js")>()),
  auditSafe: mocks.audit,
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autonomy-level-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

let calls: ToolCall[] = [];
const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool === "m365_mail_list") {
    return { ok: true, text: "1. id: m1\n", pluginId: "microsoft-365" };
  }
  if (call.tool === "m365_mail_create_draft") {
    return { ok: true, text: "Created draft", details: { id: "d1" }, pluginId: "microsoft-365" };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};
let reply: Json = { items: [] };
const reasoner: Reasoner = {
  async reason() {
    return { text: JSON.stringify(reply), backend: "fake", model: null };
  },
};
const deps = () => ({
  cfg: {},
  reasoner,
  tools,
  workItems: defaultWorkItemSink(),
  defaultAgentId: "main",
});
const manual = { kind: "manual" as const, by: "device:person" };
const person = { id: "device:person", kind: "person" as const };

const base = {
  edition: "business",
  area: "secretariat",
  trigger: { schedule: "*/15 * * * *", tz: "Asia/Tokyo" },
  gather: [{ id: "list", tool: "m365_mail_list", args: { top: 5 } }],
  reasoning: { prompt: "mail-triage" },
  queue: "ga-requests",
};
const ROUTINES = [
  { ...base, id: "replies", actions: ["workitem.intake", "mail.draft"], level: "L2" },
  { ...base, id: "sender", actions: ["workitem.intake", "mail.draft", "mail.send"], level: "L3" },
  { ...base, id: "low", actions: ["workitem.intake", "mail.draft", "mail.send"], level: "L1" },
];

let project: Project;

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "context", "autopilot.yaml"),
    YAML.stringify({ version: 1, routines: ROUTINES }),
  );
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-general-affairs",
  )!;
  project = createProject(
    { name: "GA", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
});

afterAll(() => {
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

function reset(routineId: string, over: Record<string, unknown> = {}) {
  updateRoutineState(project.id, routineId, () => ({
    ...routineState(project.id, "__none__"),
    ...over,
  }));
}
const override = (level: string) => ({
  override: {
    level,
    kind: "demoted",
    by: "watchdog",
    at: "2026-10-01T00:00:00.000Z",
    reason: "x",
    changeId: "cxxxxxxxxxxxxxx",
  },
});
const changesOf = (routineId: string) =>
  readAutonomyChanges(project.id).filter((c) => c.routineId === routineId);
const accept = (over: Record<string, unknown> = {}, actor: { id: string; kind: string } = person) =>
  acceptAutonomyProposal(
    project,
    {
      routineId: "replies",
      kind: "promote",
      proposed: "L2",
      reason: "steady for a month",
      ...over,
    },
    actor as typeof person,
  );

beforeEach(() => {
  calls = [];
  mocks.audit.mockClear();
  mocks.corrections = new Map();
});

describe("autopilot.autonomy.accept", () => {
  it("raises the effective level to the accepted one, with evidence and an audit entry", async () => {
    reset("replies", override("L1"));
    // 30 items, none corrected: promote L1 → L2 (the file's level).
    mocks.corrections = new Map([["replies", { items: 30, corrected: 0 }]]);
    const [p] = autonomyProposals(
      project.id,
      loadRoutines(project).routines.filter((r) => r.id === "replies"),
    );
    expect(p).toMatchObject({ current: "L1", kind: "promote", proposed: "L2", fileLevel: "L2" });
    expect(p.acceptBlocker).toBeNull();
    const out = accept();
    expect(out.effectiveLevel).toBe("L2");
    expect(out.change).toMatchObject({ kind: "accept", from: "L1", to: "L2", by: person.id });
    expect(Value.Check(AutopilotAutonomyChangeSchema, out.change)).toBe(true);
    // Accepting the file's own level clears the override: the routine follows its file again.
    expect(routineState(project.id, "replies").override).toBeNull();
    const v = await verifyEvidenceBundle(
      path.join(autonomyChangeDir(project.id, out.change.id), "evidence"),
    );
    expect(v.ok).toBe(true);
    expect(changesOf("replies").at(-1)?.evidence?.root).toBe(out.change.evidence?.root);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "autopilot.autonomy.accept", identity: person.id }),
    );
  });

  it("stores an accepted level below the file's level as the override", () => {
    reset("replies");
    // 12 items, 4 corrected: demote L2 → L1.
    mocks.corrections = new Map([["replies", { items: 12, corrected: 4 }]]);
    accept({ kind: "demote", proposed: "L1" });
    expect(routineState(project.id, "replies").override).toMatchObject({
      level: "L1",
      kind: "accepted",
      by: person.id,
    });
  });

  it.each([
    [{}, { id: "agent:x", kind: "agent" }, "not_a_person"],
    [{ reason: " ok " }, person, "reason_required"],
    [{ kind: "demote", proposed: "L1" }, person, "proposal_changed"],
    [{ proposed: "L3" }, person, "proposal_changed"],
  ])("refuses %o by %o (%s) and records nothing", (over, actor, code) => {
    reset("replies", override("L1"));
    mocks.corrections = new Map([["replies", { items: 30, corrected: 0 }]]);
    const before = changesOf("replies").length;
    expect(() => accept(over, actor)).toThrow(expect.objectContaining({ code }) as Error);
    expect(changesOf("replies")).toHaveLength(before);
    expect(routineState(project.id, "replies").override?.level).toBe("L1");
  });

  it("has nothing to accept on a hold", () => {
    reset("replies");
    expect(() => accept()).toThrow(expect.objectContaining({ code: "nothing_to_accept" }) as Error);
  });

  it("never goes above the routine file's level", () => {
    reset("replies");
    // At the file's level L2 with a clean record: the proposal is L3, which the file forbids.
    mocks.corrections = new Map([["replies", { items: 30, corrected: 0 }]]);
    const [p] = autonomyProposals(
      project.id,
      loadRoutines(project).routines.filter((r) => r.id === "replies"),
    );
    expect(p).toMatchObject({ proposed: "L3", acceptBlocker: "above_file_level" });
    expect(() => accept({ proposed: "L3" })).toThrow(
      expect.objectContaining({ code: "above_file_level" }) as Error,
    );
    expect(routineState(project.id, "replies").override).toBeNull();
  });

  it("an override above the file's level has no effect", async () => {
    reset("low", { override: { ...override("L3").override, kind: "accepted" } });
    reply = {
      items: [
        {
          ref: "m1",
          title: "t",
          summary: "",
          actions: [
            { kind: "mail.send", args: { to: ["a@client.example.jp"], subject: "s", body: "b" } },
          ],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "low", manual);
    expect(run.level).toBe("L1");
    expect(run.actions[0]).toMatchObject({ decision: "needs_person", code: "level_too_low" });
    expect(calls.some((c) => c.tool === "m365_mail_send")).toBe(false);
  });

  it("a promotion to L3 needs an active standing approval for the routine", () => {
    reset("sender", override("L2"));
    mocks.corrections = new Map([["sender", { items: 30, corrected: 0 }]]);
    const go = () => accept({ routineId: "sender", proposed: "L3" });
    expect(() => go()).toThrow(expect.objectContaining({ code: "no_standing_approval" }) as Error);
    expect(routineState(project.id, "sender").override?.level).toBe("L2");
    createStandingApproval(
      project,
      {
        routineId: "sender",
        action: "mail.send",
        scope: { domains: ["client.example.jp"], templates: ["ack"], maxPerDay: 5 },
        reason: "acknowledgements",
        expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      },
      person,
    );
    expect(go().effectiveLevel).toBe("L3");
    expect(routineState(project.id, "sender").override).toBeNull();
  });
});

describe("automatic demotion", () => {
  it("a watchdog trip drops the routine one level now and records why", async () => {
    reset("replies");
    // An action the routine does not list trips the watchdog.
    reply = {
      items: [
        {
          ref: "m1",
          title: "t",
          summary: "",
          actions: [{ kind: "calendar.propose", args: { title: "t", slots: ["x"] } }],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "replies", manual);
    expect(run.watchdog?.tripped).toBe(true);
    const s = routineState(project.id, "replies");
    expect(s.paused).toBe(true);
    expect(s.override).toMatchObject({ level: "L1", kind: "demoted", by: "watchdog" });
    expect(s.lastDemotion).toMatchObject({
      from: "L2",
      to: "L1",
      cause: "watchdog",
      runId: run.id,
    });
    expect(changesOf("replies").at(-1)).toMatchObject({ kind: "demotion", cause: "watchdog" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "autopilot.autonomy.demote" }),
    );
  });

  it("the effective level is what authorizeAction uses (demoted to L0: nothing executes)", async () => {
    reset("replies", override("L0"));
    reply = {
      items: [
        {
          ref: "m1",
          title: "t",
          summary: "",
          actions: [
            { kind: "mail.draft", args: { to: ["a@client.example.jp"], subject: "s", body: "b" } },
          ],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "replies", manual);
    expect(run.level).toBe("L0");
    expect(run.actions[0]).toMatchObject({ decision: "refuse", code: "level_observe" });
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    expect(run.watchdog?.tripped).toBe(false);
  });

  it("a reported serious error drops the routine that made the item one level", () => {
    reset("replies");
    const runId = "rabcdefghijklmn";
    const created = defaultWorkItemSink().create({
      project,
      routine: loadRoutines(project).routines.find((r) => r.id === "replies")!,
      runId,
      item: {
        ref: "m9",
        title: "Wrong reply",
        summary: "",
        category: null,
        priority: "normal",
        flags: [],
        sources: [],
        actions: [],
      },
      kind: "intake",
      awaitingPerson: null,
      pending: [],
    });
    const operator = { id: "device:operator", kind: "person" as const, privileged: true };
    const outsider = { id: "device:outsider", kind: "person" as const };
    const report = (actor: { id: string; kind: string; privileged?: boolean } = operator) =>
      reportAutopilotError(
        project,
        { itemId: created.id, reason: "replied to the wrong client" },
        actor as typeof operator,
      );
    expect(() => report({ id: "agent:x", kind: "agent" })).toThrow(
      expect.objectContaining({ code: "not_a_person" }) as Error,
    );
    // Someone who cannot read the item cannot report it (and learns nothing about it).
    expect(() => report(outsider)).toThrow(
      expect.objectContaining({ code: "item_not_found" }) as Error,
    );
    const out = report();
    expect(out).toMatchObject({ routineId: "replies", effectiveLevel: "L1" });
    expect(routineState(project.id, "replies").lastDemotion).toMatchObject({
      from: "L2",
      to: "L1",
      cause: "reported_error",
      by: operator.id,
      itemId: created.id,
      runId,
    });
    expect(() => report()).toThrow(expect.objectContaining({ code: "already_reported" }) as Error);
    expect(routineState(project.id, "replies").override?.level).toBe("L1");
    const manualItem = createWorkItem(
      project,
      { queue: "ga-requests", title: "by hand", source: { documents: [], fields: {} } },
      operator,
    );
    expect(() =>
      reportAutopilotError(project, { itemId: manualItem.id, reason: "not ours" }, operator),
    ).toThrow(expect.objectContaining({ code: "not_autopilot_item" }) as Error);
  });

  it("never goes below L0", () => {
    reset("replies", override("L0"));
    const created = defaultWorkItemSink().create({
      project,
      routine: loadRoutines(project).routines.find((r) => r.id === "replies")!,
      runId: "rabcdefghijklmo",
      item: {
        ref: "m10",
        title: "Wrong",
        summary: "",
        category: null,
        priority: "normal",
        flags: [],
        sources: [],
        actions: [],
      },
      kind: "intake",
      awaitingPerson: null,
      pending: [],
    });
    const out = reportAutopilotError(
      project,
      { itemId: created.id, reason: "still wrong" },
      { id: "device:operator", kind: "person", privileged: true },
    );
    expect(out.change).toMatchObject({ from: "L0", to: "L0" });
    expect(routineState(project.id, "replies").override?.level).toBe("L0");
  });
});
