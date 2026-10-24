// 成果物 / Outputs: list (page and project tab), the side panel next to the chat, and the
// "save as output" dialog.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AppViewState } from "../app-view-state";
import { buildArtifactExport } from "../controllers/artifact-export";
import {
  filterArtifacts,
  lineDiff,
  nextStatuses,
  type ArtifactStatus,
  type ArtifactType,
} from "../controllers/artifacts";
import { formatAgo } from "../format";
import { t, type MessageId } from "../i18n";
import { icons } from "../icons";
import { toSanitizedMarkdownHtml } from "../markdown";

const STATUS_KEY: Record<ArtifactStatus, MessageId> = {
  draft: "artifacts.status.draft",
  review: "artifacts.status.review",
  approved: "artifacts.status.approved",
};

const ACTION_KEY: Record<ArtifactStatus, MessageId> = {
  draft: "artifacts.action.draft",
  review: "artifacts.action.review",
  approved: "artifacts.action.approved",
};

const TYPES: ArtifactType[] = ["document", "table", "draft", "code", "other"];

export function statusChip(status: ArtifactStatus) {
  return html`<span class="ent-status ent-artifact-status--${status}">${t(STATUS_KEY[status])}</span>`;
}

function projectName(state: AppViewState, id: string | null): string {
  if (!id) {
    return "–";
  }
  return state.projects.projects.find((p) => p.id === id)?.name ?? id;
}

