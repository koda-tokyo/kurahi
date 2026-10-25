// プロジェクト / Projects: list, create from a template, and the project page
// (Chat / Files / Outputs / Agents / Rules / History).
import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state";
import { isBusinessProject } from "../controllers/business";
import { chatTitle } from "../controllers/chat-history";
import { isIndustrialProject } from "../controllers/industrial-modernisation";
import {
  formFromTemplate,
  groupPack,
  localized,
  projectIdOfSession,
  projectModeOf,
  PROJECT_MODES,
  PROJECT_VIEWS,
  type Project,
  type ProjectMode,
  type ProjectView,
} from "../controllers/projects";
import { formatAgo } from "../format";
import { t, type MessageId } from "../i18n";
import { icons } from "../icons";
import { renderArtifactList } from "./artifacts";
import { renderAutopilot } from "./autopilot";
import { renderBusiness } from "./business";
import { renderIndustrialModernisation } from "./industrial-modernisation";
import { renderProjectList } from "./projects-list";
import { renderTerminal } from "./terminal";

function fmtSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function canAdmin(state: AppViewState): boolean {
  return state.audience !== "business";
}

function templateName(state: AppViewState, id: string | null): string {
  if (!id) {
    return "–";
  }
  const tpl = state.projects.templates.find((x) => x.id === id);
  return tpl ? localized(tpl.name, state.locale) : id;
}

// ---- list + create ----

function renderCreateForm(state: AppViewState) {
  const p = state.projects;
  const f = p.form;
  const pick = (id: string | null) => {
    const tpl = id ? (p.templates.find((x) => x.id === id) ?? null) : null;
    state.patchProjects({ form: formFromTemplate(tpl, state.locale), formError: null });
  };
  return html`
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("projects.form.title")}</div>
      <div class="ent-label">${t("projects.form.template")}</div>
      <div class="ent-tpl-grid" role="radiogroup" aria-label=${t("projects.form.template")}>
        ${p.templates.map(
          (tpl) => html`<button
            type="button"
            role="radio"
            aria-checked=${f.templateId === tpl.id}
            class="ent-tpl ${f.templateId === tpl.id ? "active" : ""}"
            @click=${() => pick(tpl.id)}
          >
            <strong>${localized(tpl.name, state.locale)}</strong>
            <span class="muted">${localized(tpl.description, state.locale)}</span>
          </button>`,
        )}
        <button
          type="button"
          role="radio"
          aria-checked=${f.templateId === null}
          class="ent-tpl ${f.templateId === null ? "active" : ""}"
          @click=${() => pick(null)}
        >
          <strong>${t("projects.form.blank")}</strong>
          <span class="muted">${t("projects.form.blankDesc")}</span>
        </button>
      </div>
      <label class="field ent-field">
        <span>${t("projects.form.name")}</span>
        <input
          .value=${f.name}
          @input=${(e: Event) =>
            state.patchProjects({ form: { ...f, name: (e.target as HTMLInputElement).value } })}
        />
      </label>
      <label class="field ent-field">
        <span>${t("projects.form.folder")}</span>
        <input
          class="mono"
          .value=${f.folder}
          spellcheck="false"
          @input=${(e: Event) =>
            state.patchProjects({ form: { ...f, folder: (e.target as HTMLInputElement).value } })}
        />
        <span class="muted">${t("projects.form.folderHint")}</span>
      </label>
      <label class="field ent-field">
        <span>${t("projects.form.agents")}</span>
        <input
          class="mono"
          .value=${f.agents}
          @input=${(e: Event) =>
            state.patchProjects({ form: { ...f, agents: (e.target as HTMLInputElement).value } })}
        />
      </label>
      ${p.formError ? html`<div class="callout danger">${p.formError}</div>` : nothing}
      <div class="ent-actions">
        <button class="btn primary" ?disabled=${p.busy || !f.name || !f.folder} @click=${() => state.submitNewProject()}>
          ${t("projects.form.create")}
        </button>
        <button class="btn" @click=${() => state.patchProjects({ creating: false, formError: null })}>
          ${t("projects.form.cancel")}
        </button>
      </div>
    </section>
  `;
}

// ---- project page ----

const MODE_LABEL: Record<ProjectMode, MessageId> = {
  read: "projects.mode.read",
  plan: "projects.mode.plan",
  act: "projects.mode.act",
};

const MODE_DESC: Record<ProjectMode, MessageId> = {
  read: "projects.mode.readDesc",
  plan: "projects.mode.planDesc",
  act: "projects.mode.actDesc",
};

