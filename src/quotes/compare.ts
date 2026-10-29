// Supplier quotation comparison (Kurahi Business, 相見積). Deterministic: every supplier quote is
// priced by calculateQuote, and the comparison only reads those results. It never awards: it says
// which complete quotes are lowest and why the others cannot be compared; a person decides.
//
// Quotes are compared on the tax-exclusive net (税抜), the usual basis for 相見積. A quote that
// leaves out a requested item, or quotes a different quantity, is incomplete and is never named
// lowest: a missing item is not a free item.

import {
  calculateQuote,
  QuoteError,
  toScaled,
  type QuoteLineInput,
  type QuoteOptions,
  type QuoteTotals,
} from "./calculate.js";

export type ComparisonItem = {
  code: string;
  description?: string;
  /** Decimal string or number, up to 3 decimal places, greater than 0. */
  quantity: string | number;
};

export type SupplierQuoteInput = {
  supplier: string;
  /** Every line names a requested item code. */
  lines: QuoteLineInput[];
  options?: QuoteOptions;
};

export type SupplierResult = {
  supplier: string;
  totals: QuoteTotals;
  /** Requested codes this supplier did not quote. */
  missing: string[];
  /** Requested codes quoted at a different quantity. */
  quantityMismatch: string[];
  complete: boolean;
};

export type ItemOffer = {
  supplier: string;
  /** Line amount after line discounts, before any document discount; null when not quoted. */
  amount: number | null;
};

export type ItemComparison = {
  code: string;
  offers: ItemOffer[];
  /** Suppliers with the lowest amount among those that quoted the requested quantity. */
  lowest: string[];
};

export type QuoteComparison = {
  suppliers: SupplierResult[];
  items: ItemComparison[];
  /** Complete quotes with the lowest net total; more than one on a tie, empty when none is complete. */
  lowest: string[];
  lowestNet: number | null;
};

/** 相見積 means at least two quotes; one quote is not a comparison. */
export const MIN_SUPPLIERS = 2;

/**
 * Size limits shared by a case's stored procurement (src/workitems/procurement.ts) and the office
 * comparison and purchase-order tools (extensions/office/src/quote-compare.ts), so everything a
 * case can store can also be compared and drafted. Text limits are in characters.
 */
export const COMPARISON_LIMITS = {
  items: 200,
  suppliers: 20,
  code: 64,
  description: 200,
  supplier: 120,
} as const;

export function compareSupplierQuotes(
  request: ComparisonItem[],
  quotes: SupplierQuoteInput[],
): QuoteComparison {
  if (request.length === 0) {
    throw new QuoteError("a comparison needs at least one requested item");
  }
  if (quotes.length < MIN_SUPPLIERS) {
    throw new QuoteError(`a comparison needs quotes from at least ${MIN_SUPPLIERS} suppliers`);
  }

  const wanted = new Map<string, bigint>();
  for (const item of request) {
    const code = item.code?.trim();
    if (!code) {
      throw new QuoteError("every requested item needs a code");
    }
    if (wanted.has(code)) {
      throw new QuoteError(`requested item ${code} is listed twice`);
    }
    const qty = toScaled(item.quantity, 3, `quantity of ${code}`);
    if (qty === 0n) {
      throw new QuoteError(`quantity of ${code} must be greater than 0`);
    }
    wanted.set(code, qty);
  }

  const names = new Set<string>();
  const suppliers: SupplierResult[] = [];
  const amounts = new Map<string, Map<string, number>>(); // supplier → code → amount
  for (const quote of quotes) {
    const supplier = quote.supplier?.trim();
    if (!supplier) {
      throw new QuoteError("every quote needs a supplier name");
    }
    const key = supplier.normalize("NFKC").toLowerCase();
    if (names.has(key)) {
      throw new QuoteError(`supplier ${supplier} is listed twice`);
    }
    names.add(key);

    let totals: QuoteTotals;
    try {
      totals = calculateQuote(quote.lines, quote.options);
    } catch (e) {
      throw new QuoteError(`${supplier}: ${(e as Error).message}`);
    }
    const byCode = new Map<string, number>();
    const mismatch: string[] = [];
    totals.lines.forEach((line, i) => {
      const code = line.code?.trim();
      // An unrequested or repeated line would change the total being compared, so it is refused.
      if (!code || !wanted.has(code)) {
        throw new QuoteError(`${supplier}: line ${i + 1} is not a requested item`);
      }
      if (byCode.has(code)) {
        throw new QuoteError(`${supplier}: item ${code} is quoted twice`);
      }
      byCode.set(code, line.amount);
      if (toScaled(line.quantity, 3, "quantity") !== wanted.get(code)) {
        mismatch.push(code);
      }
    });
    const missing = [...wanted.keys()].filter((code) => !byCode.has(code));
    amounts.set(supplier, byCode);
    suppliers.push({
      supplier,
      totals,
      missing,
      quantityMismatch: mismatch,
      complete: missing.length === 0 && mismatch.length === 0,
    });
  }

  const items: ItemComparison[] = [...wanted.keys()].map((code) => {
    const offers = suppliers.map((s) => ({
      supplier: s.supplier,
      amount: amounts.get(s.supplier)?.get(code) ?? null,
    }));
    const comparable = offers.filter(
      (o, i) => o.amount !== null && !suppliers[i].quantityMismatch.includes(code),
    );
    return { code, offers, lowest: lowestOf(comparable, (o) => o.amount ?? 0) };
  });

  const complete = suppliers.filter((s) => s.complete);
  const lowest = lowestOf(complete, (s) => s.totals.net);
  return {
    suppliers,
    items,
    lowest,
    lowestNet: complete.length === 0 ? null : Math.min(...complete.map((s) => s.totals.net)),
  };
}

function lowestOf<T extends { supplier: string }>(rows: T[], value: (row: T) => number): string[] {
  if (rows.length === 0) {
    return [];
  }
  const min = Math.min(...rows.map(value));
  return rows.filter((row) => value(row) === min).map((row) => row.supplier);
}
