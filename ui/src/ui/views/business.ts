import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { WorkItem, WorkItemSummary } from "../../../../packages/client/src/workitems.js";
import type { AppViewState } from "../app-view-state";
import type { BusinessState } from "../controllers/business";
import type { Project } from "../controllers/projects";
import { getBusinessDepartment } from "../business-departments";
import { t, type MessageId } from "../i18n";
import { renderBusinessChatEntry, type BusinessChatEntryState } from "./business-chat-entry";
import { renderDepartmentNavigation, renderDepartmentWorkspace } from "./business-departments";
import { renderBusinessIntake } from "./business-intake";
import { renderBusinessRoute } from "./business-route";
import { renderBusinessWorkIntake } from "./business-work-intake";

type BusinessViewState = Pick<
  AppViewState,
  | "beginBusinessExpense"
  | "editBusinessExpense"
  | "cancelBusinessExpense"
  | "createBusinessExpense"
  | "acknowledgeExpenseOutcome"
  | "business"
  | "locale"
  | "connected"
  | "refreshBusiness"
  | "selectBusinessQueue"
  | "selectBusinessDepartment"
  | "setBusinessOrganizationMode"
  | "filterBusiness"
  | "beginBusinessWork"
  | "editBusinessWork"
  | "cancelBusinessWork"
  | "createBusinessWork"
  | "acknowledgeBusinessWorkOutcome"
  | "selectBusinessItem"
  | "loadMoreBusiness"
  | "loadBusinessDraft"
  | "verifyBusinessEvidence"
  | "beginBusinessDecision"
  | "editBusinessDecision"
  | "cancelBusinessDecision"
  | "submitBusinessDecision"
> &
  BusinessChatEntryState;

const label = (id: string, params?: Record<string, string | number>) => t(id as MessageId, params);
const statusLabel = (value: string) => label(`business.status.${value}`);
const typeLabel = (value: string) => label(`business.type.${value}`);
const priorityLabel = (value: string) => label(`business.priority.${value}`);