export function modeBadge(project: Project) {
  const mode = projectModeOf(project);
  return html`<span class="ent-mode-badge ent-mode-badge--${mode}">${t("projects.mode.badge", { mode: t(MODE_LABEL[mode]) })}</span>`;
}

function renderModeCard(state: AppViewState, proj: Project) {
  const current = projectModeOf(proj);
  const admin = canAdmin(state);
  return html`
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("projects.mode.title")}</div>
      <div class="ent-mode-grid" role="radiogroup" aria-label=${t("projects.mode.title")}>
        ${PROJECT_MODES.map(
          (m) => html`<button
            type="button"
            role="radio"
            aria-checked=${m === current}
            class="ent-tpl ent-mode ${m === current ? "active" : ""}"
            ?disabled=${!admin || state.projects.busy}
            @click=${() => (m === current ? undefined : state.changeProjectMode(proj.id, m))}
          >
            <strong>${t(MODE_LABEL[m])}</strong>
            <span class="muted">${t(MODE_DESC[m])}</span>
          </button>`,
        )}
      </div>
      <div class="muted ent-small">${t("projects.mode.enforced")}</div>
      ${admin ? nothing : html`<div class="muted ent-small">${t("projects.mode.adminOnly")}</div>`}
    </section>
  `;
}

function renderPackView(state: AppViewState) {
  const pack = state.projects.pack;
  if (!pack) {
    return html`<div class="muted">${t("common.loading")}</div>`;
  }
  return html`
    <div class="callout ent-callout">${t("pack.intro")}</div>
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("pack.title")}</div>
      ${
        pack.files.length === 0
          ? html`<div class="ent-empty">${icons.book}<span>${t("pack.empty")}</span></div>`
          : html`<div class="muted ent-small">${t("pack.summary", {
              included: pack.includedChars,
              total: pack.totalChars,
              budget: pack.budget,
            })}</div>
            <div class="ent-table-wrap"><table class="ent-table ent-table--dense">
              <thead><tr>
                <th>${t("pack.col.file")}</th><th>${t("pack.col.source")}</th>
                <th>${t("pack.col.size")}</th><th>${t("pack.col.loaded")}</th>
              </tr></thead>
              <tbody>
                ${groupPack(pack).map(
                  (
                    g,
                  ) => html`<tr class="ent-pack-section"><td colspan="4"><strong>${t(`pack.section.${g.section}` as MessageId)}</strong></td></tr>
                    ${g.files.map(
                      (f) => html`<tr>
                        <td class="mono ent-wrap">${f.path}</td>
                        <td>${t(f.source === "project" ? "pack.source.project" : "pack.source.template")}</td>
                        <td>${f.chars}</td>
                        <td>${
                          f.includedChars === 0 && f.truncated
                            ? html`<span class="ent-status ent-status--disabled">${t("pack.notLoaded")}</span>`
                            : f.truncated
                              ? html`${f.includedChars} <span class="ent-status ent-artifact-status--review">${t("pack.truncated")}</span>`
                              : html`${f.includedChars}`
                        }</td>
                      </tr>`,
                    )}`,
                )}
              </tbody>
            </table></div>`
      }
    </section>
  `;
}

const VIEW_LABEL: Record<ProjectView, MessageId> = {
  autopilot: "autopilot.title",
  business: "projects.view.business",
  terminal: "industrial.tab.terminal",
  chat: "projects.view.chat",
  modernize: "projects.view.modernize",
  pack: "projects.view.pack",
  files: "projects.view.files",
  artifacts: "projects.view.artifacts",
  agents: "projects.view.agents",
  rules: "projects.view.rules",
  history: "projects.view.history",
};

