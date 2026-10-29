// Safe previews of a work item's documents and diffs of its draft versions.
//
// Only references the item itself holds are served: one of its source documents (re-checked to
// still be inside the Project: its attachments area, its folder, or a Project artifact) or its
// pinned draft artifact. Text is extracted from text-like content only (binary files answer
// `binary: true` and no text), capped, stripped of control characters and HTML-escaped. PDF and
// Office sources get their text from the document extractors in the bounded child process
// (previewDocumentText), and only while their bytes still match the recorded SHA-256. Every
// preview is flagged `untrusted`: documents come from outside and may contain instructions.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "../projects/types.js";
import type { WorkItem } from "./types.js";
import { getArtifact, type Artifact } from "../projects/artifacts.js";
import { kindFromName, type DocumentKind } from "../projects/documents.js";
import { cleanRelPath, excludedPathRegexes, projectDataDir } from "../projects/store.js";
import { extractTextIsolated, type IsolatedExtractOptions } from "../security/isolated-extract.js";
import { diffLines, toHunks, type DiffHunk } from "./diff.js";
import { WorkItemRefused } from "./errors.js";

export const PREVIEW_MAX_CHARS = 64_000;
const READ_MAX_BYTES = 1024 * 1024;
const HASH_MAX_BYTES = 64 * 1024 * 1024;
const DIFF_MAX_LINES = 5000;
const DIFF_MAX_LINE_CHARS = 2000;
const DIFF_MAX_OUTPUT_LINES = 4000;

const MEDIA: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Drop control characters (keep tab and newline), normalise newlines, remove a BOM. */
function cleanText(s: string): string {
  let out = "";
  for (const ch of s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")) {
    const c = ch.charCodeAt(0);
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) {
      out += ch;
    }
  }
  return out;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export type DocumentPreview = {
  ref: string;
  kind: "attachment" | "file" | "artifact" | "draft";
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string | null;
  recordedSha256: string | null;
  sha256Matches: boolean | null;
  version: number | null;
  binary: boolean;
  text: string | null;
  /** Where the text came from: the bytes themselves, the document extractor, or none. */
  textSource: "raw" | "extracted" | null;
  /** Why an extractable document has no text (changed bytes, extractor failure), else null. */
  extractError: string | null;
  truncated: boolean;
  escaped: "html";
  untrusted: true;
  provenance: Record<string, unknown>;
};

function render(text: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = cleanText(text);
  const truncated = clean.length > maxChars;
  return { text: escapeHtml(truncated ? clean.slice(0, maxChars) : clean), truncated };
}

function within(base: string, real: string): boolean {
  return real.startsWith(`${base}${path.sep}`);
}

function hashFile(file: string, size: number): string | null {
  if (size > HASH_MAX_BYTES) {
    return null;
  }
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * The source documents whose bytes no longer match the SHA-256 recorded when they were attached:
 * changed, gone, or too large to hash. Approval rests on the bytes that were reviewed.
 */
export function changedDocuments(
  project: Pick<Project, "id" | "folder">,
  item: Pick<WorkItem, "source">,
  home: string,
): string[] {
  const changed: string[] = [];
  for (const doc of item.source.documents) {
    if (!doc.sha256 || doc.kind === "artifact") {
      continue;
    }
    let sha: string | null = null;
    try {
      const real = resolveFile(project, doc.kind, doc.ref, home);
      sha = hashFile(real, fs.statSync(real).size);
    } catch {
      sha = null;
    }
    if (sha !== doc.sha256) {
      changed.push(doc.name);
    }
  }
  return changed;
}

/** SHA-256 of a file, or null when it is not a readable file or is too large to hash. */
export function fileSha256(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? hashFile(file, st.size) : null;
  } catch {
    return null;
  }
}

