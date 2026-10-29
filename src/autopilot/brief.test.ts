import { Value } from "@sinclair/typebox/value";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Project } from "../projects/types.js";
import type { WorkItem } from "../workitems/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { flushAudit } from "../audit/audit-log.js";
import { AutopilotBriefSchema } from "../gateway/protocol/schema/autopilot.js";
import { createProject, projectDataDir } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { createWorkItem } from "../workitems/lifecycle.js";
import { createLinkedCase } from "../workitems/links-store.js";
import { markNotificationRead, recordNotifications } from "../workitems/notifications-store.js";
import { readWorkItem, workItemDir, writeWorkItem } from "../workitems/store.js";
import { buildBrief, renderBriefText } from "./brief.js";
import { loadRoutines, parseRoutines } from "./routines.js";
import { runRoutine } from "./runner.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-brief-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const ALICE = "device:alice0000001";
const BOB = "device:bob000000001";
const CAROL = "device:carol0000001";
const DAVE = "device:dave00000001";
const person = (id: string, privileged = false) => ({ id, kind: "person" as const, privileged });

let calls: ToolCall[] = [];
const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool === "m365_mail_create_draft") {
    return { ok: true, text: "Created draft", details: { id: "d1" }, pluginId: "microsoft-365" };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};
const reasoner: Reasoner = {
  async reason() {
    throw new Error("a brief routine must not call the model");
  },
};
const deps = () => ({
  cfg: {},
  reasoner,
  tools,
  workItems: defaultWorkItemSink(),
  defaultAgentId: "main",
});

let project: Project;
const items: Record<string, WorkItem> = {};

beforeAll(() => {
  const folder = path.join(root, "ops");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "context", "workqueue.yaml"),
    YAML.stringify({
      version: 1,
      timezone: "Asia/Tokyo",
      queues: [{ id: "secretariat-work", types: ["request", "case"], slaHours: 12 }],
      access: {
        members: [
          { principal: ALICE, name: "Alice", roles: ["approver"], email: "alice@corp.example.jp" },
          { principal: BOB, name: "Bob", roles: [] },
          { principal: CAROL, name: "Carol", roles: ["operator"] },
        ],
      },
    }),
  );
  fs.writeFileSync(
    path.join(folder, "context", "autopilot.yaml"),
    YAML.stringify({
      version: 1,
      routines: [
        {
          id: "morning-brief",
          edition: "business",
          area: "secretariat",
          trigger: { schedule: "30 7 * * 1-5", tz: "Asia/Tokyo" },
          reasoning: { prompt: "morning-brief" },
          actions: ["brief.deliver"],
          level: "L1",
          limits: { maxItemsPerRun: 50, maxActionsPerDay: 100 },
        },
      ],
    }),
  );
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-company-operations",
  )!;
  project = createProject(
    { name: "Ops", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
  const source = { documents: [], fields: {} };
  // Bob's own request: due within the SLA, visible to Bob (and operators) only.
  items.bob = createWorkItem(
    project,
    { queue: "secretariat-work", title: "Bob's request", source },
    person(BOB),
  );
  // Dave's request routed to Alice for a decision.
  const routed = createWorkItem(
    project,
    { queue: "secretariat-work", title: "Needs Alice", source },
    person(DAVE),
  );
  const cur = readWorkItem(project.id, routed.id)!;
  cur.status = "awaiting_review";
  cur.route = {
    id: "review",
    kind: "single",
    policyDigest: "test",
    skipped: [],
    current: 0,
    stages: [
      {
        id: "s1",
        name: { en: "Review" },
        approvers: {
          any: false,
          roles: [],
          principals: [ALICE],
          departmentField: null,
          department: null,
        },
        minApprovals: 1,
        dueHours: null,
        onReturn: "requester",
        delegation: false,
        escalation: null,
        status: "active",
        approvals: [],
        delegations: [],
        activatedAt: cur.createdAt,
        dueAt: null,
        completedAt: null,
        overdueAt: null,
        escalatedAt: null,
      },
    ],
  };
  writeWorkItem(cur);
  items.routed = cur;
  // A flagged autopilot escalation: only an operator (or its approvers) may clear it.
  const routine = loadRoutines(project).routines[0];
  const flagged = defaultWorkItemSink().create({
    project,
    routine,
    runId: "rflaggedrun0001",
    item: {
      ref: "m1",
      title: "Bank details changed",
      summary: "",
      category: null,
      priority: "high",
      flags: ["suspected_fraud"],
      sources: [],
      actions: [],
    },
    kind: "escalation",
    awaitingPerson: "flagged (suspected_fraud): a person decides",
    pending: [],
  });
  items.flagged = readWorkItem(project.id, flagged.id)!;
});

