import { html, nothing } from "lit";
import type { WorkItem, WorkItemSummary } from "../../../../packages/client/src/workitems.js";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { t, type MessageId } from "../i18n";

type BusinessViewState = Pick<
  AppViewState,
  | "business"
  | "locale"
  | "connected"
  | "refreshBusiness"
  | "selectBusinessQueue"
  | "selectBusinessItem"
  | "loadMoreBusiness"
>;

const label = (id: string) => t(id as MessageId);
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

function renderSummary(item: WorkItemSummary, selected: boolean, onSelect: () => void) {
  return html`<button
    type="button"
    class="business-item ${selected ? "is-selected" : ""}"
    aria-pressed=${selected}
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

function renderDetail(item: WorkItem | null, loading: boolean, failed: boolean, locale: string) {
  if (loading && !item) {
    return html`<div class="business-muted" role="status">${label("business.loading")}</div>`;
  }
  if (failed) {
    return html`<div class="business-error" role="alert">${label("business.detailError")}</div>`;
  }
  if (!item) {
    return html`<div class="business-muted">${label("business.selectItem")}</div>`;
  }

  const source = item.source;
  const draft = item.draft;
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
    </dl><p class="business-muted">${label("business.draftMetadataNote")}</p>`
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
    <p class="business-evidence-note">${label("business.evidenceNote")}</p>
  `;
}

export function renderBusiness(state: BusinessViewState, project: Project) {
  const business = state.business;
  const inProject = state.connected && business.projectId === project.id;
  const config = inProject ? business.config : null;
  const list = inProject ? business.list : null;
  const item = inProject && business.item?.projectId === project.id ? business.item : null;
  const queues = config?.queues ?? [];

  return html`<main class="business-workspace">
    <header class="business-header">
      <div><div class="business-eyebrow">${project.name}</div><h1>${label("business.title")}</h1>
        <p>${label("business.intro")}</p></div>
      <div class="business-header__actions"><span class="business-readonly">${label("business.readOnly")}</span>
        <button type="button" class="business-refresh" ?disabled=${!state.connected || business.loading} @click=${() => state.refreshBusiness()}>${label("business.refresh")}</button>
      </div>
    </header>
    ${!state.connected ? html`<div class="business-error" role="status">${label("business.disconnected")}</div>` : nothing}
    ${state.connected && inProject && business.error ? html`<div class="business-error" role="alert">${label("business.loadError")}</div>` : nothing}
    ${state.connected && business.loading && !list ? html`<div class="business-loading" role="status">${label("business.loading")}</div>` : nothing}
    ${config?.error ? html`<div class="business-error" role="alert">${label("business.policyError")}</div>` : nothing}
    ${
      state.connected && inProject && config
        ? html`<div class="business-policy-strip">
      <span><b>${label("business.separation")}</b>${config.separationOfDuties ? label("business.enabled") : label("business.disabled")}</span>
        <span><b>${label("business.policySource")}</b>${config.source.kind}${config.source.path ? ` · ${config.source.path}` : ""}</span>
      <span class="business-policy-digest"><b>${label("business.policyDigest")}</b><code>${config.digest}</code></span>
    </div>`
        : nothing
    }
    <div class="business-layout">
      <aside class="business-queue-panel" aria-label=${label("business.queue")}>
        <label class="business-queue-select"><span>${label("business.queue")}</span>
          <select .value=${inProject ? business.queue : ""} @change=${(event: Event) => state.selectBusinessQueue((event.currentTarget as HTMLSelectElement).value)}>
            <option value="" ?selected=${!inProject || business.queue === ""}>${label("business.allQueues")}</option>
            ${queues.map((queue) => html`<option value=${queue.id} ?selected=${business.queue === queue.id}>${queue.name[state.locale === "ja" ? "ja" : "en"] ?? queue.name.en ?? queue.name.ja ?? queue.id}</option>`)}
          </select>
        </label>
      </aside>
      <aside class="business-items-panel" aria-label=${label("business.items")}>
        <div class="business-count">${list ? t("business.loadedOfTotal" as MessageId, { loaded: list.items.length, total: list.total }) : label("business.items")}</div>
        ${
          list?.items.length
            ? html`<div class="business-list" role="list">
          ${list.items.map((row) => renderSummary(row, business.selectedId === row.id, () => state.selectBusinessItem(row.id)))}
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
      <article class="business-detail-panel">${renderDetail(item, business.detailLoading, Boolean(business.detailError), state.locale)}</article>
    </div>
  </main>`;
}
