// Quotation arithmetic (Kurahi Business, 見積管理). Deterministic and exact: the model never
// computes money. A routine's model only extracts line items (an item code or description and a
// quantity); prices come from the company price list and every amount is computed here.
//
// Arithmetic is exact with BigInt: unit prices carry up to 2 decimal places (sen), quantities up
// to 3, percentages up to 2. Amounts are whole yen. Consumption tax follows the qualified-invoice
// rule (インボイス制度): one rounding per tax rate per document, on the rate's taxable total.

export const TAX_RATES = [10, 8, 0] as const;
export type TaxRate = (typeof TAX_RATES)[number];

/** 端数処理. Japanese practice is mostly 切り捨て (floor), so that is the default. */
export const ROUNDING_MODES = ["floor", "round", "ceil"] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export type QuoteLineInput = {
  /** Item code from the price list, when known. */
  code?: string;
  description: string;
  /** Decimal string or number, up to 3 decimal places, greater than 0. */
  quantity: string | number;
  unit?: string;
  /** Tax-exclusive unit price in yen, up to 2 decimal places, 0 or more. */
  unitPrice: string | number;
  taxRate: TaxRate;
  /** Line discount as a percentage (0–100, up to 2 decimals) of the line amount. */
  discountPercent?: string | number;
  /** Line discount in whole yen, after any percentage discount. */
  discountAmount?: number;
};

export type QuoteOptions = {
  /** Rounding of each line amount to whole yen. Default floor. */
  lineRounding?: RoundingMode;
  /** Rounding of the tax per rate. Default floor. */
  taxRounding?: RoundingMode;
  /** Document discount in whole yen, spread over the tax rates in proportion to their totals. */
  documentDiscount?: number;
};

export type QuoteLine = {
  code?: string;
  description: string;
  quantity: string;
  unit?: string;
  unitPrice: string;
  taxRate: TaxRate;
  /** quantity × unitPrice, rounded to whole yen. */
  gross: number;
  discount: number;
  /** gross − discount, tax-exclusive. */
  amount: number;
};

export type QuoteTaxBucket = {
  rate: TaxRate;
  /** Tax-exclusive total of the lines at this rate, before the document discount. */
  lines: number;
  /** Share of the document discount allocated to this rate. */
  documentDiscount: number;
  /** Taxable amount: lines − documentDiscount. */
  taxable: number;
  tax: number;
};

export type QuoteTotals = {
  lines: QuoteLine[];
  buckets: QuoteTaxBucket[];
  subtotal: number;
  documentDiscount: number;
  /** Tax-exclusive total after all discounts. */
  net: number;
  tax: number;
  /** Tax-inclusive total. */
  total: number;
};

