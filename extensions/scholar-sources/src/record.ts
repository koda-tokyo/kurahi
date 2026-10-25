// The one record shape every source normalizes to, its bounds and its text form for the model.
import type { SourceId } from "./config.js";
import { formatId, type ScholarId } from "./ids.js";

export const MAX_AUTHORS = 10;
export const SNIPPET_CHARS = 800;
export const ABSTRACT_CHARS = 4_000;
const TITLE_CHARS = 500;
const VENUE_CHARS = 200;

export type ScholarRecord = {
  source: SourceId | "doi";
  /** Canonical id (see formatId): the DOI when there is one, else the source's own id. */
  id: string;
  doi: string | null;
  arxivId: string | null;
  pmid: string | null;
  openalexId: string | null;
  title: string;
  authors: string[];
  authorsTotal: number;
  venue: string | null;
  /** YYYY-MM-DD, YYYY-MM or YYYY. */
  date: string | null;
  /** Every year the source gives for the work (issued, online, print, first version …). */
  years: number[];
  abstract: string;
  url: string | null;
  isOa: boolean;
  oaPdfUrl: string | null;
  license: string | null;
};

// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]+/g;

/** One line of provider text: no control characters, collapsed spaces, bounded. */
export function line(v: unknown, max: number): string {
  const t = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return t.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Markup (JATS, HTML) out of an abstract, entities decoded. */
export function plainText(v: unknown): string {
  const t = typeof v === "string" ? v : "";
  return decodeEntities(t.replace(/<[^>]{0,200}>/g, " "))
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(t: string): string {
  return t
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

export function normalizeDate(y?: number | null, m?: number | null, d?: number | null) {
  if (!y || !Number.isInteger(y) || y < 1000 || y > 3000) {
    return null;
  }
  const p = (n: number) => String(n).padStart(2, "0");
  if (m && Number.isInteger(m) && m >= 1 && m <= 12) {
    return d && Number.isInteger(d) && d >= 1 && d <= 31 ? `${y}-${p(m)}-${p(d)}` : `${y}-${p(m)}`;
  }
  return String(y);
}

/** Only http(s) URLs reach the record. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) {
    return null;
  }
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function makeRecord(
  r: Omit<ScholarRecord, "id" | "authors" | "authorsTotal" | "title" | "venue" | "abstract"> & {
    primary: ScholarId;
    title: unknown;
    authors: unknown[];
    venue: unknown;
    abstract: unknown;
  },
  abstractChars = ABSTRACT_CHARS,
): ScholarRecord {
  const authors = r.authors.map((a) => line(a, 120)).filter(Boolean);
  const id = r.doi ? `doi:${r.doi}` : formatId(r.primary);
  const abstract = plainText(r.abstract);
  return {
    source: r.source,
    id,
    doi: r.doi,
    arxivId: r.arxivId,
    pmid: r.pmid,
    openalexId: r.openalexId,
    title: line(plainText(r.title), TITLE_CHARS) || "(untitled)",
    authors: authors.slice(0, MAX_AUTHORS),
    authorsTotal: authors.length,
    venue: line(r.venue, VENUE_CHARS) || null,
    date: r.date,
    years: [...new Set(r.years.filter((y) => Number.isInteger(y) && y > 1000 && y < 3000))],
    abstract: clipText(abstract, abstractChars),
    url: r.url,
    isOa: r.isOa,
    oaPdfUrl: r.oaPdfUrl,
    license: r.license ? line(r.license, 80) : null,
  };
}

export function clipText(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Keys under which two records are the same work. */
export function recordKeys(r: ScholarRecord): string[] {
  return [
    r.doi ? `doi:${r.doi.toLowerCase()}` : null,
    r.arxivId ? `arxiv:${r.arxivId}` : null,
    r.pmid ? `pmid:${r.pmid}` : null,
    r.openalexId ? `openalex:${r.openalexId}` : null,
  ].filter((k): k is string => k !== null);
}

/** Merge a duplicate into the first record seen: fill what the first lacks. */
export function mergeRecord(a: ScholarRecord, b: ScholarRecord): ScholarRecord {
  const doi = a.doi ?? b.doi;
  return {
    ...a,
    id: doi ? `doi:${doi}` : a.id,
    doi,
    arxivId: a.arxivId ?? b.arxivId,
    pmid: a.pmid ?? b.pmid,
    openalexId: a.openalexId ?? b.openalexId,
    venue: a.venue ?? b.venue,
    date: a.date ?? b.date,
    years: [...new Set([...a.years, ...b.years])],
    abstract: a.abstract.length >= b.abstract.length ? a.abstract : b.abstract,
    url: a.url ?? b.url,
    isOa: a.isOa || b.isOa,
    oaPdfUrl: a.oaPdfUrl ?? b.oaPdfUrl,
    license: a.license ?? b.license,
  };
}

/** One record as numbered text lines (`N. id: …` is what a routine's fan-out matches). */
export function formatRecord(r: ScholarRecord, n: number): string {
  const more =
    r.authorsTotal > r.authors.length ? ` (+${r.authorsTotal - r.authors.length} more)` : "";
  const ids = [
    r.doi ? `DOI ${r.doi}` : null,
    r.arxivId ? `arXiv ${r.arxivId}` : null,
    r.pmid ? `PMID ${r.pmid}` : null,
    r.openalexId ? `OpenAlex ${r.openalexId}` : null,
  ].filter(Boolean);
  const out = [
    `${n}. id: ${r.id}`,
    `   title: ${r.title}`,
    `   authors: ${r.authors.join("; ") || "(none listed)"}${more}`,
    `   venue: ${r.venue ?? "(none)"} · date: ${r.date ?? "(unknown)"} · source: ${r.source}`,
    `   ids: ${ids.join(" · ") || "(none)"}`,
    `   url: ${r.url ?? "(none)"}`,
    r.oaPdfUrl
      ? `   open access pdf: ${r.oaPdfUrl}${r.license ? ` (licence ${r.license})` : ""}`
      : `   open access: ${r.isOa ? "yes (no direct PDF)" : "no"}`,
  ];
  if (r.abstract) {
    out.push(`   abstract: ${r.abstract}`);
  }
  return out.join("\n");
}
