import type { ScholarHttp } from "./http.js";
import type { ScholarRecord } from "./record.js";
// scholar_cite_check: does each reference resolve, and does what the draft says about it (title
// words, year) match the record it resolves to?
//   DOI    Crossref /works/{doi}, then doi.org content negotiation (DataCite, mEDRA …)
//   arXiv  the arXiv API (id_list)
//   PMID   PubMed efetch
//   none   Crossref query.bibliographic (one row); verified only on a close title match
// Status: verified | mismatch (resolves, but the title or the year disagree) | not_found.
import { errorCodeOf } from "../../../src/connectors/business/index.js";
import { findScholarId, formatId, type ScholarId } from "./ids.js";
import { arxivGet, crossrefBibliographic, crossrefGet, doiCsl, pubmedGet } from "./sources.js";

export const MAX_CITATIONS = 50;
const MAX_CITATION_CHARS = 1_000;
/** Share of the record's title words the reference must contain. */
const TITLE_MATCH = 0.6;
/** A reference without an identifier needs a closer match to count as verified. */
const BIBLIOGRAPHIC_MATCH = 0.8;

export type CiteStatus = "verified" | "mismatch" | "not_found";
export type CiteResult = {
  index: number;
  citation: string;
  status: CiteStatus;
  identifier: string | null;
  record: ScholarRecord | null;
  reasons: string[];
  /** Set when the provider could not be asked (rate limit, network): not a verdict on the work. */
  error: string | null;
};

