// Document upload validation and text extraction (Kurahi v0.3).
//
// Accepted: PDF, XLSX, DOCX, CSV, TXT, MD and common images. The type is decided by the file's
// magic bytes (and for the Office formats, the parts inside the zip), and must agree with the
// file name's extension. Text is extracted on the gateway so the agent never needs to open the
// binary itself.

import JSZip from "jszip";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 200_000;

export type DocumentKind =
  | "pdf"
  | "xlsx"
  | "docx"
  | "csv"
  | "txt"
  | "md"
  | "png"
  | "jpeg"
  | "gif"
  | "webp";

const EXTENSIONS: Record<string, DocumentKind> = {
  pdf: "pdf",
  xlsx: "xlsx",
  docx: "docx",
  csv: "csv",
  txt: "txt",
  md: "md",
  markdown: "md",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSIONS);

export function kindFromName(name: string): DocumentKind | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? (EXTENSIONS[m[1].toLowerCase()] ?? null) : null;
}

/** A file name safe to store: no directories, no control characters, bounded length. */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  // Control characters and characters Windows forbids in names become "_".
  const cleaned = base
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(-120);
  return cleaned || "file";
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((b, i) => buf[offset + i] === b);
}

function isUtf8Text(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  if (sample.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      sample.length < buf.length ? trimPartialUtf8(sample) : sample,
    );
    return true;
  } catch {
    return false;
  }
}

/** Drop a trailing incomplete UTF-8 sequence so a sample cut mid-character still validates. */
function trimPartialUtf8(buf: Buffer): Buffer {
  let end = buf.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = buf[end - i];
    if ((b & 0xc0) === 0x80) {
      continue;
    }
    if ((b & 0xe0) === 0xc0 && i < 2) {
      end -= i;
    } else if ((b & 0xf0) === 0xe0 && i < 3) {
      end -= i;
    } else if ((b & 0xf8) === 0xf0 && i < 4) {
      end -= i;
    }
    break;
  }
  return buf.subarray(0, end);
}

/** Detect the kind from content. Office files are zips; the parts inside tell them apart. */
export async function sniffKind(buf: Buffer): Promise<DocumentKind | "zip" | null> {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "pdf";
  }
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) {
    return "gif";
  }
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const zip = await JSZip.loadAsync(buf);
      if (zip.file("word/document.xml")) {
        return "docx";
      }
      if (zip.file("xl/workbook.xml")) {
        return "xlsx";
      }
    } catch {
      return null;
    }
    return "zip";
  }
  return isUtf8Text(buf) ? "txt" : null;
}

export type ValidationResult = { ok: true; kind: DocumentKind } | { ok: false; error: string };

/** Check size, extension and magic bytes together. */
export async function validateDocument(name: string, buf: Buffer): Promise<ValidationResult> {
  if (buf.length === 0) {
    return { ok: false, error: "the file is empty" };
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `the file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` };
  }
  const declared = kindFromName(name);
  if (!declared) {
    return {
      ok: false,
      error: `unsupported file type (accepted: ${ACCEPTED_EXTENSIONS.join(", ")})`,
    };
  }
  const sniffed = await sniffKind(buf);
  const textKinds: DocumentKind[] = ["txt", "csv", "md"];
  const matches = sniffed === declared || (sniffed === "txt" && textKinds.includes(declared));
  if (!matches) {
    return {
      ok: false,
      error: `the content does not match the .${name.split(".").pop()} extension`,
    };
  }
  return { ok: true, kind: declared };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

async function docxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const withBreaks = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const c of letters) {
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n - 1;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function xlsxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXmlEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const sheetNames = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) =>
    decodeXmlEntities(m[1]),
  );
  const sheetFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .toSorted((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const out: string[] = [];
  for (const [i, file] of sheetFiles.entries()) {
    const xml = (await zip.file(file)?.async("string")) ?? "";
    out.push(`## ${sheetNames[i] ?? `Sheet${i + 1}`}`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
        const type = /t="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? "";
        const inner = c[2] ?? "";
        let value = "";
        if (type === "s") {
          value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? "";
        } else if (type === "inlineStr") {
          value = decodeXmlEntities(
            [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""),
          );
        } else {
          value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        }
        cells[ref ? columnIndex(ref) : cells.length] = value;
      }
      out.push(Array.from(cells, (v) => csvCell(v ?? "")).join(","));
    }
  }
  return out.join("\n").trim();
}

async function pdfText(buf: Buffer, maxPages = 200): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buf), disableWorker: true } as never)
    .promise;
  const parts: string[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    parts.push(
      content.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.join("\n\n").trim();
}

/** Extracted text for the agent; images have none. Capped at MAX_EXTRACTED_CHARS. */
export async function extractText(kind: DocumentKind, buf: Buffer): Promise<string> {
  let text = "";
  switch (kind) {
    case "txt":
    case "md":
    case "csv":
      text = buf.toString("utf8").replace(/^﻿/, "");
      break;
    case "docx":
      text = await docxText(buf);
      break;
    case "xlsx":
      text = await xlsxText(buf);
      break;
    case "pdf":
      text = await pdfText(buf);
      break;
    default:
      text = "";
  }
  return text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
}
