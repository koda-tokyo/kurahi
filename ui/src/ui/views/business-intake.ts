import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state";
import type { ExpenseForm } from "../controllers/business-intake";
import { expenseFormValid } from "../controllers/business-intake";
import { t, type MessageId } from "../i18n";

type IntakeViewState = Pick<
  AppViewState,
  | "business"
  | "locale"
  | "editBusinessExpense"
  | "cancelBusinessExpense"
  | "createBusinessExpense"
  | "acknowledgeExpenseOutcome"
>;
const label = (key: string) => t(`business.intake.${key}` as MessageId);

export function renderBusinessIntake(state: IntakeViewState, enabled: boolean) {
  const business = state.business;
  const form = business.expenseForm;
  const target = form?.target;
  const stale =
    !!target &&
    (business.item?.id !== target.id ||
      business.selectedId !== target.id ||
      business.item?.revision !== target.revision ||
      !["new", "sent_back"].includes(business.item?.status ?? ""));
  const locked = !enabled || stale || business.expensePending || business.expenseUncertain;
  const valid =
    !!form &&
    (target?.action === "submit" || expenseFormValid(target ? { ...form, documents: "" } : form));
  const heading =
    target?.action === "edit"
      ? "editHeading"
      : target?.action === "submit"
        ? "submitHeading"
        : "heading";
  const queues = business.config?.queues.filter((queue) => queue.types.includes("expense")) ?? [];
  const input = (key: Exclude<keyof ExpenseForm, "target">, type = "text", max = 200) => html`
    <label>${label(key)}
      <input name=${key} type=${type} required maxlength=${max}
        step=${type === "number" ? "any" : nothing}
        .value=${form?.[key] ?? ""} @input=${(event: Event) => state.editBusinessExpense({ [key]: (event.currentTarget as HTMLInputElement).value })}>
    </label>`;
  return html`
    ${business.expenseNotice ? html`<p class="business-decision__notice" role=${business.expenseUncertain ? "alert" : "status"}>${business.expenseNotice}</p>` : nothing}
    ${
      business.expenseUncertain
        ? html`<div class="business-intake-reconcile">
      <p>${label("reconcileHelp")}</p>
      <button type="button" class="business-refresh" ?disabled=${!enabled || business.expensePending} @click=${() => state.acknowledgeExpenseOutcome()}>${label("reconcile")}</button>
    </div>`
        : nothing
    }
    ${
      form
        ? html`<section class="business-intake business-decision" aria-labelledby="business-intake-title">
      <h2 id="business-intake-title">${label(heading)}</h2>
      <p class="business-muted">${label(target?.action === "submit" ? "submitHelp" : target ? "editHelp" : "help")}</p>
      <form class="business-intake__form" @submit=${(event: Event) => {
        event.preventDefault();
        if (!locked && valid && queues.some((queue) => queue.id === form.queue)) {
          void state.createBusinessExpense();
        }
      }}>
        ${target ? html`<p>${t("business.intake.confirmRevision" as MessageId, { revision: target.revision })}</p>` : nothing}
        ${stale ? html`<p role="alert">${label("changed")}</p>` : nothing}
        <fieldset ?disabled=${locked || target?.action === "submit"}>
          <legend class="sr-only">${label(heading)}</legend>
          <div class="business-intake__fields">
            <label>${t("business.queue")}
              <select ?disabled=${!!target} name="queue" .value=${form.queue} @change=${(event: Event) => state.editBusinessExpense({ queue: (event.currentTarget as HTMLSelectElement).value })}>
                ${queues.map((queue) => html`<option value=${queue.id} ?selected=${queue.id === form.queue}>${queue.name[state.locale === "ja" ? "ja" : "en"] ?? queue.name.en ?? queue.name.ja ?? queue.id}</option>`)}
              </select>
            </label>
            ${input("title", "text", 500)}
            ${input("employeeId")}
            ${input("amount", "number")}
            ${input("expenseDate", "date")}
            ${input("category")}
            <label class="business-intake__wide">${label("purpose")}
              <textarea name="purpose" rows="3" required maxlength="2000" .value=${form.purpose} @input=${(event: Event) => state.editBusinessExpense({ purpose: (event.currentTarget as HTMLTextAreaElement).value })}></textarea>
            </label>
            <label class="business-intake__wide">${label("documents")}
              <textarea ?disabled=${!!target} name="documents" rows="3" aria-describedby="business-intake-documents-help" .value=${form.documents} @input=${(event: Event) => state.editBusinessExpense({ documents: (event.currentTarget as HTMLTextAreaElement).value })}></textarea>
              <small id="business-intake-documents-help">${label("documentsHelp")}</small>
            </label>
          </div>
        </fieldset>
        ${!valid ? html`<p class="business-muted">${label("validation")}</p>` : nothing}
        <div class="business-decision__actions">
          <button type="button" class="business-decision__secondary" ?disabled=${business.expensePending} @click=${() => state.cancelBusinessExpense()}>${label("close")}</button>
          <button type="submit" class="business-decision__primary" ?disabled=${locked || !valid || !queues.some((queue) => queue.id === form.queue)}>${label(business.expensePending ? "saving" : target?.action === "submit" ? "submit" : "save")}</button>
        </div>
      </form>
    </section>`
        : nothing
    }
  `;
}
