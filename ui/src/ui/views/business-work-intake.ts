import { html, nothing } from "lit";
import type { BusinessState } from "../controllers/business";
import { workFormValid, type BusinessWorkForm } from "../controllers/business-work-intake";

type WorkIntakeViewState = {
  business: BusinessState;
  locale: string;
  editBusinessWork: (update: Partial<BusinessWorkForm>) => void;
  cancelBusinessWork: () => void;
  createBusinessWork: () => void | Promise<void>;
  acknowledgeBusinessWorkOutcome: () => void;
};
export function renderBusinessWorkIntake(state: WorkIntakeViewState, enabled = true) {
  const b = state.business;
  const form = b.workForm;
  const t = (en: string, ja: string) => (state.locale === "ja" ? ja : en);
  const queue =
    b.config && !b.config.error
      ? b.config.queues.find((q) => q.id === b.queue && q.id === form?.queue)
      : undefined;
  const locked =
    !enabled ||
    b.workPending ||
    b.workUncertain ||
    b.loading ||
    !!b.error ||
    b.decisionPending ||
    !!b.decisionForm ||
    b.expensePending ||
    !!b.expenseForm ||
    b.expenseUncertain;
  const valid = !!form && !!queue && queue.types.includes(form.type) && workFormValid(form);
  return html`
    ${b.workNotice ? html`<p class="business-decision__notice" role=${b.workUncertain ? "alert" : "status"}>${b.workNotice}</p>` : nothing}
    ${b.workUncertain ? html`<div class="business-intake-reconcile"><p>${t("Refresh and inspect the queue for this request. Only confirm after checking whether it was created; retrying can create a duplicate.", "キューを更新して、この依頼が作成されたか確認してください。確認せず再試行すると、重複する可能性があります。")}</p><button type="button" class="business-refresh" ?disabled=${!enabled || b.workPending || b.loading || !!b.error || !b.config || !!b.config.error} @click=${() => state.acknowledgeBusinessWorkOutcome()}>${t("I checked the creation outcome", "作成結果を確認しました")}</button></div>` : nothing}
    ${
      form
        ? html`<section class="business-work-intake business-intake business-decision" aria-labelledby="business-work-title">
      <h2 id="business-work-title">${t("New work item", "案件の新規作成")}</h2>
      <p class="business-muted" id="business-work-help">${t("Create a request for this queue. This saves the request; sending, approval, booking and payment are separate actions.", "このキューに依頼を登録します。送信、承認、予約、支払いは別の操作です。")}</p>
      <form class="business-intake__form" aria-describedby="business-work-help" @submit=${(
        event: Event,
      ) => {
        event.preventDefault();
        if (!locked && valid) {
          void state.createBusinessWork();
        }
      }}>
      <fieldset ?disabled=${locked}><legend class="sr-only">${t("Request details", "依頼内容")}</legend><div class="business-intake__fields">
        <label>${t("Queue", "キュー")}<input name="queue" readonly .value=${queue?.name[state.locale === "ja" ? "ja" : "en"] ?? form.queue}></label>
        <label>${t("Type", "種別")}<select name="type" .value=${form.type} @change=${(event: Event) => state.editBusinessWork({ type: (event.currentTarget as HTMLSelectElement).value as BusinessWorkForm["type"] })}>${queue?.types.map((type) => html`<option value=${type} ?selected=${type === form.type}>${type}</option>`)}</select></label>
        <label>${t("Requested for", "依頼対象")}<input name="requester" required maxlength="200" .value=${form.requester} @input=${(event: Event) => state.editBusinessWork({ requester: (event.currentTarget as HTMLInputElement).value })}></label>
        <label>${t("Title", "件名")}<input name="title" required maxlength="500" .value=${form.title} @input=${(event: Event) => state.editBusinessWork({ title: (event.currentTarget as HTMLInputElement).value })}></label>
        <label class="business-intake__wide">${t("Description", "内容")}<textarea name="description" required maxlength="2000" rows="4" .value=${form.description} @input=${(event: Event) => state.editBusinessWork({ description: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
      <label class="business-intake__wide">${t("Existing Project file references (optional)", "既存のプロジェクトファイル参照（任意）")}<textarea name="documents" rows="3" aria-describedby="business-work-documents-help" .value=${form.documents ?? ""} @input=${(event: Event) => state.editBusinessWork({ documents: (event.currentTarget as HTMLTextAreaElement).value })}></textarea><small id="business-work-documents-help">${t("One existing relative file path per line, up to 50 (for example, requests/brief.pdf). This links Project files; it does not upload them. Document reviews may require attachments.", "既存ファイルの相対パスを1行に1件、最大50件入力してください（例：requests/brief.pdf）。プロジェクト内のファイルを参照する欄で、アップロードは行いません。文書確認には添付資料が必要な場合があります。")}</small></label>
      </div></fieldset>
      ${!valid ? html`<p class="business-muted">${t("Enter the requester, title and description and choose a configured type.", "依頼対象、件名、内容を入力し、設定済みの種別を選択してください。")}</p>` : nothing}
      <div class="business-decision__actions"><button type="button" class="business-decision__secondary" ?disabled=${b.workPending} @click=${() => state.cancelBusinessWork()}>${t("Cancel", "キャンセル")}</button><button type="submit" class="business-decision__primary" ?disabled=${locked || !valid}>${b.workPending ? t("Creating…", "作成中…") : t("Confirm and create request", "確認して依頼を作成")}</button></div>
      </form></section>`
        : nothing
    }
  `;
}
