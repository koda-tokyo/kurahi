/* eslint-disable no-control-regex -- Terminal input rejects control bytes; output strips escape actions. */
import { html, nothing } from "lit";
import type { TerminalEvent } from "../../../../packages/client/src/generated/types";
import type { AppViewState } from "../app-view-state";
import { projectModeOf, type Project } from "../controllers/projects";
import { t } from "../i18n";

export function terminalEventText(event: TerminalEvent): string {
  if (event.type === "stdout" || event.type === "stderr") {
    // Strip CSI/OSC and controls. No links, HTML, clipboard or cursor escape execution.
    return event.data
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  }
  if (event.type === "exit") {
    return `\n[exit: ${event.exitCode ?? event.signal ?? event.reason}]\n`;
  }
  if (event.type === "notice") {
    return `\n[${event.code}]\n`;
  }
  if (event.type === "approval.requested") {
    return `\n[approval.requested] ${event.command}\n`;
  }
  if (event.type === "approval.resolved") {
    return `\n[approval.resolved: ${event.decision}]\n`;
  }
  const violations = event.violations ? `, read-only-path: ${event.violations}` : "";
  return `\n[file.diff: ${event.totals.files} files, +${event.totals.added}/-${event.totals.removed}${violations}]\n`;
}

export function renderTerminal(state: AppViewState, project: Project) {
  const terminal = state.terminal;
  const session = terminal.session?.projectId === project.id ? terminal.session : null;
  const other = terminal.session && !session && !terminal.closed;
  const read = projectModeOf(project) === "read";
  const disabled = !state.connected || terminal.busy;
  const pending = state.execApprovalQueue.some(
    (entry) =>
      entry.request.sessionKey === `terminal:${session?.sessionId}` &&
      entry.expiresAtMs > Date.now(),
  );
  return html`
    <section class="card ent-card ent-card--wide project-terminal" aria-label=${t("terminal.title")}>
      <h2 class="card-title">${t("terminal.title")}</h2>
      ${!state.connected ? html`<p role="status">${t("terminal.offline")}</p>` : nothing}
      ${read ? html`<p>${t("terminal.read")}</p>` : nothing}
      ${
        other
          ? html`<p>${t("terminal.other")}</p>`
          : html`
        ${terminal.error ? html`<p class="callout danger" role="alert">${t("terminal.error")}</p>` : nothing}
        ${
          !session || terminal.closed
            ? html`
          <p>${t(terminal.closed ? "terminal.closed" : "terminal.empty")}</p>
          <button class="btn" ?disabled=${disabled || read} @click=${() => state.openProjectTerminal(project)}>${t("terminal.open")}</button>
        `
            : html`
          <p class="mono ent-wrap">${session.cwd}</p>
          <p>${t(session.sandboxed ? "terminal.sandbox" : "terminal.host")}</p>
          <div class="ent-actions">
            <button class="btn" ?disabled=${disabled} @click=${() => state.runTerminalAction("cancel", project)}>${t("terminal.cancel")}</button>
            <button class="btn" ?disabled=${disabled} @click=${() => state.runTerminalAction("close", project)}>${t("terminal.close")}</button>
            <button class="btn" ?disabled=${!state.connected || terminal.replaying} @click=${() => state.refreshTerminal()}>${t("terminal.refresh")}</button>
          </div>
          <p role="status">${t(terminal.synced ? "terminal.ready" : "terminal.syncing")}</p>
          ${pending ? html`<p role="status">${t("terminal.approval")}</p>` : nothing}
          <form @submit=${(event: Event) => {
            event.preventDefault();
            void state.runTerminalAction("input", project);
          }}>
            <label class="field"><span>${t("terminal.input")}</span>
              <input class="mono" .value=${terminal.draft} maxlength=${session.limits.maxLineLength}
                autocomplete="off" spellcheck="false" ?disabled=${disabled || read || !terminal.synced || pending}
                @input=${(event: Event) => state.patchTerminalDraft((event.target as HTMLInputElement).value)} />
            </label>
            <p class="muted">${t("terminal.lineHint")}</p>
            <button class="btn primary" type="submit" ?disabled=${disabled || read || !terminal.synced || pending || !terminal.draft.trim()}>${t("terminal.send")}</button>
          </form>
        `
        }
        ${terminal.truncated ? html`<p>${t("terminal.truncated")}</p>` : nothing}
        <pre class="project-terminal__output" tabindex="0" aria-label=${t("terminal.output")}>${session ? terminal.events.map(terminalEventText).join("") : ""}</pre>
      `
      }
    </section>
  `;
}