/** The whole file, or null if it is gone or longer than `max` bytes. */
function readCapped(file: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      total += n;
      if (total > max) {
        return null;
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(file: string, size: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, READ_MAX_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve a stored file reference to a real path inside the Project, or refuse. */
function resolveFile(
  project: Pick<Project, "id" | "folder">,
  kind: "attachment" | "file",
  ref: string,
  home: string,
): string {
  const refuse = () =>
    new WorkItemRefused("outside_project", "the document is not inside this project");
  let base: string;
  let real: string;
  try {
    if (kind === "attachment") {
      base = fs.realpathSync(path.join(projectDataDir(project.id, home), "attachments"));
      real = fs.realpathSync(ref);
    } else {
      const rel = cleanRelPath(ref);
      if (!rel || rel === ".") {
        throw refuse();
      }
      base = fs.realpathSync(project.folder);
      real = fs.realpathSync(path.join(base, rel));
    }
  } catch (err) {
    if (err instanceof WorkItemRefused) {
      throw err;
    }
    throw new WorkItemRefused("document_not_found", "the document is no longer there");
  }
  const rel = path.relative(base, real).split(path.sep).join("/");
  if (!within(base, real) || excludedPathRegexes().some((re) => re.test(rel))) {
    throw refuse();
  }
  if (!fs.statSync(real).isFile()) {
    throw new WorkItemRefused("document_not_found", "the document is not a file");
  }
  return real;
}

function artifactPreview(
  ref: string,
  kind: "artifact" | "draft",
  a: { artifact: Artifact; content: string; version: number },
  recorded: string | null,
  maxChars: number,
  provenance: Record<string, unknown>,
): DocumentPreview {
  const v = a.artifact.versions.find((x) => x.version === a.version)!;
  const shown = render(a.content, maxChars);
  return {
    ref,
    kind,
    name: a.artifact.title,
    mediaType: MEDIA[`.${a.artifact.format}`] ?? "text/plain",
    bytes: v.size,
    sha256: v.sha256,
    recordedSha256: recorded,
    sha256Matches: recorded ? recorded === v.sha256 : null,
    version: a.version,
    binary: false,
    ...shown,
    textSource: "raw",
    extractError: null,
    escaped: "html",
    untrusted: true,
    provenance: {
      artifactId: a.artifact.id,
      status: a.artifact.status,
      createdAt: v.createdAt,
      createdBy: v.createdByUser,
      agentId: v.createdByAgent,
      note: v.note,
      ...provenance,
    },
  };
}

function runIdOf(item: WorkItem, artifactId: string, version: number): string | null {
  const h = item.history.findLast(
    (e) =>
      e.action === "draft" && e.detail?.artifactId === artifactId && e.detail?.version === version,
  );
  return typeof h?.detail?.runId === "string" ? h.detail.runId : null;
}

/**
 * Preview one document: `ref` is `draft` (the pinned draft), `draft@<version>` (another version
 * of the pinned draft artifact) or the `ref` of one of the item's source documents.
 */
export function previewDocument(
  project: Pick<Project, "id" | "folder">,
  item: WorkItem,
  ref: string,
  opts: { home: string; maxChars?: number },
): DocumentPreview {
  const maxChars = Math.min(PREVIEW_MAX_CHARS, Math.max(1, opts.maxChars ?? PREVIEW_MAX_CHARS));
  const draftRef = /^draft(?:@(\d{1,6}))?$/.exec(ref);
  if (draftRef) {
    if (!item.draft) {
      throw new WorkItemRefused("no_draft", "this item has no draft");
    }
    const version = draftRef[1] ? Number(draftRef[1]) : item.draft.version;
    const a = loadProjectArtifact(project, item.draft.artifactId, version, opts.home);
    const pinned = version === item.draft.version;
    return artifactPreview(ref, "draft", a, pinned ? item.draft.sha256 : null, maxChars, {
      pinned,
      pinnedVersion: item.draft.version,
      runId: runIdOf(item, a.artifact.id, version) ?? (pinned ? item.draft.runId : null),
    });
  }
  const doc = item.source.documents.find((d) => d.ref === ref);
  if (!doc) {
    throw new WorkItemRefused("unknown_ref", "ref is not one of this item's documents");
  }
  if (doc.kind === "artifact") {
    const a = loadProjectArtifact(project, doc.ref, null, opts.home);
    return artifactPreview(ref, "artifact", a, doc.sha256 ?? null, maxChars, { source: true });
  }
  const real = resolveFile(project, doc.kind, doc.ref, opts.home);
  const st = fs.statSync(real);
  const head = readHead(real, st.size);
  const binary = looksBinary(head);
  const sha = hashFile(real, st.size);
  const shown = binary ? { text: null, truncated: false } : render(head.toString("utf8"), maxChars);
  return {
    ref,
    kind: doc.kind,
    name: doc.name,
    mediaType: MEDIA[path.extname(real).toLowerCase()] ?? "application/octet-stream",
    bytes: st.size,
    sha256: sha,
    recordedSha256: doc.sha256 ?? null,
    sha256Matches: doc.sha256 && sha ? doc.sha256 === sha : null,
    version: null,
    binary,
    text: shown.text,
    textSource: binary ? null : "raw",
    extractError: null,
    truncated: shown.truncated || (!binary && st.size > READ_MAX_BYTES),
    escaped: "html",
    untrusted: true,
    provenance: { modifiedAt: st.mtime.toISOString(), source: true },
  };
}

export const PREVIEW_EXTRACT_TIMEOUT_MS = 15_000;
const EXTRACTED_KINDS = new Set<DocumentKind>(["pdf", "docx", "xlsx", "pptx"]);

/**
 * previewDocument, plus the text of a PDF or Office source document, extracted in the bounded
 * child process. The format is chosen by name, not by the NUL heuristic, so an all-ASCII PDF is
 * extracted too. Text is shown only for the bytes that were attached: the child reads a private
 * snapshot whose own bytes were hashed, and a document whose SHA-256 no longer matches the
 * recorded one (before the snapshot or after the read) answers no text and an `extractError`,
 * as does an extractor failure. The gateway process never parses the document.
 */
export async function previewDocumentText(
  project: Pick<Project, "id" | "folder">,
  item: WorkItem,
  ref: string,
  opts: { home: string; maxChars?: number; extract?: IsolatedExtractOptions },
): Promise<DocumentPreview> {
  const p = previewDocument(project, item, ref, opts);
  const kind = kindFromName(p.name);
  if ((p.kind !== "attachment" && p.kind !== "file") || !kind || !EXTRACTED_KINDS.has(kind)) {
    return p;
  }
  // A recognized document's raw syntax (an ASCII PDF's objects and xref) is not its text.
  const noText = (extractError: string): DocumentPreview => ({
    ...p,
    text: null,
    textSource: null,
    truncated: false,
    extractError,
  });
  if (!p.sha256 || (p.recordedSha256 && p.sha256Matches !== true)) {
    return noText(p.sha256 ? "changed" : "too_large");
  }
  const doc = item.source.documents.find((d) => d.ref === ref)!;
  const real = resolveFile(project, doc.kind as "attachment" | "file", doc.ref, opts.home);
  // The child parses a private copy whose own bytes carry the hash shown, so an edit-and-restore
  // of the project file while the child reads cannot put other bytes' text under that hash.
  const bytes = readCapped(real, HASH_MAX_BYTES);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== p.sha256) {
    return noText("changed");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-preview-"));
  let r: Awaited<ReturnType<typeof extractTextIsolated>>;
  try {
    const snapshot = path.join(dir, `document.${kind}`);
    fs.writeFileSync(snapshot, bytes, { mode: 0o600, flag: "wx" });
    r = await extractTextIsolated(kind, snapshot, {
      timeoutMs: PREVIEW_EXTRACT_TIMEOUT_MS,
      ...opts.extract,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!r.ok) {
    return noText(r.code);
  }
  // The source changed while it was read: the text is of bytes the project no longer holds.
  if (fileSha256(real) !== p.sha256) {
    return noText("changed");
  }
  const maxChars = Math.min(PREVIEW_MAX_CHARS, Math.max(1, opts.maxChars ?? PREVIEW_MAX_CHARS));
  const shown = render(r.text, maxChars);
  return { ...p, ...shown, textSource: "extracted", extractError: null };
}

function loadProjectArtifact(
  project: Pick<Project, "id">,
  id: string,
  version: number | null,
  home: string,
) {
  let a: ReturnType<typeof getArtifact>;
  try {
    a = getArtifact(id, version, { home });
  } catch (err) {
    throw new WorkItemRefused(
      "document_not_found",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (a.artifact.projectId !== project.id) {
    throw new WorkItemRefused("outside_project", "the artifact is not in this project");
  }
  return a;
}

export type DraftVersionProvenance = {
  artifactId: string;
  version: number;
  sha256: string;
  size: number;
  createdAt: string;
  createdBy: string;
  agentId: string | null;
  runId: string | null;
  note: string | null;
  pinned: boolean;
};

export type DraftDiff = {
  artifactId: string;
  from: DraftVersionProvenance;
  to: DraftVersionProvenance;
  hunks: DiffHunk[];
  stats: { added: number; removed: number; unchanged: number };
  identical: boolean;
  truncated: boolean;
  escaped: "html";
  untrusted: true;
};

function lines(text: string): { lines: string[]; truncated: boolean } {
  const all = cleanText(text).split("\n");
  const truncated = all.length > DIFF_MAX_LINES || all.some((l) => l.length > DIFF_MAX_LINE_CHARS);
  return {
    lines: all.slice(0, DIFF_MAX_LINES).map((l) => l.slice(0, DIFF_MAX_LINE_CHARS)),
    truncated,
  };
}

/** Line diff between two versions of the item's pinned draft artifact. */
export function draftDiff(
  project: Pick<Project, "id">,
  item: WorkItem,
  fromVersion: number,
  toVersion: number,
  opts: { home: string },
): DraftDiff {
  if (!item.draft) {
    throw new WorkItemRefused("no_draft", "this item has no draft");
  }
  const id = item.draft.artifactId;
  const a = loadProjectArtifact(project, id, fromVersion, opts.home);
  const b = loadProjectArtifact(project, id, toVersion, opts.home);
  const prov = (x: typeof a): DraftVersionProvenance => {
    const v = x.artifact.versions.find((e) => e.version === x.version)!;
    return {
      artifactId: id,
      version: v.version,
      sha256: v.sha256,
      size: v.size,
      createdAt: v.createdAt,
      createdBy: v.createdByUser,
      agentId: v.createdByAgent,
      runId: runIdOf(item, id, v.version),
      note: v.note,
      pinned: v.version === item.draft!.version,
    };
  };
  const la = lines(a.content);
  const lb = lines(b.content);
  const script = diffLines(la.lines, lb.lines) ?? [
    ...la.lines.map((t, i) => ({ op: "del" as const, text: t, oldLine: i + 1, newLine: null })),
    ...lb.lines.map((t, i) => ({ op: "add" as const, text: t, oldLine: null, newLine: i + 1 })),
  ];
  const stats = { added: 0, removed: 0, unchanged: 0 };
  for (const l of script) {
    stats[l.op === "add" ? "added" : l.op === "del" ? "removed" : "unchanged"] += 1;
  }
  let budget = DIFF_MAX_OUTPUT_LINES;
  let cut = false;
  const hunks: DiffHunk[] = [];
  for (const h of toHunks(script)) {
    if (budget <= 0) {
      cut = true;
      break;
    }
    const part = h.lines.slice(0, budget);
    cut ||= part.length < h.lines.length;
    budget -= part.length;
    hunks.push({ ...h, lines: part.map((l) => ({ ...l, text: escapeHtml(l.text) })) });
  }
  return {
    artifactId: id,
    from: prov(a),
    to: prov(b),
    hunks,
    stats,
    identical:
      a.artifact.versions.find((v) => v.version === a.version)!.sha256 ===
      b.artifact.versions.find((v) => v.version === b.version)!.sha256,
    truncated: la.truncated || lb.truncated || cut,
    escaped: "html",
    untrusted: true,
  };
}
