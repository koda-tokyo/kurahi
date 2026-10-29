// The Business procurement routine (`procurement-po-draft`) end to end with the real office
// purchase order tool: a person's supplier choice on a 相見積 case makes the case due, one run
// drafts its 発注書 and marks the case, and the next run ends at the gate with no model call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { Actor } from "../workitems/types.js";
import type { Reasoner } from "./reasoner.js";
import type { ToolCall, ToolInvoker } from "./runner.js";
import { createOfficeTools } from "../../extensions/office/src/tools.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject, setProjectMode } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { createWorkItem } from "../workitems/lifecycle.js";
import { recordWorkItemProcurement, selectWorkItemSupplier } from "../workitems/procurement.js";
import { readWorkItem } from "../workitems/store.js";
import { runRoutine } from "./runner.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-procurement-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
const ROUTINE = "procurement-po-draft";
const buyer: Actor = { id: "device:buyer", kind: "person" };

let project: Project;
let calls: ToolCall[] = [];
const office = () => createOfficeTools({ sessionKey: calls.at(-1)?.sessionKey });

const tools: ToolInvoker = async (call) => {
  calls.push(call);
  if (call.tool.startsWith("office_")) {
    const t = office().find((x) => x.name === call.tool)!;
    const r = (await t.execute("c1", call.args)) as Json;
    if (r.details?.error) {
      return { ok: false, error: r.content[0].text };
    }
    return { ok: true, text: r.content[0].text, details: r.details, pluginId: "office" };
  }
  return { ok: false, error: `unexpected tool ${call.tool}` };
};

// The model proposes po.prepare for every id the gather listed.
let prompts: string[] = [];
const reasoner: Reasoner = {
  async reason(req) {
    prompts.push(req.prompt);
    const ids = /dueIds=([^\s]*)/.exec(req.prompt)?.[1]?.split(",").filter(Boolean) ?? [];
    const items = ids.map((id) => ({
      ref: id,
      title: "発注書の作成",
      summary: "選定済み取引先の発注書を下書き",
      category: "procurement",
      priority: "normal",
      flags: [],
      actions: [{ kind: "po.prepare", args: { case: id, language: "ja" } }],
    }));
    return { text: JSON.stringify({ items }), backend: "fake", model: null };
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

const request = [{ code: "BRG-6204", description: "ベアリング", quantity: 20 }];
const quote = (supplier: string, unitPrice: number) => ({
  supplier,
  lines: [{ code: "BRG-6204", description: "BRG", quantity: 20, unitPrice, taxRate: 10 }],
});

function chosenCase(supplier: string, reason?: string) {
  const item = createWorkItem(project, { queue: "proc-requests", title: "Bearings" }, buyer);
  const quoted = recordWorkItemProcurement(
    project,
    item.id,
    { request, quotes: [quote("Sato Kogyo", 1000), quote("Towa Shoji", 1100)] },
    buyer,
    item.revision,
  );
  return selectWorkItemSupplier(
    project,
    item.id,
    { supplier, ...(reason ? { reason } : {}) },
    buyer,
    quoted.revision,
  );
}

beforeAll(() => {
  const folder = path.join(root, "proc");
  fs.mkdirSync(folder, { recursive: true });
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-procurement",
  )!;
  project = createProject(
    { name: "Procurement", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  );
  project = setProjectMode(project.id, "act").project;
  // The Project's own routines file: the template routine, switched on.
  const pack = path.join(
    resolveTemplatesDir({}),
    "packs",
    "business-procurement",
    "autopilot.yaml",
  );
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "context", "autopilot.yaml"),
    fs.readFileSync(pack, "utf8").replace("enabled: false", "enabled: true"),
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

describe("procurement-po-draft (procurement starter routine)", () => {
  it("ends at the gate with no model call while no case is due", async () => {
    prompts = [];
    calls = [];
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(run.status).toBe("no_input");
    expect(prompts).toHaveLength(0);
  });

  it("drafts each chosen case once, bound to the person's choice, and never sends", async () => {
    const item = chosenCase("Towa Shoji", "Sato cannot deliver before the line restart");
    prompts = [];
    calls = [];
    const run = await runRoutine(deps(), project, ROUTINE, manual);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(item.id);
    const po = calls.filter((c) => c.tool === "office_po_create");
    expect(po).toHaveLength(1);
    expect(po[0].args).toMatchObject({
      order: {
        supplier: "Towa Shoji",
        selected_by: "device:buyer",
        reason: "Sato cannot deliver before the line restart",
      },
    });
    expect(calls.some((c) => /send|issue|pay/.test(c.tool))).toBe(false);
    expect(run.status).not.toBe("error");

    const marked = readWorkItem(project.id, item.id)!;
    expect(marked.purchaseOrderDraft).toMatchObject({
      supplier: "Towa Shoji",
      draftedBy: `autopilot:${ROUTINE}`,
      runId: run.id,
    });
    expect(
      fs.existsSync(path.join(project.folder, String(marked.purchaseOrderDraft!.document))),
    ).toBe(true);

    // The next run (the safety schedule, a second signal) does not draft it again.
    prompts = [];
    calls = [];
    const again = await runRoutine(deps(), project, ROUTINE, manual);
    expect(again.status).toBe("no_input");
    expect(prompts).toHaveLength(0);
    expect(calls.some((c) => c.tool === "office_po_create")).toBe(false);
  });
});