function showValue(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function renderSummary(
  item: WorkItemSummary,
  selected: boolean,
  onSelect: () => void,
  disabled = false,
) {
  return html`<button
    type="button"
    class="business-item ${selected ? "is-selected" : ""}"
    aria-pressed=${selected}
    ?disabled=${disabled}
    @click=${onSelect}
  >
    <span class="business-item__top"><strong>${item.title}</strong><span>${statusLabel(item.status)}</span></span>
    <span class="business-item__meta">${item.queue} · ${typeLabel(item.type)} · ${priorityLabel(item.priority)}</span>
    <span class="business-item__meta">${item.dueAt ? `${label("business.due")}: ${item.dueAt}` : label("business.noDue")}</span>
  </button>`;
}

function fieldRows(fields: Record<string, unknown>) {
  const entries = Object.entries(fields);
  if (!entries.length) {
    return nothing;
  }
  return html`<dl class="business-kv">
    ${entries.map(([key, value]) => html`<div><dt>${key}</dt><dd>${showValue(value)}</dd></div>`)}
  </dl>`;
}

function section(title: string, body: unknown, extra = "") {
  return html`<section class="business-section ${extra}"><h3>${title}</h3>${body}</section>`;
}

function renderDecision(item: WorkItem, state: BusinessViewState, enabled: boolean) {
  const form = state.business.decisionForm;
  const matches = form?.id === item.id && form.revision === item.revision;
  const sameItem = form?.id === item.id ? form : null;
  const approval = item.status === "awaiting_review";
  const canCancel = item.status !== "done" && item.status !== "cancelled";
  const formDecision = sameItem?.decision;
  const commentRequired = formDecision === "send_back" || formDecision === "cancel";
  const overrideValid =
    formDecision !== "approve" ||
    !sameItem?.override ||
    (sameItem.overrideReason.trim().length >= 10 && sameItem.overrideReason.trim().length <= 2000);
  const commentValid =
    (!commentRequired || Boolean(sameItem?.comment.trim())) &&
    (sameItem?.comment.length ?? 0) <= 2000;
  const statusValid =
    formDecision === "cancel"
      ? canCancel
      : formDecision === "approve" || formDecision === "send_back"
        ? approval
        : false;
  const submitDisabled =
    !enabled ||
    !matches ||
    !sameItem ||
    !statusValid ||
    !commentValid ||
    !overrideValid ||
    state.business.decisionPending;
  const notice = state.business.decisionNotice;

  return html`<section class="business-decision" aria-labelledby="business-decision-title">
    <div class="business-decision__heading">
      <h3 id="business-decision-title">${label("business.decision.title")}</h3>
      <span class="business-revision">${label("business.revision")} ${item.revision}</span>
    </div>
    <p class="business-muted">${label("business.decision.limitations")}</p>
    <p class="business-decision__controls"><b>${label("business.approvals")}</b> ${item.approvals.length} / ${item.requiredApprovals}
      ${state.business.config && !state.business.config.error ? html`· <b>${label("business.separation")}</b> ${state.business.config.separationOfDuties ? label("business.enabled") : label("business.disabled")}` : nothing}</p>
    ${notice ? html`<p class="business-decision__notice" role=${notice === label("business.decision.saved") ? "status" : "alert"}>${notice}</p>` : nothing}
    ${
      sameItem
        ? html`<form class="business-decision__form" @submit=${(event: Event) => {
            event.preventDefault();
            if (!submitDisabled) {
              void state.submitBusinessDecision();
            }
          }}>
      <p class="business-muted">${label("business.decision.confirmRevision", { revision: sameItem.revision })}</p>
      <label>${label("business.decision.comment")}
        <textarea rows="3" maxlength="2000" aria-invalid=${!commentValid} aria-describedby=${commentRequired && !commentValid ? "business-comment-validation" : nothing} ?disabled=${state.business.decisionPending} .value=${sameItem.comment} @input=${(event: Event) => state.editBusinessDecision({ comment: (event.currentTarget as HTMLTextAreaElement).value })}></textarea>
      </label>
      ${commentRequired && !commentValid ? html`<small id="business-comment-validation" class="business-decision__validation">${label("business.decision.commentRequired")}</small>` : nothing}
      ${
        formDecision === "approve"
          ? html`<label class="business-decision__check"><input type="checkbox" ?disabled=${state.business.decisionPending} .checked=${sameItem.override} @change=${(event: Event) => state.editBusinessDecision({ override: (event.currentTarget as HTMLInputElement).checked })}> ${label("business.decision.override")}</label>
        ${
          sameItem.override
            ? html`<label>${label("business.overrideReason")}
          <textarea rows="2" maxlength="2000" aria-invalid=${!overrideValid} aria-describedby=${!overrideValid ? "business-override-validation" : nothing} ?disabled=${state.business.decisionPending} .value=${sameItem.overrideReason} @input=${(event: Event) => state.editBusinessDecision({ overrideReason: (event.currentTarget as HTMLTextAreaElement).value })}></textarea>
        </label>${!overrideValid ? html`<small id="business-override-validation" class="business-decision__validation">${label("business.decision.overrideReasonRequired")}</small>` : nothing}`
            : nothing
        }`
          : nothing
      }
      <div class="business-decision__actions">
        <button type="button" class="business-decision__secondary" ?disabled=${state.business.decisionPending} @click=${() => state.cancelBusinessDecision()}>${label("business.decision.back")}</button>
        <button type="submit" class="business-decision__primary" ?disabled=${submitDisabled}>${state.business.decisionPending ? label("business.decision.submitting") : label(`business.decision.confirm.${sameItem.decision}`)}</button>
      </div>
    </form>`
        : html`<div class="business-decision__actions">
      <button type="button" class="business-decision__primary" ?disabled=${!enabled || !approval} data-business-decision="approve" @click=${() => state.beginBusinessDecision("approve")}>${label("business.decision.start.approve")}</button>
      <button type="button" class="business-decision__secondary" ?disabled=${!enabled || !approval} data-business-decision="send_back" @click=${() => state.beginBusinessDecision("send_back")}>${label("business.decision.start.send_back")}</button>
      <button type="button" class="business-decision__secondary" ?disabled=${!enabled || !canCancel} data-business-decision="cancel" @click=${() => state.beginBusinessDecision("cancel")}>${label("business.decision.start.cancel")}</button>
    </div>`
    }
  </section>`;
}

function renderDetail(
  item: WorkItem | null,
  loading: boolean,
  failed: boolean,
  locale: string,
  state: BusinessViewState,
  enabled: boolean,
) {
  if (loading && !item) {
    return html`<div class="business-muted" role="status">${label("business.loading")}</div>`;
  }
  if (failed) {
    return html`<div class="business-error" role="alert">${label("business.detailError")}</div>`;
  }
  if (!item) {
    return html`<div class="business-muted">${label("business.selectItem")}</div>`;
  }

  const evidence = state.business.evidence;
  const matchingEvidence =
    evidence?.itemId === item.id && evidence.revision === item.revision ? evidence : null;
  const source = item.source;
  const draft = item.draft;
  const preview = state.business.draftPreview;
  const matchingPreview =
    preview?.itemId === item.id && preview.revision === item.revision ? preview : null;
  return html`
    <div class="business-detail-head">
      <div><div class="business-eyebrow">${item.queue} · ${typeLabel(item.type)}</div><h2>${item.title}</h2></div>
      <span class="business-status">${statusLabel(item.status)}${loading ? html`<span class="business-updating" role="status"> · ${label("business.updating")}</span>` : nothing}</span>
    </div>
    <div class="business-detail-meta">
      <span><b>${label("business.status")}</b>${statusLabel(item.status)}</span>
      <span><b>${label("business.priority")}</b>${priorityLabel(item.priority)}</span>
      <span><b>${label("business.due")}</b>${item.dueAt ?? label("business.noDue")}</span>
      <span><b>${label("business.approvals")}</b>${item.approvals.length} / ${item.requiredApprovals}</span>
      <span><b>${label("business.revision")}</b>${item.revision}</span>
    </div>
    ${renderBusinessRoute(item.route, locale)}
    ${section(
      label("business.source"),
      html`
      <h4>${label("business.sourceFields")}</h4>${fieldRows(source.fields)}
      <h4>${label("business.documents")}</h4>
      ${
        source.documents.length
          ? html`<ul class="business-docs">${source.documents.map(
              (doc) => html`<li>
        <span>${doc.name}</span><span class="business-mono">${doc.kind}: ${doc.ref}</span>
        ${doc.sha256 ? html`<span class="business-mono business-break">SHA-256: ${doc.sha256}</span>` : nothing}
      </li>`,
            )}</ul>`
          : html`<p class="business-muted">${label("business.noDocuments")}</p>`
      }
    `,
    )}
    ${section(
      label("business.draft"),
      draft
        ? html`<dl class="business-kv">
      <div><dt>${label("business.artifact")}</dt><dd class="business-mono business-break">${draft.artifactId}</dd></div>
      <div><dt>${label("business.version")}</dt><dd>${draft.version}</dd></div>
      <div><dt>${label("business.sha256")}</dt><dd class="business-mono business-break">${draft.sha256}</dd></div>
      <div><dt>${label("business.agent")}</dt><dd>${draft.agentId ?? "—"}</dd></div>
    </dl>
    <button type="button" class="business-refresh" ?disabled=${loading || matchingPreview?.status === "loading"} @click=${() => state.loadBusinessDraft()}>${label(matchingPreview?.status === "loading" ? "business.loading" : "business.preview.load")}</button>
    ${matchingPreview?.status === "error" ? html`<p role="alert" class="business-error">${label("business.preview.error")}</p>` : nothing}
    ${matchingPreview?.status === "ready" ? html`<p class="business-muted" role="status">${label("business.preview.matched")}</p><pre class="business-draft-content" tabindex="0" aria-label=${label("business.preview.content")}>${matchingPreview.content === "" ? label("business.preview.empty") : matchingPreview.content}</pre>` : html`<p class="business-muted">${label("business.draftMetadataNote")}</p>`}`
        : html`<p class="business-muted">${label("business.noDraft")}</p>`,
    )}
    ${section(
      label("business.checks"),
      item.checks.length
        ? html`<div class="business-checks">
      ${item.checks.map(
        (check) => html`<article class="business-check">
        <div class="business-check__top"><strong>${check.label[locale === "ja" ? "ja" : "en"] ?? check.label.en ?? check.label.ja ?? check.policyId}</strong>
          <span class="business-check--${check.result}">${label(`business.check.${check.result}`)}</span></div>
        <div class="business-muted">${check.blocking ? label("business.blocking") : label("business.nonBlocking")} · ${check.checkedAt} · ${check.policyId}${check.draftVersion === null ? "" : ` · ${label("business.version")} ${check.draftVersion}`}</div>
        <div class="business-mono business-break">${label("business.policyDigest")}: ${check.policyDigest}</div>
        ${fieldRows(check.evidence)}
      </article>`,
      )}
    </div>`
        : html`<p class="business-muted">${label("business.noChecks")}</p>`,
    )}
    ${section(
      label("business.approvals"),
      html`<ul class="business-docs">${
        item.approvals.length
          ? item.approvals.map(
              (approval) => html`<li>
      <span>${approval.by} · ${approval.at}</span>${approval.comment ? html`<span>${approval.comment}</span>` : nothing}
    </li>`,
            )
          : html`<li><span>${label("business.approvals")}: 0 / ${item.requiredApprovals}</span></li>`
      }</ul>`,
    )}
    ${section(
      label("business.override"),
      item.override
        ? html`<dl class="business-kv">
      <div><dt>${label("business.overrideReason")}</dt><dd>${item.override.reason}</dd></div>
      <div><dt>${item.override.by}</dt><dd>${item.override.at}</dd></div>
      <div><dt>${label("business.checks")}</dt><dd>${item.override.policyIds.join(", ")}</dd></div>
    </dl>`
        : html`<p class="business-muted">${label("business.noOverride")}</p>`,
    )}
    ${section(
      label("business.history"),
      item.history.length
        ? html`<ol class="business-history">
      ${item.history.map(
        (event) => html`<li><div><strong>${event.action}</strong><span>${event.at}</span></div>
        <div class="business-muted">${event.by} · ${label(`business.actor.${event.actorKind}`)}${event.from || event.to ? ` · ${event.from ? statusLabel(event.from) : ""}${event.from && event.to ? " → " : ""}${event.to ? statusLabel(event.to) : ""}` : ""}</div>
        ${event.comment ? html`<p>${event.comment}</p>` : nothing}
        ${event.evidence ? html`<div class="business-muted">${label("business.evidence")}: ${event.evidence.bundle} · <span class="business-mono business-break">${event.evidence.root}</span></div>` : nothing}
      </li>`,
      )}
    </ol>`
        : html`<p class="business-muted">${label("business.noHistory")}</p>`,
    )}
    ${renderDecision(item, state, enabled)}
    ${section(
      label("business.evidence"),
      html`
      <button type="button" class="business-refresh" ?disabled=${loading || state.business.loading || state.business.decisionPending || matchingEvidence?.status === "loading"} @click=${() => state.verifyBusinessEvidence()}>${label(matchingEvidence?.status === "loading" ? "business.evidence.verifying" : "business.evidence.verify")}</button>
      ${
        matchingEvidence
          ? html`<p role=${matchingEvidence.status === "failed" || matchingEvidence.status === "unavailable" ? "alert" : "status"}>${label(`business.evidence.${matchingEvidence.status}`)}</p>
        ${matchingEvidence.checkedAt ? html`<p class="business-muted">${label("business.evidence.checkedAt")}: <time datetime=${matchingEvidence.checkedAt}>${matchingEvidence.checkedAt}</time> · ${label("business.evidence.bundles", { count: matchingEvidence.bundles })}</p>` : nothing}`
          : html`<p class="business-muted">${label("business.evidenceNote")}</p>`
      }
      <p class="business-muted">${label("business.evidence.scope")}</p>
    `,
    )}
  `;
}

export function renderBusiness(state: BusinessViewState, project: Project) {
  const business = state.business;
  const inProject = state.connected && business.projectId === project.id;
  const config = inProject ? business.config : null;
  const list = inProject ? business.list : null;
  const item = inProject && business.item?.projectId === project.id ? business.item : null;
  const department = getBusinessDepartment(business.department ?? "all");
  const unmapped = business.department === "unmapped";
  const queues = (config?.queues ?? []).filter((queue) =>
    unmapped ? !queue.department : !department || queue.department === department.id,
  );
  const navigationDisabled =
    !inProject ||
    business.decisionPending ||
    business.expensePending ||
    Boolean(
      business.decisionForm || business.expenseForm || business.workForm || business.workPending,
    );
  const intakeEnabled = Boolean(
    inProject &&
    config &&
    !config.error &&
    !business.error &&
    !business.loading &&
    !business.detailLoading &&
    !business.detailError &&
    !business.decisionPending &&
    !business.workPending &&
    !business.workForm &&
    !business.workUncertain &&
    !business.decisionForm,
  );
  const expenseQueues = queues.filter((queue) => queue.types.includes("expense"));
  const decisionEnabled = Boolean(
    item &&
    config &&
    !config.error &&
    !business.loading &&
    !business.detailLoading &&
    !business.decisionPending &&
    !business.expensePending &&
    !business.expenseForm &&
    !business.workPending &&
    !business.workForm &&
    !business.workUncertain &&
    !business.expenseUncertain,
  );

  return html`<main class="business-workspace">
    <header class="business-header">
      <div><div class="business-eyebrow">${project.name}</div><h1>${label("business.title")}</h1>
        <p>${label("business.intro")}</p></div>
      <div class="business-header__actions">
        ${queues.some((queue) => queue.id === business.queue) ? html`<button type="button" data-business-work-new class="business-refresh" ?disabled=${navigationDisabled || business.workUncertain || business.expenseUncertain || business.loading || Boolean(config?.error || business.error)} @click=${() => state.beginBusinessWork()}>${label("business.departments.new")}</button>` : nothing}
        ${expenseQueues.length ? html`<button type="button" data-business-expense class="business-refresh" ?disabled=${!intakeEnabled || business.expensePending || business.expenseUncertain || !!business.expenseForm} @click=${() => state.beginBusinessExpense()}>${label("business.intake.new")}</button>` : nothing}
        <span class="business-readonly">${label("business.reviewDecisions")}</span>
        <button type="button" data-business-refresh class="business-refresh" ?disabled=${!state.connected || business.loading || business.decisionPending} @click=${() => state.refreshBusiness()}>${label("business.refresh")}</button>
      </div>
    </header>
    ${!state.connected ? html`<div class="business-error" role="status">${label("business.disconnected")}</div>` : nothing}
    ${state.connected && inProject && business.error ? html`<div class="business-error" role="alert">${label("business.loadError")}</div>` : nothing}
    ${state.connected && business.loading && !list ? html`<div class="business-loading" role="status">${label("business.loading")}</div>` : nothing}
    ${config?.error ? html`<div class="business-error" role="alert">${label("business.policyError")}</div>` : nothing}
    ${renderDepartmentNavigation({
      locale: state.locale,
      mode: business.organizationMode ?? "enterprise",
      selected: unmapped ? "unmapped" : (department?.id ?? "all"),
      departments: config?.departments ?? [],
      disabled: navigationDisabled,
      onSelect: (id) => void state.selectBusinessDepartment(id),
      onModeChange: (mode) => state.setBusinessOrganizationMode(mode),
    })}
    ${
      unmapped
        ? nothing
        : renderBusinessChatEntry({
            locale: state.locale,
            projectId: project.id,
            projectName: project.name,
            department,
            disabled: navigationDisabled,
            state,
          })
    }
    <form class="business-departments__filters" @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget as HTMLFormElement);
      const search = fields.get("search");
      const status = fields.get("status");
      if (!navigationDisabled && typeof search === "string" && typeof status === "string") {
        void state.filterBusiness(search, status as BusinessState["status"]);
      }
    }}>
      <label>${label("business.departments.search")}<input name="search" type="search" maxlength="200" .value=${business.search ?? ""} ?disabled=${navigationDisabled}></label>
      <label>${label("business.departments.status")}<select name="status" .value=${business.status ?? ""} ?disabled=${navigationDisabled}>
        <option value="">${label("business.departments.allStatuses")}</option>
        ${["new", "drafting", "awaiting_review", "approved", "sent_back", "done", "cancelled"].map((status) => html`<option value=${status} ?selected=${business.status === status}>${statusLabel(status)}</option>`)}
      </select></label>
      <button type="submit" class="business-refresh" ?disabled=${navigationDisabled || business.loading}>${label("business.departments.apply")}</button>
    </form>
    ${
      department
        ? renderDepartmentWorkspace({
            disabled: navigationDisabled,
            locale: state.locale,
            department,
            queues,
            selectedQueue: inProject ? business.queue : "",
            list: inProject && !config?.error ? list : null,
            loading: state.connected && business.loading,
            unavailable: !inProject || !config || Boolean(config.error || business.error),
            onQueueSelect: (id) => {
              if (!navigationDisabled) {
                void state.selectBusinessQueue(id);
              }
            },
            onItemSelect: (id) => {
              if (!navigationDisabled) {
                void state.selectBusinessItem(id);
              }
            },
          })
        : nothing
    }
    ${department && list?.nextCursor ? html`<button type="button" class="business-load-more" ?disabled=${business.loading || navigationDisabled} @click=${() => state.loadMoreBusiness()}>${business.loading ? label("business.loading") : label("business.loadMore")}</button>` : nothing}
    ${
      state.connected && inProject && config
        ? html`<div class="business-policy-strip">
      <span><b>${label("business.separation")}</b>${config.separationOfDuties ? label("business.enabled") : label("business.disabled")}</span>
        <span><b>${label("business.policySource")}</b>${config.source.kind}${config.source.path ? ` · ${config.source.path}` : ""}</span>
      <span class="business-policy-digest"><b>${label("business.policyDigest")}</b><code>${config.digest}</code></span>
    </div>`
        : nothing
    }
    ${
      item?.type === "expense" &&
      item.id === business.selectedId &&
      ["new", "sent_back"].includes(item.status) &&
      expenseQueues.some((queue) => queue.id === item.queue)
        ? html`<div class="business-header__actions" aria-label=${label("business.intake.heading")}>
        <button type="button" data-business-expense-edit class="business-refresh" ?disabled=${!intakeEnabled || business.expensePending || business.expenseUncertain || !!business.expenseForm} @click=${() => state.beginBusinessExpense("edit")}>${label("business.intake.editHeading")}</button>
        <button type="button" data-business-expense-submit class="business-refresh" ?disabled=${!intakeEnabled || business.expensePending || business.expenseUncertain || !!business.expenseForm} @click=${() => state.beginBusinessExpense("submit")}>${label("business.intake.submitHeading")}</button>
      </div>`
        : nothing
    }
    ${inProject ? renderBusinessIntake(state, intakeEnabled) : nothing}
    ${inProject ? renderBusinessWorkIntake(state, !business.loading && !business.error && Boolean(config && !config.error)) : nothing}
    <div class="business-layout ${department ? "business-layout--department" : ""}">
      ${
        !department
          ? html`
      <aside class="business-queue-panel" aria-label=${label("business.queue")}>
        ${unmapped ? html`<h2>${state.locale.startsWith("ja") ? "部門未設定" : "Unmapped queues"}</h2>` : nothing}
        <label class="business-queue-select"><span>${label("business.queue")}</span>
          <select data-business-queue .value=${inProject ? business.queue : ""} ?disabled=${navigationDisabled || Boolean(department && !queues.length)} @change=${(event: Event) => state.selectBusinessQueue((event.currentTarget as HTMLSelectElement).value)}>
            <option value="" .selected=${live(!inProject || business.queue === "")}>${label("business.allQueues")}</option>
            ${queues.map((queue) => html`<option value=${queue.id} .selected=${live(business.queue === queue.id)}>${queue.name[state.locale === "ja" ? "ja" : "en"] ?? queue.name.en ?? queue.name.ja ?? queue.id}</option>`)}
          </select>
        </label>
      </aside>
      <aside class="business-items-panel" aria-label=${label("business.items")}>
        <div class="business-count">${list ? t("business.loadedOfTotal" as MessageId, { loaded: list.items.length, total: list.total }) : label("business.items")}</div>
        ${
          list?.items.length
            ? html`<div class="business-list" role="list">
          ${list.items.map((row) => renderSummary(row, business.selectedId === row.id, () => state.selectBusinessItem(row.id), navigationDisabled))}
        </div>`
            : list
              ? html`<div class="business-empty">${label("business.empty")}</div>`
              : nothing
        }
        ${
          list?.nextCursor
            ? html`<button type="button" class="business-load-more" ?disabled=${business.loading} @click=${() => state.loadMoreBusiness()}>
          ${business.loading ? label("business.loading") : label("business.loadMore")}</button>`
            : nothing
        }
      </aside>
      `
          : nothing
      }
      <article class="business-detail-panel" tabindex="-1">${renderDetail(item, business.detailLoading, Boolean(business.detailError), state.locale, state, decisionEnabled)}</article>
    </div>
  </main>`;
}
