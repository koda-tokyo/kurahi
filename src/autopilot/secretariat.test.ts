// The Business starter routine `secretariat-inbox-full` (company operations template), end to
// end with the real office renderer: intake per message (department queues, flags), a reply
// draft, a Word document from the approved company facts, attached to that draft.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Project } from "../projects/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { registerOfficeSpecParsers } from "../../extensions/office/index.js";
import { createOfficeTools } from "../../extensions/office/src/tools.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject, setProjectMode } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { readWorkItem } from "../workitems/store.js";
import { resetOfficeSpecParsersForTests } from "./office-spec.js";
import { parsePlan } from "./reasoning.js";
import { loadRoutines } from "./routines.js";
import { runRoutine } from "./runner.js";
import { routineState, updateRoutineState } from "./store.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-sec-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
const ROUTINE = "secretariat-inbox-full";
const FACTS = "KODA SōKEN 会社概要: 所在地 東京都中央区。標準作業単価 ¥12,000/時。";

let project: Project;
let calls: ToolCall[] = [];
let inbox = "";
let n = 0;
const office = () => createOfficeTools({ sessionKey: calls.at(-1)?.sessionKey });

const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool === "m365_mail_list") {
    return { ok: true, text: inbox, pluginId: "microsoft-365" };
  }
  if (call.tool === "m365_mail_read") {
    return { ok: true, text: `body of ${String(call.args.id)}`, pluginId: "microsoft-365" };
  }
  if (call.tool === "m365_mail_create_draft") {
    const id = `DRAFT${++n}`;
    return {
      ok: true,
      text: `Created draft ${id} for 1 recipient(s); not sent.`,
      details: { id },
      pluginId: "microsoft-365",
    };
  }
  if (call.tool.startsWith("office_")) {
    // The real office plugin tool, in the routine's project session.
    const t = office().find((x) => x.name === call.tool)!;
    const r = (await t.execute("c1", call.args)) as Json;
    if (r.details?.error) {
      return { ok: false, error: r.content[0].text };
    }
    return { ok: true, text: r.content[0].text, details: r.details, pluginId: "office" };
  }
  if (call.tool === "m365_mail_attach_to_draft") {
    const file = path.join(project.folder, String(call.args.path));
    if (!fs.existsSync(file)) {
      return { ok: false, error: "no such file" };
    }
    return { ok: true, text: "Attached; not sent.", pluginId: "microsoft-365" };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};

