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
import { intakeEmail } from "../workitems/intake.js";
import { updateWorkItem } from "../workitems/lifecycle.js";
import { readWorkItem } from "../workitems/store.js";
import { createStandingApproval } from "./approvals.js";
import { invokeAsEngine } from "./engine-origin.js";
import { runEvidenceDir } from "./evidence.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./runner.js";
import { checkStandingSend, dayIn } from "./standing-send.js";
import { autopilotStats } from "./stats.js";
import { approvalUsesOn, readRunSummaries, routineState, updateRoutineState } from "./store.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-run-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

const inboxOf = (a: string, b: string) =>
  `1. id: ${a}\n   received: 2026-10-25T01:00:00Z (unread)\n   from: A <a@client.example.jp>\n   subject: hello\n` +
  `2. id: ${b}\n   received: 2026-10-25T02:00:00Z\n   from: B <b@evil.example>\n   subject: urgent\n`;
const INBOX = inboxOf("m1", "m2");
let fresh = 0;
/** New message ids for a test (intake is idempotent per message: old ids are handled). */
function freshInbox(): [string, string] {
  fresh++;
  const ids: [string, string] = [`n${fresh}a`, `n${fresh}b`];
  inbox = inboxOf(...ids);
  return ids;
}
let personVerdict: "allow" | "deny" = "deny";

let calls: ToolCall[] = [];
let inbox = INBOX;
let providerOverride: string | null = null;
const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool === "m365_mail_list" || call.tool === "m365_mail_search") {
    return { ok: true, text: inbox, pluginId: providerOverride ?? "microsoft-365" };
  }
  if (call.tool === "m365_mail_read") {
    return { ok: true, text: `body of ${String(call.args.id)}`, pluginId: "microsoft-365" };
  }
  if (call.tool === "m365_mail_create_draft") {
    const id = `d-${calls.length}`;
    return {
      ok: true,
      text: `Created draft ${id} for 1 recipient(s); not sent.`,
      details: { id },
      pluginId: "microsoft-365",
    };
  }
  if (call.tool === "m365_mail_send") {
    // What the connector does (extensions/microsoft-365): verify the standing approval under the
    // engine invocation, else ask a person.
    const out = await invokeAsEngine(call, async () =>
      checkStandingSend({
        tool: call.tool,
        connector: "microsoft-365",
        sessionKey: call.sessionKey,
        recipients: [...(call.args.to as string[]), ...((call.args.cc as string[]) ?? [])],
      }),
    );
    if (out.value.kind !== "approved" && personVerdict !== "allow") {
      return { ok: false, error: "approval_denied" };
    }
    return {
      ok: true,
      text: "Sent to 1 recipient(s).",
      pluginId: "microsoft-365",
      approvalUsed: out.used?.approvalId ?? null,
      approvalFallback: out.fallback,
    };
  }
  if (call.tool === "web_search") {
    return { ok: true, text: "results", pluginId: null };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};

