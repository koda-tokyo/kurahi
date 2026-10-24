import { html } from "lit";
import type { AppViewState } from "../app-view-state";
import {
  getEditionManifest,
  getWorkspaceManifest,
  resolveWorkspaceId,
  type EditionId,
  type WorkspaceId,
} from "../editions/manifests";
import { t, type MessageId } from "../i18n";
import { currentProject } from "./chat-extras";

const EDITION_LABELS: Readonly<Record<EditionId, MessageId>> = {
  industrial: "frame.edition.industrial",
  business: "frame.edition.business",
  scholars: "frame.edition.scholars",
  core: "frame.edition.core",
};

const WORKSPACE_LABELS: Readonly<Record<WorkspaceId, MessageId>> = {
  industrial: "frame.workspace.industrial",
  backoffice: "frame.workspace.backoffice",
  research: "frame.workspace.research",
  education: "frame.workspace.education",
  generic: "frame.workspace.generic",
};

export function resolveFrameSelection(state: AppViewState) {
  const editionId = state.settings.edition ?? "industrial";
  const workspaceId = resolveWorkspaceId(editionId, state.settings.workspace);
  return {
    edition: getEditionManifest(editionId),
    workspace: getWorkspaceManifest(workspaceId),
  };
}

export function renderSharedFrameContext(state: AppViewState) {
  const { edition, workspace } = resolveFrameSelection(state);
  const selectedProject =
    currentProject(state) ??
    state.projects.projects.find((project) => project.id === state.projects.selectedId) ??
    null;

  return html`
    <div class="frame-context" aria-label=${t("frame.context")}>
      <span class="frame-context__product">${t(EDITION_LABELS[edition.id])}</span>
      <span class="frame-context__divider" aria-hidden="true"></span>
      <span class="frame-context__workspace">${t(WORKSPACE_LABELS[workspace.id])}</span>
      <span class="frame-context__item">
        <span class="frame-context__label">${t("frame.project")}</span>
        <strong>${selectedProject?.name ?? t("frame.project.none")}</strong>
      </span>
      <span class="frame-context__item">
        <span class="frame-context__label">${t("frame.mode")}</span>
        <strong>${selectedProject?.mode ?? t("frame.mode.none")}</strong>
      </span>
    </div>
  `;
}