let reply: Json = { items: [] };
let lastPrompt = "";
const reasoner: Reasoner = {
  async reason(req) {
    lastPrompt = req.prompt;
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

const DOCX_SPEC = {
  title: "お見積りのご案内",
  blocks: [
    { type: "heading", level: 1, text: "お見積り" },
    { type: "paragraph", text: "標準作業単価は ¥12,000/時です。納期は【要確認】。" },
    { type: "table", header: ["項目", "単価"], rows: [["作業", "¥12,000/時"]] },
  ],
  footer: "KODA SōKEN · 下書き（要レビュー）",
};

function mailItem(ref: string, spec: Record<string, unknown> = DOCX_SPEC) {
  return {
    ref,
    title: "見積書の依頼",
    summary: "見積書（Word）の送付依頼",
    category: "sales",
    priority: "normal",
    flags: [],
    actions: [
      { kind: "workitem.intake", args: { department: "sales", note: "見積書を確認して送付" } },
      {
        kind: "mail.draft",
        args: {
          to: ["a@client.example.jp"],
          subject: "RE: 見積のお願い",
          body: "お世話になっております。",
        },
      },
      { kind: "office.create", args: { kind: "docx", file: "quote.docx", spec } },
      { kind: "mail.attach" },
    ],
  };
}

function setInbox(...ids: string[]) {
  inbox = ids
    .map(
      (id, i) =>
        `${i + 1}. id: ${id}\n   received: 2026-10-25T01:0${i}:00Z\n   from: Tanaka <a@client.example.jp>\n   subject: 見積のお願い\n`,
    )
    .join("");
}

function resetState() {
  updateRoutineState(project.id, ROUTINE, (cur) => ({ ...cur, seen: [] }));
}

beforeAll(() => {
  const folder = path.join(root, "company");
  fs.mkdirSync(folder, { recursive: true });
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-company-operations",
  )!;
  project = createProject(
    { name: "Company", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
  project = setProjectMode(project.id, "act").project;
  fs.writeFileSync(path.join(folder, "knowledge", "company-facts.md"), FACTS);
  registerOfficeSpecParsers();
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

describe("secretariat-inbox-full (company operations starter routine)", () => {
  it("is the template's routine: L1, prepare-only actions, knowledge in a read-only folder", () => {
    expect(project.rules.readOnly).toContain("knowledge");
    const set = loadRoutines(project);
    expect(set.error).toBeNull();
    expect(set.source.kind).toBe("template");
    const r = set.routines.find((x) => x.id === ROUTINE)!;
    expect(r).toMatchObject({
      level: "L1",
      actions: ["workitem.intake", "mail.draft", "office.create", "mail.attach"],
      knowledge: ["knowledge/company-facts.md"],
      queue: "secretariat-work",
    });
  });

  it("files, drafts, writes the Word document from approved facts and attaches it", async () => {
    setInbox("MSG1", "MSG2");
    reply = {
      items: [
        mailItem("MSG1"),
        {
          ref: "MSG2",
          title: "口座変更のお願い",
          summary: "振込先口座の変更依頼",
          flags: ["phishing"],
          actions: [
            { kind: "workitem.intake", args: { department: "finance" } },
            { kind: "mail.draft", args: { to: ["a@client.example.jp"], subject: "RE", body: "x" } },
          ],
        },
      ],
    };
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(run.status).toBe("escalated");
    // Trusted knowledge is its own block, before the untrusted sources.
    const k = lastPrompt.indexOf("APPROVED COMPANY KNOWLEDGE (TRUSTED");
    expect(k).toBeGreaterThan(0);
    expect(lastPrompt).toContain(FACTS);
    expect(k).toBeLessThan(lastPrompt.indexOf("===== SOURCE"));
    expect(lastPrompt).toContain("office.create args:");
    // Sequence: draft → office (real renderer) → attach that file to that draft.
    expect(calls.map((c) => c.tool).slice(3)).toEqual([
      "m365_mail_create_draft",
      "office_docx_create",
      "m365_mail_attach_to_draft",
    ]);
    const rel = `output/autopilot/${run.id}/1/quote.docx`;
    const attach = calls.find((c) => c.tool === "m365_mail_attach_to_draft")!;
    expect(attach.args).toEqual({ draftId: "DRAFT1", path: rel });
    const bytes = fs.readFileSync(path.join(project.folder, rel));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(run.actions.map((a) => [a.kind, a.decision, a.executed])).toEqual([
      ["workitem.intake", "allow", true],
      ["mail.draft", "allow", true],
      ["office.create", "allow", true],
      ["mail.attach", "allow", true],
      ["workitem.intake", "refuse", false],
      ["mail.draft", "refuse", false],
    ]);
    // Intake: department queue, email reference, flags on the item.
    const [clean, flagged] = run.workItems.map((id) => readWorkItem(project.id, id)!);
    expect(clean.queue).toBe("sales-work");
    expect(clean.source.origin).toMatchObject({ connector: "microsoft-365", messageId: "MSG1" });
    expect(clean.source.fields.note).toBe("見積書を確認して送付");
    expect(flagged.queue).toBe("secretariat-work");
    expect(flagged.flags).toEqual(["phishing"]);
    expect(calls.some((c) => /send/.test(c.tool))).toBe(false);
  });

  it("a spec the office plugin's parser rejects writes nothing and attaches nothing", async () => {
    resetState();
    setInbox("MSG3");
    // The plan schema accepts it (a table's header is optional there); the plugin parser not.
    const bad = { title: "t", blocks: [{ type: "table", rows: [["a"]] }] };
    reply = { items: [mailItem("MSG3", bad)] };
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(calls.some((c) => c.tool.startsWith("office_"))).toBe(false);
    expect(calls.some((c) => c.tool === "m365_mail_attach_to_draft")).toBe(false);
    const byKind = Object.fromEntries(run.actions.map((a) => [a.kind, a]));
    expect(byKind["office.create"].error).toMatch(/spec: blocks\[0\]\.header/);
    expect(byKind["mail.attach"].error).toMatch(/needs this item's mail.draft and office.create/);
    expect(run.status).toBe("escalated");
  });

  it("fails closed without the office plugin's parsers (no renderer, nothing written)", async () => {
    resetState();
    setInbox("MSG4");
    reply = { items: [mailItem("MSG4")] };
    resetOfficeSpecParsersForTests();
    try {
      const run = await runRoutine(deps(), project, ROUTINE, manual);
      const office = run.actions.find((a) => a.kind === "office.create")!;
      expect(office.error).toMatch(/office plugin is not enabled/);
      expect(calls.some((c) => c.tool.startsWith("office_"))).toBe(false);
    } finally {
      registerOfficeSpecParsers();
    }
  });

  it("the plan schema types the office spec per kind (unknown keys fail the plan)", () => {
    const plan = (spec: Record<string, unknown>, kind = "docx") =>
      JSON.stringify({
        items: [
          {
            ref: "x",
            title: "t",
            summary: "s",
            actions: [{ kind: "office.create", args: { kind, file: `a.${kind}`, spec } }],
          },
        ],
      });
    expect(() => parsePlan(plan(DOCX_SPEC), "autopilot.plan.v1")).not.toThrow();
    // A sentence or fence around the object is tolerated; the schema still applies.
    expect(() =>
      parsePlan(`Here is the plan:\n${plan(DOCX_SPEC)}\nDone.`, "autopilot.plan.v1"),
    ).not.toThrow();
    expect(() => parsePlan("no object here", "autopilot.plan.v1")).toThrow(/not JSON/);
    expect(() => parsePlan(plan({ ...DOCX_SPEC, script: "x" }), "autopilot.plan.v1")).toThrow(
      /does not match/,
    );
    expect(() => parsePlan(plan({ title: "t", slides: [] }), "autopilot.plan.v1")).toThrow(
      /does not match/,
    );
    expect(() =>
      parsePlan(
        plan({ sheets: [{ name: "s", header: ["a"], rows: [[1]] }] }, "xlsx"),
        "autopilot.plan.v1",
      ),
    ).not.toThrow();
  });

  it("refuses knowledge outside a read-only folder (the run fails before the model)", async () => {
    const r = loadRoutines(project).routines.find((x) => x.id === ROUTINE)!;
    fs.writeFileSync(path.join(project.folder, "output", "facts.md"), "agent-writable");
    fs.mkdirSync(path.join(project.folder, "context"), { recursive: true });
    fs.writeFileSync(
      path.join(project.folder, "context", "autopilot.yaml"),
      YAML.stringify({
        version: 1,
        routines: [
          {
            id: "kb",
            edition: "business",
            area: "secretariat",
            trigger: { interval: 60 },
            gather: [{ id: "inbox", tool: "m365_mail_list", args: {} }],
            reasoning: { prompt: r.reasoning.promptId },
            actions: ["workitem.intake"],
            knowledge: ["output/facts.md"],
          },
        ],
      }),
    );
    try {
      lastPrompt = "";
      const run = await runRoutine(deps(), project, "kb", manual);
      expect(run.status).toBe("failed");
      expect(run.reason).toMatch(/not under a read-only folder/);
      expect(lastPrompt).toBe("");
      expect(routineState(project.id, "kb").seen).toEqual([]);
    } finally {
      fs.rmSync(path.join(project.folder, "context", "autopilot.yaml"));
    }
  });
});
