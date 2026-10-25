import { html, nothing } from "lit";
import type { WorkitemsListResult } from "../../../../packages/client/src/generated/types.js";
import type { WorkItemSummary, WorkQueueDef } from "../../../../packages/client/src/workitems.js";
import {
  BUSINESS_DEPARTMENTS,
  SME_DEPARTMENT_GROUPS,
  getBusinessDepartment,
  type BusinessDepartment,
} from "../business-departments";

type NavigationProps = {
  locale: string;
  departments?: readonly string[];
  mode: "enterprise" | "sme";
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onModeChange: (mode: "enterprise" | "sme") => void;
};
type WorkspaceProps = {
  disabled?: boolean;
  locale: string;
  department: BusinessDepartment;
  queues: WorkQueueDef[];
  selectedQueue: string;
  list: WorkitemsListResult | null;
  loading: boolean;
  unavailable: boolean;
  onQueueSelect: (id: string) => void;
  onItemSelect: (id: string) => void;
};
const language = (locale: string) => (locale?.startsWith("ja") ? "ja" : "en");
const words = (locale: string, en: string, ja: string) => (language(locale) === "ja" ? ja : en);
const statusNames: Record<string, [string, string]> = {
  new: ["New", "新規"],
  drafting: ["Preparing", "準備中"],
  awaiting_review: ["Awaiting review", "レビュー待ち"],
  approved: ["Approved", "承認済み"],
  sent_back: ["Returned", "差戻し"],
  done: ["Completed", "完了"],
  cancelled: ["Cancelled", "取消済み"],
};
function status(locale: string, value: string) {
  const names = statusNames[value];
  return names ? words(locale, ...names) : value;
}

function financeException(item: WorkItemSummary, locale: string) {
  const hold = item.checks.some(
    (check) =>
      check.policyId === "finance.bank-change-verification" &&
      check.blocking &&
      check.result !== "pass",
  );
  return hold
    ? html`<strong role="status">${words(locale, "Needs verification", "要確認")}</strong>
    <p>${words(locale, "Possible payment fraud. Payment on hold pending independent phone verification using the supplier contact already on file.", "支払詐欺の疑い。登録済みの取引先連絡先への電話で担当者が確認するまで支払保留。")}</p>`
    : nothing;
}

export function renderDepartmentNavigation(props: NavigationProps) {
  const lang = language(props.locale);
  const departments = BUSINESS_DEPARTMENTS.filter(
    (department) => !props.departments || props.departments.includes(department.id),
  );
  const button = (
    id: string,
    name: string,
  ) => html`<button type="button" class="business-departments__nav-button"
    data-department=${id} aria-pressed=${props.selected === id} ?disabled=${props.disabled}
    @click=${() => props.onSelect(id)}>${name}</button>`;
  return html`<nav class="business-departments" aria-label=${words(props.locale, "Departments", "部門")}>
    <div class="business-departments__heading"><h2>${words(props.locale, "Departments", "部門")}</h2>
      <div class="business-departments__modes" role="group" aria-label=${words(props.locale, "Organisation view", "組織表示")}>
        ${(["enterprise", "sme"] as const).map(
          (mode) => html`<button type="button" data-department-mode=${mode}
          aria-pressed=${props.mode === mode} ?disabled=${props.disabled} @click=${() => props.onModeChange(mode)}>
          ${mode === "enterprise" ? words(props.locale, "Enterprise", "企業") : words(props.locale, "SME", "中小企業")}</button>`,
        )}
      </div>
    </div>
    ${button("all", words(props.locale, "All queues", "すべてのキュー"))}
    ${button("unmapped", words(props.locale, "Unmapped queues", "部門未設定"))}
    <div class="business-departments__navigation">
      ${
        props.mode === "enterprise"
          ? departments.map((department) => button(department.id, department.name[lang]))
          : SME_DEPARTMENT_GROUPS.filter((group) =>
              group.departments.some((id) =>
                departments.some((department) => department.id === id),
              ),
            ).map(
              (
                group,
              ) => html`<section class="business-departments__group" aria-label=${group.name[lang]}>
          <h3>${group.name[lang]}</h3>${group.departments.map((id) => {
            const department = getBusinessDepartment(id);
            return department && departments.includes(department)
              ? button(id, department.name[lang])
              : nothing;
          })}</section>`,
            )
      }
    </div>
  </nav>`;
}

