// The Business sales quotation routine (`sales-quote-intake`) end to end with the real office
// quotation tool: intake, a reply draft, a 見積書 priced from the Project's price list and
// attached to the draft. The quotation's computed figures land on the work item, and an
// unpriced line blocks approval until a person overrides with a written reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { createOfficeTools } from "../../extensions/office/src/tools.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject, projectDataDir, setProjectMode } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { evaluatePolicy } from "../workitems/checks.js";
import { decideWorkItem } from "../workitems/decide.js";
import { updateWorkItem } from "../workitems/lifecycle.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { readWorkItem } from "../workitems/store.js";
import { runRoutine } from "./runner.js";
import { updateRoutineState } from "./store.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-quote-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
const ROUTINE = "sales-quote-intake";

let project: Project;
// A new message id files a new case (one case per email).
let messageId = "MSGQ1";
let calls: ToolCall[] = [];
let n = 0;
const office = () => createOfficeTools({ sessionKey: calls.at(-1)?.sessionKey });

const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool === "m365_mail_search") {
    return {
      ok: true,
      text: `1. id: ${messageId}\n   received: 2026-10-25T01:00:00Z\n   from: Sato <sato@client.example.jp>\n   subject: 見積依頼\n`,
      pluginId: "microsoft-365",
    };
  }
  if (call.tool === "m365_mail_read") {
    return {
      ok: true,
      text: "部品A 10個と設置作業 1.5時間、特注品 1個の見積をお願いします。",
      pluginId: "microsoft-365",
    };
  }
  if (call.tool === "m365_mail_create_draft") {
    const id = `DRAFT${++n}`;
    return {
      ok: true,
      text: `Created draft ${id}; not sent.`,
      details: { id },
      pluginId: "microsoft-365",
    };
  }
  if (call.tool.startsWith("office_")) {
    const t = office().find((x) => x.name === call.tool)!;
    const r = (await t.execute("c1", call.args)) as Json;
    if (r.details?.error) {
      return { ok: false, error: r.content[0].text };
    }
    return { ok: true, text: r.content[0].text, details: r.details, pluginId: "office" };
  }
  if (call.tool === "m365_mail_attach_to_draft") {
    return fs.existsSync(path.join(project.folder, String(call.args.path)))
      ? { ok: true, text: "Attached; not sent.", pluginId: "microsoft-365" }
      : { ok: false, error: "no such file" };
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

const quoteItem = (lines: Json[]) => ({
  ref: messageId,
  title: "見積依頼（サンプル精機）",
  summary: "部品A・設置作業・特注品の見積依頼",
  category: "sales",
  priority: "normal",
  flags: [],
  actions: [
    {
      kind: "workitem.intake",
      args: { type: "quote", note: "依頼: 部品A 10個、設置作業 1.5時間、特注品 1個" },
    },
    {
      kind: "mail.draft",
      args: {
        to: ["sato@client.example.jp"],
        subject: "RE: 見積依頼",
        body: "御見積書を添付いたします。",
      },
    },
    {
      kind: "quote.prepare",
      args: {
        quote: { customer: "株式会社サンプル精機", subject: "部品と設置作業の御見積", lines },
      },
    },
    { kind: "mail.attach" },
  ],
});

beforeAll(() => {
  const folder = path.join(root, "sales");
  fs.mkdirSync(folder, { recursive: true });
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-sales-quotation",
  )!;
  project = createProject(
    { name: "Sales", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
  project = setProjectMode(project.id, "act").project;
  fs.mkdirSync(path.join(folder, "quotes"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "quotes", "price-list.csv"),
    "品番,品名,単位,単価,税率\nA-100,部品A,個,1200,10\nS-900,設置作業,時間,8000,10\n",
  );
  // The Project's own policy: the pack's, with one named sales lead as approver.
  const packPolicy = path.join(
    resolveTemplatesDir({}),
    "packs",
    "business-sales-quotation",
    "workqueue.yaml",
  );
  fs.mkdirSync(projectDataDir(project.id), { recursive: true });
  fs.writeFileSync(
    path.join(projectDataDir(project.id), "workqueue.yaml"),
    fs
      .readFileSync(packPolicy, "utf8")
      .replace(
        "  fallback: none\n",
        "  fallback: none\n  members:\n    - { principal: device:saleslead01, name: 営業リーダー, roles: [approver], departments: [sales] }\n",
      ),
  );
  // The Project's own routines file: the template routine, switched on.
  const pack = path.join(
    resolveTemplatesDir({}),
    "packs",
    "business-sales-quotation",
    "autopilot.yaml",
  );
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "context", "autopilot.yaml"),
    fs.readFileSync(pack, "utf8").replace("enabled: false", "enabled: true"),
  );
});

