import { Value } from "@sinclair/typebox/value";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { SupplierQuoteInput } from "../quotes/compare.js";
import type { Actor, WorkItem } from "./types.js";
import { flushAudit } from "../audit/audit-log.js";
import { WorkItemProcurementSchema } from "../gateway/protocol/schema/workitems.js";
import { createProject } from "../projects/store.js";
import { COMPARISON_LIMITS } from "../quotes/compare.js";
import { createWorkItem } from "./lifecycle.js";
import {
  PROCUREMENT_MAX_SUPPLIERS,
  procurementSourceOf,
  purchaseOrderSelectionFor,
  recordPurchaseOrderDraft,
  recordWorkItemProcurement,
  selectWorkItemSupplier,
} from "./procurement.js";
import { mutateWorkItem, readWorkItem, summarize } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-workitems-procurement-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const person: Actor = { id: "device:buyer", kind: "person" };
const agent: Actor = { id: "agent:main", kind: "agent", privileged: true };

const request = [
  { code: "BRG-6204", description: "ベアリング", quantity: 20 },
  { code: "BLT-M8", description: "ボルト M8", quantity: 500 },
];

function quote(supplier: string, prices: Record<string, number>): SupplierQuoteInput {
  return {
    supplier,
    lines: Object.entries(prices).map(([code, unitPrice]) => ({
      code,
      description: code,
      quantity: code === "BRG-6204" ? 20 : 500,
      unitPrice,
      taxRate: 10 as const,
    })),
  };
}

// Sato is lowest (1000*20 + 10*500 = 25000), Towa second (1100*20 + 10*500 = 27000).
const quotes = [
  quote("Sato Kogyo", { "BRG-6204": 1000, "BLT-M8": 10 }),
  quote("Towa Shoji", { "BRG-6204": 1100, "BLT-M8": 10 }),
];

let project: Project;

beforeAll(() => {
  const folder = path.join(root, "proc");
  fs.mkdirSync(folder, { recursive: true });
  project = createProject(
    { name: "Procurement", folder },
    { createdBy: person.id, template: null },
  );
});

afterAll(async () => {
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  fs.rmSync(root, { recursive: true, force: true });
});

function newCase(): WorkItem {
  return createWorkItem(project, { queue: "procurement", title: "Bearings and bolts" }, person);
}

function withQuotes(): WorkItem {
  const item = newCase();
  return recordWorkItemProcurement(project, item.id, { request, quotes }, person, item.revision);
}