const viewTitles: Record<string, [string, string]> = {
  secretariat: ["Agenda & follow-ups", "予定・フォローアップ"],
  finance: ["Financial reviews", "会計レビュー"],
  admin: ["Office requests", "総務依頼"],
  hr: ["People cases", "人事案件"],
  planning: ["Initiatives & milestones", "施策・マイルストーン"],
  it: ["Service requests", "ITサービス依頼"],
  procurement: ["Purchase reviews", "購買レビュー"],
  sales: ["Sales follow-ups", "営業フォローアップ"],
  marketing: ["Campaign work", "キャンペーン業務"],
  service: ["Customer cases", "顧客対応案件"],
  operations: ["Delivery work", "業務遂行"],
  legal: ["Agreement reviews", "契約レビュー"],
  product: ["Development work", "開発業務"],
  facilities: ["Maintenance requests", "保守依頼"],
  quality: ["Corrective actions", "是正措置"],
};

function recordMeta(item: WorkItemSummary, props: WorkspaceProps) {
  const w = (en: string, ja: string) => words(props.locale, en, ja);
  const due = item.dueAt ?? w("No due date", "期限なし");
  const owner = item.assignee?.id ?? w("Unassigned", "担当未設定");
  const id = props.department.id;
  if (id === "secretariat" || id === "marketing") {
    return html`<span class="business-departments__date">${w("Due", "期限")}: ${due}</span><span>${owner}</span>`;
  }
  if (id === "hr" || id === "quality" || id === "legal") {
    return html`<span>${w("Checks passed", "検証合格")}: ${item.checks.filter((check) => check.result === "pass").length} / ${item.checks.length}</span>
      <span>${w("Approvals recorded", "承認記録")}: ${item.approvals.length} / ${item.requiredApprovals}</span><span>${owner}</span>`;
  }
  if (id === "planning" || id === "product" || id === "operations") {
    return html`<span>${w("Due", "期限")}: ${due}</span><span>${w("Owner", "担当")}: ${owner}</span>`;
  }
  const priority = {
    low: w("Low", "低"),
    normal: w("Normal", "通常"),
    high: w("High", "高"),
    urgent: w("Urgent", "緊急"),
  }[item.priority];
  return html`<span>${w("Priority", "優先度")}: ${priority}</span><span>${w("Due", "期限")}: ${due}</span><span>${owner}</span>`;
}

function records(props: WorkspaceProps) {
  const w = (en: string, ja: string) => words(props.locale, en, ja);
  const items = props.list?.items ?? [];
  if (props.department.id === "finance" || props.department.id === "procurement") {
    return html`<div class="business-departments__table-wrap"><table class="business-departments__table">
      <caption>${props.selectedQueue ? w("Records in the selected queue", "選択したキューの記録") : w("Records across department queues", "部門内のすべてのキューの記録")}</caption>
      <thead><tr><th scope="col">${w("Record", "記録")}</th><th scope="col">${w("Status", "状態")}</th><th scope="col">${w("Due", "期限")}</th><th scope="col">${w("Documents", "文書")}</th></tr></thead>
      <tbody>${items.map(
        (
          item,
        ) => html`<tr><td><button type="button" data-department-item=${item.id} ?disabled=${props.disabled || props.unavailable} @click=${() => props.onItemSelect(item.id)}>${item.title}</button></td>
        <td>${status(props.locale, item.status)}${props.department.id === "finance" ? financeException(item, props.locale) : nothing}</td><td>${item.dueAt ?? w("No due date", "期限なし")}</td><td>${item.source.documents}</td></tr>`,
      )}</tbody>
    </table></div>`;
  }
  const layout = ["secretariat", "marketing"].includes(props.department.id)
    ? "agenda"
    : ["planning", "product", "operations"].includes(props.department.id)
      ? "milestones"
      : ["hr", "quality", "legal"].includes(props.department.id)
        ? "checklist"
        : "requests";
  return html`<ul class="business-departments__records business-departments__records--${layout}">
    ${items.map(
      (
        item,
      ) => html`<li><button type="button" class="business-departments__record" data-department-item=${item.id} ?disabled=${props.disabled || props.unavailable}
      @click=${() => props.onItemSelect(item.id)}><span class="business-departments__record-heading"><strong>${item.title}</strong>
      <span class="business-departments__status">${status(props.locale, item.status)}</span></span>
      <span class="business-departments__record-meta">${recordMeta(item, props)}</span></button></li>`,
    )}
  </ul>`;
}

