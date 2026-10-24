import { html } from "lit";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { emptyVoice } from "../controllers/voice";
import { t } from "../i18n";

export function renderVoice(state: AppViewState, project: Project) {
  const voice = state.voice ?? emptyVoice();
  const phase = voice.projectId === project.id ? voice.phase : "idle";
  const active = phase === "starting" || phase === "recording" || phase === "stopping";
  const available = Boolean(state.voiceCapture);
  return html`
    <section class="industrial-voice-panel" aria-label=${t("voice.title")}>
      <div class="industrial-voice-actions">
        <button class="btn industrial-voice" type="button"
          ?disabled=${!available || !state.connected || active || phase === "ready"}
          @click=${() => state.startProjectVoice(project)}>${t("voice.start")}</button>
        ${
          phase === "recording"
            ? html`<button class="btn" type="button"
          @click=${() => state.stopProjectVoice()}>${t("voice.stop")}</button>`
            : ""
        }
        ${
          active || phase === "ready"
            ? html`<button class="btn" type="button"
          @click=${() => state.cancelProjectVoice()}>${t("voice.cancel")}</button>`
            : ""
        }
      </div>
      <p class="muted ent-small" role="status">${
        !available
          ? t("voice.unavailable")
          : !state.connected
            ? t("voice.disconnected")
            : t(`voice.${phase}`)
      }</p>
      ${
        phase === "ready"
          ? html`
        <label>${t("voice.transcript")}
          <textarea .value=${voice.text} maxlength="100000"
            @input=${(e: Event) => state.patchVoiceText((e.target as HTMLTextAreaElement).value)}></textarea>
        </label>
        <button class="btn" type="button" ?disabled=${!state.connected || !voice.text.trim()}
          @click=${() => state.useVoiceDraft(project)}>${t("voice.use")}</button>
      `
          : active && voice.text
            ? html`<p>${voice.text}</p>`
            : ""
      }
      <p class="muted ent-small">${t("voice.review")}</p>
    </section>
  `;
}
