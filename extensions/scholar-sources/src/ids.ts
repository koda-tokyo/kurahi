// Scholarly identifiers: DOI, arXiv id (new 2401.01234 and old hep-th/9901001 forms), PubMed id
// and OpenAlex work id, from a bare id, a prefixed id (`doi:`, `arXiv:`, `PMID:`) or a URL.

export type IdKind = "doi" | "arxiv" | "pmid" | "openalex";
export type ScholarId = { kind: IdKind; value: string };

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>{}|\\^`]+)/i;
const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d{1,3})?$/;
const ARXIV_OLD = /^([a-z][a-z.-]{1,20}(?:\.[A-Z]{2})?\/\d{7})(v\d{1,3})?$/;
const PMID_RE = /^\d{1,9}$/;
const OPENALEX_RE = /^W\d{2,12}$/i;

/** A DOI without the resolver prefix and without trailing punctuation, lower-cased. */
export function cleanDoi(raw: string): string | null {
  let v = raw
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  const m = DOI_RE.exec(v);
  if (!m) {
    return null;
  }
  v = m[1].replace(/[.,;:)\]}>]+$/, "");
  // A closing parenthesis that belongs to the DOI (e.g. 10.1016/s0140-6736(20)30183-5) stays.
  if (/\([^)]*$/.test(v) && raw.includes(`${v})`)) {
    v = `${v})`;
  }
  return v.length <= 200 ? v.toLowerCase() : null;
}

function cleanArxiv(raw: string): string | null {
  const v = raw.trim();
  const m = ARXIV_NEW.exec(v) ?? ARXIV_OLD.exec(v);
  return m ? m[1] : null;
}

/** Parse one identifier. Null when it is none of the four kinds. */
export function parseScholarId(input: unknown): ScholarId | null {
  if (typeof input !== "string") {
    return null;
  }
  const raw = input.trim();
  if (!raw || raw.length > 300) {
    return null;
  }
  const lower = raw.toLowerCase();
  const prefixed = /^(doi|arxiv|pmid|openalex)\s*:\s*(.+)$/i.exec(raw);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase() as IdKind;
    const rest = prefixed[2].trim();
    if (kind === "doi") {
      const doi = cleanDoi(rest);
      return doi ? { kind, value: doi } : null;
    }
    if (kind === "arxiv") {
      const id = cleanArxiv(rest);
      return id ? { kind, value: id } : null;
    }
    if (kind === "pmid") {
      return PMID_RE.test(rest) ? { kind, value: String(Number(rest)) } : null;
    }
    const w = rest.replace(/^https?:\/\/openalex\.org\//i, "");
    return OPENALEX_RE.test(w) ? { kind: "openalex", value: w.toUpperCase() } : null;
  }
  let m = /^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i.exec(raw);
  if (m) {
    const id = cleanArxiv(m[1]);
    return id ? { kind: "arxiv", value: id } : null;
  }
  m = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})\/?$/i.exec(raw);
  if (m) {
    return { kind: "pmid", value: String(Number(m[1])) };
  }
  m = /^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?(W\d{2,12})$/i.exec(raw);
  if (m) {
    return { kind: "openalex", value: m[1].toUpperCase() };
  }
  if (lower.startsWith("10.") || /doi\.org\//i.test(raw)) {
    const doi = cleanDoi(raw);
    return doi ? { kind: "doi", value: doi } : null;
  }
  const arxiv = cleanArxiv(raw);
  if (arxiv) {
    return { kind: "arxiv", value: arxiv };
  }
  if (PMID_RE.test(raw)) {
    return { kind: "pmid", value: String(Number(raw)) };
  }
  if (OPENALEX_RE.test(raw)) {
    return { kind: "openalex", value: raw.toUpperCase() };
  }
  return null;
}

/** The first identifier written inside a free-text reference (DOI, then arXiv, then PMID). */
export function findScholarId(text: string): ScholarId | null {
  const doi = /(?:doi\.org\/|doi:\s*|\b)(10\.\d{4,9}\/[^\s"'<>{}|\\^`]+)/i.exec(text);
  if (doi) {
    const v = cleanDoi(doi[1]);
    if (v) {
      return { kind: "doi", value: v };
    }
  }
  const arxiv =
    /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?=[\s,;)\]]|$)/i.exec(text) ??
    /\barxiv\s*:\s*([^\s,;)\]]+)/i.exec(text);
  if (arxiv) {
    const v = cleanArxiv(arxiv[1].replace(/[.]+$/, ""));
    if (v) {
      return { kind: "arxiv", value: v };
    }
  }
  const pmid =
    /\bPMID\s*:?\s*(\d{1,9})\b/i.exec(text) ?? /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/i.exec(text);
  if (pmid) {
    return { kind: "pmid", value: String(Number(pmid[1])) };
  }
  return null;
}

/** Canonical text form: `doi:10.x/y`, `arxiv:2401.01234`, `pmid:123`, `openalex:W123`. */
export function formatId(id: ScholarId): string {
  return `${id.kind}:${id.value}`;
}

/** The audit form of an id (the audit log accepts `[A-Za-z0-9._=!+/-]` only). */
export function auditId(id: ScholarId): string {
  return `${id.kind}/${id.value}`.replace(/[^A-Za-z0-9._=!+/-]/g, "_").slice(0, 200);
}