beforeEach(() => {
  calls = [];
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

const ids = (list: Array<{ itemId: string }>) => list.map((i) => i.itemId).toSorted();

describe("morning brief contents", () => {
  it("contains only the items each person can already read", () => {
    const alice = buildBrief(project, person(ALICE), { mayAcceptProposals: true });
    const bob = buildBrief(project, person(BOB));
    const carol = buildBrief(project, person(CAROL));
    expect(ids(alice.waiting.decisions)).toEqual([items.routed.id]);
    expect(alice.waiting.flagged).toEqual([]);
    // The decision she owes is due within the queue's SLA: it is one of her commitments too.
    expect(ids(alice.commitments)).toEqual([items.routed.id]);
    expect(alice.name).toBe("Alice");

    expect(bob.waiting.decisions).toEqual([]);
    expect(bob.waiting.flagged).toEqual([]);
    expect(ids(bob.commitments)).toEqual([items.bob.id]);

    // Carol is an operator: she may clear the flag; she decides nothing and owes nothing.
    expect(ids(carol.waiting.flagged)).toEqual([items.flagged.id]);
    expect(carol.waiting.flagged[0].flags).toEqual(["suspected_fraud"]);
    expect(carol.waiting.decisions).toEqual([]);

    // Someone outside the Project sees no item at all.
    const outsider = buildBrief(project, person("device:outsider0001"));
    expect([
      ...outsider.waiting.decisions,
      ...outsider.waiting.flagged,
      ...outsider.commitments,
    ]).toEqual([]);
    for (const b of [alice, bob, carol, outsider]) {
      expect(Value.Check(AutopilotBriefSchema, b)).toBe(true);
      expect(Object.values(b.truncated)).toEqual([false, false, false, false, false]);
    }
  });

  it("renders Japanese first, then English, with the item ids", () => {
    const text = renderBriefText(buildBrief(project, person(ALICE)));
    expect(text.subject).toMatch(/^朝のブリーフ \/ Morning brief: Ops /);
    expect(text.body.indexOf("あなたの判断待ち")).toBeLessThan(
      text.body.indexOf("Waiting for your decision"),
    );
    expect(text.body).toContain(items.routed.id);
    expect(text.body).not.toContain(items.bob.id);
    expect(text.body).not.toContain("More not shown");
  });
});

describe("brief.deliver", () => {
  it("drafts to the member's own address or writes output/briefs/, never sends, no model", async () => {
    const run = await runRoutine(deps(), project, "morning-brief", {
      kind: "manual",
      by: "device:admin",
    });
    expect(run.status).toBe("ok");
    expect(run.reasoning.backend).toBe("engine");
    expect(run.counts).toMatchObject({ items: 3, prepared: 3, escalated: 0, failed: 0 });
    // One draft, to Alice's own address; nothing else touches mail and nothing sends.
    expect(calls.map((c) => c.tool)).toEqual(["m365_mail_create_draft"]);
    expect(calls[0].args.to).toEqual(["alice@corp.example.jp"]);
    expect(String(calls[0].args.body)).toContain(items.routed.id);
    expect(calls.some((c) => /send/.test(c.tool))).toBe(false);
    const files = fs.readdirSync(path.join(project.folder, "output", "briefs")).toSorted();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes("device-bob000000001"))).toBe(true);
    const bobName = files.find((f) => f.includes("bob")) ?? "missing";
    const bobFile = fs.readFileSync(path.join(project.folder, "output", "briefs", bobName), "utf8");
    expect(bobFile).toContain(items.bob.id);
    expect(bobFile).not.toContain(items.routed.id);
    expect(run.actions.map((a) => a.ref)).toEqual(
      expect.arrayContaining(["m365_mail_create_draft:d1"]),
    );
    // A second run the same day writes a new file, never over the first.
    await runRoutine(deps(), project, "morning-brief", { kind: "manual", by: "device:admin" });
    expect(fs.readdirSync(path.join(project.folder, "output", "briefs"))).toHaveLength(4);
  });

  it("the starter routine is in the company operations pack (07:30 weekdays, L1)", () => {
    const text = fs.readFileSync(
      path.join(resolveTemplatesDir(), "packs", "business-company-operations", "autopilot.yaml"),
      "utf8",
    );
    const r = parseRoutines(text).find((x) => x.id === "morning-brief");
    expect(r).toMatchObject({
      level: "L1",
      actions: ["brief.deliver"],
      trigger: { kind: "schedule", expr: "30 7 * * 1-5", tz: "Asia/Tokyo" },
      reasoning: { promptId: "morning-brief" },
    });
  });
});