let reply: Json = { items: [] };
let reasonCalls = 0;
let lastPrompt = "";
const reasoner: Reasoner = {
  async reason(req) {
    reasonCalls++;
    lastPrompt = req.prompt;
    return {
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      backend: "fake",
      model: null,
    };
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
  metrics: { baselineMinutes: 5 },
};

function writeRoutines(routines: Array<Record<string, unknown>>) {
  fs.writeFileSync(
    path.join(project.folder, "context", "autopilot.yaml"),
    YAML.stringify({ version: 1, routines }),
  );
}

function resetState(routineId: string) {
  updateRoutineState(project.id, routineId, () => ({
    ...routineState(project.id, "__none__"),
  }));
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

beforeEach(() => {
  calls = [];
  inbox = INBOX;
  providerOverride = null;
  reasonCalls = 0;
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

describe("runner (fake reasoner)", () => {
  it("drafts clean mail, escalates flagged mail, and writes a signed record", async () => {
    writeRoutines([ROUTINE]);
    reply = {
      items: [
        {
          ref: "m1",
          title: "Hello",
          summary: "greeting",
          priority: "low",
          flags: [],
          actions: [
            {
              kind: "mail.draft",
              args: {
                to: ["a@client.example.jp"],
                subject: "RE: hello",
                body: "お世話になっております",
              },
            },
            { kind: "workitem.intake", args: { title: "Reply to A" } },
          ],
        },
        {
          ref: "m2",
          title: "Urgent bank change",
          summary: "asks to change bank details",
          flags: ["suspected_fraud"],
          actions: [
            { kind: "mail.draft", args: { to: ["b@evil.example"], subject: "RE", body: "ok" } },
          ],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.status).toBe("escalated");
    expect(run.counts).toMatchObject({
      items: 2,
      prepared: 2,
      acted: 0,
      escalated: 1,
      refused: 1,
      handled: 1,
    });
    // Gather read the list and both mails; one draft was created, none for the flagged mail.
    expect(calls.map((c) => c.tool)).toEqual([
      "m365_mail_list",
      "m365_mail_read",
      "m365_mail_read",
      "m365_mail_create_draft",
    ]);
    expect(calls.every((c) => c.sessionKey.startsWith(`agent:main:proj-${project.id}-ap`))).toBe(
      true,
    );
    // Untrusted content is data inside SOURCE blocks.
    expect(lastPrompt).toContain("===== SOURCE mail.1 (m365_mail_read) =====");
    expect(run.workItems).toHaveLength(2);
    const [intake, escalation] = run.workItems.map((id) => readWorkItem(project.id, id)!);
    expect(intake.createdBy).toBe("autopilot:inbox");
    expect(intake.source.fields).toMatchObject({ autopilotKind: "intake", autopilotRef: "m1" });
    expect(escalation.source.fields).toMatchObject({
      autopilotKind: "escalation",
      autopilotRef: "m2",
      autopilotRun: run.id,
    });
    // Email intake: a reference to the message, the flag on the item (person-only clearing).
    expect(escalation.flags).toEqual(["suspected_fraud"]);
    expect(escalation.flagReason).toMatch(/flagged/);
    expect(escalation.source.fields.autopilotFlags).toBeUndefined();
    expect(escalation.source.origin).toEqual({
      kind: "email",
      connector: "microsoft-365",
      messageId: "m2",
      from: "b@evil.example",
      subject: "urgent",
      receivedAt: "2026-10-25T02:00:00.000Z",
    });
    expect(intake.source.origin?.messageId).toBe("m1");
    expect(intake.summary).toBe("greeting");
    expect(String(escalation.source.fields.awaitingPerson)).toMatch(/flagged/);
    // The reply draft answers the message it is about.
    expect(calls.find((c) => c.tool === "m365_mail_create_draft")?.args.replyToMessageId).toBe(
      "m1",
    );
    // Signed evidence verifies and matches the record.
    const v = await verifyEvidenceBundle(runEvidenceDir(project.id, run.id));
    expect(v.ok).toBe(true);
    expect(v.manifest?.events.root).toBe(run.evidence?.root);
    expect(readRunSummaries(project.id).at(-1)?.id).toBe(run.id);
  });

  it("does not re-process seen inputs (no_input, no model call)", async () => {
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.status).toBe("no_input");
    expect(reasonCalls).toBe(0);
  });

  it("chains run evidence to the previous run", async () => {
    inbox = "1. id: m3\n   received: x\n   from: C <c@client.example.jp>\n   subject: s\n";
    reply = { items: [] };
    const first = readRunSummaries(project.id).at(-1)!;
    const run = await runRoutine(deps(), project, "inbox", manual);
    const events = fs
      .readFileSync(path.join(runEvidenceDir(project.id, run.id), "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events[0].data.prevRoot).toBe(first.evidence?.root);
  });

  it("never executes a forbidden action; never actions wait for a person", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    reply = {
      items: [
        {
          ref: m,
          title: "Pay",
          summary: "invoice",
          actions: [
            { kind: "mail.send", args: { to: ["a@client.example.jp"], subject: "s", body: "b" } },
            { kind: "payment.execute", args: { amount: 100 } },
            { kind: "shell.exec", args: {} },
          ],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(calls.some((c) => c.tool === "m365_mail_send")).toBe(false);
    expect(run.actions.map((a) => [a.kind, a.decision, a.code])).toEqual([
      ["mail.send", "refuse", "not_in_routine"],
      ["payment.execute", "needs_person", "never_autonomous"],
      ["shell.exec", "refuse", "unknown_action"],
    ]);
    expect(run.counts.escalated).toBe(1);
    const item = readWorkItem(project.id, run.workItems[0])!;
    expect(String(item.source.fields.pendingActions)).toMatch(/payment\.execute/);
    // A payment is a person's decision, not by itself a fraud flag.
    expect(item.flags).toBeUndefined();
  });

  it("a proposed bank-detail change puts suspected_fraud on the item (person-only clearing)", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    reply = {
      items: [
        {
          ref: m,
          title: "New bank account",
          summary: "vendor asks to pay into a new account",
          actions: [{ kind: "bank.change", args: {} }],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "inbox", manual);
    const item = readWorkItem(project.id, run.workItems[0])!;
    expect(item.flags).toEqual(["suspected_fraud"]);
    expect(item.flagReason).toMatch(/bank\.change/);
    expect(item.source.origin?.messageId).toBe(m);
  });

  it("is idempotent with intake: a message the routine filed is never acted on again", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    const draft = {
      kind: "mail.draft",
      args: { to: ["a@client.example.jp"], subject: "RE", body: "b" },
    };
    reply = {
      items: [{ ref: m, title: "a", summary: "s", actions: [draft, { kind: "workitem.intake" }] }],
    };
    const first = await runRoutine(deps(), project, "inbox", manual);
    expect(first.workItems).toHaveLength(1);
    // The seen state is lost (or the run is retried): the same message comes again.
    resetState("inbox");
    calls = [];
    const second = await runRoutine(deps(), project, "inbox", manual);
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    expect(second.workItems).toEqual([]);
    expect(second.actions.map((a) => [a.kind, a.code, a.ref])).toEqual([
      ["mail.draft", "already_handled", first.workItems[0]],
      ["workitem.intake", "already_handled", first.workItems[0]],
    ]);
    expect(second.counts.items).toBe(0);
  });

  it("does not act on a message someone else already filed", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    const filed = intakeEmail(
      project,
      {
        queue: "ga-requests",
        title: "filed by a person",
        type: "request",
        priority: "normal",
        summary: "a person took this message in first",
        source: { kind: "email", connector: "microsoft-365", messageId: m },
      },
      { id: "person:sato", kind: "person" },
    );
    reply = {
      items: [
        {
          ref: m,
          title: "a",
          summary: "s",
          actions: [
            { kind: "mail.draft", args: { to: ["a@client.example.jp"], subject: "RE", body: "b" } },
            { kind: "workitem.intake" },
          ],
        },
      ],
    };
    calls = [];
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(calls.some((c) => c.tool === "m365_mail_create_draft")).toBe(false);
    expect(run.actions.every((a) => a.code === "already_handled" && a.ref === filed.item.id)).toBe(
      true,
    );
  });

  it("a failed run keeps the messages that reached the queue seen, retries the rest", async () => {
    resetState("inbox");
    const [a, b] = freshInbox();
    reply = {
      items: [
        { ref: a, title: "a", summary: "s", actions: [{ kind: "workitem.intake" }] },
        { ref: b, title: "b", summary: "s", actions: [{ kind: "workitem.intake" }] },
      ],
    };
    const real = defaultWorkItemSink();
    const sink = {
      ...real,
      create: (req: Parameters<typeof real.create>[0]) => {
        if (req.item.ref === b) {
          throw new Error("queue unavailable");
        }
        return real.create(req);
      },
    };
    const run = await runRoutine({ ...deps(), workItems: sink }, project, "inbox", manual);
    expect(run.status).toBe("failed");
    expect(routineState(project.id, "inbox").seen).toEqual([`mail:${a}`]);
  });

  it("refuses gather from a tool answered by another provider (no model call)", async () => {
    resetState("inbox");
    providerOverride = "evil-plugin";
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/provided by evil-plugin/);
    expect(reasonCalls).toBe(0);
  });

  it("refuses a routines file whose gather names a write tool", async () => {
    writeRoutines([{ ...ROUTINE, gather: [{ tool: "m365_mail_send", args: {} }] }]);
    await expect(runRoutine(deps(), project, "inbox", manual)).rejects.toMatchObject({
      code: "routines_invalid",
    });
    expect(calls).toEqual([]);
    writeRoutines([ROUTINE]);
  });

  it("fails closed on invalid model output and retries the inputs next time", async () => {
    resetState("inbox");
    reply = '{"items":[{"ref":"m1","title":"t","summary":"s","level":"L3"}]}';
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/does not match/);
    expect(run.actions).toEqual([]);
    expect(routineState(project.id, "inbox").seen).toEqual([]);
  });

  it("enforces maxItemsPerRun and maxActionsPerDay", async () => {
    writeRoutines([{ ...ROUTINE, limits: { maxItemsPerRun: 1, maxActionsPerDay: 1 } }]);
    resetState("inbox");
    const [a, b] = freshInbox();
    const draft = {
      kind: "mail.draft",
      args: { to: ["a@client.example.jp"], subject: "s", body: "b" },
    };
    reply = {
      items: [
        { ref: a, title: "a", summary: "", actions: [draft, draft] },
        { ref: b, title: "b", summary: "", actions: [draft] },
      ],
    };
    const run = await runRoutine(deps(), project, "inbox", manual);
    expect(run.counts).toMatchObject({ items: 1, deferred: 1, prepared: 1, escalated: 1 });
    expect(run.actions.map((a) => a.code)).toEqual([null, "daily_limit"]);
    writeRoutines([ROUTINE]);
  });

  it("L3 sends only under a standing approval in scope, and records the approval id", async () => {
    writeRoutines([{ ...ROUTINE, actions: ["workitem.intake", "mail.send"], level: "L3" }]);
    resetState("inbox");
    const [a, b] = freshInbox();
    const approval = createStandingApproval(
      project,
      {
        routineId: "inbox",
        action: "mail.send",
        scope: { domains: ["client.example.jp"], templates: ["ack"], maxPerDay: 3 },
        reason: "acknowledge known clients",
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      { id: "device:person", kind: "person" },
    );
    const send = (to: string) => ({
      kind: "mail.send",
      args: { to: [to], subject: "受領", body: "受領しました", templateId: "ack" },
    });
    reply = {
      items: [
        { ref: a, title: "a", summary: "", actions: [send("a@client.example.jp")] },
        { ref: b, title: "b", summary: "", actions: [send("b@evil.example")] },
      ],
    };
    const run = await runRoutine(deps(), project, "inbox", manual);
    const sends = calls.filter((c) => c.tool === "m365_mail_send");
    expect(sends).toHaveLength(1);
    expect(sends[0].args.to).toEqual(["a@client.example.jp"]);
    // The template is engine context checked against the approval, not a tool argument.
    expect(sends[0].args.templateId).toBeUndefined();
    expect(sends[0].engine).toMatchObject({ approvalId: approval.id, templateId: "ack" });
    expect(run.actions[0]).toMatchObject({
      executed: true,
      approvalId: approval.id,
      class: "external",
    });
    expect(run.actions[1]).toMatchObject({
      decision: "needs_person",
      code: "recipient_out_of_scope",
    });
    expect(run.counts).toMatchObject({ acted: 1, escalated: 1 });
    // One counter, incremented by the connector that verified the approval.
    const day = dayIn(new Date(), "Asia/Tokyo");
    expect(approvalUsesOn(project.id, day)[approval.id]).toBe(1);

    // The approval is revoked between authorize and send (or the connector disagrees): the
    // connector asks a person; when the person allows it the record says so, without the id.
    resetState("inbox");
    const [c] = freshInbox();
    reply = {
      items: [{ ref: c, title: "c", summary: "", actions: [send("c@client.example.jp")] }],
    };
    const { mutateApprovals } = await import("./store.js");
    const real = deps().tools;
    personVerdict = "allow";
    const racing: ToolInvoker = async (call) => {
      if (call.tool === "m365_mail_send") {
        mutateApprovals(project.id, (all) => {
          all[0].revokedAt = new Date().toISOString();
        });
      }
      return real(call);
    };
    const run2 = await runRoutine({ ...deps(), tools: racing }, project, "inbox", manual);
    personVerdict = "deny";
    expect(run2.actions[0]).toMatchObject({
      executed: true,
      approvalId: null,
      code: "person_approved",
    });
    expect(approvalUsesOn(project.id, day)[approval.id]).toBe(1);
    writeRoutines([ROUTINE]);
  });

  it("scholars: a citation that names no retrieved source goes to a person", async () => {
    writeRoutines([
      ROUTINE,
      {
        id: "lit",
        edition: "scholars",
        area: "literature",
        trigger: { interval: 60 },
        gather: [{ id: "search", tool: "web_search", args: { query: "q" } }],
        reasoning: { prompt: "literature-watch" },
        actions: ["workitem.intake"],
        level: "L1",
      },
    ]);
    reply = {
      items: [
        {
          ref: "p1",
          title: "Real",
          summary: "",
          sources: ["search"],
          actions: [{ kind: "workitem.intake" }],
        },
        {
          ref: "p2",
          title: "Invented",
          summary: "",
          sources: ["doi:10.1/fake"],
          actions: [{ kind: "workitem.intake" }],
        },
      ],
    };
    const run = await runRoutine(deps(), project, "lit", manual);
    expect(run.counts).toMatchObject({ prepared: 1, escalated: 1, refused: 1 });
    const flagged = readWorkItem(project.id, run.workItems[1])!;
    expect(flagged.source.fields.autopilotFlags).toBe("unverified_citation");
  });

  it("an escalation that cannot reach the queue fails the run", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    reply = { items: [{ ref: m, title: "x", summary: "", flags: ["phishing"], actions: [] }] };
    const sink = {
      create: () => {
        throw new Error("queue unavailable");
      },
    };
    const run = await runRoutine({ ...deps(), workItems: sink }, project, "inbox", manual);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/queue unavailable/);
  });

  it("a paused routine does not run", async () => {
    updateRoutineState(project.id, "inbox", (cur) => ({
      ...cur,
      paused: true,
      pausedBy: "device:person",
    }));
    await expect(runRoutine(deps(), project, "inbox", manual)).rejects.toMatchObject({
      code: "paused",
    });
    updateRoutineState(project.id, "inbox", (cur) => ({ ...cur, paused: false, pausedBy: null }));
  });

  it("the kill switch skips the run (recorded)", async () => {
    resetState("inbox");
    const run = await runRoutine(
      { ...deps(), killed: () => "fleet stopped by owner" },
      project,
      "inbox",
      manual,
    );
    expect(run.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("stats: server totals, corrections from person edits, minutes only with a baseline", () => {
    const runs = readRunSummaries(project.id);
    const routines = loadRoutines(project).routines;
    const before = autopilotStats(project.id, routines);
    const inbox = before.routines.find((r) => r.routineId === "inbox")!;
    expect(inbox.runs).toBe(runs.filter((r) => r.routineId === "inbox").length);
    expect(inbox.prepared).toBe(
      runs.filter((r) => r.routineId === "inbox").reduce((n, r) => n + r.counts.prepared, 0),
    );
    expect(inbox.minutesSaved).toBe(Math.max(0, inbox.handled - inbox.correctedByPerson) * 5);
    expect(before.routines.find((r) => r.routineId === "lit")!.minutesSaved).toBeNull();
    expect(before.totals.runs).toBe(runs.length);
    expect(before.areas.find((a) => a.area === "secretariat")).toMatchObject({
      edition: "business",
      department: "secretariat",
    });
    // A person edits an autopilot-prepared item → one correction.
    const intakeRun = runs.find((r) => r.workItems.length > 0 && r.routineId === "inbox")!;
    const item = readWorkItem(project.id, intakeRun.workItems[0])!;
    updateWorkItem(
      project,
      item.id,
      { title: "Edited by a person" },
      { id: "device:person", kind: "person" },
      item.revision,
    );
    const after = autopilotStats(project.id, routines);
    expect(after.routines.find((r) => r.routineId === "inbox")!.correctedByPerson).toBe(
      inbox.correctedByPerson + 1,
    );
  });
});

describe("keepListEntries", () => {
  it("keeps only the entries read in this run and both untrusted boundaries", async () => {
    const { keepListEntries } = await import("./runner.js");
    const list = [
      "NOTICE\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nSource: Email\n---",
      "1. id: AAA\n   subject: old",
      "2. id: BBB\n   subject: new",
      "3. id: CCC\n   subject: older\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    const out = keepListEntries(list, new Set(["BBB"]));
    expect(out).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(out).toContain("2. id: BBB");
    expect(out).not.toContain("AAA");
    expect(out).not.toContain("CCC");
    expect(out.endsWith("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>")).toBe(true);
  });
});

describe("malformed plan retry", () => {
  it("asks the reasoner once more when the first reply is not valid JSON", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    let callsToReasoner = 0;
    const good = JSON.stringify({
      items: [{ ref: m, title: "a", summary: "s", actions: [{ kind: "workitem.intake" }] }],
    });
    const d = deps();
    d.reasoner = {
      reason: async () => {
        callsToReasoner++;
        return {
          text: callsToReasoner === 1 ? good.slice(0, -2) : good,
          backend: "fake",
          model: null,
        };
      },
    } as Reasoner;
    const run = await runRoutine(d, project, "inbox", manual);
    expect(callsToReasoner).toBe(2);
    expect(run.reasoning.retried).toBe(true);
    expect(run.status).not.toBe("failed");
  });
});

describe("agent for unnamed routines", () => {
  it("runs as the first agent the Project allows when the default agent is not allowed", async () => {
    resetState("inbox");
    const [m] = freshInbox();
    reply = {
      items: [{ ref: m, title: "a", summary: "s", actions: [{ kind: "workitem.intake" }] }],
    };
    calls = [];
    const limited = { ...project, allowedAgents: ["backoffice"] };
    const run = await runRoutine(deps(), limited, "inbox", manual);
    expect(run.status).not.toBe("failed");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.agentId === "backoffice")).toBe(true);
  });
});
