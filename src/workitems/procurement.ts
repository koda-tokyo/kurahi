// Procurement comparison on a work item (相見積 → 発注). The case keeps the request lines and the
// supplier quotes as structured input, so every later step recomputes the comparison server-side
// instead of trusting a caller's numbers. A person then records which supplier they chose
// (workitems.selectSupplier); a routine may only draft an order from that record, and only while
// the quotes are still the ones the person chose from (src/quotes/supplier-selection.ts).

import type { Project } from "../projects/types.js";
import type { ComparisonItem, SupplierQuoteInput } from "../quotes/compare.js";
import type { PurchaseOrderSelection } from "../quotes/purchase-order.js";
import type { Actor, WorkItem } from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { QuoteError } from "../quotes/calculate.js";
import { COMPARISON_LIMITS } from "../quotes/compare.js";
import { readSupplierQuoteFile } from "../quotes/quotes-file.js";
import {
  assertSelectionCurrent,
  comparisonDigest,
  recordSupplierSelection,
} from "../quotes/supplier-selection.js";
import { canRead } from "./access.js";
import { WorkItemRefused } from "./errors.js";
import { assertNoFraudFlag } from "./flags.js";
import { applyTransition, type LifecycleOpts } from "./lifecycle.js";
import { loadWorkQueuePolicy } from "./policy.js";
import { TERMINAL_STATUSES } from "./types.js";

export const PROCUREMENT_MAX_ITEMS = COMPARISON_LIMITS.items;
export const PROCUREMENT_MAX_SUPPLIERS = COMPARISON_LIMITS.suppliers;
/** Serialized size cap of the stored request + quotes. */
export const PROCUREMENT_MAX_BYTES = 256 * 1024;

export type WorkItemProcurement = {
  request: ComparisonItem[];
  quotes: SupplierQuoteInput[];
  /** sha256 of the priced comparison when recorded. */
  comparisonDigest: string;
  /** Quotes read server-side from a supplier sheet under quotes/, with the sheet's sha256. */
  files?: ProcurementQuoteFile[];
  recordedBy: string;
  at: string;
};

export type ProcurementQuoteFile = { supplier: string; file: string; sha256: string };

export type WorkItemPurchaseOrderDraft = {
  document: string | null;
  comparisonDigest: string;
  supplier: string;
  /** Revision of the selection the draft was made from (each choice, even a repeat, has its own). */
  selectionRevision: number;
  /**
   * The chosen supplier's quote sheet when the draft was made (null: quotes entered by an agent),
   * kept so the draft never borrows a sheet recorded later. Absent on drafts from before it was
   * kept.
   */
  source?: DraftQuoteSource | null;
  draftedBy: string;
  runId: string;
  at: string;
};

export type DraftQuoteSource = { file: string; sha256: string };

/** The recorded quote sheet behind a supplier's quotes on this case, or null when typed. */
export function procurementSourceOf(item: WorkItem, supplier: string): DraftQuoteSource | null {
  const file = item.procurement?.files?.find((f) => f.supplier === supplier);
  return file ? { file: file.file, sha256: file.sha256 } : null;
}

export type ProcurementInput = { request?: unknown; quotes?: unknown };
export type SelectSupplierInput = { supplier?: unknown; reason?: unknown };

function refuseQuote<T>(code: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof QuoteError) {
      throw new WorkItemRefused(code, e.message);
    }
    throw e;
  }
}

function assertOpen(project: Pick<Project, "archived">, cur?: WorkItem): void {
  if (project.archived) {
    throw new Error("project is archived");
  }
  if (cur && TERMINAL_STATUSES.has(cur.status)) {
    throw new WorkItemRefused("terminal", `work item is already ${cur.status}`);
  }
}

