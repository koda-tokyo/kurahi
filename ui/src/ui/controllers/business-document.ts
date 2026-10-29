import type { WorkitemsDocumentResult } from "../../../../packages/client/src/generated/types";
import type { BusinessDocumentPreview, BusinessHost } from "./business";

const MAX_CHARS = 20_000;

/** The gateway HTML-escapes document text; Lit escapes again when it renders text bindings. */
export function unescapeBusinessDocumentText(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Read one source document. Text is untrusted data and is withheld when the bytes changed. */
export async function loadBusinessDocument(host: BusinessHost, ref: string) {
  const client = host.client;
  const item = host.business.item;
  const doc = item?.source.documents.find((entry) => entry.ref === ref);
  if (
    !client ||
    !host.connected ||
    host.tab !== "projects" ||
    host.projects.view !== "business" ||
    !item ||
    !doc ||
    item.projectId !== host.projects.selectedId ||
    item.projectId !== host.business.projectId ||
    item.id !== host.business.selectedId ||
    host.business.detailLoading ||
    host.business.documentPreview?.status === "loading"
  ) {
    return;
  }
  const preview: BusinessDocumentPreview = {
    itemId: item.id,
    revision: item.revision,
    ref,
    status: "loading",
    text: null,
    textSource: null,
    extractError: null,
    truncated: false,
  };
  host.business = { ...host.business, documentPreview: preview };
  const current = () =>
    host.client === client &&
    host.connected &&
    host.tab === "projects" &&
    host.projects.view === "business" &&
    host.projects.selectedId === item.projectId &&
    host.business.item === item &&
    host.business.selectedId === item.id &&
    host.business.documentPreview === preview;
  try {
    const result = await client.request<WorkitemsDocumentResult>("workitems.document", {
      projectId: item.projectId,
      id: item.id,
      ref,
      maxChars: MAX_CHARS,
    });
    if (!current()) {
      return;
    }
    const document = result?.document;
    if (
      !document ||
      document.ref !== ref ||
      !document.untrusted ||
      document.escaped !== "html" ||
      (document.text !== null && typeof document.text !== "string") ||
      (doc.sha256 !== undefined && document.recordedSha256 !== doc.sha256)
    ) {
      throw new Error("Document mismatch");
    }
    // Never show text from bytes that differ from the recorded hash.
    const changed = document.sha256Matches === false;
    host.business = {
      ...host.business,
      documentPreview: {
        ...preview,
        status: changed ? "changed" : "ready",
        text:
          changed || document.text === null ? null : unescapeBusinessDocumentText(document.text),
        textSource: changed ? null : document.textSource,
        extractError: changed ? null : document.extractError,
        truncated: !changed && document.truncated,
      },
    };
  } catch {
    if (current()) {
      host.business = { ...host.business, documentPreview: { ...preview, status: "error" } };
    }
  }
}
