// Document upload from the chat box (v0.3): chunked over the gateway WebSocket, validated and
// text-extracted on the gateway, then attached to the next message as a document block.
import type { GatewayBrowserClient } from "../gateway";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const ACCEPT =
  ".pdf,.xlsx,.docx,.csv,.txt,.md,.markdown,.png,.jpg,.jpeg,.gif,.webp,application/pdf,text/plain,text/csv,text/markdown";
const DOC_EXT = /\.(pdf|xlsx|docx|csv|txt|md|markdown|png|jpe?g|gif|webp)$/i;

export type UploadedDocument = {
  name: string;
  kind: string;
  size: number;
  sha256: string;
  path: string;
  projectId: string | null;
  text: string;
  textChars: number;
  textTruncated: boolean;
};

export type UploadState = {
  busy: boolean;
  progress: number;
  error: string | null;
  documents: UploadedDocument[];
};

export const DEFAULT_UPLOAD_STATE: UploadState = {
  busy: false,
  progress: 0,
  error: null,
  documents: [],
};

/** Client-side pre-check (the gateway checks again, by content). */
export function precheckFile(file: { name: string; size: number }): string | null {
  if (!DOC_EXT.test(file.name)) {
    return "type";
  }
  if (file.size <= 0) {
    return "empty";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return "size";
  }
  return null;
}

/** Byte ranges for a file split into chunks of `chunk` bytes. */
export function chunkRanges(size: number, chunk: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = 0; start < size; start += chunk) {
    out.push([start, Math.min(size, start + chunk)]);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const BLOCK_RE = /\[\[kurahi-document name="([^"\]]*)"[^\]]*\]\][\s\S]*?\[\[\/kurahi-document\]\]/g;

function attr(v: string): string {
  return v.replace(/["\]\n]/g, "_");
}

/** The message sent to the agent: the user's text plus one block per attached document. */
export function composeWithDocuments(message: string, docs: UploadedDocument[]): string {
  if (docs.length === 0) {
    return message;
  }
  const blocks = docs.map((d) => {
    const head = `[[kurahi-document name="${attr(d.name)}" kind="${attr(d.kind)}" path="${attr(d.path)}"]]`;
    const body = d.text
      ? `${d.text}${d.textTruncated ? `\n[... ${d.textChars - d.text.length} more characters in ${d.path}.extracted.txt]` : ""}`
      : `[No text could be extracted. The file is stored at ${d.path}.]`;
    return `${head}\n${body}\n[[/kurahi-document]]`;
  });
  return `${message.trim()}\n\n${blocks.join("\n\n")}`;
}

/** What people see instead of a document block (in the chat and in history). */
export function collapseDocumentBlocks(text: string, label: (name: string) => string): string {
  return stripProjectMarkers(text.replace(BLOCK_RE, (_m, name: string) => label(name)));
}

/**
 * Lines carrying the gateway's project-context markers. Small models sometimes repeat the
 * context they were given; it is not part of the answer, so it is not shown or saved.
 */
export function stripProjectMarkers(text: string): string {
  if (!text.includes("kurahi-project]]")) {
    return text;
  }
  return text
    .replace(/\[\[kurahi-project\]\][\s\S]*?\[\[\/kurahi-project\]\]/g, "")
    .replace(/^.*\[\[\/?kurahi-project\]\].*$\n?/gm, "")
    .trim();
}

type Host = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  uploads: UploadState;
};

function patch(host: Host, next: Partial<UploadState>) {
  host.uploads = { ...host.uploads, ...next };
}

export async function uploadFile(
  host: Host,
  file: File,
  projectId: string | null,
): Promise<UploadedDocument | null> {
  if (!host.client || !host.connected) {
    return null;
  }
  const pre = precheckFile(file);
  if (pre) {
    patch(host, { error: pre });
    return null;
  }
  patch(host, { busy: true, progress: 0, error: null });
  let uploadId = "";
  try {
    const begin = (await host.client.request("files.upload.begin", {
      name: file.name,
      size: file.size,
      projectId: projectId ?? undefined,
    })) as { uploadId: string; chunkBytes: number };
    uploadId = begin.uploadId;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ranges = chunkRanges(bytes.length, begin.chunkBytes);
    for (const [seq, [a, b]] of ranges.entries()) {
      await host.client.request("files.upload.chunk", {
        uploadId,
        seq,
        data: toBase64(bytes.subarray(a, b)),
      });
      patch(host, { progress: Math.round(((seq + 1) / ranges.length) * 100) });
    }
    const res = (await host.client.request("files.upload.commit", { uploadId })) as {
      document: UploadedDocument;
    };
    patch(host, {
      busy: false,
      progress: 100,
      documents: [...host.uploads.documents, res.document],
    });
    return res.document;
  } catch (err) {
    if (uploadId) {
      void host.client.request("files.upload.abort", { uploadId }).catch(() => {});
    }
    patch(host, { busy: false, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
