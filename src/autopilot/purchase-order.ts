// po.prepare: the office_po_create arguments for a procurement case, bound by the engine from the
// case itself. The comparison is the case's recorded request and quotes, and the supplier,
// chooser and reason are the person's recorded selection (purchaseOrderSelectionFor refuses
// without one, after the quotes changed, or with a fraud flag). The model names only the case
// and the order's free details; it can never choose, or rename the chooser of, a supplier.

import type { WorkItem } from "../workitems/types.js";
import { purchaseOrderSelectionFor } from "../workitems/procurement.js";

/** The wire form office_po_create parses (extensions/office/src/quote-compare.ts). */
export function purchaseOrderToolArgs(
  item: WorkItem,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { request, quotes, selection } = purchaseOrderSelectionFor(item);
  const comparison = {
    items: request.map((r) => ({
      code: r.code,
      ...(r.description ? { description: r.description } : {}),
      quantity: r.quantity,
    })),
    quotes: quotes.map((q) => ({
      supplier: q.supplier,
      lines: q.lines.map((l) => ({
        code: l.code,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        tax_rate: l.taxRate,
        ...(l.discountPercent === undefined ? {} : { discount_percent: l.discountPercent }),
        ...(l.discountAmount === undefined ? {} : { discount_amount: l.discountAmount }),
      })),
      ...(q.options?.lineRounding ? { line_rounding: q.options.lineRounding } : {}),
      ...(q.options?.taxRounding ? { tax_rounding: q.options.taxRounding } : {}),
      ...(q.options?.documentDiscount === undefined
        ? {}
        : { document_discount: q.options.documentDiscount }),
    })),
  };
  const free: Record<string, unknown> = {};
  for (const key of ["number", "delivery", "notes", "language"] as const) {
    if (typeof args[key] === "string") {
      free[key] = args[key];
    }
  }
  return {
    order: {
      ...free,
      comparison,
      supplier: selection.supplier,
      selected_by: selection.selectedBy,
      ...(selection.reason ? { reason: selection.reason } : {}),
    },
  };
}