/** Shape and size checks only; pricing rules are enforced by the comparison itself. */
function cleanProcurementInput(
  project: Project,
  input: ProcurementInput,
): {
  request: ComparisonItem[];
  quotes: SupplierQuoteInput[];
  files: ProcurementQuoteFile[];
} {
  const { request, quotes } = input;
  if (!Array.isArray(request) || request.length === 0 || request.length > PROCUREMENT_MAX_ITEMS) {
    throw new WorkItemRefused(
      "invalid_comparison",
      `request must list 1 to ${PROCUREMENT_MAX_ITEMS} items`,
    );
  }
  if (!Array.isArray(quotes) || quotes.length > PROCUREMENT_MAX_SUPPLIERS) {
    throw new WorkItemRefused(
      "invalid_comparison",
      `quotes must list at most ${PROCUREMENT_MAX_SUPPLIERS} suppliers`,
    );
  }
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!request.every(isObject) || !quotes.every(isObject)) {
    throw new WorkItemRefused("invalid_comparison", "request items and quotes must be objects");
  }
  // A quote may name the supplier's sheet under quotes/ instead of listing lines: the lines are
  // then read here, by the office tools' trust rule, so an agent recording the case cannot
  // retype a supplier's prices on the way in.
  const files: ProcurementQuoteFile[] = [];
  const read = (quotes as Record<string, unknown>[]).map((quote, q) => {
    if (quote.file === undefined) {
      return quote;
    }
    if (typeof quote.file !== "string" || typeof quote.supplier !== "string") {
      throw new WorkItemRefused(
        "invalid_comparison",
        `quote ${q + 1}: file and supplier must be strings`,
      );
    }
    if (quote.lines !== undefined) {
      throw new WorkItemRefused(
        "invalid_comparison",
        `quote ${q + 1}: give lines or file, not both`,
      );
    }
    const { file, ...rest } = quote;
    const sheet = refuseQuote("invalid_comparison", () => readSupplierQuoteFile(project, file));
    files.push({ supplier: quote.supplier, file, sha256: sheet.sha256 });
    return { ...rest, lines: sheet.lines };
  });
  // Stored as plain JSON (a round trip drops anything else), with a size cap.
  const json = JSON.stringify({ request, quotes: read });
  if (Buffer.byteLength(json, "utf8") > PROCUREMENT_MAX_BYTES) {
    throw new WorkItemRefused(
      "invalid_comparison",
      `request and quotes exceed ${PROCUREMENT_MAX_BYTES} bytes`,
    );
  }
  const stored = JSON.parse(json) as { request: ComparisonItem[]; quotes: SupplierQuoteInput[] };
  assertStoredShape(stored.request, stored.quotes);
  return { ...stored, files };
}

// Field types of the stored request and quotes, as published in WorkItemProcurementSchema
// (src/gateway/protocol/schema/workitems.ts). Pricing checks values, not every field's type, so
// without this a numeric description or unit would be stored and served as a malformed item.
// Text lengths are the office tools' (COMPARISON_LIMITS): po.prepare must accept any stored case.
type FieldType = "string" | "number" | "decimal" | "object";
const REQUEST_FIELDS: Record<string, [FieldType, boolean]> = {
  code: ["string", true],
  description: ["string", false],
  quantity: ["decimal", true],
};
const LINE_FIELDS: Record<string, [FieldType, boolean]> = {
  code: ["string", false],
  description: ["string", true],
  quantity: ["decimal", true],
  unit: ["string", false],
  unitPrice: ["decimal", true],
  taxRate: ["number", true],
  discountPercent: ["decimal", false],
  discountAmount: ["number", false],
};

const TEXT_LIMITS: Record<string, number> = {
  code: COMPARISON_LIMITS.code,
  description: COMPARISON_LIMITS.description,
  supplier: COMPARISON_LIMITS.supplier,
};

function hasType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "decimal":
      return typeof value === "string" || typeof value === "number";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return typeof value === type;
  }
}

function assertFields(
  value: Record<string, unknown>,
  fields: Record<string, [FieldType, boolean]>,
  where: string,
): void {
  for (const [name, [type, required]] of Object.entries(fields)) {
    if (value[name] === undefined ? required : !hasType(value[name], type)) {
      throw new WorkItemRefused(
        "invalid_comparison",
        `${where}: ${name} must be ${type === "decimal" ? "a number or decimal string" : `a ${type}`}`,
      );
    }
    const max = TEXT_LIMITS[name];
    if (max !== undefined && typeof value[name] === "string" && value[name].length > max) {
      throw new WorkItemRefused(
        "invalid_comparison",
        `${where}: ${name} must be at most ${max} characters`,
      );
    }
  }
}

