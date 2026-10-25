import { html, nothing } from "lit";
import type { WorkItemRoute } from "../../../../packages/client/src/workitems.js";
import { t, type MessageId } from "../i18n";

const label = (id: string) => t(id as MessageId);

function localizedName(name: { en?: string; ja?: string }, locale: string, fallback: string) {
  return name[locale === "ja" ? "ja" : "en"] ?? name.en ?? name.ja ?? fallback;
}

export function renderBusinessRoute(route: WorkItemRoute | null, locale: string) {
  if (!route || route.kind !== "staged") {
    return nothing;
  }

  return html`<section class="business-route" aria-labelledby="business-route-title">
    <h3 id="business-route-title">${label("business.route.title")}</h3>
    <ol class="business-route__stages">
      ${route.stages.map(
        (stage, index) => html`<li class="business-route__stage">
        <div class="business-route__heading">
          <strong>${localizedName(stage.name, locale, stage.id)}</strong>
          <span class="business-route__status business-route__status--${stage.status}">${label(`business.route.status.${stage.status}`)}</span>
          ${stage.status === "active" && route.current === index ? html`<span class="business-route__current">${label("business.route.current")}</span>` : nothing}
        </div>
        <div class="business-route__meta">
          <span><b>${label("business.approvals")}</b> ${stage.approvals.length} / ${stage.minApprovals}</span>
          ${stage.dueAt ? html`<span><b>${label("business.route.deadline")}</b> <time datetime=${stage.dueAt}>${stage.dueAt}</time></span>` : nothing}
          ${stage.overdueAt ? html`<span class="business-route__marker">${label("business.route.overdue")}</span>` : nothing}
          ${stage.escalatedAt ? html`<span class="business-route__marker">${label("business.route.escalated")}</span>` : nothing}
        </div>
      </li>`,
      )}
    </ol>
    ${
      route.skipped.length
        ? html`<div class="business-route__skipped">
      <h4>${label("business.route.skipped")}</h4>
      <ul>${route.skipped.map((stage) => html`<li><strong>${localizedName(stage.name, locale, stage.id)}</strong><span>${stage.reason}</span></li>`)}</ul>
    </div>`
        : nothing
    }
  </section>`;
}
