import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { loadRoutines } from "../autopilot/routines.js";
import { calculateQuote } from "../quotes/calculate.js";
import { decodeCsv, priceRequest, readPriceList } from "../quotes/price-list.js";
import { evaluatePolicy } from "../workitems/checks.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { buildRoute } from "../workitems/routes.js";
import { seedStarterFiles, seedStarterPack } from "./pack.js";
import { createProject } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-quote-pack-"));
const homeBefore = process.env.KOLO_HOME;
const stateBefore = process.env.KOLO_STATE_DIR;
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
afterAll(async () => {
  await flushAudit();
  if (homeBefore === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = homeBefore;
  }
  if (stateBefore === undefined) {
    delete process.env.KOLO_STATE_DIR;
  } else {
    process.env.KOLO_STATE_DIR = stateBefore;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const template = loadTemplates(resolveTemplatesDir({})).find(
  (t) => t.id === "business-sales-quotation",
)!;
const folder = path.join(root, "project");
fs.mkdirSync(folder);
const project = createProject(
  { name: "Sales quotations example", folder },
  { createdBy: "device:sales01", template },
);
const packDir = path.join(resolveTemplatesDir({}), "packs", "business-sales-quotation");

describe("Sales quotation starter pack", () => {
  it("loads the template with a read-only quotes folder and the office plugin", () => {
    expect(template).toBeDefined();
    expect(template.rules.readOnly).toEqual(["quotes"]);
    expect(template.plugins).toEqual(["office"]);
  });

  it("seeds a sample price list the quotation engine can read", () => {
    seedStarterPack(project.id, packDir);
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toHaveLength(3);
    const list = readPriceList(
      decodeCsv(fs.readFileSync(path.join(folder, "quotes/price-list.csv"))),
    );
    expect(list.problems).toEqual([]);
    expect(list.items.length).toBeGreaterThanOrEqual(5);
    expect(list.items.every((i) => i.name.includes("サンプル"))).toBe(true);
    const { priced, unpriced } = priceRequest(
      [
        { code: "A-100", description: "部品A", quantity: 10 },
        { code: "F-001", description: "弁当", quantity: 5 },
        { code: "X-1", description: "特注", quantity: 1 },
      ],
      list,
    );
    expect(unpriced).toHaveLength(1);
    const q = calculateQuote(priced);
    expect(q.buckets.map((b) => [b.rate, b.tax])).toEqual([
      [10, 1200],
      [8, 432],
    ]);
    const company = JSON.parse(fs.readFileSync(path.join(folder, "quotes/company.json"), "utf8"));
    expect(company.taxRounding).toBe("floor");
  });

  it("has a quote queue, a person-approved route and no-commitment wording rules", () => {
    const policy = loadWorkQueuePolicy(project);
    expect(policy.error).toBeNull();
    expect(policy.separationOfDuties).toBe(true);
    expect(policy.queues.map((q) => [q.id, q.types])).toEqual([["sales-quotes", ["quote"]]]);
    const item = {
      queue: "sales-quotes",
      type: "quote" as const,
      source: { fields: {}, documents: [] },
    };
    const route = buildRoute(policy, { ...item, requiredApprovals: 1 });
    expect(route.stages.map((s) => s.id)).toEqual(["sales-lead"]);
    const now = new Date("2035-01-01T00:00:00Z");
    const noDoc = evaluatePolicy(
      policy,
      item,
      { text: "御見積書を添付いたします。", version: 1 },
      now,
    );
    expect(noDoc.checks.find((c) => c.policyId === "quote.document")?.result).toBe("fail");
    const promised = evaluatePolicy(policy, item, { text: "受注確定しました。", version: 1 }, now);
    expect(promised.checks.find((c) => c.policyId === "quote.no-commitments")?.result).toBe("fail");
  });

  it("blocks approval while items are unpriced; the total routes a second approver", () => {
    const policy = loadWorkQueuePolicy(project);
    const now = new Date("2035-01-01T00:00:00Z");
    const fields = (f: Record<string, unknown>) => ({
      queue: "sales-quotes",
      type: "quote" as const,
      source: { fields: f, documents: ["output/quotes/見積書_Q-1.docx"] },
    });
    const check = (f: Record<string, unknown>, id: string) =>
      evaluatePolicy(policy, fields(f), null, now).checks.find((c) => c.policyId === id);
    expect(
      check({ quoteNumber: "Q-1", quoteUnpriced: 0, quoteTotal: 1000 }, "quote.complete")?.result,
    ).toBe("pass");
    const open = check(
      { quoteNumber: "Q-1", quoteUnpriced: 2, quoteTotal: 1000 },
      "quote.complete",
    );
    expect(open?.result).toBe("fail");
    expect(open?.blocking).toBe(true);
    const zero = check(
      { quoteNumber: "Q-1", quoteUnpriced: 0, quoteZeroRate: 1 },
      "quote.taxclass",
    );
    expect(zero).toMatchObject({ result: "fail", blocking: true, overrideOutcome: "provisional" });
    // A list past the company's limit needs a person: a final (not provisional) override.
    expect(
      check({ quoteNumber: "Q-1", quotePriceListOverdueDays: 0 }, "quote.price-list-current")
        ?.result,
    ).toBe("pass");
    const overdue = check(
      { quoteNumber: "Q-1", quotePriceListOverdueDays: 1 },
      "quote.price-list-current",
    );
    expect(overdue).toMatchObject({ result: "fail", blocking: true });
    expect(overdue?.overrideOutcome).toBeUndefined();
    // A quotation made before the field existed is not failed for lacking it.
    expect(check({ quoteNumber: "Q-1" }, "quote.price-list-current")?.result).toBe("pass");
    // A quote item made by hand, without a Kurahi quotation, fails the generated check.
    expect(check({}, "quote.generated")?.result).toBe("fail");
    const big = evaluatePolicy(
      policy,
      fields({ quoteNumber: "Q-1", quoteUnpriced: 0, quoteTotal: 1_200_000 }),
      null,
      now,
    );
    expect(big.requiredApprovals).toBe(2);
  });

  it("loads an opt-in L1 routine that prepares, never sends", () => {
    const routines = loadRoutines(project);
    expect(routines.error).toBeNull();
    expect(routines.routines).toHaveLength(1);
    const r = routines.routines[0];
    expect(r).toMatchObject({
      id: "sales-quote-intake",
      enabled: false,
      level: "L1",
      queue: "sales-quotes",
      actions: ["workitem.intake", "mail.draft", "quote.prepare", "mail.attach"],
    });
    expect(r.actions).not.toContain("mail.send");
  });
});
