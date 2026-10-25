// Shared pieces of the Office renderers: errors, XML escaping, input checks, zip packaging.
import JSZip from "jszip";

/** A refusal or bad input; `code` is stable, `message` is safe to show the model. */
export class OfficeError extends Error {
  constructor(
    readonly code: "bad_request" | "not_in_project" | "mode" | "path" | "exists" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "OfficeError";
  }
}

export function bad(message: string): never {
  throw new OfficeError("bad_request", message);
}

// Characters XML 1.0 cannot carry (control characters, lone surrogates) are dropped.
// Built from a string so the escapes stay readable (a regex literal would spell them out).
const XML_INVALID = new RegExp(
  "[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]",
  "gu",
);

/**
 * The document language: the spec's `language` when given, else Japanese when the text has any
 * kana or kanji and English otherwise. A wrong "ja" makes Word and LibreOffice break English
 * words mid-word at line ends.
 */
export function pickLang(language: unknown, text: string): "ja" | "en" {
  if (language === "en" || language === "ja") {
    return language;
  }
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(text) ? "ja" : "en";
}

export function cleanText(s: string): string {
  return s.replace(XML_INVALID, "");
}

/** Escape for XML text and attribute values. */
export function esc(s: string): string {
  return cleanText(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---- input checks ----------------------------------------------------------------------------

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string (numbers are accepted and stringified), trimmed, bounded. */
export function str(
  v: unknown,
  where: string,
  opts: { max: number; required?: boolean },
): string | undefined {
  if (v === undefined || v === null) {
    if (opts.required) {
      bad(`${where} is required`);
    }
    return undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    v = String(v);
  }
  if (typeof v !== "string") {
    bad(`${where} must be a string`);
  }
  const s = cleanText(v).trim();
  if (!s) {
    if (opts.required) {
      bad(`${where} is required`);
    }
    return undefined;
  }
  if (s.length > opts.max) {
    bad(`${where} is too long (${s.length} characters, at most ${opts.max})`);
  }
  return s;
}

export function reqStr(v: unknown, where: string, max: number): string {
  return str(v, where, { max, required: true }) as string;
}

export function list(v: unknown, where: string, opts: { max: number; min?: number }): unknown[] {
  if (v === undefined || v === null) {
    if ((opts.min ?? 0) > 0) {
      bad(`${where} is required`);
    }
    return [];
  }
  if (!Array.isArray(v)) {
    bad(`${where} must be an array`);
  }
  if (v.length > opts.max) {
    bad(`${where}: at most ${opts.max} items (got ${v.length})`);
  }
  if (v.length < (opts.min ?? 0)) {
    bad(`${where}: at least ${opts.min} item(s)`);
  }
  return v;
}

export function num(v: unknown, where: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    bad(`${where} must be a finite number`);
  }
  return n;
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

// ---- text measurement (layout estimates) -----------------------------------------------------

/** East Asian wide/fullwidth characters take a full em; others about half. */
export function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Approximate width of `s` in ems. */
export function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 1 : ch === " " ? 0.3 : 0.56;
  }
  return w;
}

// ---- packaging -------------------------------------------------------------------------------

export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function corePropsXml(title: string, now: Date): string {
  const t = isoSeconds(now);
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${t}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${t}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

export function appPropsXml(extra = ""): string {
  return (
    XML_HEAD +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>Kurahi</Application>${extra}</Properties>`
  );
}

export type Rel = { id: string; type: string; target: string };

export const REL = {
  officeDocument:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  app: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
};

export function relsXml(rels: Rel[]): string {
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels
      .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`)
      .join("") +
    "</Relationships>"
  );
}

export function packageRels(mainTarget: string): string {
  return relsXml([
    { id: "rId1", type: REL.officeDocument, target: mainTarget },
    { id: "rId2", type: REL.core, target: "docProps/core.xml" },
    { id: "rId3", type: REL.app, target: "docProps/app.xml" },
  ]);
}

export function contentTypesXml(
  defaults: Record<string, string>,
  overrides: Record<string, string>,
): string {
  const all = {
    rels: "application/vnd.openxmlformats-package.relationships+xml",
    xml: "application/xml",
    ...defaults,
  };
  const ov = {
    "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
    "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    ...overrides,
  };
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    Object.entries(all)
      .map(([ext, ct]) => `<Default Extension="${ext}" ContentType="${ct}"/>`)
      .join("") +
    Object.entries(ov)
      .map(([part, ct]) => `<Override PartName="${part}" ContentType="${ct}"/>`)
      .join("") +
    "</Types>"
  );
}

/** Zip the parts in order ([Content_Types].xml first), with fixed entry dates. */
export async function zipParts(
  parts: Array<[string, string | Buffer]>,
  now: Date,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of parts) {
    zip.file(name, content, { date: now, createFolders: false });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  });
}
