import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KoLoPluginAuditInput } from "../../src/plugins/types.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import { testWorkbook } from "../../src/quotes/test-helpers.js";
import { createOfficeTools, OFFICE_TOOL_NAMES } from "./index.js";

type Out = { content: Array<{ text: string }>; details?: Record<string, unknown> };

function tool() {
  const audits: KoLoPluginAuditInput[] = [];
  const t = createOfficeTools({ agentId: "main", audit: (a) => audits.push(a) }).find(
    (x) => x.name === "office_quote_compare",
  ) as unknown as { execute: (id: string, p: Record<string, unknown>) => Promise<Out> };
  return { audits, compare: (c: unknown) => t.execute("call-1", { comparison: c }) };
}

const ITEMS = [
  { code: "A-100", quantity: 10 },
  { code: "S-900", quantity: 2 },
];
const line = (code: string, quantity: number, unit_price: number) => ({
  code,
  quantity,
  unit_price,
  tax_rate: 10,
});

describe("office_quote_compare", () => {
  it("is registered under its declared name", () => {
    expect(OFFICE_TOOL_NAMES).toContain("office_quote_compare");
  });

  it("names the lowest complete quote; a cheaper quote missing an item is not lowest", async () => {
    const { compare, audits } = tool();
    const out = await compare({
      items: ITEMS,
      quotes: [
        { supplier: "東和工業", lines: [line("A-100", 10, 1200), line("S-900", 2, 8000)] },
        { supplier: "北辰商事", lines: [line("A-100", 10, 1150), line("S-900", 2, 8200)] },
        { supplier: "安価部品", lines: [line("A-100", 10, 900)] },
      ],
    });
    expect(out.details?.lowest).toEqual(["北辰商事"]);
    expect(out.details?.lowestNet).toBe(27_900);
    const cheap = (out.details!.suppliers as Array<Record<string, unknown>>)[2];
    expect(cheap).toMatchObject({ complete: false, missing: ["S-900"], net: 9000 });
    expect(out.content[0].text).toContain("安価部品");
    expect(out.content[0].text).toContain("not an award");
    expect(audits).toEqual([
      expect.objectContaining({
        action: "office.quote.compare",
        outcome: "ok",
        detail: { items: 2, suppliers: 3, lowest: 1, files: 0 },
      }),
    ]);
  });

  it("says no quote can be named lowest when none is complete", async () => {
    const { compare } = tool();
    const out = await compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", lines: [line("A-100", 10, 1000)] },
        { supplier: "B社", lines: [line("A-100", 5, 1000), line("S-900", 2, 8000)] },
      ],
    });
    expect(out.details?.lowest).toEqual([]);
    expect(out.details?.lowestNet).toBeNull();
    expect(out.content[0].text).toContain("none can be named lowest");
  });

  it("refuses a single quote, a bad tax rate and an unrequested line", async () => {
    const { compare, audits } = tool();
    const one = await compare({
      items: ITEMS,
      quotes: [{ supplier: "A社", lines: [line("A-100", 10, 1)] }],
    });
    expect(one.details?.error).toBe("bad_request");
    const rate = await compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", lines: [{ ...line("A-100", 10, 1), tax_rate: 5 }] },
        { supplier: "B社", lines: [line("A-100", 10, 1)] },
      ],
    });
    expect(rate.content[0].text).toMatch(/tax_rate must be one of 10, 8, 0/);
    // Each of these coerces to 0 with Number(), which would silently price the line tax-free.
    for (const taxRate of [null, "", " ", false, [], "0x0"]) {
      const coerced = await compare({
        items: ITEMS,
        quotes: [
          { supplier: "A社", lines: [{ ...line("A-100", 10, 1), tax_rate: taxRate }] },
          { supplier: "B社", lines: [line("A-100", 10, 1)] },
        ],
      });
      expect(coerced.content[0].text).toMatch(/tax_rate must be one of 10, 8, 0/);
    }
    const extra = await compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", lines: [line("A-100", 10, 1), line("Z-999", 1, 1)] },
        { supplier: "B社", lines: [line("A-100", 10, 1)] },
      ],
    });
    expect(extra.content[0].text).toContain("A社: line 2 is not a requested item");
    expect(audits.every((a) => a.outcome === "failed")).toBe(true);
    // A digit string is still a rate the model may send.
    const quoted = await compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", lines: [{ ...line("A-100", 10, 1), tax_rate: "8" }] },
        { supplier: "B社", lines: [line("A-100", 10, 1)] },
      ],
    });
    expect(quoted.details?.error).toBeUndefined();
  });
});

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-compare-test-")));
const home = path.join(tmpRoot, "state");
fs.mkdirSync(home, { recursive: true });
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function projectTools(mode: "act" | "plan" | "read" = "act") {
  const folder = path.join(tmpRoot, `project-${++seq}`);
  for (const sub of ["output", "quotes"]) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true });
  }
  const project = createProject(
    {
      name: `Compare ${seq}`,
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
  const tools = createOfficeTools({
    agentId: "main",
    sessionKey: projectSessionKey("main", project.id, "c1"),
    home,
    now: () => new Date("2026-10-27T00:00:00Z"),
  });
  const run = (name: string) =>
    tools.find((x) => x.name === name) as unknown as {
      execute: (id: string, p: Record<string, unknown>) => Promise<Out>;
    };
  return {
    folder,
    write: (rel: string, body: string | Buffer) => fs.writeFileSync(path.join(folder, rel), body),
    compare: (c: unknown) => run("office_quote_compare").execute("call-1", { comparison: c }),
    order: (o: unknown) => run("office_po_create").execute("call-1", { order: o }),
  };
}

const TOWA_CSV = [
  "品番,品名,数量,単価,税率",
  "A-100,部品A,10,1200,10%",
  "S-900,設置,2,8000,10",
].join("\r\n");

describe("office_quote_compare with supplier quote files", () => {
  it("reads CSV and .xlsx supplier sheets under quotes/ and reports their sha256", async () => {
    const env = projectTools();
    env.write("quotes/towa.csv", TOWA_CSV);
    const t = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
    env.write(
      "quotes/hokushin.xlsx",
      await testWorkbook([
        {
          name: "御見積",
          xml:
            `<row r="1">${t("A1", "品番")}${t("B1", "数量")}${t("C1", "見積単価")}</row>` +
            `<row r="2">${t("A2", "A-100")}<c r="B2"><v>10</v></c><c r="C2"><v>1150</v></c></row>` +
            `<row r="3">${t("A3", "S-900")}<c r="B3"><v>2</v></c><c r="C3"><v>8200</v></c></row>`,
        },
      ]),
    );
    const out = await env.compare({
      items: ITEMS,
      quotes: [
        { supplier: "東和工業", file: "quotes/towa.csv" },
        { supplier: "北辰商事", file: "quotes/hokushin.xlsx" },
        { supplier: "手入力", lines: [line("A-100", 10, 1300), line("S-900", 2, 8000)] },
      ],
    });
    expect(out.details?.error).toBeUndefined();
    expect(out.details?.lowest).toEqual(["北辰商事"]);
    expect(out.details?.lowestNet).toBe(27_900);
    const files = out.details?.files as Array<Record<string, string>>;
    expect(files.map((f) => [f.supplier, f.file])).toEqual([
      ["東和工業", "quotes/towa.csv"],
      ["北辰商事", "quotes/hokushin.xlsx"],
    ]);
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it("refuses a sheet the agent could have written, outside quotes/, or linked out of it", async () => {
    const env = projectTools();
    env.write("output/cheap.csv", TOWA_CSV);
    fs.symlinkSync(
      path.join(env.folder, "output", "cheap.csv"),
      path.join(env.folder, "quotes", "link.csv"),
    );
    fs.linkSync(
      path.join(env.folder, "output", "cheap.csv"),
      path.join(env.folder, "quotes", "hard.csv"),
    );
    for (const [file, why] of [
      ["output/cheap.csv", /must be a \.csv or \.xlsx file under quotes\//],
      ["quotes/../output/cheap.csv", /under quotes\//],
      ["quotes/link.csv", /link\.csv: must be a \.csv or \.xlsx file under quotes\//],
      ["quotes/hard.csv", /hard\.csv: must be a plain file with no other links/],
      ["quotes/missing.csv", /supplier quote quotes\/missing\.csv/],
    ] as const) {
      const out = await env.compare({
        items: ITEMS,
        quotes: [
          { supplier: "A社", file },
          { supplier: "B社", lines: [line("A-100", 10, 1)] },
        ],
      });
      expect(out.details?.error, file).toBe("bad_request");
      expect(out.content[0].text, file).toMatch(why);
    }
  });

  it("refuses a whole sheet with every problem listed, and lines given with a file", async () => {
    const env = projectTools();
    env.write(
      "quotes/bad.csv",
      ["品番,数量,単価", "A-100,10,#N/A", "A-100,1,5", ",2,3"].join("\n"),
    );
    env.write("quotes/towa.csv", TOWA_CSV);
    const bad = await env.compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", file: "quotes/bad.csv" },
        { supplier: "B社", file: "quotes/towa.csv" },
      ],
    });
    expect(bad.content[0].text).toMatch(/row 2 \(A-100\): a cell shows the error #N\/A/);
    expect(bad.content[0].text).toMatch(/row 4: the item code is required/);
    const both = await env.compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", file: "quotes/towa.csv", lines: [line("A-100", 10, 1)] },
        { supplier: "B社", file: "quotes/towa.csv" },
      ],
    });
    expect(both.content[0].text).toContain("quotes[0]: give lines or file, not both");
  });

  it("needs a Project chat to read a file; transcribed lines still compare without one", async () => {
    const { compare } = tool();
    const out = await compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", file: "quotes/towa.csv" },
        { supplier: "B社", lines: [line("A-100", 10, 1)] },
      ],
    });
    expect(out.content[0].text).toMatch(/Project chat/);
    // Read mode: reading a sheet needs 計画 Plan or 実行 Act, like the other office tools.
    const env = projectTools("read");
    env.write("quotes/towa.csv", TOWA_CSV);
    const read = await env.compare({
      items: ITEMS,
      quotes: [
        { supplier: "A社", file: "quotes/towa.csv" },
        { supplier: "B社", lines: [line("A-100", 10, 1)] },
      ],
    });
    expect(read.content[0].text).toMatch(/参照 Read/);
  });

  it("drafts a purchase order from file quotes and carries the sheets' sha256", async () => {
    const env = projectTools();
    env.write("quotes/towa.csv", TOWA_CSV);
    env.write("quotes/b.csv", ["品番,数量,単価", "A-100,10,1300", "S-900,2,8100"].join("\n"));
    const out = await env.order({
      comparison: {
        items: ITEMS,
        quotes: [
          { supplier: "東和工業", file: "quotes/towa.csv" },
          { supplier: "B社", file: "quotes/b.csv" },
        ],
      },
      supplier: "東和工業",
      selected_by: "購買 山田",
    });
    expect(out.details?.error).toBeUndefined();
    expect(out.details).toMatchObject({
      supplier: "東和工業",
      net: 28_000,
      deviatesFromLowest: false,
    });
    expect(out.details?.quoteFiles).toHaveLength(2);
  });
});
