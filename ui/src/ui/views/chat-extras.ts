// Chat additions (v0.3): the conversation history panel, document upload and the agent / model
// picker in the chat box, and approval cards inside the conversation.
import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state";
import { chatTitle, groupHistory } from "../controllers/chat-history";
import { allowedAgents, allowedModels, modelLabel } from "../controllers/picker";
import { projectIdOfSession } from "../controllers/projects";
import { ACCEPT } from "../controllers/uploads";
import { formatAgo } from "../format";
import { t, type MessageId } from "../i18n";
import { icons } from "../icons";

export function currentProject(state: AppViewState) {
  const pid = projectIdOfSession(state.sessionKey);
  return pid ? (state.projects.projects.find((p) => p.id === pid) ?? null) : null;
}

// ---- history panel ----

export function renderChatHistoryPanel(state: AppViewState) {
  const h = state.chatHistory;
  if (!h.open) {
    return html`<button class="ent-history-toggle btn btn--sm" title=${t("chat.history.show")} aria-label=${t("chat.history.show")}
      @click=${() => state.patchChatHistory({ open: true })}>${icons.menu}</button>`;
  }
  const groups = groupHistory(h.rows, {
    projects: state.projects.projects,
    archived: h.archived,
    showArchived: h.showArchived,
    query: h.query,
    textHits: h.textHits,
    noProjectLabel: t("chat.history.noProject"),
  });
  const admin = state.audience !== "business";
  return html`
    <aside class="ent-history" aria-label=${t("chat.history.title")}>
      <div class="ent-history__head">
        <strong>${t("chat.history.title")}</strong>
        <button class="btn btn--sm" title=${t("chat.history.hide")} aria-label=${t("chat.history.hide")}
          @click=${() => state.patchChatHistory({ open: false })}>${icons.x}</button>
      </div>
      <button class="btn primary ent-history__new" @click=${() => state.startNewChat()}>${t("chat.history.new")}</button>
      <label class="ent-search">
        <span class="sr-only">${t("chat.history.search")}</span>
        ${icons.search}
        <input type="search" .value=${h.query} placeholder=${t("chat.history.search")}
          @input=${(e: Event) => state.patchChatHistory({ query: (e.target as HTMLInputElement).value, textHits: null })}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              void state.searchChats();
            }
          }} />
      </label>
      <label class="ent-check">
        <input type="checkbox" .checked=${h.showArchived}
          @change=${(e: Event) => state.patchChatHistory({ showArchived: (e.target as HTMLInputElement).checked })} />
        ${t("chat.history.showArchived")}
      </label>
      ${h.error ? html`<div class="callout danger ent-small">${h.error}</div>` : nothing}
      <div class="ent-history__list">
        ${groups.length === 0 ? html`<div class="muted ent-small">${t("chat.history.empty")}</div>` : nothing}
        ${groups.map(
          (g) => html`
            <div class="ent-history__group">${g.projectId ? icons.folder : nothing}<span>${g.name}</span></div>
            ${g.rows.map((r) => {
              const active = r.key === state.sessionKey;
              if (h.renaming === r.key) {
                return html`<div class="ent-history__item active">
                  <input class="ent-history__rename" .value=${h.renameValue}
                    @input=${(e: Event) => state.patchChatHistory({ renameValue: (e.target as HTMLInputElement).value })}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter") {
                        void state.renameChat(r.key, h.renameValue);
                      }
                      if (e.key === "Escape") {
                        state.patchChatHistory({ renaming: null });
                      }
                    }} />
                  <button class="btn btn--sm" @click=${() => state.renameChat(r.key, h.renameValue)}>${t("chat.history.save")}</button>
                </div>`;
              }
              const archived = h.archived.includes(r.key);
              return html`<div class="ent-history__item ${active ? "active" : ""}">
                <button class="ent-history__open" @click=${() => state.openChatSession(r.key)} title=${chatTitle(r)}>
                  <span class="ent-history__name">${chatTitle(r)}</span>
                  <span class="muted ent-small">${formatAgo(r.updatedAt ?? 0)}</span>
                </button>
                <span class="ent-history__actions">
                  ${
                    admin
                      ? html`<button class="ent-icon-btn" title=${t("chat.history.rename")} aria-label=${t("chat.history.rename")}
                        @click=${() => state.patchChatHistory({ renaming: r.key, renameValue: r.label ?? chatTitle(r) })}>${icons.penLine}</button>`
                      : nothing
                  }
                  <button class="ent-icon-btn" title=${t(archived ? "chat.history.unarchive" : "chat.history.archive")}
                    aria-label=${t(archived ? "chat.history.unarchive" : "chat.history.archive")}
                    @click=${() => state.archiveChat(r.key, !archived)}>${archived ? icons.repeat : icons.package}</button>
                </span>
              </div>`;
            })}
          `,
        )}
      </div>
    </aside>
  `;
}

// ---- compose extras: project chip, picker, upload ----