export function renderDepartmentWorkspace(props: WorkspaceProps) {
  const lang = language(props.locale);
  const w = (en: string, ja: string) => words(props.locale, en, ja);
  const configured = props.queues.length > 0;
  const selected = props.queues.find((queue) => queue.id === props.selectedQueue);
  const title = viewTitles[props.department.id];
  return html`<section class="business-departments business-departments__workspace" aria-labelledby="business-department-title" aria-busy=${props.loading}>
    <header><p class="business-departments__eyebrow">${w("Department workspace", "部門ワークスペース")}</p>
      <h2 id="business-department-title">${props.department.name[lang]}</h2><p>${props.department.description[lang]}</p></header>
    <details class="business-departments__guidance"><summary>${w("Typical workflows", "主な業務")}</summary>
      <ul>${props.department.workflows[lang].map((workflow) => html`<li>${workflow}</li>`)}</ul>
      <p>${w("Workflow guidance. Available work depends on the queues configured for this project.", "業務の参考情報です。利用できる業務は、このプロジェクトのキュー設定によって異なります。")}</p>
    </details>
    ${
      props.unavailable
        ? html`<p role="status">${w("Department data is unavailable. Connect and refresh to view current work.", "部門データを取得できません。接続して更新してください。")}</p>`
        : !configured
          ? html`<div class="business-departments__empty"><h3>${w("No queues configured", "キュー未設定")}</h3>
        <p>${w("Map a project queue to this department to see its work here. This workspace is read-only until a queue is configured.", "この部門にプロジェクトのキューを割り当てると、業務が表示されます。キュー設定までは閲覧のみです。")}</p></div>`
          : html`<div class="business-departments__queues" role="group" aria-label=${w("Department queues", "部門キュー")}>
        <button type="button" data-department-queue="" aria-pressed=${props.selectedQueue === ""}
          ?disabled=${props.loading || props.disabled || props.unavailable} @click=${() => props.onQueueSelect("")}>${w("All department queues", "部門内のすべてのキュー")}</button>
        ${props.queues.map(
          (
            queue,
          ) => html`<button type="button" data-department-queue=${queue.id} aria-pressed=${props.selectedQueue === queue.id}
          ?disabled=${props.loading || props.disabled || props.unavailable} @click=${() => props.onQueueSelect(queue.id)}>${queue.name[lang] ?? queue.name.en ?? queue.id}</button>`,
        )}</div>
        <h3>${title ? w(...title) : props.department.name[lang]}</h3>
        ${
          props.loading
            ? html`<p role="status">${w("Loading queue…", "キューを読み込み中…")}</p>`
            : props.selectedQueue && !selected
              ? html`<p>${w("Select a queue to view its work.", "キューを選択すると業務が表示されます。")}</p>`
              : !props.list
                ? html`<p>${w("No queue data loaded. Refresh to try again.", "キューデータ未取得です。更新して再試行してください。")}</p>`
                : html`<p class="business-departments__scope">${selected ? `${w("Selected queue", "選択したキュー")}: ${selected.name[lang] ?? selected.name.en ?? selected.id}` : w("All department queues", "部門内のすべてのキュー")}
                · ${props.list.items.length} ${w("loaded", "件取得済み")} / ${props.list.total} ${w("total", "件合計")}</p>
                ${props.list.items.length ? records(props) : html`<p class="business-departments__empty">${props.selectedQueue ? w("No work items in this queue.", "このキューに業務はありません。") : w("No work items in this department.", "この部門に業務はありません。")}</p>`}`
        }`
    }
  </section>`;
}