function renderChatView(state: AppViewState, proj: Project) {
  // The same rows and archive list as the history panel: archived chats stay hidden here too.
  const archived = new Set(state.chatHistory.archived);
  const chats = state.chatHistory.rows
    .filter((s) => projectIdOfSession(s.key) === proj.id && !archived.has(s.key))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return html`
    <div class="ent-toolbar">
      <button class="btn primary" @click=${() => state.startProjectChat(proj.id)}>${icons.messageSquare} ${t("projects.chat.new")}</button>
    </div>
    ${
      proj.starterPrompts.length
        ? html`<section class="card ent-card ent-card--wide">
          <div class="card-title">${t("projects.chat.starters")}</div>
          <div class="ent-starters">
            ${proj.starterPrompts.map((sp) => {
              const text = localized(sp, state.locale);
              return html`<button class="ent-starter" @click=${() => state.startProjectChat(proj.id, text)}>${text}</button>`;
            })}
          </div>
        </section>`
        : nothing
    }
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("projects.chat.list")}</div>
      ${
        chats.length === 0
          ? html`<div class="muted">${t("projects.chat.empty")}</div>`
          : html`<ul class="ent-list">
            ${chats.map(
              (c) => html`<li>
                <a href="#" class="ent-link" @click=${(e: Event) => {
                  e.preventDefault();
                  state.openChatSession(c.key);
                }}>${chatTitle(c)}</a>
                <span class="muted">${formatAgo(c.updatedAt ?? 0)}</span>
              </li>`,
            )}
          </ul>`
      }
    </section>
  `;
}

function renderFilesView(state: AppViewState) {
  const files = state.projects.files;
  return html`
    <div class="muted ent-count">${t("projects.readOnlyNote")}</div>
    ${state.projects.filesError ? html`<div class="callout danger">${state.projects.filesError}</div>` : nothing}
    <section class="card ent-card ent-card--wide">
      ${
        !files
          ? html`<div class="muted">${t("common.loading")}</div>`
          : files.length === 0
            ? html`<div class="ent-empty">${icons.folder}<span>${t("projects.files.empty")}</span></div>`
            : html`<div class="ent-table-wrap"><table class="ent-table ent-table--dense">
              <thead><tr><th>${t("projects.files.col.path")}</th><th>${t("projects.files.col.size")}</th><th>${t("projects.files.col.access")}</th></tr></thead>
              <tbody>${files.map(
                (f) => html`<tr>
                  <td class="mono ent-wrap">${f.type === "dir" ? `${f.path}/` : f.path}</td>
                  <td>${f.type === "dir" ? "" : fmtSize(f.size)}</td>
                  <td><span class="ent-status ${f.access === "write" ? "ent-status--active" : "ent-status--disabled"}">${t(f.access === "write" ? "projects.files.write" : "projects.files.read")}</span></td>
                </tr>`,
              )}</tbody>
            </table></div>`
      }
    </section>
  `;
}

function renderAgentsView(state: AppViewState, proj: Project) {
  return html`
    <div class="muted ent-count">${t("projects.readOnlyNote")}</div>
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("projects.agents.allowed")}</div>
      ${
        proj.allowedAgents.length
          ? html`<div>${proj.allowedAgents.map((a) => html`<span class="chip mono">${a}</span> `)}</div>`
          : html`<div class="muted">${t("projects.agents.defaultOnly")}</div>`
      }
    </section>
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("projects.agents.skills")}</div>
      ${
        proj.suggestedSkills.length
          ? html`<div>${proj.suggestedSkills.map((s) => html`<span class="chip mono">${s}</span> `)}</div>`
          : html`<div class="muted">${t("common.none")}</div>`
      }
    </section>
  `;
}

function renderRulesView(state: AppViewState, proj: Project) {
  const profile = state.projects.terminalProfiles.find((p) => p.id === proj.terminalProfile);
  const profileName = profile ? localized(profile.label, state.locale) : proj.terminalProfile;
  return html`
    ${renderModeCard(state, proj)}
    <div class="muted ent-count">${t("projects.readOnlyNote")}</div>
    <div class="callout ent-callout">${t("projects.rules.scope")}</div>
    <section class="card ent-card ent-card--wide">
      <dl class="ent-dl">
        <dt>${t("projects.rules.readOnly")}</dt>
        <dd>${proj.rules.readOnly.length ? proj.rules.readOnly.map((r) => html`<span class="chip mono">${r}</span> `) : t("common.none")}</dd>
        <dt>${t("projects.rules.writable")}</dt>
        <dd>${proj.rules.writable.length ? proj.rules.writable.map((r) => html`<span class="chip mono">${r}</span> `) : t("projects.rules.nothingWritable")}</dd>
        <dt>${t("projects.rules.approval")}</dt>
        <dd>${t(proj.rules.artifactApprovalRequired ? "common.yes" : "common.no")}</dd>
        <dt>${t("projects.rules.terminal")}</dt>
        <dd>
          ${t("projects.rules.terminalValue", { name: profileName })}
          ${profile ? html`<div class="muted">${localized(profile.allowedCommandsPolicy, state.locale)}</div>` : nothing}
          <div class="muted">${t("projects.rules.terminalNote")}</div>
        </dd>
      </dl>
    </section>
    <section class="card ent-card ent-card--wide">
      <div class="card-title">${t("projects.rules.instructions")}</div>
      ${
        proj.rules.instructions.length
          ? html`<ul class="ent-bullets">${proj.rules.instructions.map((r) => html`<li>${localized(r, state.locale)}</li>`)}</ul>`
          : html`<div class="muted">${t("common.none")}</div>`
      }
    </section>
  `;
}