const UPLOAD_ERROR: Record<string, MessageId> = {
  type: "upload.error.type",
  size: "upload.error.size",
  empty: "upload.error.empty",
};

export function renderComposeExtras(state: AppViewState) {
  const project = currentProject(state);
  const agents = allowedAgents(
    state.agentsList?.agents ?? [],
    state.agentsList?.defaultId ?? "main",
    project,
  );
  const currentAgent =
    /^agent:([^:]+):/.exec(state.sessionKey)?.[1] ?? state.agentsList?.defaultId ?? "main";
  const admin = state.audience !== "business";
  const config = state.configSnapshot?.config ?? null;
  const models = admin ? allowedModels(config, project) : [];
  const row = state.sessionsResult?.sessions?.find((s) => s.key === state.sessionKey);
  const currentModel = row?.model && row.modelProvider ? `${row.modelProvider}/${row.model}` : "";
  const u = state.uploads;
  return html`
    <div class="ent-compose-extras">
      ${project ? html`<span class="chip ent-project-chip">${icons.folder} ${t("chat.project", { name: project.name })}</span>` : nothing}
      ${
        agents.length > 0
          ? html`<label class="ent-picker">${t("picker.agent")}
            <select .value=${currentAgent} @change=${(e: Event) => state.pickAgent((e.target as HTMLSelectElement).value)}>
              ${agents.map((a) => html`<option value=${a.id} ?selected=${a.id === currentAgent}>${a.label}</option>`)}
            </select>
          </label>`
          : nothing
      }
      ${
        models.length > 0
          ? html`<label class="ent-picker">${t("picker.model")}
            <select @change=${(e: Event) => state.pickModel((e.target as HTMLSelectElement).value)}>
              <option value="" ?selected=${!currentModel}>${t("picker.modelDefault")}</option>
              ${models.map(
                (m) =>
                  html`<option value=${m} ?selected=${m === currentModel}>${modelLabel(config, m)}</option>`,
              )}
            </select>
          </label>`
          : nothing
      }
      <label class="btn btn--sm ent-attach" title=${t("upload.attach")}>
        ${icons.paperclip} ${t("upload.attach")}
        <input type="file" accept=${ACCEPT} hidden ?disabled=${u.busy || !state.connected}
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const files = [...(input.files ?? [])];
            input.value = "";
            void state.uploadFiles(files);
          }} />
      </label>
      ${u.busy ? html`<span class="muted ent-small">${t("upload.uploading", { progress: u.progress })}</span>` : nothing}
      ${u.error ? html`<span class="ent-error ent-small">${UPLOAD_ERROR[u.error] ? t(UPLOAD_ERROR[u.error]) : u.error}</span>` : nothing}
      ${u.documents.map(
        (d, i) => html`<span class="chip ent-doc-chip" title=${d.path}>
          ${icons.fileText} ${d.name}
          <span class="muted">· ${d.text ? t("upload.chars", { count: d.textChars }) : t("upload.noText")}
            · ${t(d.projectId ? "upload.where.project" : "upload.where.scratch")}</span>
          <button class="ent-icon-btn" aria-label=${t("upload.remove")} title=${t("upload.remove")}
            @click=${() => state.patchUploads({ documents: u.documents.filter((_, j) => j !== i) })}>${icons.x}</button>
        </span>`,
      )}
    </div>
  `;
}

// ---- approvals inside the chat ----

export function renderInlineApprovals(state: AppViewState) {
  const items = state.execApprovalQueue.filter((q) => q.request.sessionKey === state.sessionKey);
  if (items.length === 0) {
    return nothing;
  }
  return html`
    <div class="ent-inline-approvals">
      ${items.map(
        (
          q,
        ) => html`<div class="ent-inline-approval" role="group" aria-label=${t("approvals.inline.title")}>
          <div class="ent-inline-approval__head">${icons.shieldCheck}<strong>${t("approvals.inline.title")}</strong>
            <span class="muted ent-small">${t("approvals.inline.expires", { time: new Date(q.expiresAtMs).toLocaleTimeString(state.locale) })}</span>
          </div>
          <pre class="mono ent-inline-approval__cmd">${q.request.command}</pre>
          ${q.request.cwd ? html`<div class="muted ent-small">${t("approvals.inline.folder")}: <span class="mono">${q.request.cwd}</span></div>` : nothing}
          <div class="ent-actions">
            <button class="btn btn--sm primary" ?disabled=${state.execApprovalBusy} @click=${() => state.decideApproval(q.id, "allow-once")}>${t("approvals.inline.approve")}</button>
            <button class="btn btn--sm" ?disabled=${state.execApprovalBusy} @click=${() => state.decideApproval(q.id, "allow-always")}>${t("approvals.inline.always")}</button>
            <button class="btn btn--sm danger" ?disabled=${state.execApprovalBusy} @click=${() => state.decideApproval(q.id, "deny")}>${t("approvals.inline.reject")}</button>
          </div>
        </div>`,
      )}
    </div>
  `;
}
