import { render } from "lit";
import { describe, it, expect, vi } from "vitest";
import type { ProcurementItem } from "../controllers/business-supplier";
import { emptyBusiness } from "../controllers/business";
import { setLocale } from "../i18n";
import { renderBusinessSupplier } from "./business-supplier";

describe("Supplier panel", () => {
  it("escapes quote content, opens only on click and validates deviation confirmation", () => {
    setLocale("en");
    const item = {
      id: "a",
      projectId: "p",
      revision: 3,
      status: "new",
      procurement: {
        request: [{ code: "A", quantity: 1 }],
        quotes: [10, 20].map((price, i) => ({
          supplier: `Supplier ${i}`,
          lines: [
            {
              code: "A",
              description: "<img src=x onerror=alert(1)>",
              quantity: 1,
              unitPrice: price,
              taxRate: 10,
            },
          ],
        })),
        comparisonDigest: "new",
        recordedBy: "agent",
        at: "now",
      },
      supplierSelection: {
        supplier: "Supplier 0",
        selectedBy: "alice",
        at: "earlier",
        comparisonDigest: "old",
      },
    } as ProcurementItem;
    const state = {
      business: emptyBusiness(),
      canDeclineAutonomy: true,
      beginBusinessSupplier: vi.fn(),
      editBusinessSupplier: vi.fn(),
      cancelBusinessSupplier: vi.fn(),
      submitBusinessSupplier: vi.fn(),
    };
    const container = document.createElement("div");
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Quotes changed");
    expect(state.submitBusinessSupplier).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[data-supplier="Supplier 1"]')!.click();
    expect(state.beginBusinessSupplier).toHaveBeenCalledWith("Supplier 1");
    state.business.supplierForm = {
      projectId: "p",
      id: "a",
      revision: 3,
      supplier: "Supplier 1",
      reason: "short",
    };
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    state.business.supplierForm.reason = "Delivery is guaranteed";
    render(renderBusinessSupplier(item, state, true), container);
    container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(state.submitBusinessSupplier).toHaveBeenCalledOnce();
    state.canDeclineAutonomy = false;
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    setLocale("ja");
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.textContent).toContain("仕入先の選定");
    setLocale("en");
  });
  it("shows which quotes were read from a supplier sheet and tolerates malformed sources", () => {
    setLocale("en");
    const item = {
      id: "a",
      projectId: "p",
      revision: 1,
      status: "new",
      procurement: {
        request: [{ code: "A", quantity: 1 }],
        quotes: ["Sheet Co", "Typed Co"].map((supplier) => ({
          supplier,
          lines: [{ code: "A", description: "Bolt", quantity: 1, unitPrice: 10, taxRate: 10 }],
        })),
        files: [{ supplier: "Sheet Co", file: "quotes/sheet-co.xlsx", sha256: "a".repeat(64) }],
        comparisonDigest: "d",
        recordedBy: "agent",
        at: "now",
      },
    } as ProcurementItem;
    const state = {
      business: emptyBusiness(),
      canDeclineAutonomy: true,
      beginBusinessSupplier: vi.fn(),
      editBusinessSupplier: vi.fn(),
      cancelBusinessSupplier: vi.fn(),
      submitBusinessSupplier: vi.fn(),
    };
    const container = document.createElement("div");
    render(renderBusinessSupplier(item, state, true), container);
    const sources = [...container.querySelectorAll("[data-quote-source]")].map(
      (n) => n.textContent,
    );
    expect(sources).toEqual([
      `Read from supplier sheet: quotes/sheet-co.xlsx · sha256 ${"a".repeat(12)}`,
      "Entered by the agent, not read from a supplier sheet",
    ]);
    item.procurement!.files = [
      null,
      { supplier: "Sheet Co", file: "quotes/sheet-co.xlsx", sha256: 7 },
    ] as unknown as NonNullable<ProcurementItem["procurement"]>["files"];
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.textContent).not.toContain("Read from supplier sheet");
    item.procurement!.files = "malformed" as unknown as NonNullable<
      ProcurementItem["procurement"]
    >["files"];
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.querySelectorAll("[data-quote-source]")).toHaveLength(2);
  });
  it("shows the recorded purchase order draft with the sheet it was made from", () => {
    setLocale("en");
    const item = {
      id: "a",
      projectId: "p",
      revision: 3,
      status: "new",
      procurement: {
        request: [{ code: "A", quantity: 1 }],
        quotes: [
          ["Sheet Co", 10],
          ["Other Co", 20],
        ].map(([supplier, unitPrice]) => ({
          supplier,
          lines: [{ code: "A", description: "Bolt", quantity: 1, unitPrice, taxRate: 10 }],
        })),
        files: [{ supplier: "Sheet Co", file: "quotes/sheet-co.xlsx", sha256: "b".repeat(64) }],
        comparisonDigest: "d",
        recordedBy: "agent",
        at: "now",
      },
      supplierSelection: {
        supplier: "Sheet Co",
        selectedBy: "Sato",
        reason: null,
        comparisonDigest: "d",
        lowest: ["Sheet Co"],
        deviatesFromLowest: false,
        at: "then",
        revision: 2,
      },
      purchaseOrderDraft: {
        document: "output/po-1.docx",
        comparisonDigest: "d",
        supplier: "Sheet Co",
        selectionRevision: 2,
        source: { file: "quotes/sheet-co.xlsx", sha256: "b".repeat(64) },
        draftedBy: "routine",
        runId: "r",
        at: "later",
      },
    } as ProcurementItem;
    const state = {
      business: emptyBusiness(),
      canDeclineAutonomy: true,
      beginBusinessSupplier: vi.fn(),
      editBusinessSupplier: vi.fn(),
      cancelBusinessSupplier: vi.fn(),
      submitBusinessSupplier: vi.fn(),
    };
    const container = document.createElement("div");
    const panel = () => {
      render(renderBusinessSupplier(item, state, true), container);
      return container.querySelector("[data-po-draft]")?.textContent ?? null;
    };
    expect(panel()).toBe(
      "Purchase order draft (not issued): Sheet Co · output/po-1.docx · later" +
        `Read from supplier sheet: quotes/sheet-co.xlsx · sha256 ${"b".repeat(12)}`,
    );
    item.purchaseOrderDraft!.document = null;
    expect(panel()).toContain("no draft file reported");
    const moved = () => container.querySelector("[data-draft-source-moved]");
    expect(moved()).toBeNull();
    // Same prices recorded from a later sheet: the draft keeps its own sheet and says it moved.
    item.procurement!.files = [
      { supplier: "Sheet Co", file: "quotes/sheet-co.xlsx", sha256: "c".repeat(64) },
    ];
    expect(panel()).toContain(`sha256 ${"b".repeat(12)}`);
    expect(panel()).not.toContain("c".repeat(12));
    expect(moved()).not.toBeNull();
    // A newer choice of the same supplier, or rerecorded quotes, leaves the draft behind: the
    // stale alert, still naming the draft's own sheet.
    item.supplierSelection!.revision = 4;
    expect(panel()).toContain(`sha256 ${"b".repeat(12)}`);
    expect(container.querySelector("[data-po-draft] [role=alert]")).not.toBeNull();
    expect(moved()).toBeNull();
    item.supplierSelection!.revision = 2;
    item.procurement!.comparisonDigest = "e";
    expect(container.querySelector("[data-po-draft] [role=alert]")).not.toBeNull();
    item.procurement!.comparisonDigest = "d";
    panel();
    expect(container.querySelector("[data-po-draft] [role=alert]")).toBeNull();
    // Drafts from typed quotes, from before the sheet was kept, or with a malformed hash.
    item.purchaseOrderDraft!.source = null;
    expect(panel()).toContain("Entered by the agent");
    delete item.purchaseOrderDraft!.source;
    expect(panel()).toContain("Quote source was not recorded for this draft");
    expect(panel()).not.toContain("Read from supplier sheet");
    item.purchaseOrderDraft!.source = { file: "quotes/x.xlsx", sha256: "zz" };
    expect(panel()).toContain("Quote source was not recorded for this draft");
    item.purchaseOrderDraft = { supplier: 7 } as unknown as ProcurementItem["purchaseOrderDraft"];
    expect(panel()).toBeNull();
  });
  it("renders malformed persisted comparisons unavailable without interactive controls", () => {
    const item = {
      procurement: { request: "malformed", quotes: [] },
    } as unknown as ProcurementItem;
    const state = {
      business: emptyBusiness(),
      canDeclineAutonomy: true,
      beginBusinessSupplier: vi.fn(),
      editBusinessSupplier: vi.fn(),
      cancelBusinessSupplier: vi.fn(),
      submitBusinessSupplier: vi.fn(),
    };
    const container = document.createElement("div");
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.textContent).toContain("cannot be compared");
    expect(container.querySelector("button")).toBeNull();
    item.procurement!.request = Array.from({ length: 201 }, (_, i) => ({
      code: String(i),
      quantity: 1,
    }));
    render(renderBusinessSupplier(item, state, true), container);
    expect(container.textContent).toContain("cannot be compared");
    expect(container.querySelector("button")).toBeNull();
  });
});