export class QuoteError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line + 1}: ${message}`);
    this.name = "QuoteError";
  }
}

/** A decimal as an integer scaled by 10^places, exactly. Rejects more places than allowed. */
export function toScaled(value: string | number, places: number, what: string): bigint {
  const text = typeof value === "number" ? numberText(value, what) : value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    throw new QuoteError(`${what} must be a non-negative decimal number`);
  }
  const frac = m[2] ?? "";
  if (frac.length > places) {
    throw new QuoteError(`${what} has more than ${places} decimal places`);
  }
  return BigInt(m[1] + frac.padEnd(places, "0"));
}

function numberText(n: number, what: string): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new QuoteError(`${what} must be a non-negative decimal number`);
  }
  // Shortest round-trip text; exponent forms are refused rather than guessed.
  const text = String(n);
  if (/e/i.test(text)) {
    throw new QuoteError(`${what} is out of range`);
  }
  return text;
}

/** numerator / denominator rounded to an integer with the given mode (both non-negative). */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n) {
    return q;
  }
  if (mode === "floor") {
    return q;
  }
  if (mode === "ceil") {
    return q + 1n;
  }
  return r * 2n >= denominator ? q + 1n : q;
}

function wholeYen(n: number | undefined, what: string, line?: number): bigint {
  if (n === undefined) {
    return 0n;
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new QuoteError(`${what} must be a whole number of yen, 0 or more`, line);
  }
  return BigInt(n);
}

function scaledText(v: bigint, places: number): string {
  if (places === 0) {
    return v.toString();
  }
  const s = v.toString().padStart(places + 1, "0");
  const int = s.slice(0, -places);
  const frac = s.slice(-places).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function safe(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QuoteError(`${what} is too large`);
  }
  return Number(v);
}

/**
 * Compute a quotation. Lines keep their input order; buckets are listed 10%, 8%, 0% (only rates
 * that occur). Throws QuoteError on invalid input; never returns a partial result.
 */
export function calculateQuote(inputs: QuoteLineInput[], options: QuoteOptions = {}): QuoteTotals {
  if (inputs.length === 0) {
    throw new QuoteError("a quotation needs at least one line");
  }
  const lineRounding = options.lineRounding ?? "floor";
  const taxRounding = options.taxRounding ?? "floor";

  const lines: QuoteLine[] = [];
  const byRate = new Map<TaxRate, bigint>();
  inputs.forEach((input, i) => {
    if (!(TAX_RATES as readonly number[]).includes(input.taxRate)) {
      throw new QuoteError(`tax rate must be one of ${TAX_RATES.join(", ")}`, i);
    }
    if (!input.description?.trim()) {
      throw new QuoteError("description is required", i);
    }
    let qty: bigint;
    let price: bigint;
    let pct: bigint;
    try {
      qty = toScaled(input.quantity, 3, "quantity"); // ×1000
      price = toScaled(input.unitPrice, 2, "unit price"); // ×100
      pct = toScaled(input.discountPercent ?? 0, 2, "discount percent"); // ×100
    } catch (e) {
      throw new QuoteError((e as Error).message, i);
    }
    if (qty === 0n) {
      throw new QuoteError("quantity must be greater than 0", i);
    }
    if (pct > 10000n) {
      throw new QuoteError("discount percent must be 100 or less", i);
    }
    const gross = divRound(qty * price, 100_000n, lineRounding);
    // Percentage discounts are rounded down, so a discount never exceeds what was offered.
    const pctDiscount = (gross * pct) / 10_000n;
    const amountDiscount = wholeYen(input.discountAmount, "discount amount", i);
    const discount = pctDiscount + amountDiscount;
    if (discount > gross) {
      throw new QuoteError("discount is larger than the line amount", i);
    }
    const amount = gross - discount;
    byRate.set(input.taxRate, (byRate.get(input.taxRate) ?? 0n) + amount);
    lines.push({
      ...(input.code ? { code: input.code } : {}),
      description: input.description.trim(),
      quantity: scaledText(qty, 3),
      ...(input.unit ? { unit: input.unit } : {}),
      unitPrice: scaledText(price, 2),
      taxRate: input.taxRate,
      gross: safe(gross, "line amount"),
      discount: safe(discount, "discount"),
      amount: safe(amount, "line amount"),
    });
  });

  const subtotal = [...byRate.values()].reduce((a, b) => a + b, 0n);
  const docDiscount = wholeYen(options.documentDiscount, "document discount");
  if (docDiscount > subtotal) {
    throw new QuoteError("document discount is larger than the subtotal");
  }
  const rates = TAX_RATES.filter((r) => byRate.has(r));
  const shares = allocate(
    docDiscount,
    rates.map((r) => byRate.get(r) ?? 0n),
  );

  const buckets: QuoteTaxBucket[] = rates.map((rate, i) => {
    const linesTotal = byRate.get(rate) ?? 0n;
    const taxable = linesTotal - shares[i];
    const tax = divRound(taxable * BigInt(rate), 100n, taxRounding);
    return {
      rate,
      lines: safe(linesTotal, "subtotal"),
      documentDiscount: safe(shares[i], "document discount"),
      taxable: safe(taxable, "taxable amount"),
      tax: safe(tax, "tax"),
    };
  });
  const net = subtotal - docDiscount;
  const tax = buckets.reduce((a, b) => a + BigInt(b.tax), 0n);
  return {
    lines,
    buckets,
    subtotal: safe(subtotal, "subtotal"),
    documentDiscount: safe(docDiscount, "document discount"),
    net: safe(net, "net total"),
    tax: safe(tax, "tax"),
    total: safe(net + tax, "total"),
  };
}

/**
 * Split `amount` over `weights` in proportion, in whole yen, summing exactly to `amount`
 * (largest remainder; ties go to the earlier weight, so the result is deterministic).
 */
export function allocate(amount: bigint, weights: bigint[]): bigint[] {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (amount === 0n || total === 0n) {
    return weights.map(() => 0n);
  }
  const base = weights.map((w) => (amount * w) / total);
  const rem = weights.map((w, i) => ({ i, r: (amount * w) % total }));
  let left = amount - base.reduce((a, b) => a + b, 0n);
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rem) {
    if (left === 0n) {
      break;
    }
    base[i] += 1n;
    left -= 1n;
  }
  return base;
}
