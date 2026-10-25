import { html } from "lit";
import type { AppViewState } from "../app-view-state";
import {
  INDUSTRIAL_CAPABILITIES,
  INDUSTRIAL_DOCUMENT_ACTIONS,
  INDUSTRIAL_DOCUMENT_COPY,
  industrialDocumentPrompt,
  industrialAnalyzerEnabled,
  INDUSTRIAL_LIFECYCLE,
  type IndustrialCapabilityStatus,
} from "../controllers/industrial-modernisation";
import { localized, projectModeOf, type Project, type ProjectView } from "../controllers/projects";
import { capabilityPacksForEdition, type CapabilityPackReadiness } from "../editions/manifests";
import { t, type MessageId } from "../i18n";
import { renderVoice } from "./voice";

const STATUS_LABEL: Record<IndustrialCapabilityStatus, MessageId> = {
  deterministic: "industrial.status.deterministic",
  planned: "industrial.planned",
};

const STATUS_CLASS: Record<IndustrialCapabilityStatus, string> = {
  deterministic: "active",
  planned: "planned",
};

const PACK_STATUS_LABEL: Record<CapabilityPackReadiness, MessageId> = {
  active: "industrial.pack.status.active",
  unverified: "industrial.pack.status.unverified",
  disabled: "industrial.pack.status.disabled",
  planned: "industrial.pack.status.planned",
};

const PACK_STATUS_CLASS: Record<CapabilityPackReadiness, string> = {
  active: "active",
  unverified: "unverified",
  disabled: "disabled",
  planned: "planned",
};

const WORKBENCH_TABS: ReadonlyArray<{
  id: string;
  label: MessageId;
  view?: ProjectView;
  disabled?: boolean;
}> = [
  { id: "chat", label: "industrial.tab.chat", view: "chat" },
  { id: "terminal", label: "industrial.tab.terminal", view: "terminal" },
  { id: "timeline", label: "industrial.tab.timeline", view: "history" },
  { id: "files", label: "industrial.tab.files", view: "files" },
  { id: "artifacts", label: "industrial.tab.artifacts", view: "artifacts" },
  { id: "assets", label: "industrial.tab.assets", view: "modernize" },
];

function renderWorkbenchTabs(state: AppViewState) {
  return html`
    <nav class="industrial-tabs" aria-label=${t("industrial.workbench.tabs")}>
      ${WORKBENCH_TABS.map(
        (tab) => html`
          <button
            type="button"
            class="industrial-tab ${tab.id === "assets" ? "active" : ""}"
            aria-current=${tab.id === "assets" ? "page" : "false"}
            ?disabled=${tab.disabled}
            title=${tab.disabled ? t("industrial.planned") : t(tab.label)}
            @click=${() => (tab.view ? state.setProjectView(tab.view) : undefined)}
          >
            ${t(tab.label)}
            ${tab.disabled ? html`<span>${t("industrial.planned")}</span>` : ""}
          </button>
        `,
      )}
    </nav>
  `;
}

function renderCapabilityGrid(state: AppViewState, project: Project) {
  const available = Boolean(
    state.connected &&
    project.folder?.trim() &&
    industrialAnalyzerEnabled(project, state.projects?.templates),
  );
  const unavailableCopy =
    !state.connected || !project.folder?.trim()
      ? INDUSTRIAL_DOCUMENT_COPY.unavailable
      : INDUSTRIAL_DOCUMENT_COPY.analyzerUnavailable;
  return html`
    <section class="industrial-panel industrial-panel--capabilities">
      <div class="industrial-panel__head">
        <div>
          <div class="card-title">${t("industrial.capabilities")}</div>
          <p class="muted ent-small">${t("industrial.capabilityTruth")}</p>
        </div>

      </div>
      ${renderVoice(state, project)}
      <div class="industrial-capability-grid">
        ${INDUSTRIAL_CAPABILITIES.map(
          (capability) => html`
            <article class="industrial-capability" data-capability=${capability.id}>
              <div class="industrial-capability__top">
                <strong>${localized(capability.name, state.locale)}</strong>
                <span class="ent-status ent-status--${STATUS_CLASS[capability.status]}">
                  ${t(STATUS_LABEL[capability.status])}
                </span>
              </div>
              <p>${localized(capability.evidence, state.locale)}</p>
              <button
                type="button"
                class="btn"
                aria-label=${`${t(capability.status === "planned" ? "industrial.planned" : "industrial.start")}: ${localized(capability.name, state.locale)}`}
                ?disabled=${capability.status === "planned" || !available}
                title=${capability.status === "planned" ? t("industrial.planned") : !available ? localized(unavailableCopy, state.locale) : t("industrial.start")}
                @click=${() =>
                  capability.status === "deterministic" && available
                    ? state.startProjectChat(project.id, localized(capability.prompt, state.locale))
                    : undefined}
              >
                ${t(capability.status === "planned" ? "industrial.planned" : "industrial.start")}
              </button>
            </article>
          `,
        )}
      </div>
      ${!available ? html`<p class="callout ent-callout">${localized(unavailableCopy, state.locale)}</p>` : ""}
      <div class="callout ent-callout">${t("industrial.approval")}</div>
    </section>
  `;
}

