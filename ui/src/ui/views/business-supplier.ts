import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { AppViewState } from "../app-view-state";
import { supplierComparison, type ProcurementItem } from "../controllers/business-supplier";
import { t } from "../i18n";

type State = Pick<
  AppViewState,
  | "business"
  | "canDeclineAutonomy"
  | "beginBusinessSupplier"
  | "editBusinessSupplier"
  | "cancelBusinessSupplier"
  | "submitBusinessSupplier"
>;
export function renderBusinessSupplier(item: ProcurementItem, state: State, enabled: boolean) {
  const procurement = item.procurement;
  if (!procurement) {
    return nothing;
  }
  const comparison = supplierComparison(item);
  if (!comparison) {
    return html`<section class="business-section" data-business-supplier><h3>${t("business.supplier.title")}</h3><p role="alert">${t("business.supplier.unavailable")}</p></section>`;
  }
  const form = state.business.supplierForm;
  const matching =
    form?.projectId === item.projectId && form.id === item.id && form.revision === item.revision
      ? form
      : null;
  const disabled =
    !enabled ||
    !state.canDeclineAutonomy ||
    !!state.business.error ||
    !!state.business.decisionForm ||
    !!state.business.reportForm ||
    item.status === "done" ||
    item.status === "cancelled";
  const selection = item.supplierSelection;
  const stale = selection && selection.comparisonDigest !== procurement.comparisonDigest;
  const sources = Array.isArray(procurement.files) ? procurement.files : [];
  const sourceOf = (supplier: string) => {
    const file = sources.find((f) => f && f.supplier === supplier);
    return file && typeof file.file === "string" && typeof file.sha256 === "string"
      ? html`<p class="business-muted" data-quote-source>${t("business.supplier.source")}: ${file.file} · sha256 ${file.sha256.slice(0, 12)}</p>`
      : html`<p class="business-muted" data-quote-source>${t("business.supplier.sourceTyped")}</p>`;
  };
  const draft = item.purchaseOrderDraft;
  const shownDraft =
    draft && typeof draft.supplier === "string" && typeof draft.at === "string" ? draft : null;
  const draftCurrent =
    !!shownDraft &&
    !!selection &&
    shownDraft.supplier === selection.supplier &&
    shownDraft.selectionRevision === selection.revision &&
    shownDraft.comparisonDigest === selection.comparisonDigest &&
    shownDraft.comparisonDigest === procurement.comparisonDigest;
  // The draft names the sheet it was made from, never the one recorded now (same prices can come
  // from a later sheet); drafts from before the sheet was kept say so.
  const draftSource = (draft: NonNullable<typeof shownDraft>) => {
    const frozen = draft.source;
    if (frozen === null) {
      return html`<p class="business-muted" data-draft-source>${t("business.supplier.sourceTyped")}</p>`;
    }
    if (
      !frozen ||
      typeof frozen.file !== "string" ||
      !/^[0-9a-f]{64}$/.test(String(frozen.sha256))
    ) {
      return html`<p class="business-muted" data-draft-source>${t("business.supplier.poSourceUnknown")}</p>`;
    }
    const now = sources.find((f) => f && f.supplier === draft.supplier);
    const moved = draftCurrent && (now?.sha256 !== frozen.sha256 || now?.file !== frozen.file);
    return html`<p class="business-muted" data-draft-source>${t("business.supplier.source")}: ${frozen.file} · sha256 ${frozen.sha256.slice(0, 12)}</p>${moved ? html`<p role="note" data-draft-source-moved>${t("business.supplier.poSourceMoved")}</p>` : nothing}`;
  };
  const valid =
    matching &&
    comparison?.suppliers.some((s) => s.supplier === matching.supplier && s.complete) &&
    matching.reason.trim().length <= 500 &&
    (comparison.lowest.includes(matching.supplier) || matching.reason.trim().length >= 10);
  return html`<section class="business-section" data-business-supplier>
    <h3>${t("business.supplier.title")}</h3>
    <p class="business-muted">${t("business.supplier.scope")}</p>
    <h4>${t("business.supplier.request")}</h4>
    <ul>${procurement.request.map((line) => html`<li>${line.code} · ${line.description ?? ""} · ${line.quantity}</li>`)}</ul>
    ${
      comparison
        ? html`<ul class="business-docs">${comparison.suppliers.map(
            (s) => html`<li>
      <strong>${s.supplier}</strong><span>${t("business.supplier.net")}: ${s.totals.net} JPY · ${s.complete ? (comparison.lowest.includes(s.supplier) ? t("business.supplier.lowest") : t("business.supplier.complete")) : t("business.supplier.incomplete")}</span>
      <button type="button" class="business-refresh" data-supplier=${s.supplier} ?disabled=${disabled || !!form || !s.complete} @click=${() => state.beginBusinessSupplier(s.supplier)}>${t("business.supplier.choose")}</button>
    </li>`,
          )}</ul>`
        : html`<p role="alert">${t("business.supplier.unavailable")}</p>`
    }
    <details><summary>${t("business.supplier.quotes")}</summary>${procurement.quotes.map((q) => html`<h4>${q.supplier}</h4>${sourceOf(q.supplier)}<ul class="business-docs">${q.lines.map((line) => html`<li><span>${line.code} · ${line.description}</span><span>${t("business.supplier.quantity")}: ${line.quantity} ${line.unit ?? ""} · ${t("business.supplier.unitPrice")}: ${line.unitPrice} JPY · ${t("business.supplier.tax")}: ${line.taxRate}%</span>${line.discountPercent !== undefined || line.discountAmount !== undefined ? html`<span>${t("business.supplier.discount")}: ${line.discountPercent ?? 0}% + ${line.discountAmount ?? 0} JPY</span>` : nothing}</li>`)}</ul>${q.options?.documentDiscount !== undefined ? html`<p>${t("business.supplier.discount")}: ${q.options.documentDiscount} JPY</p>` : nothing}`)}</details>
    ${selection ? html`<p>${t("business.supplier.recorded")}: ${selection.supplier} · ${selection.selectedBy} · ${selection.at}</p>${selection.reason ? html`<p>${selection.reason}</p>` : nothing}${stale ? html`<p role="alert">${t("business.supplier.stale")}</p>` : nothing}` : nothing}
    ${shownDraft ? html`<div data-po-draft><p>${t("business.supplier.poDraft")}: ${shownDraft.supplier} · ${typeof shownDraft.document === "string" ? shownDraft.document : t("business.supplier.poNoFile")} · ${shownDraft.at}</p>${draftSource(shownDraft)}${draftCurrent ? nothing : html`<p role="alert">${t("business.supplier.poStale")}</p>`}</div>` : nothing}
    ${state.business.supplierNotice ? html`<p role="status">${state.business.supplierNotice}</p>` : nothing}
    ${
      matching
        ? html`<form @submit=${(event: Event) => {
            event.preventDefault();
            if (!disabled && valid) {
              void state.submitBusinessSupplier();
            }
          }}>
      <p>${matching.supplier} · ${t("business.revision")} ${matching.revision}</p>
      <label>${t("business.supplier.reason")}<textarea rows="3" maxlength="500" .value=${live(matching.reason)} ?disabled=${disabled} @input=${(event: Event) => state.editBusinessSupplier((event.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
      <p class="business-muted">${t("business.supplier.reasonHelp")}</p>
      <button type="button" class="business-refresh" ?disabled=${state.business.decisionPending} @click=${() => state.cancelBusinessSupplier()}>${t("business.decision.back")}</button>
      <button type="submit" class="business-refresh" ?disabled=${disabled || !valid}>${t("business.supplier.confirm")}</button>
    </form>`
        : nothing
    }
  </section>`;
}