// Last: it adds items that would change the other tests' briefs.
describe("morning brief caps", () => {
  it("does not flag a list of exactly 50", () => {
    const source = { documents: [], fields: {} };
    const have = buildBrief(project, person(CAROL)).commitments.length;
    for (let i = have; i < 50; i++) {
      createWorkItem(
        project,
        { queue: "secretariat-work", title: `Carol's request ${i}`, source },
        person(CAROL),
      );
    }
    const carol = buildBrief(project, person(CAROL));
    expect(carol.commitments).toHaveLength(50);
    expect(carol.truncated.commitments).toBe(false);
    expect(renderBriefText(carol).body).not.toContain("More not shown");
  });

  it("cuts a list at 50 and says so", () => {
    const source = { documents: [], fields: {} };
    for (let i = 0; i < 50; i++) {
      createWorkItem(
        project,
        { queue: "secretariat-work", title: `Bob's request ${i}`, source },
        person(BOB),
      );
    }
    const bob = buildBrief(project, person(BOB));
    expect(bob.commitments).toHaveLength(50);
    expect(bob.truncated).toEqual({
      documents: false,
      decisions: false,
      flagged: false,
      commitments: true,
      linked: false,
    });
    expect(Value.Check(AutopilotBriefSchema, bob)).toBe(true);
    const text = renderBriefText(bob).body;
    expect(text).toContain("ほかにもあります");
    expect(text).toContain("More not shown");
    // Another person's short list stays untruncated.
    expect(buildBrief(project, person(ALICE)).truncated.commitments).toBe(false);
  });
});

describe("morning brief linked cases", () => {
  it("lists the owner's linked case with ready steps, and an unreadable record, nobody else's", () => {
    const parent = createWorkItem(
      project,
      { queue: "secretariat-work", title: "Onboard Eve", source: { documents: [], fields: {} } },
      person(BOB),
    );
    createLinkedCase(
      project.id,
      parent.id,
      {
        steps: [
          { key: "prepare", department: "hr", title: { en: "Prepare" }, dependsOn: [] },
          { key: "account", department: "it", title: { en: "Account" }, dependsOn: ["prepare"] },
        ],
      },
      person(BOB),
      new Date(),
    );
    const bob = buildBrief(project, person(BOB));
    expect(bob.waiting.linked).toEqual([
      expect.objectContaining({
        itemId: parent.id,
        done: 0,
        total: 2,
        ready: ["prepare"],
        missing: [],
        blocked: false,
        unreadable: false,
      }),
    ]);
    expect(Value.Check(AutopilotBriefSchema, bob)).toBe(true);
    expect(renderBriefText(bob).body).toContain("steps ready to open: prepare");
    // Alice can read nothing of Bob's; Carol (operator) can read it but does not own it.
    expect(buildBrief(project, person(ALICE)).waiting.linked).toEqual([]);
    expect(buildBrief(project, person(CAROL)).waiting.linked).toEqual([]);

    fs.writeFileSync(path.join(workItemDir(project.id, parent.id), "linked-case.json"), "{");
    const broken = buildBrief(project, person(BOB));
    expect(broken.waiting.linked).toEqual([
      expect.objectContaining({ itemId: parent.id, unreadable: true, ready: [] }),
    ]);
    expect(renderBriefText(broken).body).toContain("連携記録を読み取れません");
  });
});

describe("morning brief notifications", () => {
  it("counts the person's unread notifications on items they can read; unreadable says so", () => {
    const item = createWorkItem(
      project,
      { queue: "secretariat-work", title: "Bob's notice", source: { documents: [], fields: {} } },
      person(BOB),
    );
    const unread = (id: string) => buildBrief(project, person(id)).waiting.notifications;
    const bobBefore = unread(BOB)!.unread;
    const aliceBefore = unread(ALICE)!.unread;
    const added = recordNotifications(
      { projectId: project.id, id: item.id, revision: item.revision + 100 },
      [
        { principal: BOB, reason: "decided" },
        // Alice cannot read Bob's item: the record exists but the brief must not count it.
        { principal: ALICE, reason: "awaiting_you" },
      ],
      new Date(),
    );
    const bob = buildBrief(project, person(BOB));
    expect(bob.waiting.notifications).toEqual({ unread: bobBefore + 1, unreadable: false });
    expect(unread(ALICE)).toEqual({ unread: aliceBefore, unreadable: false });
    expect(Value.Check(AutopilotBriefSchema, bob)).toBe(true);
    expect(renderBriefText(bob).body).toContain(`${bobBefore + 1} unread`);
    const mine = added.find((n) => n.principal === BOB)!;
    markNotificationRead(project.id, BOB, mine.id, new Date());
    expect(unread(BOB)).toEqual({ unread: bobBefore, unreadable: false });

    const dir = path.join(projectDataDir(project.id), "notifications");
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
    const saved = files.map((f) => fs.readFileSync(f));
    try {
      for (const f of files) {
        fs.writeFileSync(f, "{");
      }
      const broken = buildBrief(project, person(BOB));
      expect(broken.waiting.notifications).toEqual({ unread: 0, unreadable: true });
      expect(Value.Check(AutopilotBriefSchema, broken)).toBe(true);
      expect(renderBriefText(broken).body).toContain("通知記録を読み取れません");
    } finally {
      files.forEach((f, i) => fs.writeFileSync(f, saved[i]));
    }
  });
});