function renderHistoryView(state: AppViewState, proj: Project) {
  const events = state.artifacts.items
    .filter((a) => a.projectId === proj.id)
    .flatMap((a) => a.history.map((h) => ({ ...h, title: a.title })))
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .slice(0, 100);
  return html`
    <section class="card ent-card ent-card--wide">
      <dl class="ent-dl">
        <dt>${t("projects.history.created", { by: proj.createdBy })}</dt>
        <dd>${new Date(proj.createdAt).toLocaleString(state.locale)}</dd>
        <dt>${t("projects.history.updated")}</dt>
        <dd>${new Date(proj.updatedAt).toLocaleString(state.locale)}</dd>
      </dl>
    </section>
    <section class="card ent-card ent-card--wide">
      ${
        events.length === 0
          ? html`<div class="muted">${t("projects.history.empty")}</div>`
          : html`<ul class="ent-list">${events.map(
              (e) => html`<li>
              <span class="mono">${new Date(e.at).toLocaleString(state.locale)}</span>
              <strong>${e.title}</strong>
              <span>${e.action === "status" ? `${e.from ?? ""} → ${e.to ?? ""}` : `${e.action} v${e.version ?? ""}`}</span>
              <span class="muted mono">${e.by}</span>
            </li>`,
            )}</ul>`
      }
    </section>
  `;
}

function renderProjectPage(state: AppViewState, proj: Project) {
  const view = state.projects.view;
  const views: ProjectView[] = isIndustrialProject(proj)
    ? [
        "chat",
        "modernize",
        "terminal",
        ...PROJECT_VIEWS.filter((candidate) => candidate !== "chat"),
      ]
    : isBusinessProject(proj)
      ? ["business", ...PROJECT_VIEWS]
      : PROJECT_VIEWS;
  return html`
    <div class="ent-toolbar">
      <a href="#" class="ent-link" @click=${(e: Event) => {
        e.preventDefault();
        state.openProject(null);
      }}>${t("projects.back")}</a>
    </div>
    <section class="card ent-card ent-card--wide ent-project-head">
      <div class="ent-big">${proj.name} ${modeBadge(proj)}</div>
      <div class="muted mono ent-wrap">${proj.folder}</div>
      <div class="muted ent-small">${t("projects.folderBoundary")}</div>
      <div class="muted">${templateName(state, proj.templateId)}</div>
    </section>
    <nav class="ent-subtabs" role="tablist">
      ${views.map(
        (v) => html`<a
          href="#"
          role="tab"
          aria-selected=${v === view}
          class="ent-subtabs__tab ${v === view ? "active" : ""}"
          @click=${(e: Event) => {
            e.preventDefault();
            state.setProjectView(v);
          }}
          >${t(VIEW_LABEL[v])}</a
        >`,
      )}
    </nav>
    ${view === "autopilot" ? renderAutopilot(state, proj) : nothing}
    ${view === "business" ? renderBusiness(state, proj) : nothing}
    ${view === "chat" ? renderChatView(state, proj) : nothing}
    ${view === "modernize" ? renderIndustrialModernisation(state, proj) : nothing}
    ${view === "terminal" ? renderTerminal(state, proj) : nothing}
    ${view === "files" ? renderFilesView(state) : nothing}
    ${view === "artifacts" ? renderArtifactList(state, { projectId: proj.id }) : nothing}
    ${view === "pack" ? renderPackView(state) : nothing}
    ${view === "agents" ? renderAgentsView(state, proj) : nothing}
    ${view === "rules" ? renderRulesView(state, proj) : nothing}
    ${view === "history" ? renderHistoryView(state, proj) : nothing}
  `;
}

export function renderProjects(state: AppViewState) {
  const id = state.projects.selectedId;
  const proj = id ? state.projects.projects.find((p) => p.id === id) : undefined;
  return proj
    ? renderProjectPage(state, proj)
    : renderProjectList(state, { canAdmin, templateName, renderCreateForm });
}
