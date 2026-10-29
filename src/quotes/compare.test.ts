import { describe, expect, it } from "vitest";
import { QuoteError } from "./calculate.js";
import { compareSupplierQuotes, type SupplierQuoteInput } from "./compare.js";

const request = [
  { code: "BRG-6204", description: "ベアリング", quantity: 20 },
  { code: "BLT-M8", description: "ボルト M8", quantity: 500 },
];

function quote(
  supplier: string,
  prices: Record<string, number>,
  quantities: Record<string, number> = {},
): SupplierQuoteInput {
  return {
    supplier,
    lines: Object.entries(prices).map(([code, unitPrice]) => ({
      code,
      description: code,
      quantity: quantities[code] ?? (code === "BRG-6204" ? 20 : 500),
      unitPrice,
      taxRate: 10 as const,
    })),
  };
}

describe("compareSupplierQuotes", () => {
  it("names the complete quote with the lowest net and the lowest offer per item", () => {
    const c = compareSupplierQuotes(request, [
      quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }), // 9000 + 6000 = 15000
      quote("東和産業", { "BRG-6204": 400, "BLT-M8": 15 }), // 8000 + 7500 = 15500
    ]);
    expect(c.lowest).toEqual(["北辰商事"]);
    expect(c.lowestNet).toBe(15000);
    expect(c.items).toEqual([
      {
        code: "BRG-6204",
        offers: [
          { supplier: "北辰商事", amount: 9000 },
          { supplier: "東和産業", amount: 8000 },
        ],
        lowest: ["東和産業"],
      },
      {
        code: "BLT-M8",
        offers: [
          { supplier: "北辰商事", amount: 6000 },
          { supplier: "東和産業", amount: 7500 },
        ],
        lowest: ["北辰商事"],
      },
    ]);
    expect(c.suppliers.every((s) => s.complete)).toBe(true);
  });

  it("never names a quote that leaves an item out, however cheap", () => {
    const c = compareSupplierQuotes(request, [
      quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }),
      quote("安価工業", { "BRG-6204": 100 }), // 2000, but no bolts
    ]);
    expect(c.lowest).toEqual(["北辰商事"]);
    const cheap = c.suppliers.find((s) => s.supplier === "安価工業");
    expect(cheap).toMatchObject({ complete: false, missing: ["BLT-M8"] });
    expect(c.items[1].offers[1]).toEqual({ supplier: "安価工業", amount: null });
    // Per item it still shows where it was cheapest.
    expect(c.items[0].lowest).toEqual(["安価工業"]);
  });

  it("treats a different quantity as incomplete, not as a cheaper offer", () => {
    const c = compareSupplierQuotes(request, [
      quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }),
      quote("東和産業", { "BRG-6204": 400, "BLT-M8": 12 }, { "BLT-M8": 100 }),
    ]);
    const towa = c.suppliers[1];
    expect(towa).toMatchObject({ complete: false, missing: [], quantityMismatch: ["BLT-M8"] });
    expect(c.lowest).toEqual(["北辰商事"]);
    expect(c.items[1].lowest).toEqual(["北辰商事"]);
  });

  it("matches quantities exactly, whatever their spelling", () => {
    const c = compareSupplierQuotes(
      [{ code: "CUT-OIL", quantity: "2.5" }],
      [
        {
          supplier: "A",
          lines: [
            { code: "CUT-OIL", description: "x", quantity: "2.500", unitPrice: 1000, taxRate: 10 },
          ],
        },
        {
          supplier: "B",
          lines: [
            { code: "CUT-OIL", description: "x", quantity: 2.5, unitPrice: 1000, taxRate: 10 },
          ],
        },
      ],
    );
    expect(c.suppliers.map((s) => s.complete)).toEqual([true, true]);
    expect(c.lowest).toEqual(["A", "B"]);
  });

  it("lists every supplier on a tie and none when no quote is complete", () => {
    const tie = compareSupplierQuotes(request, [
      quote("A", { "BRG-6204": 450, "BLT-M8": 12 }),
      quote("B", { "BRG-6204": 450, "BLT-M8": 12 }),
    ]);
    expect(tie.lowest).toEqual(["A", "B"]);

    const none = compareSupplierQuotes(request, [
      quote("A", { "BRG-6204": 450 }),
      quote("B", { "BLT-M8": 12 }),
    ]);
    expect(none.lowest).toEqual([]);
    expect(none.lowestNet).toBeNull();
  });

  it("compares the net after a document discount", () => {
    const discounted = quote("東和産業", { "BRG-6204": 400, "BLT-M8": 15 }); // 15500
    discounted.options = { documentDiscount: 1000 }; // 14500
    const c = compareSupplierQuotes(request, [
      quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }),
      discounted,
    ]);
    expect(c.lowest).toEqual(["東和産業"]);
    expect(c.lowestNet).toBe(14500);
  });

  it("refuses fewer than two suppliers, duplicates and unrequested or repeated lines", () => {
    const ok = quote("A", { "BRG-6204": 450, "BLT-M8": 12 });
    expect(() => compareSupplierQuotes(request, [ok])).toThrow(/at least 2 suppliers/);
    expect(() => compareSupplierQuotes([], [ok, quote("B", {})])).toThrow(QuoteError);
    expect(() => compareSupplierQuotes([...request, request[0]], [ok, ok])).toThrow(/listed twice/);
    expect(() => compareSupplierQuotes(request, [ok, { ...ok, supplier: " Ａ " }])).toThrow(
      /supplier Ａ is listed twice/,
    );
    expect(() =>
      compareSupplierQuotes(request, [ok, quote("B", { "BRG-6204": 450, "XTRA-1": 1 })]),
    ).toThrow(/B: line 2 is not a requested item/);
    const repeated = quote("B", { "BRG-6204": 450 });
    repeated.lines.push({ ...repeated.lines[0] });
    expect(() => compareSupplierQuotes(request, [ok, repeated])).toThrow(
      /BRG-6204 is quoted twice/,
    );
    expect(() => compareSupplierQuotes(request, [ok, { supplier: "B", lines: [] }])).toThrow(
      /B: a quotation needs at least one line/,
    );
  });
});
