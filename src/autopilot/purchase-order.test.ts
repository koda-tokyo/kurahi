// po.prepare: the engine binds the purchase order to the case's recorded comparison and the
// person's recorded supplier choice; the model names only the case. Run through the real office
// purchase order tool so the bound arguments are exactly what it parses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { SupplierQuoteInput } from "../quotes/compare.js";
import type { Actor, WorkItem } from "../workitems/types.js";
import type { ActCall, ItemContext } from "./act.js";
import type { PlanItem } from "./types.js";
import { createOfficeTools } from "../../extensions/office/src/tools.js";
import { flushAudit } from "../audit/audit-log.js";
import { projectSessionKey } from "../projects/scope.js";
import { createProject } from "../projects/store.js";
import { COMPARISON_LIMITS } from "../quotes/compare.js";
import { createWorkItem } from "../workitems/lifecycle.js";
import {
  purchaseOrderDue,
  recordPurchaseOrderDraft,
  recordWorkItemProcurement,
  selectWorkItemSupplier,
} from "../workitems/procurement.js";
import { readWorkItem } from "../workitems/store.js";
import { executeAction } from "./act.js";
import { cleanActionArgs, getActionDef } from "./actions.js";
import { engineToolNoInput, runEngineTool } from "./engine-tools.js";
import { purchaseOrderToolArgs } from "./purchase-order.js";
import { defaultWorkItemSink } from "./workitems-adapter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-po-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

const buyer: Actor = { id: "device:buyer", kind: "person" };
const request = [
  { code: "BRG-6204", description: "ベアリング", quantity: 20 },
  { code: "BLT-M8", description: "ボルト M8", quantity: 500 },
];
const quote = (supplier: string, bearing: number): SupplierQuoteInput => ({
  supplier,
  lines: [
    { code: "BRG-6204", description: "BRG", quantity: 20, unitPrice: bearing, taxRate: 10 },
    { code: "BLT-M8", description: "BLT", quantity: 500, unitPrice: 10, taxRate: 10 },
  ],
});
// Sato is lowest (25,000 net), Towa second (27,000 net).
const quotes = [quote("Sato Kogyo", 1000), quote("Towa Shoji", 1100)];

let project: Project;

beforeAll(() => {
  const folder = path.join(root, "proc");
  fs.mkdirSync(folder, { recursive: true });
  project = createProject(
    {
      name: "Procurement",
      folder,
      rules: {
        readOnly: [],
        writable: ["output"],
        artifactApprovalRequired: false,
        instructions: [],
      },
      mode: "act",
    },
    { createdBy: buyer.id, template: null },
  );
});

afterAll(async () => {
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  fs.rmSync(root, { recursive: true, force: true });
});

function quotedCase(): WorkItem {
  const item = createWorkItem(project, { queue: "procurement", title: "Bearings" }, buyer);
  return recordWorkItemProcurement(project, item.id, { request, quotes }, buyer, item.revision);
}

function chosen(supplier: string, reason?: string): WorkItem {
  const item = quotedCase();
  return selectWorkItemSupplier(
    project,
    item.id,
    { supplier, ...(reason ? { reason } : {}) },
    buyer,
    item.revision,
  );
}

const sessionKey = () => projectSessionKey("main", project.id, "c1");

async function runPoTool(args: Record<string, unknown>): Promise<Json> {
  const tool = createOfficeTools({ agentId: "main", sessionKey: sessionKey() }).find(
    (t) => t.name === "office_po_create",
  )!;
  return (await tool.execute("c1", args)) as Json;
}

