import type { WorkItem } from "../../../../packages/client/src/workitems";
import { compareSupplierQuotes, type SupplierQuoteInput } from "../../../../src/quotes/compare";
import { t } from "../i18n";
import { canDeclineAutonomy } from "./autopilot";
import { canDecide, inFlightDecisions, loadBusiness, type BusinessHost } from "./business";

export type ProcurementItem = WorkItem;
export type SupplierForm = {
  projectId: string;
  id: string;
  revision: number;
  supplier: string;
  reason: string;
};
export function supplierComparison(item: ProcurementItem) {
  try {
    const p = item.procurement;
    if (
      !p ||
      !Array.isArray(p.request) ||
      !Array.isArray(p.quotes) ||
      p.request.length < 1 ||
      p.request.length > 200 ||
      p.quotes.length < 2 ||
      p.quotes.length > 20 ||
      !p.request.every(
        (r) => r && (r.description === undefined || typeof r.description === "string"),
      ) ||
      !p.quotes.every(
        (q) =>
          q &&
          Array.isArray(q.lines) &&
          q.lines.length <= 200 &&
          q.lines.every(
            (l) =>
              l &&
              typeof l.description === "string" &&
              (l.unit === undefined || typeof l.unit === "string"),
          ),
      )
    ) {
      return null;
    }
    return item.procurement
      ? compareSupplierQuotes(
          item.procurement.request,
          item.procurement.quotes as SupplierQuoteInput[],
        )
      : null;
  } catch {
    return null;
  }
}
function allowed(host: BusinessHost) {
  return (
    canDecide(host) &&
    canDeclineAutonomy(host) &&
    !host.business.error &&
    !host.business.decisionForm &&
    !host.business.reportForm &&
    host.business.item?.status !== "done" &&
    host.business.item?.status !== "cancelled" &&
    !host.projects.projects?.find((p) => p.id === host.business.projectId)?.archived
  );
}
export function beginSupplier(host: BusinessHost, supplier: string) {
  if (!allowed(host)) {
    return;
  }
  const item = host.business.item!;
  if (!supplierComparison(item)?.suppliers.some((s) => s.supplier === supplier && s.complete)) {
    return;
  }
  host.business = {
    ...host.business,
    supplierNotice: null,
    supplierForm: {
      projectId: item.projectId,
      id: item.id,
      revision: item.revision,
      supplier,
      reason: "",
    },
  };
}
export function editSupplier(host: BusinessHost, reason: string) {
  const form = host.business.supplierForm;
  if (!form || host.business.decisionPending) {
    return;
  }
  host.business = { ...host.business, supplierForm: { ...form, reason } };
}
export function cancelSupplier(host: BusinessHost) {
  if (!host.business.decisionPending) {
    host.business = { ...host.business, supplierForm: null };
  }
}
/** Explicit confirmation only; refreshes and refusals never replay a selection. */
export async function submitSupplier(host: BusinessHost) {
  const form = host.business.supplierForm;
  const client = host.client;
  if (!form || !client || !allowed(host)) {
    return;
  }
  const item = host.business.item!;
  if (form.projectId !== item.projectId || form.id !== item.id || form.revision !== item.revision) {
    host.business = {
      ...host.business,
      supplierForm: null,
      supplierNotice: t("business.supplier.changed"),
    };
    return;
  }
  const comparison = supplierComparison(item);
  const reason = form.reason.trim();
  if (
    !comparison?.suppliers.some((s) => s.supplier === form.supplier && s.complete) ||
    reason.length > 500 ||
    (!comparison.lowest.includes(form.supplier) && reason.length < 10)
  ) {
    return;
  }
  const current = () =>
    host.client === client &&
    host.connected &&
    host.tab === "projects" &&
    host.projects.view === "business" &&
    host.projects.selectedId === form.projectId &&
    host.business.projectId === form.projectId &&
    host.business.selectedId === form.id &&
    host.business.supplierForm === form;
  inFlightDecisions.add(host);
  host.business = { ...host.business, decisionPending: true, supplierNotice: null };
  try {
    let notice: string;
    try {
      const result = await client.request<{ item: WorkItem }>("workitems.selectSupplier", {
        projectId: form.projectId,
        id: form.id,
        expectedRevision: form.revision,
        supplier: form.supplier,
        ...(reason ? { reason } : {}),
      });
      if (result.item.id !== form.id || result.item.projectId !== form.projectId) {
        throw new Error("Scope mismatch");
      }
      notice = t("business.supplier.saved");
    } catch {
      notice = t("business.supplier.refused");
    }
    if (!current()) {
      return;
    }
    host.business = { ...host.business, supplierForm: null, supplierNotice: notice };
    await loadBusiness(host, false, true);
  } finally {
    inFlightDecisions.delete(host);
    host.business = { ...host.business, decisionPending: false };
  }
}