export function renderArtifactList(state: AppViewState, opts: { projectId?: string } = {}) {
  const a = state.artifacts;
  const projectFilter = opts.projectId ?? a.filterProject;
  const rows = filterArtifacts(
    projectFilter === "-" ? a.items.filter((x) => !x.projectId) : a.items,
    projectFilter === "-" ? "" : projectFilter,
    a.filterStatus,
  );
  return html`
    <div class="ent-toolbar">
      ${
        opts.projectId
          ? nothing
          : html`<select
            aria-label=${t("artifacts.filter.projectLabel")}
            .value=${a.filterProject}
            @change=${(e: Event) => state.patchArtifacts({ filterProject: (e.target as HTMLSelectElement).value })}
          >
            <option value="">${t("artifacts.filter.allProjects")}</option>
            <option value="-">${t("artifacts.filter.noProject")}</option>
            ${state.projects.projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
          </select>`
      }
      <select
        aria-label=${t("artifacts.filter.statusLabel")}
        .value=${a.filterStatus}
        @change=${(e: Event) =>
          state.patchArtifacts({
            filterStatus: (e.target as HTMLSelectElement).value as "" | ArtifactStatus,
          })}
      >
        <option value="">${t("artifacts.filter.allStatuses")}</option>
        ${(["draft", "review", "approved"] as const).map((s) => html`<option value=${s}>${t(STATUS_KEY[s])}</option>`)}
      </select>
      <button class="btn btn--sm" @click=${() => state.refreshArtifacts()}>${t("common.refresh")}</button>
    </div>
    ${a.error ? html`<div class="callout danger">${a.error}</div>` : nothing}
    <section class="card ent-card ent-card--wide">
      ${
        rows.length === 0
          ? html`<div class="ent-empty">${icons.package}<span>${t("artifacts.empty")}</span></div>`
          : html`<div class="ent-table-wrap"><table class="ent-table">
            <thead><tr>
              <th>${t("artifacts.col.title")}</th>
              <th>${t("artifacts.col.type")}</th>
              <th>${t("artifacts.col.status")}</th>
              ${opts.projectId ? nothing : html`<th>${t("artifacts.col.project")}</th>`}
              <th>${t("artifacts.col.version")}</th>
              <th>${t("artifacts.col.updated")}</th>
            </tr></thead>
            <tbody>${rows.map(
              (x) => html`<tr>
                <td><a href="#" class="ent-link" @click=${(e: Event) => {
                  e.preventDefault();
                  state.openArtifactPanel(x.id);
                }}>${x.title}</a></td>
                <td>${t(`artifacts.type.${x.type}` as MessageId)}</td>
                <td>${statusChip(x.status)}</td>
                ${opts.projectId ? nothing : html`<td>${projectName(state, x.projectId)}</td>`}
                <td>v${x.versions.at(-1)?.version ?? 1}</td>
                <td>${formatAgo(Date.parse(x.updatedAt))}</td>
              </tr>`,
            )}</tbody>
          </table></div>`
      }
    </section>
  `;
}

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportArtifact(state: AppViewState): Promise<void> {
  const cur = state.artifacts.current;
  const version = state.artifacts.currentVersion;
  if (!cur || version === null || state.artifacts.exporting) return;
  const stored = cur.versions.find((item) => item.version === version)?.sha256;
  state.patchArtifacts({ exporting: true, exportSha256: null, error: null });
  try {
    const exported = await buildArtifactExport({
      title: cur.title,
      version,
      status: cur.status,
      content: state.artifacts.content,
      storedContentSha256: stored,
    });
    download(exported.filename, exported.payload, "text/markdown;charset=utf-8");
    download(exported.sidecarFilename, exported.sidecarPayload, "text/plain;charset=utf-8");
    state.patchArtifacts({ exporting: false, exportSha256: exported.sha256 });
  } catch {
    state.patchArtifacts({ exporting: false, error: t("artifacts.panel.exportError") });
  }
}

function eventText(e: {
  action: string;
  version?: number;
  from?: ArtifactStatus;
  to?: ArtifactStatus;
}): string {
  if (e.action === "created") {
    return t("artifacts.event.created", { version: e.version ?? 1 });
  }
  if (e.action === "version") {
    return t("artifacts.event.version", { version: e.version ?? 0 });
  }
  return t("artifacts.event.status", {
    from: e.from ? t(STATUS_KEY[e.from]) : "",
    to: e.to ? t(STATUS_KEY[e.to]) : "",
  });
}

/** The side panel next to the chat (also opened from the Outputs page). */
export function renderArtifactPanel(state: AppViewState) {
  const a = state.artifacts;
  if (!a.panelOpen) {
    return nothing;
  }
  const cur = a.current;
  const ver = cur?.versions.find((v) => v.version === a.currentVersion) ?? cur?.versions.at(-1);
  return html`
    <aside class="ent-panel" role="complementary" aria-label=${cur?.title ?? ""}>
      <header class="ent-panel__head">
        <div class="ent-panel__title">${cur?.title ?? t("common.loading")}</div>
        <button class="btn btn--sm" @click=${() => state.patchArtifacts({ panelOpen: false })}>${t("artifacts.panel.close")}</button>
      </header>
      ${a.error ? html`<div class="callout danger">${a.error}</div>` : nothing}
      ${
        cur && ver
          ? html`
            <div class="ent-panel__row">
              ${statusChip(cur.status)}
              ${nextStatuses(cur.status).map(
                (
                  s,
                ) => html`<button class="btn btn--sm ${s === "approved" ? "primary" : ""}" ?disabled=${a.busy}
                  @click=${() => state.setArtifactStatus(s)}>${t(ACTION_KEY[s])}</button>`,
              )}
            </div>
            ${cur.status === "review" ? html`<div class="muted ent-small">${t("artifacts.panel.approvalRule")}</div>` : nothing}
            <div class="ent-panel__row">
              <label>${t("artifacts.panel.version")}
                <select .value=${String(ver.version)} @change=${(e: Event) =>
                  state.openArtifactPanel(cur.id, Number((e.target as HTMLSelectElement).value))}>
                  ${cur.versions.map((v) => html`<option value=${v.version}>v${v.version}</option>`)}
                </select>
              </label>
              <label>${t("artifacts.panel.compare")}
                <select .value=${a.compareVersion === null ? "" : String(a.compareVersion)} @change=${(
                  e: Event,
                ) => {
                  const v = (e.target as HTMLSelectElement).value;
                  void state.compareArtifact(v ? Number(v) : null);
                }}>
                  <option value="">${t("artifacts.panel.noCompare")}</option>
                  ${cur.versions.filter((v) => v.version !== ver.version).map((v) => html`<option value=${v.version}>v${v.version}</option>`)}
                </select>
              </label>
            </div>
            <div class="muted ent-small">
              ${t("artifacts.panel.meta", {
                version: ver.version,
                user: ver.createdByUser,
                agent: ver.createdByAgent
                  ? t("artifacts.panel.agent", { agent: ver.createdByAgent })
                  : "",
                date: new Date(ver.createdAt).toLocaleString(state.locale),
              })}
            </div>
            <div class="muted ent-small mono ent-wrap">${t("artifacts.panel.storedSha")}: ${ver.sha256}</div>
            ${
              a.exportSha256
                ? html`<div class="muted ent-small mono ent-wrap">${t("artifacts.panel.exportSha")}: ${a.exportSha256}</div>`
                : nothing
            }
            ${
              ver.sourceSession
                ? html`<div class="muted ent-small">${t("artifacts.panel.source")}: <a href="#" class="ent-link" @click=${(
                    e: Event,
                  ) => {
                    e.preventDefault();
                    state.openChatSession(ver.sourceSession ?? "");
                  }}>${ver.sourceSession}</a></div>`
                : nothing
            }
            <div class="ent-panel__body">
              ${
                a.editing
                  ? html`<textarea class="ent-editor mono" .value=${a.draft} @input=${(e: Event) =>
                      state.patchArtifacts({
                        draft: (e.target as HTMLTextAreaElement).value,
                      })}></textarea>`
                  : a.compareContent !== null
                    ? html`<pre class="ent-diff">${lineDiff(a.compareContent, a.content).map(
                        (l) =>
                          html`<div class="ent-diff__${l.type}">${l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}${l.text}</div>`,
                      )}</pre>`
                    : html`<div class="chat-text">${unsafeHTML(toSanitizedMarkdownHtml(a.content))}</div>`
              }
            </div>
            <div class="ent-panel__row">
              ${
                a.editing
                  ? html`<button class="btn btn--sm primary" ?disabled=${a.busy} @click=${() => state.saveArtifactVersion()}>${t("artifacts.panel.saveVersion")}</button>
                    <button class="btn btn--sm" @click=${() => state.patchArtifacts({ editing: false })}>${t("artifacts.panel.cancelEdit")}</button>`
                  : html`<button class="btn btn--sm" @click=${() => state.patchArtifacts({ editing: true, draft: a.content, compareContent: null, compareVersion: null })}>${t("artifacts.panel.edit")}</button>
                    <button class="btn btn--sm" ?disabled=${a.exporting} @click=${() => void exportArtifact(state)}>
                      ${icons.download} ${t(a.exporting ? "artifacts.panel.exporting" : "artifacts.panel.exportMd")}</button>`
              }
            </div>
            <div class="muted ent-small">${t("artifacts.panel.pdfNote")}</div>
            <div class="card-title ent-panel__sub">${t("artifacts.panel.history")}</div>
            <ul class="ent-list ent-small">
              ${cur.history
                .toReversed()
                .map(
                  (h) =>
                    html`<li><span class="mono">${new Date(h.at).toLocaleString(state.locale)}</span> ${eventText(h)} <span class="muted mono">${h.by}</span></li>`,
                )}
            </ul>
          `
          : nothing
      }
    </aside>
  `;
}

/** "Save as output" dialog. */
export function renderSaveArtifactDialog(state: AppViewState) {
  const f = state.artifacts.saveForm;
  if (!f) {
    return nothing;
  }
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-modal="true" aria-label=${t("artifacts.saveTitle")}>
      <div class="exec-approval-card ent-dialog">
        <div class="exec-approval-title">${t("artifacts.saveTitle")}</div>
        <label class="field ent-field"><span>${t("artifacts.saveField.title")}</span>
          <input .value=${f.title} @input=${(e: Event) =>
            state.patchArtifacts({
              saveForm: { ...f, title: (e.target as HTMLInputElement).value },
            })} />
        </label>
        <label class="field ent-field"><span>${t("artifacts.saveField.type")}</span>
          <select .value=${f.type} @change=${(e: Event) =>
            state.patchArtifacts({
              saveForm: { ...f, type: (e.target as HTMLSelectElement).value as ArtifactType },
            })}>
            ${TYPES.map((x) => html`<option value=${x}>${t(`artifacts.type.${x}` as MessageId)}</option>`)}
          </select>
        </label>
        <label class="field ent-field"><span>${t("artifacts.saveField.content")}</span>
          <textarea class="ent-editor mono" .value=${f.content} @input=${(e: Event) =>
            state.patchArtifacts({
              saveForm: { ...f, content: (e.target as HTMLTextAreaElement).value },
            })}></textarea>
        </label>
        ${state.artifacts.error ? html`<div class="callout danger">${state.artifacts.error}</div>` : nothing}
        <div class="exec-approval-actions">
          <button class="btn primary" ?disabled=${state.artifacts.busy || !f.title.trim() || !f.content.trim()}
            @click=${() => state.submitArtifactSave()}>${t("artifacts.saveSubmit")}</button>
          <button class="btn" @click=${() => state.patchArtifacts({ saveForm: null, error: null })}>${t("projects.form.cancel")}</button>
        </div>
      </div>
    </div>
  `;
}