describe("purchaseOrderToolArgs", () => {
  it("binds the recorded comparison, supplier, chooser and reason, not the model's", async () => {
    const item = chosen("Towa Shoji", "Sato cannot deliver before the line restart");
    const args = purchaseOrderToolArgs(item, {
      number: "PO-7",
      supplier: "Sato Kogyo",
      selected_by: "agent:main",
    });
    expect(args.order).toMatchObject({
      number: "PO-7",
      supplier: "Towa Shoji",
      selected_by: "device:buyer",
      reason: "Sato cannot deliver before the line restart",
    });
    const res = await runPoTool(args);
    expect(res.details?.error).toBeUndefined();
    expect(res.details).toMatchObject({
      number: "PO-7",
      supplier: "Towa Shoji",
      net: 27_000,
      total: 29_700,
      lowest: ["Sato Kogyo"],
      deviatesFromLowest: true,
    });
    expect(fs.existsSync(path.join(project.folder, res.details.path))).toBe(true);
  });

  it("drafts from any case the store accepts: the most suppliers, items and longest text", async () => {
    // Both counts at once exceed the store's byte cap, so each is at its limit on its own.
    const grid = (items: number, suppliers: number) => {
      const codes = Array.from({ length: items }, (_, i) => `P${i}`);
      return {
        request: codes.map((code) => ({ code, quantity: 1 })),
        quotes: Array.from({ length: suppliers }, (_, s) => ({
          supplier: `Supplier ${s}`,
          lines: codes.map((code) => ({
            code,
            description: code,
            quantity: 1,
            unitPrice: 100 + s,
            taxRate: 10,
          })),
        })),
      };
    };
    const long = (n: number, c: string) => c.repeat(n);
    const code = long(COMPARISON_LIMITS.code, "C");
    const text = [
      { supplier: long(COMPARISON_LIMITS.supplier, "S"), price: 100 },
      { supplier: long(COMPARISON_LIMITS.supplier, "T"), price: 110 },
    ].map(({ supplier, price }) => ({
      supplier,
      lines: [
        {
          code,
          description: long(COMPARISON_LIMITS.description, "d"),
          quantity: 1,
          unitPrice: price,
          taxRate: 10,
        },
      ],
    }));
    const cases = [
      grid(COMPARISON_LIMITS.items, 2),
      grid(10, COMPARISON_LIMITS.suppliers),
      {
        request: [{ code, description: long(COMPARISON_LIMITS.description, "r"), quantity: 1 }],
        quotes: text,
      },
    ];
    for (const [n, input] of cases.entries()) {
      const item = createWorkItem(project, { queue: "procurement", title: "Wide" }, buyer);
      const recorded = recordWorkItemProcurement(project, item.id, input, buyer, item.revision);
      const supplier = input.quotes[0].supplier;
      const picked = selectWorkItemSupplier(
        project,
        item.id,
        { supplier },
        buyer,
        recorded.revision,
      );
      const res = await runPoTool(purchaseOrderToolArgs(picked, { number: `PO-W${n}` }));
      expect(res.details?.error).toBeUndefined();
      expect(res.details).toMatchObject({ number: `PO-W${n}`, supplier });
    }
  });

  it("refuses a case without a person's choice, or whose quotes changed since", () => {
    expect(() => purchaseOrderToolArgs(quotedCase(), {})).toThrow(/selection|chose|choose/i);
    const item = chosen("Sato Kogyo");
    const requoted = recordWorkItemProcurement(
      project,
      item.id,
      { request, quotes: [quote("Sato Kogyo", 990), quote("Towa Shoji", 1100)] },
      buyer,
      item.revision,
    );
    expect(() => purchaseOrderToolArgs(requoted, {})).toThrow();
  });
});

