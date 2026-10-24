import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state";
import { connectorRows, filterConnectorRows, type ConnectorStatus } from "../connectors/catalogue";
import { t, type MessageId } from "../i18n";
import { icons } from "../icons";

const STATUS_KEYS: Record<ConnectorStatus, MessageId> = {
  active: "connectors.status.active",
  unverified: "connectors.status.unverified",
  disabled: "connectors.status.disabled",
  planned: "connectors.status.planned",
};

const KIND_KEYS: Record<string, MessageId> = {
  business: "connectors.kind.business",
  hook: "connectors.kind.hook",
  plugin: "connectors.kind.plugin",
  mcp: "connectors.kind.mcp",
};

export function renderConnectors(state: AppViewState) {
  const enterprise = state.enterprise;
  const sourceRows = state.connected
    ? (enterprise.connectors ?? connectorRows(null, null, null))
    : connectorRows(null, null, state.configSnapshot?.config);
  const rows = filterConnectorRows(
    sourceRows,
    enterprise.connectorsQuery,
    enterprise.connectorsFilter,
    t,
  );
  const disconnected = !state.connected;

  return html`
    ${disconnected ? html`<div class="callout ent-callout">${t("connectors.disconnected")}</div>` : nothing}
    <div class="connector-toolbar">
      <label class="connector-search">
        <span class="sr-only">${t("connectors.searchLabel")}</span>
        ${icons.search}
        <input type="search" .value=${enterprise.connectorsQuery} placeholder=${t("connectors.searchPlaceholder")}
          @input=${(event: Event) => state.patchEnterprise({ connectorsQuery: (event.target as HTMLInputElement).value })} />
      </label>
      <label class="connector-filter">
        <span class="sr-only">${t("connectors.filterLabel")}</span>
        <select .value=${enterprise.connectorsFilter}
          @change=${(event: Event) => state.patchEnterprise({ connectorsFilter: (event.target as HTMLSelectElement).value as ConnectorStatus | "all" })}>
          <option value="all">${t("connectors.filter.all")}</option>
          ${(["active", "unverified", "disabled", "planned"] as const).map(
            (status) => html`<option value=${status}>${t(STATUS_KEYS[status])}</option>`,
          )}
        </select>
      </label>
      <button class="btn btn--sm connector-refresh" ?disabled=${enterprise.connectorsLoading || disconnected}
        aria-label=${t("common.refresh")} title=${t("common.refresh")} @click=${() => state.refreshEnterprise()}>
        ${icons.repeat}
      </button>
      <span class="muted connector-readonly">${t("common.readOnly")}</span>
    </div>
    ${enterprise.connectorsLoading ? html`<div class="connector-notice" role="status">${t("connectors.loading")}</div>` : nothing}
    ${enterprise.connectorsSource === "partial" ? html`<div class="callout connector-notice">${t("connectors.partial")}</div>` : nothing}
    ${enterprise.connectorsSource === "unavailable" ? html`<div class="callout connector-notice">${t("connectors.unavailable")}</div>` : nothing}
    <section class="connector-list" aria-label=${t("connectors.title")}>
      ${
        rows.length === 0
          ? html`<div class="connector-empty">${icons.plug}<span>${t("connectors.filteredEmpty")}</span></div>`
          : rows.map(
              (row) => html`
          <article class="connector-row">
            <div class="connector-row__main">
              <div class="connector-row__identity">
                <span class="connector-row__name">${row.nameKey ? t(row.nameKey) : row.name}</span>
                <span class="connector-kind">${t(KIND_KEYS[row.kind])}</span>
              </div>
              <span class="ent-status ent-status--${row.status}">${t(STATUS_KEYS[row.status])}</span>
            </div>
            ${
              row.capabilities.length
                ? html`<div class="connector-capabilities">
              ${row.capabilities.map((capability) => html`<span>${t(capability)}</span>`)}
            </div>`
                : nothing
            }
            <details class="connector-why">
              <summary aria-label=${t("connectors.whyLabel")} title=${t("connectors.whyLabel")}>${icons.circle}</summary>
              <p>${t(row.why)}</p>
            </details>
          </article>
        `,
            )
      }
    </section>
  `;
}
