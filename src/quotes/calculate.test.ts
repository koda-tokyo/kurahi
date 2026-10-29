import { describe, expect, it } from "vitest";
import { allocate, calculateQuote, divRound, QuoteError, toScaled } from "./calculate.js";

describe("calculateQuote", () => {
  it("prices lines and adds 10% tax", () => {
    const q = calculateQuote([
      { code: "A-100", description: "部品A", quantity: 10, unitPrice: 1200, taxRate: 10 },
      { description: "設置作業", quantity: "1.5", unit: "時間", unitPrice: 8000, taxRate: 10 },
    ]);
    expect(q.lines.map((l) => l.amount)).toEqual([12000, 12000]);
    expect(q.subtotal).toBe(24000);
    expect(q.buckets).toEqual([
      { rate: 10, lines: 24000, documentDiscount: 0, taxable: 24000, tax: 2400 },
    ]);
    expect(q.total).toBe(26400);
    expect(q.lines[1]).toMatchObject({ quantity: "1.5", unit: "時間", unitPrice: "8000" });
  });

  it("rounds tax once per rate per document, not per line (インボイス制度)", () => {
    // Three lines of ¥333 at 10%: per-line tax would be 33 × 3 = 99; per document it is 99.9 → 99.
    // Seven lines of ¥105 at 8%: per-line 8 × 7 = 56; per document 735 × 8% = 58.8 → 58.
    const lines = [
      ...Array.from({ length: 3 }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: 333,
        taxRate: 10 as const,
      })),
      ...Array.from({ length: 7 }, () => ({
        description: "y",
        quantity: 1,
        unitPrice: 105,
        taxRate: 8 as const,
      })),
    ];
    const q = calculateQuote(lines);
    expect(q.buckets.map((b) => [b.rate, b.taxable, b.tax])).toEqual([
      [10, 999, 99],
      [8, 735, 58],
    ]);
    expect(q.tax).toBe(157);
    expect(q.total).toBe(999 + 735 + 157);
  });

  it("supports the rounding modes for tax", () => {
    const line = [{ description: "x", quantity: 1, unitPrice: 105, taxRate: 10 as const }];
    expect(calculateQuote(line, { taxRounding: "floor" }).tax).toBe(10);
    expect(calculateQuote(line, { taxRounding: "round" }).tax).toBe(11);
    expect(calculateQuote(line, { taxRounding: "ceil" }).tax).toBe(11);
    const line2 = [{ description: "x", quantity: 1, unitPrice: 104, taxRate: 10 as const }];
    expect(calculateQuote(line2, { taxRounding: "round" }).tax).toBe(10);
  });

  it("rounds fractional line amounts with the line rounding mode", () => {
    const line = [{ description: "x", quantity: "3", unitPrice: "12.5", taxRate: 10 as const }];
    expect(calculateQuote(line).lines[0].gross).toBe(37);
    expect(calculateQuote(line, { lineRounding: "round" }).lines[0].gross).toBe(38);
    expect(calculateQuote(line, { lineRounding: "ceil" }).lines[0].gross).toBe(38);
  });

  it("is exact where binary floating point is not", () => {
    // 0.1 × 3 hours at ¥10,000.10 = 3,000.03 → 3,000 (floating point gives 3000.0299999…).
    const q = calculateQuote([
      { description: "x", quantity: "0.3", unitPrice: "10000.1", taxRate: 10 },
    ]);
    expect(q.lines[0].gross).toBe(3000);
    const r = calculateQuote([{ description: "x", quantity: 0.1, unitPrice: 0.3, taxRate: 0 }], {
      lineRounding: "ceil",
    });
    expect(r.lines[0].gross).toBe(1); // 0.03 → 1 with ceil, exactly
  });

  it("applies line discounts: percentage first, rounded down, then amount", () => {
    const q = calculateQuote([
      {
        description: "x",
        quantity: 1,
        unitPrice: 9999,
        taxRate: 10,
        discountPercent: "12.5",
        discountAmount: 100,
      },
    ]);
    // 9999 × 12.5% = 1249.875 → 1249; + 100 = 1349.
    expect(q.lines[0]).toMatchObject({ gross: 9999, discount: 1349, amount: 8650 });
  });

  it("spreads a document discount over the rates and taxes what remains", () => {
    const q = calculateQuote(
      [
        { description: "a", quantity: 1, unitPrice: 30000, taxRate: 10 },
        { description: "b", quantity: 1, unitPrice: 10000, taxRate: 8 },
      ],
      { documentDiscount: 1001 },
    );
    expect(q.buckets.map((b) => [b.rate, b.documentDiscount, b.taxable, b.tax])).toEqual([
      [10, 751, 29249, 2924],
      [8, 250, 9750, 780],
    ]);
    expect(q.documentDiscount).toBe(1001);
    expect(q.net).toBe(38999);
    expect(q.total).toBe(38999 + 2924 + 780);
  });

  it("keeps tax-free lines in a 0% bucket", () => {
    const q = calculateQuote([
      { description: "export", quantity: 2, unitPrice: 5000, taxRate: 0 },
      { description: "domestic", quantity: 1, unitPrice: 1000, taxRate: 10 },
    ]);
    expect(q.buckets.map((b) => [b.rate, b.tax])).toEqual([
      [10, 100],
      [0, 0],
    ]);
  });

  it("refuses invalid input with the line number", () => {
    const ok = { description: "x", quantity: 1, unitPrice: 100, taxRate: 10 as const };
    expect(() => calculateQuote([])).toThrow(QuoteError);
    expect(() => calculateQuote([ok, { ...ok, quantity: 0 }])).toThrow(
      "line 2: quantity must be greater than 0",
    );
    expect(() => calculateQuote([{ ...ok, quantity: "1.2345" }])).toThrow(
      "more than 3 decimal places",
    );
    expect(() => calculateQuote([{ ...ok, unitPrice: "1.234" }])).toThrow(
      "more than 2 decimal places",
    );
    expect(() => calculateQuote([{ ...ok, unitPrice: -1 }])).toThrow("non-negative");
    expect(() => calculateQuote([{ ...ok, taxRate: 5 as never }])).toThrow("tax rate");
    expect(() => calculateQuote([{ ...ok, description: " " }])).toThrow("description is required");
    expect(() => calculateQuote([{ ...ok, discountPercent: 101 }])).toThrow("100 or less");
    expect(() => calculateQuote([{ ...ok, discountAmount: 101 }])).toThrow(
      "larger than the line amount",
    );
    expect(() => calculateQuote([{ ...ok, discountAmount: 1.5 }])).toThrow("whole number of yen");
    expect(() => calculateQuote([ok], { documentDiscount: 101 })).toThrow(
      "larger than the subtotal",
    );
    expect(() => calculateQuote([{ ...ok, quantity: 1e21 }])).toThrow("out of range");
    expect(() => calculateQuote([{ ...ok, quantity: "1e3" }])).toThrow("non-negative decimal");
  });

  it("refuses totals beyond safe integers instead of losing precision", () => {
    expect(() =>
      calculateQuote([
        { description: "x", quantity: "999999999", unitPrice: "99999999999", taxRate: 10 },
      ]),
    ).toThrow("too large");
  });
});