describe("recordWorkItemProcurement", () => {
  it("stores the request and quotes with the comparison digest; an agent may record them", () => {
    const item = newCase();
    const next = recordWorkItemProcurement(project, item.id, { request, quotes }, agent, undefined);
    expect(next.procurement).toMatchObject({ request, quotes, recordedBy: agent.id });
    expect(next.procurement?.comparisonDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(next.history.at(-1)).toMatchObject({ action: "procurement.record" });
    expect(next.supplierSelection).toBeUndefined();
    expect(summarize(next)).not.toHaveProperty("procurement");
  });

  it("refuses an invalid comparison and too many suppliers", () => {
    const item = newCase();
    expect(() =>
      recordWorkItemProcurement(project, item.id, { request, quotes: [quotes[0]] }, person, 1),
    ).toThrow(/at least 2 suppliers/);
    const many = Array.from({ length: PROCUREMENT_MAX_SUPPLIERS + 1 }, (_, i) =>
      quote(`S${i}`, { "BRG-6204": 1000, "BLT-M8": 10 }),
    );
    expect(() =>
      recordWorkItemProcurement(project, item.id, { request, quotes: many }, person, 1),
    ).toThrow(/at most/);
    expect(readWorkItem(project.id, item.id)?.procurement).toBeUndefined();
  });

  it("refuses fields of the wrong type, so a stored case always matches the item schema", () => {
    const item = newCase();
    const line = (patch: Record<string, unknown>) => [
      { ...quotes[0], lines: [{ ...quotes[0].lines[0], ...patch }, quotes[0].lines[1]] },
      quotes[1],
    ];
    const malformed: Array<{ request?: unknown; quotes?: unknown }> = [
      { request: [{ ...request[0], description: 123 }, request[1]], quotes },
      { request: [{ ...request[0], code: 7 }, request[1]], quotes },
      { request, quotes: line({ unit: 123 }) },
      { request, quotes: line({ description: 5 }) },
      { request, quotes: line({ code: 9 }) },
      { request, quotes: line({ taxRate: "10" }) },
      { request, quotes: line({ discountAmount: "5" }) },
      { request, quotes: [{ ...quotes[0], supplier: 42 }, quotes[1]] },
      { request, quotes: [{ ...quotes[0], lines: [1, 2] }, quotes[1]] },
      { request, quotes: [{ ...quotes[0], options: [] }, quotes[1]] },
      // Longer than the office tools accept, so po.prepare could not draft from it.
      {
        request: [{ ...request[0], code: "C".repeat(COMPARISON_LIMITS.code + 1) }, request[1]],
        quotes,
      },
      { request, quotes: line({ description: "d".repeat(COMPARISON_LIMITS.description + 1) }) },
      {
        request,
        quotes: [{ ...quotes[0], supplier: "S".repeat(COMPARISON_LIMITS.supplier + 1) }, quotes[1]],
      },
    ];
    for (const input of malformed) {
      expect(() => recordWorkItemProcurement(project, item.id, input, person, 1)).toThrow(
        expect.objectContaining({ code: "invalid_comparison" }),
      );
    }
    expect(readWorkItem(project.id, item.id)?.procurement).toBeUndefined();
    const stored = recordWorkItemProcurement(
      project,
      item.id,
      { request, quotes: line({ unit: "個" }) },
      person,
      1,
    );
    expect(Value.Check(WorkItemProcurementSchema, stored.procurement)).toBe(true);
  });
});

describe("recordWorkItemProcurement from supplier sheets under quotes/", () => {
  const sheet = (bearing: number) =>
    `品番,品名,数量,単価,税率\nBRG-6204,BRG-6204,20,${bearing},10%\nBLT-M8,BLT-M8,500,10,10%\n`;
  const write = (rel: string, text: string) => {
    const file = path.join(project.folder, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it("reads the lines server-side and records each sheet's sha256", () => {
    write("quotes/sato.csv", sheet(1000));
    write("quotes/towa.csv", sheet(1100));
    const item = newCase();
    const next = recordWorkItemProcurement(
      project,
      item.id,
      {
        request,
        quotes: [
          { supplier: "Sato Kogyo", file: "quotes/sato.csv" },
          { supplier: "Towa Shoji", file: "quotes/towa.csv" },
        ],
      },
      agent,
      undefined,
    );
    // Priced (descriptions included) the same as the same quotes typed as lines.
    const typed = withQuotes();
    expect(next.procurement?.comparisonDigest).toBe(typed.procurement?.comparisonDigest);
    expect(next.procurement?.quotes[0]).not.toHaveProperty("file");
    expect(next.procurement?.quotes[1].lines[0]).toMatchObject({
      code: "BRG-6204",
      unitPrice: "1100",
    });
    expect(next.procurement?.files).toEqual([
      {
        supplier: "Sato Kogyo",
        file: "quotes/sato.csv",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        supplier: "Towa Shoji",
        file: "quotes/towa.csv",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(next.history.at(-1)?.detail).toMatchObject({ files: next.procurement?.files });
    expect(Value.Check(WorkItemProcurementSchema, next.procurement)).toBe(true);
    expect(typed.procurement).not.toHaveProperty("files");
  });

  it("keeps a draft's sheet when a same-priced sheet replaces it, and refuses a swap mid-draft", () => {
    write("quotes/sato.csv", sheet(1000));
    write("quotes/towa.csv", sheet(1100));
    const files = [
      { supplier: "Sato Kogyo", file: "quotes/sato.csv" },
      { supplier: "Towa Shoji", file: "quotes/towa.csv" },
    ];
    const recorded = recordWorkItemProcurement(
      project,
      newCase().id,
      { request, quotes: files },
      agent,
      undefined,
    );
    const chosen = selectWorkItemSupplier(
      project,
      recorded.id,
      { supplier: "Sato Kogyo" },
      person,
      recorded.revision,
    );
    const seen = procurementSourceOf(chosen, "Sato Kogyo");
    expect(seen).toEqual({
      file: "quotes/sato.csv",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const draftOf = (source: typeof seen, runId: string) =>
      recordPurchaseOrderDraft(
        project,
        chosen.id,
        {
          document: null,
          comparisonDigest: chosen.supplierSelection!.comparisonDigest,
          supplier: "Sato Kogyo",
          selectionRevision: chosen.supplierSelection!.revision,
          source,
          runId,
        },
        agent,
      );
    const drafted = draftOf(seen, "r1");
    expect(drafted.purchaseOrderDraft?.source).toEqual(seen);

    // Same prices from different bytes: the comparison (and the person's choice) is unchanged.
    write("quotes/sato.csv", `${sheet(1000)}\n`);
    const resheeted = recordWorkItemProcurement(
      project,
      chosen.id,
      { request, quotes: files },
      agent,
      undefined,
    );
    expect(resheeted.procurement?.comparisonDigest).toBe(chosen.procurement?.comparisonDigest);
    const now = procurementSourceOf(resheeted, "Sato Kogyo");
    expect(now?.sha256).not.toBe(seen?.sha256);
    // The earlier draft still names the sheet it was made from, never the new one.
    expect(resheeted.purchaseOrderDraft?.source).toEqual(seen);
    // A draft prepared from the old sheet cannot be recorded against the new one.
    expect(() => draftOf(seen, "r2")).toThrow(
      expect.objectContaining({ code: "selection_not_current" }),
    );
    expect(draftOf(now, "r3").purchaseOrderDraft?.source).toEqual(now);
  });

  it("refuses a sheet the agent could write, lines with a file, and a missing sheet", () => {
    write("output/sato.csv", sheet(1));
    const item = newCase();
    const towa = { supplier: "Towa Shoji", file: "quotes/towa.csv" };
    const refused: unknown[][] = [
      [{ supplier: "Sato Kogyo", file: "output/sato.csv" }, towa],
      [{ supplier: "Sato Kogyo", file: "quotes/../output/sato.csv" }, towa],
      [{ ...quotes[0], file: "quotes/sato.csv" }, towa],
      [{ supplier: "Sato Kogyo", file: "quotes/none.csv" }, towa],
      [{ supplier: "Sato Kogyo", file: 7 }, towa],
    ];
    for (const q of refused) {
      expect(() =>
        recordWorkItemProcurement(project, item.id, { request, quotes: q }, agent, undefined),
      ).toThrow(expect.objectContaining({ code: "invalid_comparison" }));
    }
    expect(readWorkItem(project.id, item.id)?.procurement).toBeUndefined();
  });
});

describe("selectWorkItemSupplier", () => {
  it("refuses agents, even privileged ones", () => {
    const item = withQuotes();
    expect(() =>
      selectWorkItemSupplier(project, item.id, { supplier: "Sato Kogyo" }, agent, item.revision),
    ).toThrow(/only a person/);
  });

  it("records the calling person, never a selector from the input", () => {
    const item = withQuotes();
    const input = { supplier: "Sato Kogyo", selectedBy: "device:someone-else" };
    const next = selectWorkItemSupplier(project, item.id, input, person, item.revision);
    expect(next.supplierSelection).toMatchObject({
      supplier: "Sato Kogyo",
      selectedBy: person.id,
      deviatesFromLowest: false,
      reason: null,
      lowest: ["Sato Kogyo"],
      revision: item.revision,
    });
    expect(next.history.at(-1)).toMatchObject({ action: "supplier.select", by: person.id });
  });

  it("needs a written reason to choose other than the lowest", () => {
    const item = withQuotes();
    expect(() =>
      selectWorkItemSupplier(project, item.id, { supplier: "Towa Shoji" }, person, item.revision),
    ).toThrow(/reason/);
    const next = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Towa Shoji", reason: "Sato cannot deliver before month end" },
      person,
      item.revision,
    );
    expect(next.supplierSelection).toMatchObject({
      supplier: "Towa Shoji",
      deviatesFromLowest: true,
    });
  });

  it("refuses without a revision, on a stale revision, and without recorded quotes", () => {
    const item = withQuotes();
    expect(() =>
      selectWorkItemSupplier(project, item.id, { supplier: "Sato Kogyo" }, person, undefined),
    ).toThrow(/revision/);
    expect(() =>
      selectWorkItemSupplier(
        project,
        item.id,
        { supplier: "Sato Kogyo" },
        person,
        item.revision - 1,
      ),
    ).toThrow();
    const bare = newCase();
    expect(() =>
      selectWorkItemSupplier(project, bare.id, { supplier: "Sato Kogyo" }, person, bare.revision),
    ).toThrow(/no recorded quotes/);
  });

  it("refuses while a blocking fraud flag is uncleared", () => {
    const item = withQuotes();
    const flagged = mutateWorkItem(project.id, item.id, item.revision, (cur) => {
      cur.flags = ["suspected_fraud"];
      return cur;
    });
    expect(() =>
      selectWorkItemSupplier(
        project,
        item.id,
        { supplier: "Sato Kogyo" },
        person,
        flagged.revision,
      ),
    ).toThrow(/suspected_fraud/);
  });
});

describe("purchaseOrderSelectionFor", () => {
  it("refuses without a selection, then returns the person's choice", () => {
    const item = withQuotes();
    expect(() => purchaseOrderSelectionFor(item)).toThrow(/a person must choose first/);
    const chosen = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Sato Kogyo" },
      person,
      item.revision,
    );
    expect(purchaseOrderSelectionFor(chosen).selection).toEqual({
      supplier: "Sato Kogyo",
      selectedBy: person.id,
    });
  });

  it("refuses after the quotes change, until a person chooses again", () => {
    const item = withQuotes();
    const chosen = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Sato Kogyo" },
      person,
      item.revision,
    );
    const requoted = recordWorkItemProcurement(
      project,
      item.id,
      { request, quotes: [quote("Sato Kogyo", { "BRG-6204": 900, "BLT-M8": 10 }), quotes[1]] },
      agent,
      chosen.revision,
    );
    expect(requoted.history.at(-1)?.detail).toMatchObject({ selectionStale: true });
    expect(requoted.supplierSelection?.supplier).toBe("Sato Kogyo");
    expect(() => purchaseOrderSelectionFor(requoted)).toThrow(/quotes changed/);
    const again = selectWorkItemSupplier(
      project,
      item.id,
      { supplier: "Sato Kogyo" },
      person,
      requoted.revision,
    );
    expect(purchaseOrderSelectionFor(again).selection.supplier).toBe("Sato Kogyo");
  });
});
