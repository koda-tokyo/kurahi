import { describe, expect, it } from "vitest";
import { calculateQuote } from "./calculate.js";
import { decodeCsv, parseCsv, parseTaxRate, priceRequest, readPriceList } from "./price-list.js";

const JA_LIST = [
  "品番,品名,単位,単価,税率,原価",
  "A-100,部品A,個,1200,10%,800",
  'B-200,"ボルト, M8",本,12.5,10,7',
  'F-001,弁当,個,"¥1,080",8%,',
  "S-900,設置作業,時間,8000,,",
].join("\r\n");

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, CRLF and blank lines", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n\r\n1,2,3\n')).toEqual([
      ["a", "b,c", 'd "e"'],
      ["1", "2", "3"],
    ]);
    expect(() => parseCsv('a,"b')).toThrow("unterminated");
  });
});

describe("decodeCsv", () => {
  it("strips a UTF-8 BOM and falls back to Shift_JIS", () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("品番,品名")]);
    expect(decodeCsv(utf8)).toBe("品番,品名");
    // "品名" in Shift_JIS: 0x95 0x69 0x96 0xbc
    expect(decodeCsv(new Uint8Array([0x95, 0x69, 0x96, 0xbc]))).toBe("品名");
  });
});

describe("readPriceList", () => {
  it("reads Japanese headers, yen formatting and default tax", () => {
    const list = readPriceList(JA_LIST);
    expect(list.problems).toEqual([]);
    expect(list.items).toHaveLength(4);
    expect(list.byCode.get("A-100")).toEqual({
      code: "A-100",
      name: "部品A",
      unit: "個",
      unitPrice: "1200",
      taxRate: 10,
      cost: "800",
    });
    expect(list.byCode.get("B-200")?.name).toBe("ボルト, M8");
    expect(list.byCode.get("F-001")).toMatchObject({ unitPrice: "1080", taxRate: 8 });
    expect(list.byCode.get("S-900")?.taxRate).toBe(10);
  });

  it("reads English headers", () => {
    const list = readPriceList("Item code,Name,Unit price,Tax rate\nX1,Widget,100,8");
    expect(list.byCode.get("X1")).toMatchObject({ name: "Widget", unitPrice: "100", taxRate: 8 });
  });

  it("reports bad rows and keeps the good ones", () => {
    const list = readPriceList(
      [
        "品番,品名,単価,税率",
        "A,a,abc,10",
        "B,b,100,5",
        ",c,100,10",
        "D,d,1.234,10",
        "E,e,100,10",
        "E,e2,200,10",
        "G,g,300,10",
      ].join("\n"),
    );
    expect(list.items.map((i) => i.code)).toEqual(["G"]);
    expect(list.problems).toHaveLength(5);
    expect(list.problems.join("\n")).toMatch(/row 2 \(A\): unit price/);
    expect(list.problems.join("\n")).toMatch(/row 3 \(B\): tax rate/);
    expect(list.problems.join("\n")).toMatch(/row 7: item code E appears more than once/);
  });

  it("never prices a duplicated code from either row (peer review of 0c6053ed75)", () => {
    const list = readPriceList("code,name,price\nX,Widget,100\nX,Widget large,900\nY,Other,5");
    expect(list.byCode.has("X")).toBe(false);
    expect(list.byName.has("widget")).toBe(false);
    expect(list.items.map((i) => i.code)).toEqual(["Y"]);
    const r = priceRequest(
      [
        { code: "X", description: "Widget", quantity: 1 },
        { description: "Widget", quantity: 1 },
      ],
      list,
    );
    expect(r.priced).toEqual([]);
    expect(r.unpriced).toHaveLength(2);
  });

  it("treats a code as duplicated even when one of its rows is invalid, in either order", () => {
    for (const csv of [
      "code,name,price\nA,First,bad\nA,Second,200",
      "code,name,price\nA,Second,200\nA,First,bad",
      // A row without a name, or with an oversized cell, still names its code (peer review of 7464bf20b5).
      "code,name,price\nA,,100\nA,Valid,200",
      "code,name,price\nA,Valid,200\nA,,100",
      `code,name,price\nA,${"x".repeat(501)},100\nA,Valid,200`,
      `code,name,price\nA,Valid,200\nA,${"x".repeat(501)},100`,
    ]) {
      const list = readPriceList(csv);
      expect(list.byCode.has("A")).toBe(false);
      expect(priceRequest([{ code: "A", description: "A", quantity: 1 }], list).priced).toEqual([]);
    }
  });

  it("refuses an oversized cell instead of cutting it (peer review of 0c6053ed75)", () => {
    const list = readPriceList(`code,name,price\nY,Widget,${"0".repeat(499)}19\nZ,Fine,19`);
    expect(list.byCode.has("Y")).toBe(false);
    expect(list.byCode.get("Z")?.unitPrice).toBe("19");
    expect(list.problems.join("\n")).toMatch(/row 2: a cell is longer than 500 characters/);
  });

  it("accepts a trailing 円", () => {
    expect(readPriceList('品番,品名,単価\nA,a,"1,200円"').byCode.get("A")?.unitPrice).toBe("1200");
  });

  it("refuses a comma that does not group thousands rather than reading 1,2 as 12", () => {
    const list = readPriceList('品番,品名,単価\nA,a,"1,2"\nB,b,"12,34,567"\nC,c,"1,234,567.5"');
    expect(list.byCode.has("A")).toBe(false);
    expect(list.byCode.has("B")).toBe(false);
    expect(list.byCode.get("C")?.unitPrice).toBe("1234567.5");
  });

  it("refuses a list without the required columns", () => {
    expect(() => readPriceList("品名,単価\na,1")).toThrow(/code/);
    expect(() => readPriceList("")).toThrow("empty");
  });

  it("drops ambiguous names so they never match", () => {
    const list = readPriceList("code,name,price\nA,Same,1\nB,Same,2");
    expect(list.byName.has("same")).toBe(false);
    expect(list.byCode.size).toBe(2);
  });
});

describe("priceRequest", () => {
  const list = readPriceList(JA_LIST);

  it("prices by code or exact name and leaves the rest for a person", () => {
    const r = priceRequest(
      [
        { code: "A-100", description: "parts", quantity: 10 },
        { description: " 設置作業 ", quantity: "1.5" },
        { code: "Z-999", description: "unknown", quantity: 1 },
        { description: "something similar to 部品A", quantity: 1 },
      ],
      list,
    );
    expect(r.priced.map((l) => [l.code, l.description, l.unitPrice])).toEqual([
      ["A-100", "部品A", "1200"],
      ["S-900", "設置作業", "8000"],
    ]);
    expect(r.unpriced.map((u) => u.reason)).toEqual([
      "item code Z-999 is not in the price list",
      "no item code and no exact name match",
    ]);
    const q = calculateQuote(r.priced);
    expect(q.subtotal).toBe(12000 + 12000);
  });

  it("matches full-width item codes", () => {
    const r = priceRequest([{ code: "Ａ-100", description: "x", quantity: 1 }], list);
    expect(r.priced[0]?.code).toBe("A-100");
  });
});

describe("parseTaxRate", () => {
  it("accepts the usual spellings", () => {
    expect(parseTaxRate("10%")).toBe(10);
    expect(parseTaxRate("８％")).toBe(8);
    expect(parseTaxRate("0.1")).toBe(10);
    expect(parseTaxRate("0")).toBe(0);
    expect(parseTaxRate("5")).toBeNull();
  });
});
