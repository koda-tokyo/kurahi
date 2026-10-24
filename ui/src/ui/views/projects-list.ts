import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import { formFromTemplate } from "../controllers/projects";
import { formatAgo } from "../format";
import { t } from "../i18n";
import { icons } from "../icons";

type ListHelpers = {
  canAdmin: (state: AppViewState) => boolean;
  templateName: (state: AppViewState, id: string | null) => string;
  renderCreateForm: (state: AppViewState) => TemplateResult;
};

export function renderProjectList(state: AppViewState, helpers: ListHelpers) {
  const p = state.projects;
  const projects = p.projects;
  return html`
    <div class="ent-toolbar">
      ${
        helpers.canAdmin(state)
          ? html`<button
            class="btn primary"
            @click=${() =>
              state.patchProjects({
                creating: true,
                form: formFromTemplate(p.templates[0] ?? null, state.locale),
                formError: null,
              })}
          >
            ${t("projects.new")}
          </button>`
          : html`<span class="muted">${t("projects.adminOnly")}</span>`
      }
      <button class="btn btn--sm" @click=${() => state.refreshProjects()}>${t("common.refresh")}</button>
    </div>
    ${
      p.error
        ? html`<div class="callout danger" role="alert">
          <span>${t("projects.loadError")}</span>
          <button class="btn btn--sm" @click=${() => state.refreshProjects()}>${t("common.refresh")}</button>
        </div>`
        : nothing
    }
    ${
      !state.connected && projects.length > 0
        ? html`<div class="callout" role="status">${t("projects.disconnected")}</div>`
        : nothing
    }
    ${p.creating ? helpers.renderCreateForm(state) : nothing}
    <section class="card ent-card ent-card--wide">
      ${
        p.loading && projects.length === 0
          ? html`<div class="ent-empty" role="status">${icons.folder}<span>${t("projects.loading")}</span></div>`
          : !state.connected && projects.length === 0
            ? html`<div class="ent-empty" role="status">${icons.folder}<span>${t("projects.disconnected")}</span></div>`
            : projects.length === 0 && p.error
              ? nothing
              : projects.length === 0
                ? html`<div class="ent-empty">
                    ${icons.folder}<span>${t(p.showArchived ? "projects.emptyArchived" : "projects.empty")}</span>
                  </div>`
                : html`<div class="ent-table-wrap"><table class="ent-table">
                    <thead><tr>
                      <th>${t("projects.col.name")}</th>
                      <th>${t("projects.col.template")}</th>
                      <th>${t("projects.col.folder")}</th>
                      <th>${t("projects.col.agents")}</th>
                      <th>${t("projects.col.updated")}</th>
                      <th><span class="sr-only">${t("projects.col.actions")}</span></th>
                    </tr></thead>
                    <tbody>${projects.map(
                      (project) => html`<tr>
                        <td>
                          <a href="#" class="ent-link" @click=${(event: Event) => {
                            event.preventDefault();
                            state.openProject(project.id);
                          }}>${project.name}</a>
                          ${
                            project.archived
                              ? html`<span class="ent-status ent-status--disabled">${t("projects.archived")}</span>`
                              : nothing
                          }
                        </td>
                        <td>${helpers.templateName(state, project.templateId)}</td>
                        <td class="mono ent-wrap">${project.folder}</td>
                        <td class="mono">${project.allowedAgents.join(", ") || t("projects.agents.defaultOnly")}</td>
                        <td>${formatAgo(Date.parse(project.updatedAt))}</td>
                        <td><button class="btn btn--sm" @click=${() => state.openProject(project.id)}>${t("projects.open")}</button></td>
                      </tr>`,
                    )}</tbody>
                  </table></div>`
      }
    </section>
    <div class="ent-toolbar ent-project-archive-toggle">
      <button
        class="btn btn--sm"
        aria-pressed=${p.showArchived}
        ?disabled=${p.loading}
        @click=${() => {
          state.patchProjects({ showArchived: !p.showArchived });
          void state.refreshProjects();
        }}
      >${t(p.showArchived ? "projects.hideArchived" : "projects.showArchived")}</button>
    </div>
  `;
}
