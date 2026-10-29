// Person-recorded supplier selection on a procurement case (相見積 → 発注). A routine may only
// draft a purchase order from a choice a named person made against a specific set of quotes:
// the record carries a digest of the comparison as it was priced when the person chose, and a
// later order refuses when the quotes have changed since (no silent re-award). The caller is
// responsible for taking `selectedBy` from an authenticated session, never from a request body.

import { createHash } from "node:crypto";
import { QuoteError, toScaled } from "./calculate.js";
import { compareSupplierQuotes, type ComparisonItem, type SupplierQuoteInput } from "./compare.js";
import { preparePurchaseOrder, type PurchaseOrderSelection } from "./purchase-order.js";

export type SupplierSelection = {
  /** Supplier as named on its quote. */
  supplier: string;
  /** Actor id of the person who chose it. */
  selectedBy: string;
  /** Why, when the choice is not among the lowest complete quotes; null otherwise. */
  reason: string | null;
  /** sha256 of the priced comparison at selection time. */
  comparisonDigest: string;
  /** Lowest complete quotes at selection time, for the approver to see. */
  lowest: string[];
  deviatesFromLowest: boolean;
  at: string;
  /** Item revision the person saw. */
  revision: number;
};

/** A deviation from the lowest quote needs a substantive written reason. */
export const MIN_DEVIATION_REASON = 10;

/**
 * Digest of the comparison as priced, not as typed: equivalent input ("20" and 20) hashes the
 * same, supplier order does not matter, and any change to a priced line, total or the request
 * changes it.
 */
export function comparisonDigest(request: ComparisonItem[], quotes: SupplierQuoteInput[]): string {
  const c = compareSupplierQuotes(request, quotes);
  const canonical = {
    items: c.items.map((i) => i.code),
    // Scaled exactly as the comparison prices it, so "20" and "20.000" are the same request.
    request: request.map((r) => ({
      code: r.code.trim(),
      quantity: toScaled(r.quantity, 3, `quantity of ${r.code.trim()}`).toString(),
    })),
    suppliers: c.suppliers
      .map((s) => ({
        supplier: s.supplier,
        complete: s.complete,
        missing: s.missing,
        quantityMismatch: s.quantityMismatch,
        totals: s.totals,
      }))
      .toSorted((a, b) => (a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Validate a person's choice against the recomputed comparison and build the record. Refuses an
 * unknown supplier, an incomplete quote, a missing selector, and a deviation from the lowest
 * without a reason of at least MIN_DEVIATION_REASON characters.
 */
export function recordSupplierSelection(
  request: ComparisonItem[],
  quotes: SupplierQuoteInput[],
  choice: PurchaseOrderSelection,
  ctx: { at: Date; revision: number },
): SupplierSelection {
  // The draft runs every check an order would; nothing is written here.
  const draft = preparePurchaseOrder(request, quotes, choice);
  const reason = draft.reason ?? null;
  if (draft.deviatesFromLowest && (reason?.length ?? 0) < MIN_DEVIATION_REASON) {
    throw new QuoteError(
      `choosing ${draft.supplier} over the lowest quote needs a reason of at least ${MIN_DEVIATION_REASON} characters`,
    );
  }
  return {
    supplier: draft.supplier,
    selectedBy: draft.selectedBy,
    reason: draft.deviatesFromLowest ? reason : null,
    comparisonDigest: comparisonDigest(request, quotes),
    lowest: draft.lowest,
    deviatesFromLowest: draft.deviatesFromLowest,
    at: ctx.at.toISOString(),
    revision: ctx.revision,
  };
}

/**
 * For a routine about to draft an order: the selection must exist and the quotes must be the
 * ones the person chose from. Returns the order input, with the selector taken from the record.
 */
export function assertSelectionCurrent(
  selection: SupplierSelection | undefined,
  request: ComparisonItem[],
  quotes: SupplierQuoteInput[],
): PurchaseOrderSelection {
  if (!selection) {
    throw new QuoteError("no supplier has been chosen on this case; a person must choose first");
  }
  if (comparisonDigest(request, quotes) !== selection.comparisonDigest) {
    throw new QuoteError(
      "the quotes changed since the person chose; a person must choose the supplier again",
    );
  }
  return {
    supplier: selection.supplier,
    selectedBy: selection.selectedBy,
    ...(selection.reason ? { reason: selection.reason } : {}),
  };
}
