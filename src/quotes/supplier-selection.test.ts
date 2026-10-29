import { describe, expect, it } from "vitest";
import type { SupplierQuoteInput } from "./compare.js";
import { QuoteError } from "./calculate.js";
import { preparePurchaseOrder } from "./purchase-order.js";
import {
  assertSelectionCurrent,
  comparisonDigest,
  MIN_DEVIATION_REASON,
  recordSupplierSelection,
} from "./supplier-selection.js";

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

const quotes = [
  quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 12 }), // 15000, lowest
  quote("東和産業", { "BRG-6204": 400, "BLT-M8": 15 }), // 15500
  quote("大和部品", { "BRG-6204": 300 }), // incomplete
];

const AT = new Date("2026-10-26T07:30:00Z");

describe("comparisonDigest", () => {
  it("is stable for equivalent input and ignores supplier order", () => {
    const same = [
      quotes[2],
      quotes[0],
      { ...quotes[1], lines: quotes[1].lines.map((l) => ({ ...l, quantity: String(l.quantity) })) },
    ];
    expect(comparisonDigest(request, same)).toBe(comparisonDigest(request, quotes));
    expect(comparisonDigest(request, quotes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes an equivalently written requested quantity the same", () => {
    const written = [
      { ...request[0], quantity: " 20.000 " },
      { ...request[1], quantity: "500.0" },
    ];
    expect(comparisonDigest(written, quotes)).toBe(comparisonDigest(request, quotes));
  });

  it("changes when a quoted price or the request changes", () => {
    const base = comparisonDigest(request, quotes);
    const repriced = [quote("北辰商事", { "BRG-6204": 451, "BLT-M8": 12 }), ...quotes.slice(1)];
    expect(comparisonDigest(request, repriced)).not.toBe(base);
    const more = [{ ...request[0], quantity: 21 }, request[1]];
    expect(comparisonDigest(more, quotes)).not.toBe(base);
  });
});

describe("recordSupplierSelection", () => {
  it("records the lowest choice with the server-computed comparison", () => {
    const s = recordSupplierSelection(
      request,
      quotes,
      { supplier: " 北辰商事 ", selectedBy: "u-sato" },
      { at: AT, revision: 4 },
    );
    expect(s).toEqual({
      supplier: "北辰商事",
      selectedBy: "u-sato",
      reason: null,
      comparisonDigest: comparisonDigest(request, quotes),
      lowest: ["北辰商事"],
      deviatesFromLowest: false,
      at: AT.toISOString(),
      revision: 4,
    });
  });

  it("refuses a deviation without a substantive reason, and records it with one", () => {
    const pick = (reason?: string) =>
      recordSupplierSelection(
        request,
        quotes,
        { supplier: "東和産業", selectedBy: "u-sato", reason },
        { at: AT, revision: 1 },
      );
    expect(() => pick()).toThrow(QuoteError);
    expect(() => pick("x".repeat(MIN_DEVIATION_REASON - 1))).toThrow(/reason/);
    const s = pick("納期が2週間早いため");
    expect(s.deviatesFromLowest).toBe(true);
    expect(s.reason).toBe("納期が2週間早いため");
  });

  it("refuses an incomplete quote, an unknown supplier and a missing selector", () => {
    const pick = (supplier: string, selectedBy = "u-sato") =>
      recordSupplierSelection(
        request,
        quotes,
        { supplier, selectedBy, reason: "品質実績があるため選定" },
        { at: AT, revision: 1 },
      );
    expect(() => pick("大和部品")).toThrow(/incomplete/);
    expect(() => pick("未登録商事")).toThrow(/no quote/);
    expect(() => pick("北辰商事", " ")).toThrow(/person/);
  });
});

describe("assertSelectionCurrent", () => {
  const selection = recordSupplierSelection(
    request,
    quotes,
    { supplier: "北辰商事", selectedBy: "u-sato" },
    { at: AT, revision: 2 },
  );

  it("passes on unchanged quotes and yields the order input from the record", () => {
    const sel = assertSelectionCurrent(selection, request, quotes);
    expect(sel).toEqual({ supplier: "北辰商事", selectedBy: "u-sato" });
    expect(preparePurchaseOrder(request, quotes, sel).totals.net).toBe(15000);
  });

  it("refuses when the quotes changed after the person chose", () => {
    const repriced = [quote("北辰商事", { "BRG-6204": 450, "BLT-M8": 13 }), ...quotes.slice(1)];
    expect(() => assertSelectionCurrent(selection, request, repriced)).toThrow(
      /changed since .* chose/,
    );
  });

  it("refuses when there is no selection", () => {
    expect(() => assertSelectionCurrent(undefined, request, quotes)).toThrow(/no supplier/);
  });
});