function assertStoredShape(request: unknown[], quotes: unknown[]): void {
  request.forEach((item, i) =>
    assertFields(item as Record<string, unknown>, REQUEST_FIELDS, `request item ${i + 1}`),
  );
  quotes.forEach((raw, q) => {
    const quote = raw as Record<string, unknown>;
    assertFields(
      quote,
      { supplier: ["string", true], options: ["object", false] },
      `quote ${q + 1}`,
    );
    if (!Array.isArray(quote.lines) || quote.lines.length > PROCUREMENT_MAX_ITEMS) {
      throw new WorkItemRefused(
        "invalid_comparison",
        `quote ${q + 1}: lines must list at most ${PROCUREMENT_MAX_ITEMS} items`,
      );
    }
    quote.lines.forEach((line, l) => {
      if (!hasType(line, "object")) {
        throw new WorkItemRefused(
          "invalid_comparison",
          `quote ${q + 1} line ${l + 1} must be an object`,
        );
      }
      assertFields(line as Record<string, unknown>, LINE_FIELDS, `quote ${q + 1} line ${l + 1}`);
    });
  });
}

/**
 * Record (or replace) the request lines and supplier quotes on a case. Agents may do this (they
 * read the quotes); it never chooses a supplier. A choice made against earlier quotes stays on
 * the item for the audit trail, but no order can be drafted from it until a person chooses again.
 */
export function recordWorkItemProcurement(
  project: Project,
  id: string,
  input: ProcurementInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  assertOpen(project);
  const { request, quotes, files } = cleanProcurementInput(project, input);
  const digest = refuseQuote("invalid_comparison", () => comparisonDigest(request, quotes));
  const home = opts.home ?? resolveKoloHome();
  return applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      assertOpen(project, cur);
      if (!canRead(cur, actor, loadWorkQueuePolicy(project, home), now)) {
        throw new WorkItemRefused("not_authorised", "not allowed to update this work item");
      }
      const selectionStale =
        cur.supplierSelection !== undefined && cur.supplierSelection.comparisonDigest !== digest;
      cur.procurement = {
        request,
        quotes,
        comparisonDigest: digest,
        ...(files.length > 0 ? { files } : {}),
        recordedBy: actor.id,
        at: now.toISOString(),
      };
      return {
        next: cur,
        spec: {
          action: "procurement.record",
          actor,
          detail: {
            comparisonDigest: digest,
            items: request.length,
            suppliers: quotes.map((q) => q.supplier),
            ...(files.length > 0 ? { files } : {}),
            selectionStale,
          },
        },
      };
    },
    opts,
  );
}

/**
 * A PERSON records which supplier they chose from the case's recorded quotes. The selector is the
 * calling actor, never a value from the request; the comparison is recomputed from the stored
 * quotes. Choosing other than the lowest complete quote needs a written reason.
 */
export function selectWorkItemSupplier(
  project: Project,
  id: string,
  input: SelectSupplierInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  if (actor.kind !== "person") {
    throw new WorkItemRefused("not_a_person", "only a person may choose the supplier");
  }
  assertOpen(project);
  if (expectedRevision === undefined) {
    throw new WorkItemRefused(
      "revision_required",
      "choosing a supplier needs the revision of the item you looked at",
    );
  }
  if (typeof input.supplier !== "string" || !input.supplier.trim()) {
    throw new WorkItemRefused("invalid_selection", "name the supplier you chose");
  }
  const supplier = input.supplier;
  const reason = typeof input.reason === "string" ? input.reason : undefined;
  const home = opts.home ?? resolveKoloHome();
  return applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      assertOpen(project, cur);
      if (!canRead(cur, actor, loadWorkQueuePolicy(project, home), now)) {
        throw new WorkItemRefused("not_authorised", "not allowed to update this work item");
      }
      assertNoFraudFlag(cur, "choosing a supplier");
      if (!cur.procurement) {
        throw new WorkItemRefused(
          "no_quotes",
          "this case has no recorded quotes to choose a supplier from",
        );
      }
      const { request, quotes } = cur.procurement;
      const selection = refuseQuote("invalid_selection", () =>
        recordSupplierSelection(
          request,
          quotes,
          { supplier, selectedBy: actor.id, ...(reason !== undefined ? { reason } : {}) },
          { at: now, revision: cur.revision },
        ),
      );
      cur.supplierSelection = selection;
      return {
        next: cur,
        spec: {
          action: "supplier.select",
          actor,
          comment: selection.reason,
          detail: {
            supplier: selection.supplier,
            lowest: selection.lowest,
            deviatesFromLowest: selection.deviatesFromLowest,
            reason: selection.reason,
            comparisonDigest: selection.comparisonDigest,
          },
        },
      };
    },
    opts,
  );
}

