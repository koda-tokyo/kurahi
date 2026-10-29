import { describe, expect, it } from "vitest";
import type { SupplierQuoteInput } from "./compare.js";
import { QuoteError } from "./calculate.js";
import { MAX_SELECTION_TEXT, preparePurchaseOrder } from "./purchase-order.js";

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

const quotes = [
  quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }), // 15000
  quote("東和産業", { "BRG-6204": 400, "BLT-M8": 15 }), // 15500
  quote("大和部品", { "BRG-6204": 300 }), // incomplete
];

describe("preparePurchaseOrder", () => {
  it("drafts the order from the chosen lowest quote's computed figures", () => {
    const po = preparePurchaseOrder(request, quotes, {
      supplier: "北辰商事",
      selectedBy: "佐藤",
    });
    expect(po.status).toBe("draft");
    expect(po.supplier).toBe("北辰商事");
    expect(po.lines.map((l) => [l.code, l.amount])).toEqual([
      ["BRG-6204", 9000],
      ["BLT-M8", 6000],
    ]);
    expect(po.totals).toMatchObject({ net: 15000, tax: 1500, total: 16500 });
    expect(po.deviatesFromLowest).toBe(false);
    expect(po.reason).toBeUndefined();
    expect(po.lowest).toEqual(["北辰商事"]);
    expect(po.compared).toEqual(["北辰商事", "東和産業", "大和部品"]);
  });

  it("refuses a supplier other than the lowest without a reason, and records it with one", () => {
    expect(() =>
      preparePurchaseOrder(request, quotes, {
        supplier: "東和産業",
        selectedBy: "佐藤",
        reason: " ",
      }),
    ).toThrow(/not the lowest/);
    const po = preparePurchaseOrder(request, quotes, {
      supplier: "東和産業",
      selectedBy: "佐藤",
      reason: "納期が1週間早い",
    });
    expect(po.deviatesFromLowest).toBe(true);
    expect(po.reason).toBe("納期が1週間早い");
    expect(po.totals.net).toBe(15500);
    expect(po.lowestNet).toBe(15000);
  });

  it("never orders from an incomplete quote, even with a reason", () => {
    expect(() =>
      preparePurchaseOrder(request, quotes, {
        supplier: "大和部品",
        selectedBy: "佐藤",
        reason: "最安",
      }),
    ).toThrow(/incomplete \(BLT-M8\)/);
    const short = [
      quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }),
      quote("東和産業", { "BRG-6204": 400, "BLT-M8": 15 }, { "BLT-M8": 400 }),
    ];
    expect(() =>
      preparePurchaseOrder(request, short, {
        supplier: "東和産業",
        selectedBy: "佐藤",
        reason: "x",
      }),
    ).toThrow(/incomplete \(BLT-M8\)/);
  });

  it("needs a named person and a supplier that was quoted", () => {
    expect(() =>
      preparePurchaseOrder(request, quotes, { supplier: "北辰商事", selectedBy: "  " }),
    ).toThrow(/person who chose/);
    expect(() =>
      preparePurchaseOrder(request, quotes, { supplier: "未知商会", selectedBy: "佐藤" }),
    ).toThrow(/has no quote/);
    expect(() =>
      preparePurchaseOrder(request, quotes, { supplier: "", selectedBy: "佐藤" }),
    ).toThrow(QuoteError);
  });

  it("matches the supplier name like the comparison does (NFKC, case)", () => {
    const latin = [
      quote("ＡＢＣ Trading", { "BRG-6204": 450, "BLT-M8": 12 }),
      quote("東和産業", { "BRG-6204": 400, "BLT-M8": 15 }),
    ];
    const po = preparePurchaseOrder(request, latin, {
      supplier: "abc trading",
      selectedBy: "佐藤",
    });
    expect(po.supplier).toBe("ＡＢＣ Trading");
  });

  it("lists every tied lowest supplier and needs no reason for any of them", () => {
    const tied = [
      quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }),
      quote("東和産業", { "BRG-6204": 450, "BLT-M8": 12 }),
    ];
    const po = preparePurchaseOrder(request, tied, { supplier: "東和産業", selectedBy: "佐藤" });
    expect(po.deviatesFromLowest).toBe(false);
    expect(po.lowest).toEqual(["北辰商事", "東和産業"]);
  });

  it("refuses oversized free text", () => {
    const long = "あ".repeat(MAX_SELECTION_TEXT + 1);
    expect(() =>
      preparePurchaseOrder(request, quotes, {
        supplier: "東和産業",
        selectedBy: "佐藤",
        reason: long,
      }),
    ).toThrow(/reason is longer/);
    expect(() =>
      preparePurchaseOrder(request, quotes, { supplier: "北辰商事", selectedBy: long }),
    ).toThrow(/selectedBy is longer/);
  });

  it("passes comparison errors through: one quote is not a comparison", () => {
    expect(() =>
      preparePurchaseOrder(request, quotes.slice(0, 1), {
        supplier: "北辰商事",
        selectedBy: "佐藤",
      }),
    ).toThrow(/at least 2 suppliers/);
  });
});
