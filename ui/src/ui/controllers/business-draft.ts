import type { Artifact } from "./artifacts";
import type { BusinessHost, BusinessDraftPreview } from "./business";

/** Read the exact pinned version. A preview is never an approval or evidence verification. */
export async function loadBusinessDraft(host: BusinessHost) {
  const client = host.client;
  const item = host.business.item;
  const draft = item?.draft;
  if (
    !client ||
    !host.connected ||
    host.tab !== "projects" ||
    host.projects.view !== "business" ||
    !item ||
    !draft ||
    item.projectId !== host.projects.selectedId ||
    item.projectId !== host.business.projectId ||
    item.id !== host.business.selectedId ||
    host.business.detailLoading ||
    host.business.draftPreview?.status === "loading"
  ) {
    return;
  }
  const preview: BusinessDraftPreview = {
    itemId: item.id,
    revision: item.revision,
    status: "loading",
    content: null,
  };
  host.business = { ...host.business, draftPreview: preview };
  const current = () =>
    host.client === client &&
    host.connected &&
    host.tab === "projects" &&
    host.projects.view === "business" &&
    host.projects.selectedId === item.projectId &&
    host.business.item === item &&
    host.business.selectedId === item.id &&
    host.business.draftPreview === preview;
  try {
    const result = await client.request<{ artifact: Artifact; version: number; content: string }>(
      "artifacts.get",
      { id: draft.artifactId, version: draft.version },
    );
    if (!current()) {
      return;
    }
    const version = result.artifact.versions.find((entry) => entry.version === draft.version);
    if (
      result.artifact.id !== draft.artifactId ||
      result.artifact.projectId !== item.projectId ||
      result.version !== draft.version ||
      version?.sha256 !== draft.sha256 ||
      typeof result.content !== "string"
    ) {
      throw new Error("Pinned draft mismatch");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.content));
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== draft.sha256) {
      throw new Error("Pinned draft content mismatch");
    }
    if (current()) {
      host.business = {
        ...host.business,
        draftPreview: { ...preview, status: "ready", content: result.content },
      };
    }
  } catch {
    if (current()) {
      host.business = { ...host.business, draftPreview: { ...preview, status: "error" } };
    }
  }
}
