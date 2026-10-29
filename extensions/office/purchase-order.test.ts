import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KoLoPluginAuditInput } from "../../src/plugins/types.js";
import { extractText } from "../../src/projects/documents.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import { createOfficeTools, OFFICE_TOOL_NAMES } from "./index.js";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-po-test-")));
const home = path.join(tmpRoot, "state");
fs.mkdirSync(home, { recursive: true });
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const NOW = new Date("2026-10-26T06:00:00Z");
type Out = { content: Array<{ text: string }>; details?: Record<string, unknown> };

let seq = 0;
function setup(mode: "act" | "read" = "act") {
  const folder = path.join(tmpRoot, `project-${++seq}`);
  fs.mkdirSync(path.join(folder, "output"), { recursive: true });
  const project = createProject(
    {
      name: `Orders ${seq}`,
      folder,
      rules: {
        readOnly: [],
        writable: ["output"],
        artifactApprovalRequired: false,
        instructions: [],
      },
      mode,
    },
    { createdBy: "owner", home },
  );
  const audits: KoLoPluginAuditInput[] = [];
  const t = createOfficeTools({
    agentId: "main",
    sessionKey: projectSessionKey("main", project.id, "c1"),
    audit: (a) => audits.push(a),
    home,
    now: () => NOW,
  }).find((x) => x.name === "office_po_create") as unknown as {
    execute: (id: string, p: Record<string, unknown>) => Promise<Out>;
  };
  return { folder, audits, order: (o: unknown) => t.execute("call-1", { order: o }) };
}

const line = (code: string, quantity: number, unit_price: number) => ({
  code,
  quantity,
  unit_price,
  tax_rate: 10,
});
const COMPARISON = {
  items: [
    { code: "A-100", quantity: 10 },
    { code: "S-900", quantity: 2 },
  ],
  quotes: [
    { supplier: "東和工業", lines: [line("A-100", 10, 1200), line("S-900", 2, 8000)] },
    { supplier: "北辰商事", lines: [line("A-100", 10, 1150), line("S-900", 2, 8200)] },
    { supplier: "安価部品", lines: [line("A-100", 10, 900)] },
  ],
};

describe("office_po_create", () => {
  it("is registered under its declared name", () => {
    expect(OFFICE_TOOL_NAMES).toContain("office_po_create");
  });

  it("writes Word and Excel for the lowest complete quote with figures it computed", async () => {
    const { folder, order, audits } = setup();
    const out = await order({ comparison: COMPARISON, supplier: "北辰商事", selected_by: "佐藤" });
    expect(out.details?.error).toBeUndefined();
    expect(out.details).toMatchObject({
      path: "output/purchase-orders/発注書_PO-20261026.docx",
      workbook: "output/purchase-orders/発注書_PO-20261026.xlsx",
      supplier: "北辰商事",
      net: 27_900,
      tax: 2_790,
      total: 30_690,
      deviatesFromLowest: false,
    });
    const text = await extractText(
      "docx",
      fs.readFileSync(path.join(folder, String(out.details?.path))),
    );
    expect(text).toContain("北辰商事 御中");
    expect(text).toContain("佐藤");
    expect(text).toContain("¥30,690");
    expect(audits.at(-1)).toMatchObject({ action: "office.po.create", outcome: "ok" });
    // The audit never carries names or amounts.
    expect(JSON.stringify(audits)).not.toContain("北辰商事");
  });

  it("refuses a supplier other than the lowest without a reason, and prints the reason given", async () => {
    const { folder, order } = setup();
    const refused = await order({
      comparison: COMPARISON,
      supplier: "東和工業",
      selected_by: "佐藤",
    });
    expect(refused.details?.error).toBe("bad_request");
    expect(refused.content[0]?.text).toContain("give the reason");
    expect(fs.existsSync(path.join(folder, "output", "purchase-orders"))).toBe(false);

    const out = await order({
      comparison: COMPARISON,
      supplier: "東和工業",
      selected_by: "佐藤",
      reason: "納期が1週間早い",
    });
    expect(out.details).toMatchObject({ deviatesFromLowest: true, lowest: ["北辰商事"] });
    const text = await extractText(
      "docx",
      fs.readFileSync(path.join(folder, String(out.details?.path))),
    );
    expect(text).toContain("納期が1週間早い");
  });

  it("refuses an incomplete quote even when it is cheapest", async () => {
    const { order } = setup();
    const out = await order({
      comparison: COMPARISON,
      supplier: "安価部品",
      selected_by: "佐藤",
      reason: "安い",
    });
    expect(out.details?.error).toBe("bad_request");
    expect(out.content[0]?.text).toContain("incomplete");
  });

  it("needs the person who chose and a Project in Act mode", async () => {
    const missing = await setup().order({ comparison: COMPARISON, supplier: "北辰商事" });
    expect(missing.details?.error).toBe("bad_request");
    const readOnly = await setup("read").order({
      comparison: COMPARISON,
      supplier: "北辰商事",
      selected_by: "佐藤",
    });
    expect(readOnly.details?.error).toBeDefined();
    expect(readOnly.details?.error).not.toBe("internal");
  });
});