describe("helpers", () => {
  it("toScaled parses exactly", () => {
    expect(toScaled("12.5", 2, "p")).toBe(1250n);
    expect(toScaled(0.1, 3, "q")).toBe(100n);
    expect(toScaled("7", 0, "n")).toBe(7n);
  });

  it("divRound rounds half up with round", () => {
    expect(divRound(5n, 2n, "round")).toBe(3n);
    expect(divRound(4n, 2n, "ceil")).toBe(2n);
    expect(divRound(7n, 2n, "floor")).toBe(3n);
  });

  it("allocate sums exactly and is deterministic", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocate(10n, [0n, 7n])).toEqual([0n, 10n]);
    const r = allocate(1001n, [30000n, 10000n]);
    expect(r[0] + r[1]).toBe(1001n);
  });
});

describe("cases from the tax review", () => {
  const line = (unitPrice: number, taxRate: 10 | 8) => ({
    description: "x",
    quantity: 1,
    unitPrice,
    taxRate,
  });

  it("three ¥336 lines at 10%: tax once on ¥1,008 (per-line rounding would differ)", () => {
    const lines = [line(336, 10), line(336, 10), line(336, 10)];
    // Once per document: 100.8 → 100 / 101 / 101. Per line (wrong): 33.6 × 3 → 99 / 102 / 102.
    expect(calculateQuote(lines, { taxRounding: "floor" }).tax).toBe(100);
    expect(calculateQuote(lines, { taxRounding: "round" }).tax).toBe(101);
    expect(calculateQuote(lines, { taxRounding: "ceil" }).tax).toBe(101);
  });

  it("allocates a document discount to the tax rates before computing tax", () => {
    const q = calculateQuote([line(10000, 10), line(10000, 8)], { documentDiscount: 2000 });
    expect(q.buckets.map((b) => [b.rate, b.taxable, b.tax])).toEqual([
      [10, 9000, 900],
      [8, 9000, 720],
    ]);
    expect(q.total).toBe(19620);
  });

  it("refuses negative values instead of guessing how to round them", () => {
    expect(() => calculateQuote([{ ...line(100, 10), unitPrice: -100 }])).toThrow(QuoteError);
    expect(() => calculateQuote([{ ...line(100, 10), quantity: -1 }])).toThrow(QuoteError);
  });
});
