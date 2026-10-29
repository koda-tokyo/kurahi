import { describe, expect, it } from "vitest";
import { compareSupplierQuotes } from "./compare.js";
import { readXlsxRows } from "./price-list-xlsx.js";
import { decodeCsv, FORMULA_WITHOUT_VALUE, parseCsv } from "./price-list.js";
import { readSupplierQuoteRows, SupplierQuoteFileError } from "./supplier-quote-file.js";
import { testWorkbook } from "./test-helpers.js";

const csv = (text: string) => parseCsv(decodeCsv(Buffer.from(text)));

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof SupplierQuoteFileError) {
      return e.problems;
    }
    throw e;
  }
  throw new Error("expected SupplierQuoteFileError");
}

describe("readSupplierQuoteRows", () => {
  it("reads Japanese headers, yen formatting and a default tax rate", () => {
    const lines = readSupplierQuoteRows(
      csv(
        '品番,品名,数量,見積単価（税抜）,税率\nA-1,部品A,10,"¥1,200",10%\nB-2,,2.5,980円,\n,,,,\n',
      ),
    );
    expect(lines).toEqual([
      { code: "A-1", description: "部品A", quantity: "10", unitPrice: "1200", taxRate: 10 },
      { code: "B-2", description: "B-2", quantity: "2.5", unitPrice: "980", taxRate: 10 },
    ]);
  });

  it("refuses the whole quote and lists every row problem", () => {
    const found = problems(() =>
      readSupplierQuoteRows([
        ["code", "qty", "price", "tax"],
        ["A-1", "1", "100", "10"],
        ["A-1", "1", "90", "10"],
        ["B-2", "1", "#N/A", "10"],
        ["C-3", "1", FORMULA_WITHOUT_VALUE, "10"],
        ["D-4", "1", "10.001", "10"],
        ["E-5", "1", "10", "5"],
        ["", "1", "10", "10"],
      ]),
    );
    expect(found).toEqual([
      "row 3: item code A-1 appears more than once",
      "row 4 (B-2): a cell shows the error #N/A",
      "row 5 (C-3): a formula has no saved value; open and save the sheet in Excel",
      "row 6 (D-4): unit price has more than 2 decimal places",
      "row 7 (E-5): tax rate must be 10, 8 or 0",
      "row 8: the item code is required",
    ]);
  });

  it("refuses a currency-marked quantity and a malformed thousands separator (peer review of 8b6f3b3266)", async () => {
    const found = problems(() =>
      readSupplierQuoteRows(
        csv(
          '品番,数量,単価\nA,¥10,100\nB,10円,100\nC,"1,2",100\nD,10,"1,2"\nE,"1,000",100\nF,１０,"1,200.5"\n',
        ),
      ),
    );
    expect(found).toEqual([
      "row 2 (A): quantity must be a non-negative decimal number",
      "row 3 (B): quantity must be a non-negative decimal number",
      "row 4 (C): quantity must be a non-negative decimal number",
      "row 5 (D): unit price must be a non-negative decimal number",
    ]);
    expect(
      readSupplierQuoteRows(csv('品番,数量,単価\nE,"1,000",100\nF,１０,"1,200.5"\n')).map((l) => [
        l.quantity,
        l.unitPrice,
      ]),
    ).toEqual([
      ["1000", "100"],
      ["10", "1200.5"],
    ]);

    const c = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
    const sheet = readXlsxRows(
      await testWorkbook([
        {
          name: "御見積",
          xml:
            `<row r="1">${c("A1", "品番")}${c("B1", "数量")}${c("C1", "単価")}</row>` +
            `<row r="2">${c("A2", "A")}${c("B2", "￥10")}${c("C2", "100")}</row>`,
        },
      ]),
    );
    expect(problems(() => readSupplierQuoteRows(sheet.rows, sheet.rowNumbers))).toEqual([
      "row 2 (A): quantity must be a non-negative decimal number",
    ]);
  });

  it("needs code, quantity and unit price columns", () => {
    expect(
      problems(() =>
        readSupplierQuoteRows([
          ["品番", "単価"],
          ["A", "1"],
        ]),
      ),
    ).toEqual(["the sheet needs columns for quantity (e.g. 品番, 数量, 単価)"]);
    expect(problems(() => readSupplierQuoteRows([["品番", "数量", "単価"]]))).toEqual([
      "the sheet has no quoted lines",
    ]);
  });

  it("refuses an oversized name rather than cutting it", () => {
    expect(
      problems(() =>
        readSupplierQuoteRows([
          ["code", "name", "qty", "price"],
          ["A", "x".repeat(201), "1", "1"],
        ]),
      ),
    ).toEqual(["row 2 (A): the item name is longer than 200"]);
  });

  it("feeds an .xlsx supplier quote into the comparison with spreadsheet row numbers", async () => {
    const c = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
    const n = (ref: string, v: string) => `<c r="${ref}"><v>${v}</v></c>`;
    const sheet = readXlsxRows(
      await testWorkbook([
        {
          name: "御見積",
          xml:
            `<row r="3">${c("A3", "品番")}${c("B3", "数量")}${c("C3", "単価")}</row>` +
            `<row r="4">${c("A4", "A-1")}${n("B4", "10")}${n("C4", "1200")}</row>` +
            `<row r="5">${c("A5", "B-2")}${n("B5", "2")}${n("C5", "1499.9999999999998")}</row>`,
        },
      ]),
    );
    expect(problems(() => readSupplierQuoteRows(sheet.rows, sheet.rowNumbers))).toEqual([
      "row 5 (B-2): unit price has more than 2 decimal places",
    ]);

    const request = [
      { code: "A-1", quantity: 10 },
      { code: "B-2", quantity: 2 },
    ];
    const fixed = readSupplierQuoteRows([
      ["品番", "数量", "単価"],
      ["A-1", "10", "1200"],
      ["B-2", "2", "1500"],
    ]);
    const other = readSupplierQuoteRows([
      ["品番", "数量", "単価"],
      ["A-1", "10", "1300"],
    ]);
    const result = compareSupplierQuotes(request, [
      { supplier: "Sheet Co", lines: fixed },
      { supplier: "Partial Co", lines: other },
    ]);
    expect(result.lowest).toEqual(["Sheet Co"]);
    expect(result.lowestNet).toBe(15_000);
    expect(result.suppliers[1].missing).toEqual(["B-2"]);
  });
});