beforeEach(() => {
  calls = [];
  messageId = "MSGQ1";
  // Each test reads the same message as new.
  updateRoutineState(project.id, ROUTINE, (cur) => ({ ...cur, seen: [] }));
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

describe("sales-quote-intake (sales quotation starter routine)", () => {
  it("files the case, drafts, writes the priced 見積書, attaches it; an unpriced line blocks approval", async () => {
    reply = {
      items: [
        quoteItem([
          { code: "A-100", description: "部品A", quantity: 10 },
          { description: "設置作業", quantity: 1.5 },
          { description: "特注品", quantity: 1 },
        ]),
      ],
    };
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(lastPrompt).toContain("quote.prepare args:");
    expect(lastPrompt).toContain("Never give a price");
    expect(calls.map((c) => c.tool).slice(2)).toEqual([
      "m365_mail_create_draft",
      "office_quote_create",
      "m365_mail_attach_to_draft",
    ]);
    const attach = calls.find((c) => c.tool === "m365_mail_attach_to_draft")!;
    expect(String(attach.args.path)).toMatch(/^output\/quotes\/見積書_Q-\d{8}\.docx$/);
    expect(calls.some((c) => /send/.test(c.tool))).toBe(false);

    const item = readWorkItem(project.id, run.workItems[0])!;
    expect(item.type).toBe("quote");
    expect(item.queue).toBe("sales-quotes");
    // Figures computed by Kurahi, copied by the engine (12,000 + 12,000 + 10% tax).
    expect(item.source.fields).toMatchObject({
      quoteSubtotal: 24000,
      quoteTax: 2400,
      quoteTotal: 26400,
      quoteUnpriced: 1,
      quoteLines: 2,
    });
    expect(String(item.source.fields.quotePriceList)).toMatch(/^[0-9a-f]{64}$/);
    // The list's age in days lands on the item, so a pack rule can route an old list to a person.
    expect(item.source.fields.quotePriceListAgeDays).toEqual(expect.any(Number));
    // With the company's limit and the days past it, so the pack rule follows that limit.
    expect(item.source.fields).toMatchObject({
      quotePriceListMaxAgeDays: 180,
      quotePriceListOverdueDays: 0,
    });
    // Both files are on the item.
    expect(item.source.documents.map((d) => d.ref ?? d)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.docx$/), expect.stringMatching(/\.xlsx$/)]),
    );

    // The unpriced line blocks approval (a person may override only with a written reason).
    const policy = loadWorkQueuePolicy(project);
    const checks = evaluatePolicy(policy, item, null, new Date()).checks;
    const complete = checks.find((c) => c.policyId === "quote.complete")!;
    expect(complete).toMatchObject({
      result: "fail",
      blocking: true,
      overrideOutcome: "provisional",
    });
    expect(String(item.source.fields.quoteDocument)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(item.source.fields.quoteWorkbook)).toMatch(/^[0-9a-f]{64}$/);

    // A plain approve is refused; approving with a reason releases a PROVISIONAL estimate only.
    const lead = { id: "device:saleslead01", kind: "person" as const };
    const ready = updateWorkItem(
      project,
      item.id,
      { status: "awaiting_review" },
      lead,
      item.revision,
    );
    expect(() =>
      decideWorkItem(project, item.id, { decision: "approve" }, lead, ready.revision),
    ).toThrow(/blocking checks failed \(quote.complete\)/);
    const approved = decideWorkItem(
      project,
      item.id,
      { decision: "approve", override: { reason: "特注品は別見積として暫定で提示する" } },
      lead,
      ready.revision,
    );
    expect(approved.status).toBe("approved");
    expect(approved.override).toMatchObject({
      by: lead.id,
      policyIds: ["quote.complete"],
      outcome: "provisional",
    });
  });

  it("refuses to approve a quotation whose file changed after intake, even with an override (peer review of 7464bf20b5)", async () => {
    messageId = "MSGQ2";
    reply = { items: [quoteItem([{ code: "A-100", description: "部品A", quantity: 10 }])] };
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    const item = readWorkItem(project.id, run.workItems[0])!;
    const doc = item.source.documents.find((d) => d.ref.endsWith(".docx"))!;
    expect(doc.sha256).toBe(item.source.fields.quoteDocument);
    fs.appendFileSync(path.join(project.folder, doc.ref), "changed after the quotation was made");
    const lead = { id: "device:saleslead01", kind: "person" as const };
    const ready = updateWorkItem(
      project,
      item.id,
      { status: "awaiting_review" },
      lead,
      item.revision,
    );
    for (const decision of [
      { decision: "approve" as const },
      {
        decision: "approve" as const,
        override: { reason: "Customer asked for this exact version to be released today." },
      },
    ]) {
      expect(() => decideWorkItem(project, item.id, decision, lead, ready.revision)).toThrow(
        /document changed after it was attached/,
      );
    }
    expect(readWorkItem(project.id, item.id)!.status).toBe("awaiting_review");
  });

  it("refuses a plan that puts a price on a line", async () => {
    reply = {
      items: [quoteItem([{ code: "A-100", description: "部品A", quantity: 10, unit_price: 1 }])],
    };
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    const q = run.actions.find((a) => a.kind === "quote.prepare")!;
    expect(q.decision).toBe("refuse");
    expect(calls.some((c) => c.tool === "office_quote_create")).toBe(false);
  });
});