describe("po.prepare action", () => {
  const def = getActionDef("po.prepare")!;

  it("takes the case, never a supplier, chooser, reason or comparison", () => {
    expect(def.class).toBe("prepare");
    expect(cleanActionArgs(def, { case: "x" }).ok).toBe(true);
    for (const key of ["supplier", "selected_by", "selectedBy", "reason", "comparison"]) {
      expect(cleanActionArgs(def, { case: "x", [key]: "y" }).ok).toBe(false);
    }
    expect(cleanActionArgs(def, {}).ok).toBe(false);
  });

  it("executes on the Project's case and records the draft as the item's document", async () => {
    const item = chosen("Sato Kogyo");
    const sent: Json[] = [];
    const call = {
      deps: {
        workItems: defaultWorkItemSink(),
        tools: async (c: Json) => {
          sent.push(c);
          const r = await runPoTool(c.args);
          return r.details?.error
            ? { ok: false, error: r.content[0].text }
            : { ok: true, text: r.content[0].text, details: r.details, pluginId: "office" };
        },
      },
      project,
      routine: { id: "procurement-po", actionTools: {} },
      runId: "r1",
      sessionKey: sessionKey(),
      agentId: "main",
      engine: {},
      workItems: [],
    } as unknown as ActCall;
    const ctx: ItemContext = {
      index: 1,
      origin: undefined,
      draftId: null,
      documentPath: null,
      documents: [],
      fields: {},
    };
    const res = await executeAction(call, def, { case: item.id }, {} as PlanItem, ctx);
    expect(sent[0].tool).toBe("office_po_create");
    expect(sent[0].args.order.selected_by).toBe("device:buyer");
    expect(res.ref).toMatch(/^office_po_create:output\/purchase-orders\//);
    expect(ctx.documents).toHaveLength(2);
    expect(ctx.fields).toMatchObject({ poSupplier: "Sato Kogyo", poNet: 25_000 });

    await expect(
      executeAction(call, def, { case: "wi_missing" }, {} as PlanItem, ctx),
    ).rejects.toThrow(/no case/);

    // The case remembers the draft, so the next run does not draft it again.
    const marked = readWorkItem(project.id, item.id)!;
    expect(marked.purchaseOrderDraft).toMatchObject({
      supplier: "Sato Kogyo",
      comparisonDigest: item.supplierSelection!.comparisonDigest,
      draftedBy: "autopilot:procurement-po",
      runId: "r1",
      // Typed quotes: no sheet behind them.
      source: null,
    });
    expect(marked.purchaseOrderDraft!.document).toMatch(/^output\/purchase-orders\//);
    expect(marked.history.at(-1)?.action).toBe("po.draft");
    expect(purchaseOrderDue(marked)).toBe(false);

    // Whatever case the model names, one the gather would not list is not drafted again.
    sent.length = 0;
    await expect(executeAction(call, def, { case: item.id }, {} as PlanItem, ctx)).rejects.toThrow(
      /already has a draft/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("purchase orders due", () => {
  const routineActor: Actor = { id: "autopilot:procurement-po", kind: "agent" };

  it("is due once per current choice: not before it, not after its draft, again after a new one", () => {
    const quoted = quotedCase();
    expect(purchaseOrderDue(quoted)).toBe(false);
    const item = selectWorkItemSupplier(
      project,
      quoted.id,
      { supplier: "Sato Kogyo" },
      buyer,
      quoted.revision,
    );
    expect(purchaseOrderDue(item)).toBe(true);
    const digest = item.supplierSelection!.comparisonDigest;
    const drafted = recordPurchaseOrderDraft(
      project,
      item.id,
      {
        document: null,
        comparisonDigest: digest,
        supplier: "Sato Kogyo",
        selectionRevision: item.supplierSelection!.revision,
        source: null,
        runId: "r1",
      },
      routineActor,
    );
    expect(purchaseOrderDue(drafted)).toBe(false);

    // New quotes: the old choice is stale (not due) until a person chooses again.
    const requoted = recordWorkItemProcurement(
      project,
      item.id,
      { request, quotes: [quote("Sato Kogyo", 1000), quote("Towa Shoji", 900)] },
      buyer,
      drafted.revision,
    );
    expect(purchaseOrderDue(requoted)).toBe(false);
    // A draft bound to the old choice can no longer be recorded.
    expect(() =>
      recordPurchaseOrderDraft(
        project,
        item.id,
        {
          document: null,
          comparisonDigest: digest,
          supplier: "Sato Kogyo",
          selectionRevision: item.supplierSelection!.revision,
          source: null,
          runId: "r2",
        },
        routineActor,
      ),
    ).toThrow(/changed/);
    const rechosen = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Towa Shoji" },
      buyer,
      requoted.revision,
    );
    expect(purchaseOrderDue(rechosen)).toBe(true);
  });

  it("is due again when a person picks another supplier from the same quotes", () => {
    const item = chosen("Sato Kogyo");
    const digest = item.supplierSelection!.comparisonDigest;
    const drafted = recordPurchaseOrderDraft(
      project,
      item.id,
      {
        document: null,
        comparisonDigest: digest,
        supplier: "Sato Kogyo",
        selectionRevision: item.supplierSelection!.revision,
        source: null,
        runId: "r1",
      },
      routineActor,
    );
    expect(purchaseOrderDue(drafted)).toBe(false);
    const switched = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Towa Shoji", reason: "Sato cannot deliver before the line restart" },
      buyer,
      drafted.revision,
    );
    // Same quotes, same digest: only the supplier tells the choices apart.
    expect(switched.supplierSelection!.comparisonDigest).toBe(digest);
    expect(purchaseOrderDue(switched)).toBe(true);
    // A draft made for Sato while the person switched to Towa is refused, not recorded as Towa's.
    expect(() =>
      recordPurchaseOrderDraft(
        project,
        item.id,
        {
          document: null,
          comparisonDigest: digest,
          supplier: "Sato Kogyo",
          selectionRevision: item.supplierSelection!.revision,
          source: null,
          runId: "r2",
        },
        routineActor,
      ),
    ).toThrow(/changed/);
    expect(readWorkItem(project.id, item.id)!.purchaseOrderDraft!.runId).toBe("r1");
  });

  it("is due again when a person goes back to a supplier whose draft was replaced", () => {
    const item = chosen("Sato Kogyo");
    const digest = item.supplierSelection!.comparisonDigest;
    let cur = recordPurchaseOrderDraft(
      project,
      item.id,
      {
        document: null,
        comparisonDigest: digest,
        supplier: "Sato Kogyo",
        selectionRevision: item.supplierSelection!.revision,
        source: null,
        runId: "r1",
      },
      routineActor,
    );
    cur = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Towa Shoji", reason: "Sato cannot deliver before the line restart" },
      buyer,
      cur.revision,
    );
    cur = recordPurchaseOrderDraft(
      project,
      item.id,
      {
        document: null,
        comparisonDigest: digest,
        supplier: "Towa Shoji",
        selectionRevision: cur.supplierSelection!.revision,
        source: null,
        runId: "r2",
      },
      routineActor,
    );
    expect(purchaseOrderDue(cur)).toBe(false);
    // The case holds Towa's draft now, so going back to Sato needs a fresh one.
    cur = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Sato Kogyo", reason: "Sato confirmed the earlier delivery date" },
      buyer,
      cur.revision,
    );
    expect(purchaseOrderDue(cur)).toBe(true);
  });

  it("is due again when a person chooses the same supplier again with a corrected reason", () => {
    const item = chosen("Towa Shoji", "Original delivery justification");
    const first = item.supplierSelection!;
    // The routine built the order (and its reason) from the first choice ...
    expect(purchaseOrderToolArgs(item, {}).order).toMatchObject({
      reason: "Original delivery justification",
    });
    // ... while the person corrected the reason, keeping the supplier and the quotes.
    const corrected = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Towa Shoji", reason: "Corrected delivery justification" },
      buyer,
      item.revision,
    );
    expect(corrected.supplierSelection!.comparisonDigest).toBe(first.comparisonDigest);
    expect(() =>
      recordPurchaseOrderDraft(
        project,
        item.id,
        {
          document: null,
          comparisonDigest: first.comparisonDigest,
          supplier: "Towa Shoji",
          selectionRevision: first.revision,
          source: null,
          runId: "r1",
        },
        routineActor,
      ),
    ).toThrow(/changed/);
    const unchanged = readWorkItem(project.id, item.id)!;
    expect(unchanged.purchaseOrderDraft).toBeUndefined();
    expect(purchaseOrderDue(unchanged)).toBe(true);
    // A draft from the corrected choice is recorded, and the case is then not due.
    const drafted = recordPurchaseOrderDraft(
      project,
      item.id,
      {
        document: null,
        comparisonDigest: first.comparisonDigest,
        supplier: "Towa Shoji",
        selectionRevision: corrected.supplierSelection!.revision,
        source: null,
        runId: "r2",
      },
      routineActor,
    );
    expect(drafted.purchaseOrderDraft!.selectionRevision).toBe(
      corrected.supplierSelection!.revision,
    );
    expect(purchaseOrderDue(drafted)).toBe(false);
    // Choosing the same supplier again after its draft needs a fresh one too.
    const rechosen = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Towa Shoji", reason: "Delivery date confirmed in writing" },
      buyer,
      drafted.revision,
    );
    expect(purchaseOrderDue(rechosen)).toBe(true);
  });

  it("is never due for a case with a fraud flag or a closed case", () => {
    const item = chosen("Sato Kogyo");
    expect(purchaseOrderDue({ ...item, flags: ["suspected_fraud"] })).toBe(false);
    expect(purchaseOrderDue({ ...item, status: "cancelled" })).toBe(false);
  });

  it("lists due case ids for a routine's gather, and gates the run when none is due", () => {
    const item = chosen("Sato Kogyo");
    const text = runEngineTool("workitems_po_ready", {}, { projectId: project.id });
    const due = /^fact dueIds=(.*)$/m.exec(text)![1].split(",");
    expect(due).toContain(item.id);
    expect(text).toMatch(/^verdict OK /m);
    expect(engineToolNoInput("workitems_po_ready", text)).toBeNull();
    expect(
      engineToolNoInput(
        "workitems_po_ready",
        "fact due=0\nfact dueIds=\nfact unreadableItems=0\nfact unreadableItemIds=\nverdict OK 0",
      ),
    ).toMatch(/no case/);
    // An unreadable store is unknown, never a reason to skip the run.
    expect(
      engineToolNoInput(
        "workitems_po_ready",
        "fact due=0\nfact unreadableItems=2\nverdict ESCALATE x",
      ),
    ).toBeNull();
    const other = runEngineTool("workitems_po_ready", {}, { projectId: "missing-project" });
    expect(engineToolNoInput("workitems_po_ready", other)).toBeNull();
  });
});