const words = (t: string): string[] =>
  (
    t
      .toLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((w) => w.length >= 3 || /[^\p{Script=Latin}\p{N}]/u.test(w));

/** Share of the title's words that the reference text contains (1 for an empty title). */
export function titleOverlap(title: string, reference: string): number {
  const t = [...new Set(words(title))];
  if (t.length === 0) {
    return 1;
  }
  const ref = ` ${words(reference).join(" ")} `;
  return (
    t.filter((w) => ref.includes(` ${w} `) || (w.length > 6 && ref.includes(w))).length / t.length
  );
}

const YEAR_RE = /\b(1[89]\d\d|20\d\d)\b/g;

function compare(claim: string, record: ScholarRecord, minOverlap: number): string[] {
  const reasons: string[] = [];
  // Only a reference that says more than its identifier is compared on the title.
  if (words(claim).length >= 3) {
    const overlap = titleOverlap(record.title, claim);
    if (overlap < minOverlap) {
      reasons.push(`title does not match the record (overlap ${overlap.toFixed(2)})`);
    }
  }
  const years = [...new Set([...claim.matchAll(YEAR_RE)].map((m) => Number(m[1])))];
  if (years.length > 0 && record.years.length > 0 && !years.some((y) => record.years.includes(y))) {
    reasons.push(
      `year ${years.join("/")} in the reference, ${record.years.join("/")} in the record`,
    );
  }
  return reasons;
}

async function resolveId(http: ScholarHttp, id: ScholarId): Promise<ScholarRecord | null> {
  switch (id.kind) {
    case "doi":
      return (await crossrefGet(http, id.value)) ?? (await doiCsl(http, id.value));
    case "arxiv":
      return arxivGet(http, id.value);
    case "pmid":
      return pubmedGet(http, id.value);
    default:
      return null;
  }
}

/** The reference text without its identifier (so DOI digits are not read as a year). */
function claimText(citation: string, id: ScholarId | null): string {
  if (!id) {
    return citation;
  }
  return citation
    .replace(/https?:\/\/(?:dx\.)?doi\.org\/\S+/gi, " ")
    .replace(/\bdoi:\s*\S+/gi, " ")
    .replace(/\b10\.\d{4,9}\/\S+/g, " ")
    .replace(/https?:\/\/(?:export\.)?arxiv\.org\/\S+/gi, " ")
    .replace(/\barxiv\s*:\s*\S+/gi, " ")
    .replace(/\bPMID\s*:?\s*\d+/gi, " ")
    .replace(/https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\S+/gi, " ")
    .split(id.value)
    .join(" ");
}

export async function checkCitations(
  http: ScholarHttp,
  citations: readonly string[],
): Promise<CiteResult[]> {
  const out: CiteResult[] = [];
  for (const [i, raw] of citations.slice(0, MAX_CITATIONS).entries()) {
    const citation = raw.replace(/\s+/g, " ").trim().slice(0, MAX_CITATION_CHARS);
    const id = findScholarId(citation) ?? bareId(citation);
    const base = { index: i + 1, citation, identifier: id ? formatId(id) : null, error: null };
    try {
      if (id) {
        const record = await resolveId(http, id);
        if (!record) {
          out.push({
            ...base,
            status: "not_found",
            record: null,
            reasons: [`${id.kind} does not resolve`],
          });
          continue;
        }
        const reasons = compare(claimText(citation, id), record, TITLE_MATCH);
        out.push({ ...base, status: reasons.length ? "mismatch" : "verified", record, reasons });
        continue;
      }
      if (words(citation).length < 4) {
        out.push({
          ...base,
          status: "not_found",
          record: null,
          reasons: ["no identifier and too little text to search"],
        });
        continue;
      }
      const best = await crossrefBibliographic(http, citation);
      const reasons = best ? compare(citation, best, BIBLIOGRAPHIC_MATCH) : ["no candidate"];
      if (best && reasons.length === 0) {
        out.push({
          ...base,
          identifier: `doi:${best.doi}`,
          status: "verified",
          record: best,
          reasons: ["no identifier in the reference; matched by bibliographic search"],
        });
      } else {
        out.push({
          ...base,
          status: "not_found",
          record: null,
          reasons: [
            "no identifier in the reference and no confident bibliographic match",
            ...(best?.doi ? [`closest candidate doi:${best.doi} (${reasons.join("; ")})`] : []),
          ],
        });
      }
    } catch (err) {
      const code = errorCodeOf(err);
      out.push({
        ...base,
        status: "not_found",
        record: null,
        reasons: [`could not be checked (${code}); check again later`],
        error: code,
      });
    }
  }
  return out;
}

/** A citation that is only an identifier (`2401.01234`, `PMID 123` …). */
function bareId(citation: string): ScholarId | null {
  const t = citation.trim();
  if (/\s/.test(t) && !/^pmid\s+\d+$/i.test(t)) {
    return null;
  }
  const m = /^pmid\s+(\d{1,9})$/i.exec(t);
  if (m) {
    return { kind: "pmid", value: String(Number(m[1])) };
  }
  const arxiv = /^(\d{4}\.\d{4,5})(v\d+)?$/.exec(t);
  return arxiv ? { kind: "arxiv", value: arxiv[1] } : null;
}

const HEADING_RE =
  /^\s*(?:#{1,6}\s*)?(?:\d+\.?\s*)?(references|bibliography|works cited|literature cited|参考文献|引用文献|文献)\s*:?\s*$/gim;
const ENTRY_START = /^\s*(?:\[\d{1,4}\]|\d{1,4}[.)]|[-*•])\s+/;

/** Reference entries of a draft: the part after its last References heading, one per entry. */
export function extractReferences(text: string, max = MAX_CITATIONS): string[] {
  let body = text;
  let headed = false;
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(HEADING_RE)) {
    last = m;
  }
  if (last) {
    body = text.slice((last.index ?? 0) + last[0].length);
    headed = true;
  }
  const lines = body.split(/\r?\n/);
  const marked = lines.some((l) => ENTRY_START.test(l));
  const entries: string[] = [];
  for (const l of lines) {
    if (!l.trim()) {
      continue;
    }
    if (!marked || ENTRY_START.test(l) || entries.length === 0) {
      entries.push(l.replace(ENTRY_START, "").trim());
    } else {
      entries[entries.length - 1] += ` ${l.trim()}`;
    }
  }
  return entries
    .filter((e) => e.length >= 12 && (headed || findScholarId(e) !== null))
    .slice(0, max);
}

export function formatCiteResults(results: readonly CiteResult[]): string {
  const counts = { verified: 0, mismatch: 0, not_found: 0 };
  for (const r of results) {
    counts[r.status]++;
  }
  const lines = [
    `Checked ${results.length} reference(s): ${counts.verified} verified, ${counts.mismatch} mismatch, ${counts.not_found} not found.`,
  ];
  for (const r of results) {
    lines.push(`${r.index}. status: ${r.status}`);
    lines.push(`   reference: ${r.citation.slice(0, 300)}`);
    lines.push(`   identifier: ${r.identifier ?? "(none)"}`);
    if (r.record) {
      lines.push(
        `   resolves to: ${r.record.title} (${r.record.date ?? r.record.years[0] ?? "n.d."})${r.record.venue ? `, ${r.record.venue}` : ""}`,
      );
    }
    if (r.reasons.length) {
      lines.push(`   why: ${r.reasons.join("; ")}`);
    }
  }
  return lines.join("\n");
}
