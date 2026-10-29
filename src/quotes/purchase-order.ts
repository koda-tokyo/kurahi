// Purchase order draft from a supplier comparison (Kurahi Business, 発注書). Deterministic: the
// comparison is recomputed here from the request and the quotes, never taken from the caller, so
// the draft cannot carry figures the comparison did not produce. It never awards or sends: a named
// person chooses the supplier, and the draft waits for a person to issue it.
//
// Choosing a supplier other than the lowest complete quote is allowed, but needs a written reason
// (delivery, quality, single source): the deviation is recorded on the draft for approval.

import { QuoteError, type QuoteLine, type QuoteTotals } from "./calculate.js";
import { compareSupplierQuotes, type ComparisonItem, type SupplierQuoteInput } from "./compare.js";

export type PurchaseOrderSelection = {
  /** Supplier the person chose, as named on its quote. */
  supplier: string;
  /** The person who chose it. */
  selectedBy: string;
  /** Required when the chosen supplier is not among the lowest complete quotes. */
  reason?: string;
};

export type PurchaseOrderDraft = {
  status: "draft";
  supplier: string;
  lines: QuoteLine[];
  totals: Omit<QuoteTotals, "lines">;
  selectedBy: string;
  reason?: string;
  /** Lowest complete quotes at the time of selection. */
  lowest: string[];
  lowestNet: number | null;
  /** True when the chosen supplier is not among the lowest; the reason explains why. */
  deviatesFromLowest: boolean;
  /** Suppliers compared, in the order given. */
  compared: string[];
};

/** Reason and selector are free text written by a person; keep them to a reviewable size. */
export const MAX_SELECTION_TEXT = 500;

export function preparePurchaseOrder(
  request: ComparisonItem[],
  quotes: SupplierQuoteInput[],
  selection: PurchaseOrderSelection,
): PurchaseOrderDraft {
  const selectedBy = boundedText(selection.selectedBy, "selectedBy");
  if (!selectedBy) {
    throw new QuoteError("a purchase order needs the person who chose the supplier");
  }
  const reason = boundedText(selection.reason, "reason");

  const comparison = compareSupplierQuotes(request, quotes);
  const wanted = selection.supplier?.trim().normalize("NFKC").toLowerCase();
  const chosen = comparison.suppliers.find(
    (s) => s.supplier.normalize("NFKC").toLowerCase() === wanted,
  );
  if (!wanted || !chosen) {
    throw new QuoteError(`supplier ${selection.supplier ?? ""} has no quote in this comparison`);
  }
  // An incomplete quote would order less than was requested, or a different quantity.
  if (!chosen.complete) {
    const gaps = [...chosen.missing, ...chosen.quantityMismatch].join(", ");
    throw new QuoteError(
      `${chosen.supplier}'s quote is incomplete (${gaps}); it cannot be ordered`,
    );
  }

  const deviatesFromLowest = !comparison.lowest.includes(chosen.supplier);
  if (deviatesFromLowest && !reason) {
    throw new QuoteError(
      `${chosen.supplier} is not the lowest complete quote; give the reason for choosing it`,
    );
  }

  const { lines, ...totals } = chosen.totals;
  return {
    status: "draft",
    supplier: chosen.supplier,
    lines,
    totals,
    selectedBy,
    ...(reason ? { reason } : {}),
    lowest: comparison.lowest,
    lowestNet: comparison.lowestNet,
    deviatesFromLowest,
    compared: comparison.suppliers.map((s) => s.supplier),
  };
}

function boundedText(value: string | undefined, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > MAX_SELECTION_TEXT) {
    throw new QuoteError(`${field} is longer than ${MAX_SELECTION_TEXT} characters`);
  }
  return text;
}