/**
 * For a routine about to draft a purchase order from a case: the order input, only when a person
 * chose a supplier and the recorded quotes are still the ones they chose from.
 */
export function purchaseOrderSelectionFor(item: WorkItem): {
  request: ComparisonItem[];
  quotes: SupplierQuoteInput[];
  selection: PurchaseOrderSelection;
} {
  if (!item.procurement) {
    throw new WorkItemRefused("no_quotes", "this case has no recorded quotes");
  }
  assertNoFraudFlag(item, "drafting a purchase order");
  const { request, quotes } = item.procurement;
  const selection = refuseQuote("selection_not_current", () =>
    assertSelectionCurrent(item.supplierSelection, request, quotes),
  );
  return { request, quotes, selection };
}

/**
 * Whether a routine should draft a purchase order for this case now: open, no fraud flag, a
 * person's selection that is still current, and no draft yet from that selection.
 */
export function purchaseOrderDue(item: WorkItem): boolean {
  if (TERMINAL_STATUSES.has(item.status) || !item.procurement || !item.supplierSelection) {
    return false;
  }
  try {
    purchaseOrderSelectionFor(item);
  } catch {
    return false;
  }
  // The digest covers the request and quotes only, so a different supplier chosen from the same
  // quotes is a new choice that needs its own draft; so is the same supplier chosen again (a
  // corrected reason changes the order's text).
  const draft = item.purchaseOrderDraft;
  const selection = item.supplierSelection;
  return (
    draft?.comparisonDigest !== selection.comparisonDigest ||
    draft.supplier !== selection.supplier ||
    draft.selectionRevision !== selection.revision
  );
}

/**
 * Record on the case the purchase order a routine just drafted from its selection, so later runs
 * do not draft it again. Refuses when the selection changed under the draft (the draft was bound
 * to `comparisonDigest`, the chosen supplier and the selection's revision): the case then stays
 * due and a person's current choice gets its own.
 */
export function recordPurchaseOrderDraft(
  project: Project,
  id: string,
  input: {
    document: string | null;
    comparisonDigest: string;
    supplier: string;
    selectionRevision: number;
    /** The supplier's sheet as it was when the draft was made (procurementSourceOf). */
    source: DraftQuoteSource | null;
    runId: string;
  },
  actor: Actor,
  opts: LifecycleOpts = {},
): WorkItem {
  assertOpen(project);
  return applyTransition(
    project,
    id,
    undefined,
    (cur, now) => {
      assertOpen(project, cur);
      // A choice made against earlier quotes stays on the case for the audit trail, so the
      // recorded quotes must still be the ones the draft was bound to as well.
      const selection = cur.supplierSelection;
      if (
        !selection ||
        selection.comparisonDigest !== input.comparisonDigest ||
        selection.supplier !== input.supplier ||
        selection.revision !== input.selectionRevision ||
        cur.procurement?.comparisonDigest !== input.comparisonDigest
      ) {
        throw new WorkItemRefused(
          "selection_not_current",
          "the supplier choice changed while the purchase order was drafted",
        );
      }
      // Same prices can come from a different sheet (the digest covers the priced quotes only);
      // the draft then keeps no source rather than the wrong one, and a person re-records.
      const source = procurementSourceOf(cur, selection.supplier);
      if (source?.sha256 !== input.source?.sha256 || source?.file !== input.source?.file) {
        throw new WorkItemRefused(
          "selection_not_current",
          "the supplier's quote sheet changed while the purchase order was drafted",
        );
      }
      cur.purchaseOrderDraft = {
        document: input.document,
        comparisonDigest: input.comparisonDigest,
        supplier: selection.supplier,
        selectionRevision: selection.revision,
        source,
        draftedBy: actor.id,
        runId: input.runId.slice(0, 120),
        at: now.toISOString(),
      };
      return {
        next: cur,
        spec: {
          action: "po.draft",
          actor,
          detail: {
            supplier: selection.supplier,
            comparisonDigest: input.comparisonDigest,
            document: input.document,
          },
        },
      };
    },
    opts,
  );
}
