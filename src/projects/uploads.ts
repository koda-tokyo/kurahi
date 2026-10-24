// Chunked uploads over the gateway WebSocket (frames are capped at 512 KB, documents may be
// 20 MB). begin → chunk… → commit. Files land in the project's attachments area, or in the
// user's scratch area when no project is given; never anywhere a caller chooses.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveKoloHome } from "../config/kolo-home.js";
import {
  extractText,
  kindFromName,
  MAX_UPLOAD_BYTES,
  safeFileName,
  validateDocument,
  type DocumentKind,
} from "./documents.js";
import { getProject, projectDataDir, scratchDir } from "./store.js";

export const MAX_CHUNK_BYTES = 256 * 1024;
const UPLOAD_TTL_MS = 10 * 60_000;
const MAX_OPEN_UPLOADS = 16;
/** Text returned to the client to include in a message; the full text stays on disk. */
export const MAX_RETURNED_TEXT_CHARS = 20_000;

type OpenUpload = {
  id: string;
  user: string;
  projectId: string | null;
  name: string;
  size: number;
  chunks: Buffer[];
  received: number;
  nextSeq: number;
  expiresAt: number;
};

const open = new Map<string, OpenUpload>();

function sweep(now: number) {
  for (const [id, u] of open) {
    if (u.expiresAt < now) {
      open.delete(id);
    }
  }
}

export type BeginInput = { name?: unknown; size?: unknown; projectId?: unknown };

export function beginUpload(
  input: BeginInput,
  user: string,
  now = Date.now(),
): { uploadId: string; chunkBytes: number } {
  sweep(now);
  const name = typeof input.name === "string" ? safeFileName(input.name) : "";
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : -1;
  if (!name || !kindFromName(name)) {
    throw new Error("unsupported file type");
  }
  if (size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw new Error(`file size must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }
  let projectId: string | null = null;
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== "") {
    const project = typeof input.projectId === "string" ? getProject(input.projectId) : null;
    if (!project || project.archived) {
      throw new Error("project not found");
    }
    projectId = project.id;
  }
  if (open.size >= MAX_OPEN_UPLOADS) {
    throw new Error("too many uploads in progress");
  }
  const id = `u${randomBytes(12).toString("hex")}`;
  open.set(id, {
    id,
    user,
    projectId,
    name,
    size,
    chunks: [],
    received: 0,
    nextSeq: 0,
    expiresAt: now + UPLOAD_TTL_MS,
  });
  return { uploadId: id, chunkBytes: MAX_CHUNK_BYTES };
}

function take(uploadId: unknown, user: string): OpenUpload {
  const u = typeof uploadId === "string" ? open.get(uploadId) : undefined;
  if (!u || u.user !== user) {
    throw new Error("unknown upload");
  }
  return u;
}

export function appendChunk(
  input: { uploadId?: unknown; seq?: unknown; data?: unknown },
  user: string,
): { received: number } {
  const u = take(input.uploadId, user);
  if (input.seq !== u.nextSeq) {
    throw new Error("chunk out of order");
  }
  if (typeof input.data !== "string") {
    throw new Error("chunk data must be base64");
  }
  const buf = Buffer.from(input.data, "base64");
  if (buf.length === 0 || buf.length > MAX_CHUNK_BYTES) {
    throw new Error("invalid chunk size");
  }
  if (u.received + buf.length > u.size) {
    open.delete(u.id);
    throw new Error("more data than the declared size");
  }
  u.chunks.push(buf);
  u.received += buf.length;
  u.nextSeq += 1;
  u.expiresAt = Date.now() + UPLOAD_TTL_MS;
  return { received: u.received };
}

export function abortUpload(uploadId: unknown, user: string): void {
  const u = take(uploadId, user);
  open.delete(u.id);
}

export type StoredDocument = {
  name: string;
  kind: DocumentKind;
  size: number;
  sha256: string;
  /** Absolute path on the gateway host. */
  path: string;
  projectId: string | null;
  /** Extracted text (capped for the reply); empty for images. */
  text: string;
  textChars: number;
  textTruncated: boolean;
};

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/** Where an upload is stored: the project's attachments area, or the user's scratch area. */
export function uploadDir(
  projectId: string | null,
  user: string,
  home = resolveKoloHome(),
): string {
  return projectId
    ? path.join(projectDataDir(projectId, home), "attachments")
    : path.join(scratchDir(user, home), "attachments");
}

export async function commitUpload(
  input: { uploadId?: unknown; sha256?: unknown },
  user: string,
  opts: { home?: string; now?: Date } = {},
): Promise<StoredDocument> {
  const u = take(input.uploadId, user);
  open.delete(u.id);
  if (u.received !== u.size) {
    throw new Error("upload incomplete");
  }
  const buf = Buffer.concat(u.chunks);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (typeof input.sha256 === "string" && input.sha256 && input.sha256.toLowerCase() !== sha256) {
    throw new Error("checksum mismatch");
  }
  const check = await validateDocument(u.name, buf);
  if (!check.ok) {
    throw new Error(check.error);
  }
  const dir = uploadDir(u.projectId, user, opts.home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${stamp(opts.now ?? new Date())}-${u.name}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  let text = "";
  try {
    text = await extractText(check.kind, buf);
  } catch {
    text = "";
  }
  if (text) {
    fs.writeFileSync(`${file}.extracted.txt`, text, { mode: 0o600 });
  }
  return {
    name: u.name,
    kind: check.kind,
    size: buf.length,
    sha256,
    path: file,
    projectId: u.projectId,
    text: text.slice(0, MAX_RETURNED_TEXT_CHARS),
    textChars: text.length,
    textTruncated: text.length > MAX_RETURNED_TEXT_CHARS,
  };
}

/** Test hook. */
export function resetUploadsForTest(): void {
  open.clear();
}