function renderDocumentActions(state: AppViewState, project: Project) {
  const missingConnectionOrRoot = !state.connected || !project.folder?.trim();
  const unavailable =
    missingConnectionOrRoot || !industrialAnalyzerEnabled(project, state.projects?.templates);
  const unavailableCopy = missingConnectionOrRoot
    ? INDUSTRIAL_DOCUMENT_COPY.unavailable
    : INDUSTRIAL_DOCUMENT_COPY.analyzerUnavailable;
  return html`
    <section class="industrial-panel industrial-panel--documents">
      <div class="industrial-panel__head">
        <div>
          <div class="card-title">${localized(INDUSTRIAL_DOCUMENT_COPY.title, state.locale)}</div>
          <p class="muted ent-small">${localized(INDUSTRIAL_DOCUMENT_COPY.description, state.locale)}</p>
        </div>
      </div>
      ${INDUSTRIAL_DOCUMENT_ACTIONS.map(
        (action) => html`
        <button
          type="button"
          class="btn"
          data-document-tool=${action.tool}
          ?disabled=${unavailable}
          title=${localized(unavailable ? unavailableCopy : action.label, state.locale)}
          @click=${() =>
            unavailable
              ? undefined
              : state.startProjectChat(
                  project.id,
                  industrialDocumentPrompt(project, action.tool, state.locale),
                )}
        >${localized(action.label, state.locale)}</button>
      `,
      )}
      <p class="muted ent-small">${localized(INDUSTRIAL_DOCUMENT_COPY.save, state.locale)}</p>
      ${unavailable ? html`<p class="callout ent-callout">${localized(unavailableCopy, state.locale)}</p>` : ""}
    </section>
  `;
}

function renderAgentPacks(state: AppViewState, project: Project) {
  const packs = capabilityPacksForEdition("industrial");
  return html`
    <section class="industrial-panel industrial-panel--packs">
      <div class="industrial-panel__head">
        <div>
          <div class="card-title">${t("industrial.packs")}</div>
          <p class="muted ent-small">${t("industrial.packs.description")}</p>
        </div>
      </div>
      <div class="industrial-pack-grid">
        ${packs.map((pack) => {
          const unavailable = pack.readiness === "disabled" || pack.readiness === "planned";
          return html`
            <article class="industrial-pack" data-pack=${pack.id}>
              <div class="industrial-pack__top">
                <strong>${t(pack.labelKey as MessageId)}</strong>
                <span class="ent-status ent-status--${PACK_STATUS_CLASS[pack.readiness]}">
                  ${t(PACK_STATUS_LABEL[pack.readiness])}
                </span>
              </div>
              <p>${t(pack.descriptionKey as MessageId)}</p>
              <div class="industrial-pack__meta">
                <span>${t("industrial.pack.agents", { count: pack.agentRoles.length })}</span>
                <span>${t("industrial.pack.capabilities", { count: pack.capabilities.length })}</span>
              </div>
              <button
                type="button"
                class="btn"
                aria-label=${`${t("industrial.pack.open")}: ${t(pack.labelKey as MessageId)}`}
                ?disabled=${unavailable || !state.connected}
                title=${unavailable ? t(PACK_STATUS_LABEL[pack.readiness]) : t("industrial.pack.open")}
                @click=${() =>
                  unavailable || !state.connected
                    ? undefined
                    : state.startProjectChat(project.id, t(pack.promptKey as MessageId))}
              >
                ${t("industrial.pack.open")}
              </button>
            </article>
          `;
        })}
      </div>
    </section>
  `;
}

function renderContext(state: AppViewState, project: Project) {
  return html`
    <aside class="industrial-context" aria-label=${t("industrial.context")}>
      <div class="industrial-context__title">${t("industrial.context")}</div>
      <dl>
        <dt>${t("industrial.context.project")}</dt>
        <dd>${project.name}</dd>
        <dt>${t("industrial.context.boundary")}</dt>
        <dd class="mono ent-wrap">${project.folder}</dd>
        <dt>${t("industrial.context.mode")}</dt>
        <dd>${t(`projects.mode.${projectModeOf(project)}`)}</dd>
        <dt>${t("industrial.context.approval")}</dt>
        <dd>${t(project.rules?.artifactApprovalRequired ? "common.yes" : "common.no")}</dd>
        <dt>${t("industrial.context.service")}</dt>
        <dd>
          <span class="ent-status ent-status--${state.connected ? "active" : "disabled"}">
            ${t(state.connected ? "header.status.running" : "header.status.stopped")}
          </span>
        </dd>
      </dl>
    </aside>
  `;
}

export function renderIndustrialModernisation(state: AppViewState, project: Project) {
  return html`
    <div class="industrial-workbench">
      ${renderWorkbenchTabs(state)}
      <div class="industrial-workbench__body">
        <main class="industrial-workbench__main">
          <section class="industrial-intro">
            <div>
              <div class="card-title">${t("industrial.role")}</div>
              <h2>${t("industrial.roleName")}</h2>
              <p>${t("industrial.intro")}</p>
            </div>
            <div class="industrial-target">
              <span>${t("industrial.target.label")}</span>
              <strong>${t("industrial.target.unmeasured")}</strong>
              <small>${t("industrial.target.measured")}</small>
            </div>
          </section>
          <div class="industrial-lifecycle" aria-label=${t("industrial.lifecycle")}>
            ${INDUSTRIAL_LIFECYCLE.map(
              (stage, index) => html`
                <span><b>${index + 1}</b>${localized(stage, state.locale)}</span>
              `,
            )}
          </div>
          ${renderDocumentActions(state, project)}
          ${renderAgentPacks(state, project)}
          ${renderCapabilityGrid(state, project)}
        </main>
        ${renderContext(state, project)}
      </div>
    </div>
  `;
}
