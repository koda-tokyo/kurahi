// The four literature sources (and doi.org for DOIs no source knows), each normalized to
// ScholarRecord. API references (read 2026-10-25):
//   arXiv     GET https://export.arxiv.org/api/query (Atom): search_query with field prefixes and
//             AND, submittedDate:[YYYYMMDDTTTT TO YYYYMMDDTTTT], id_list, max_results, sortBy,
//             sortOrder. https://info.arxiv.org/help/api/user-manual.html
//   OpenAlex  GET https://api.openalex.org/works?search=&filter=from_publication_date:&per_page=
//             &select=; GET /works/{W id | doi:… | pmid:…}; abstracts as abstract_inverted_index.
//             https://help.openalex.org/api-entities/works/work-object
//             https://help.openalex.org/api-entities/works/filter-works
//   Crossref  GET https://api.crossref.org/works?query=&query.bibliographic=&filter=from-pub-date:
//             &rows=&select=&mailto=; GET /works/{doi} (404 when unknown).
//             https://api.crossref.org/swagger-docs
//             https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/
//   PubMed    E-utilities esearch.fcgi (JSON) then efetch.fcgi (XML), with tool and email.
//             https://www.ncbi.nlm.nih.gov/books/NBK25499/
//   doi.org   content negotiation, Accept: application/vnd.citationstyles.csl+json (Crossref,
//             DataCite, mEDRA …). https://citation.doi.org/docs.html
import type { SourceId } from "./config.js";
import type { ScholarHttp } from "./http.js";
import { cleanDoi, type ScholarId } from "./ids.js";
import {
  ABSTRACT_CHARS,
  makeRecord,
  normalizeDate,
  safeUrl,
  type ScholarRecord,
} from "./record.js";
import { attr, elements, firstText, textOf } from "./xml.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type SearchParams = { query: string; since: string | null; limit: number };

export const ARXIV_API = "https://export.arxiv.org/api/query";
export const OPENALEX_API = "https://api.openalex.org";
export const CROSSREF_API = "https://api.crossref.org";
export const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
export const DOI_RESOLVER = "https://doi.org";

// ---------------------------------------------------------------- arXiv

/** English function words: arXiv ANDs every term, and one of these makes a query return 0. */
const ARXIV_STOPWORDS = new Set(
  "a an and are as at be by for from in into is it of on or the to with without via using towards".split(
    " ",
  ),
);

/** Words of a free-text query as `all:` terms joined by AND (arXiv's own query syntax). */
export function arxivQuery(query: string, since: string | null): string {
  const all = query.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const content = all.filter((w) => !ARXIV_STOPWORDS.has(w.toLowerCase()));
  const words = (content.length > 0 ? content : all).slice(0, 12);
  const terms = words.map((w) => `all:${w}`);
  if (since) {
    terms.push(`submittedDate:[${since.replace(/-/g, "")}0000 TO 299912312359]`);
  }
  return terms.join(" AND ");
}

export function parseArxivFeed(xml: string, abstractChars: number): ScholarRecord[] {
  const out: ScholarRecord[] = [];
  for (const e of elements(xml, "entry", 100)) {
    const idUrl = firstText(e.inner, "id");
    const m = /arxiv\.org\/abs\/(.+?)(v\d+)?$/i.exec(idUrl);
    if (!m) {
      continue; // an error entry (http://arxiv.org/api/errors#…)
    }
    const arxivId = m[1];
    const published = firstText(e.inner, "published");
    const updated = firstText(e.inner, "updated");
    const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(published);
    const doi = cleanDoi(firstText(e.inner, "arxiv:doi"));
    const journal = firstText(e.inner, "arxiv:journal_ref");
    const cat = attr(elements(e.inner, "arxiv:primary_category", 1)[0]?.attrs ?? "", "term");
    out.push(
      makeRecord(
        {
          source: "arxiv",
          primary: { kind: "arxiv", value: arxivId },
          doi,
          arxivId,
          pmid: null,
          openalexId: null,
          title: firstText(e.inner, "title"),
          authors: elements(e.inner, "author", 200).map((a) => firstText(a.inner, "name")),
          venue: journal || (cat ? `arXiv (${cat})` : "arXiv"),
          date: ymd ? normalizeDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])) : null,
          years: [published, updated].map((d) => Number(d.slice(0, 4))),
          abstract: firstText(e.inner, "summary"),
          url: `https://arxiv.org/abs/${arxivId}`,
          isOa: true,
          oaPdfUrl: `https://arxiv.org/pdf/${arxivId}`,
          license: null,
        },
        abstractChars,
      ),
    );
  }
  return out;
}

export async function arxivSearch(http: ScholarHttp, p: SearchParams, abstractChars: number) {
  const u = new URL(ARXIV_API);
  u.searchParams.set("search_query", arxivQuery(p.query, p.since));
  u.searchParams.set("start", "0");
  u.searchParams.set("max_results", String(p.limit));
  u.searchParams.set("sortBy", p.since ? "submittedDate" : "relevance");
  u.searchParams.set("sortOrder", "descending");
  const res = await http.get("arxiv", u.toString(), "application/atom+xml");
  return res.status === 404 ? [] : parseArxivFeed(res.text, abstractChars);
}

export async function arxivGet(http: ScholarHttp, arxivId: string) {
  const u = new URL(ARXIV_API);
  u.searchParams.set("id_list", arxivId);
  u.searchParams.set("max_results", "1");
  const res = await http.get("arxiv", u.toString(), "application/atom+xml");
  return res.status === 404 ? null : (parseArxivFeed(res.text, ABSTRACT_CHARS)[0] ?? null);
}

// ---------------------------------------------------------------- OpenAlex

const OPENALEX_SELECT =
  "id,doi,title,publication_date,publication_year,authorships,primary_location,open_access,best_oa_location,abstract_inverted_index,ids,type";

/** The abstract from OpenAlex's inverted index (word → positions), bounded. */
export function invertedAbstract(index: unknown, maxWords = 2000): string {
  if (!isObj(index)) {
    return "";
  }
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of arr(positions)) {
      if (typeof p === "number" && Number.isInteger(p) && p >= 0 && p < maxWords) {
        words[p] = word;
      }
    }
  }
  return words.filter((w) => typeof w === "string").join(" ");
}

export function normalizeOpenAlex(w: Obj, abstractChars: number): ScholarRecord | null {
  const wid = /W\d+$/.exec(str(w.id))?.[0];
  if (!wid) {
    return null;
  }
  const ids = isObj(w.ids) ? w.ids : {};
  const pmid = /(\d{1,9})\/?$/.exec(str(ids.pmid))?.[1] ?? null;
  const primary = isObj(w.primary_location) ? w.primary_location : {};
  const source = isObj(primary.source) ? primary.source : {};
  const best = isObj(w.best_oa_location) ? w.best_oa_location : {};
  const oa = isObj(w.open_access) ? w.open_access : {};
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(w.publication_date));
  const doi = cleanDoi(str(w.doi));
  const bestIsOa = best.is_oa === true;
  return makeRecord(
    {
      source: "openalex",
      primary: { kind: "openalex", value: wid },
      doi,
      arxivId: null,
      pmid,
      openalexId: wid,
      title: w.title ?? w.display_name,
      authors: arr(w.authorships).map((a) =>
        isObj(a) && isObj(a.author) ? a.author.display_name : "",
      ),
      venue: source.display_name ?? primary.raw_source_name,
      date: date
        ? normalizeDate(Number(date[1]), Number(date[2]), Number(date[3]))
        : normalizeDate(Number(w.publication_year)),
      years: [Number(w.publication_year)],
      abstract: invertedAbstract(w.abstract_inverted_index),
      url: doi ? `https://doi.org/${doi}` : safeUrl(primary.landing_page_url),
      isOa: oa.is_oa === true,
      oaPdfUrl: bestIsOa ? safeUrl(best.pdf_url) : null,
      license: bestIsOa ? str(best.license) || null : null,
    },
    abstractChars,
  );
}

export async function openalexSearch(http: ScholarHttp, p: SearchParams, abstractChars: number) {
  const u = new URL(`${OPENALEX_API}/works`);
  u.searchParams.set("search", p.query);
  u.searchParams.set("per_page", String(p.limit));
  u.searchParams.set("select", OPENALEX_SELECT);
  if (p.since) {
    u.searchParams.set("filter", `from_publication_date:${p.since}`);
    u.searchParams.set("sort", "publication_date:desc");
  }
  const body = await http.json<{ results?: unknown[] }>("openalex", u.toString());
  return arr(body?.results)
    .filter(isObj)
    .map((w) => normalizeOpenAlex(w, abstractChars))
    .filter((r): r is ScholarRecord => r !== null);
}

/** One work by OpenAlex id, DOI or PMID (OpenAlex's external-id lookups). */
export async function openalexGet(http: ScholarHttp, id: ScholarId) {
  const key =
    id.kind === "openalex"
      ? id.value
      : id.kind === "doi"
        ? `doi:${id.value}`
        : id.kind === "pmid"
          ? `pmid:${id.value}`
          : null;
  if (!key) {
    return null;
  }
  const u = new URL(`${OPENALEX_API}/works/${key}`);
  u.searchParams.set("select", OPENALEX_SELECT);
  const body = await http.json<Obj>("openalex", u.toString());
  return isObj(body) ? normalizeOpenAlex(body, ABSTRACT_CHARS) : null;
}

// ---------------------------------------------------------------- Crossref

const CROSSREF_SELECT =
  "DOI,title,author,container-title,issued,published,published-online,published-print,abstract,URL,link,license,type";

function dateParts(v: unknown): number[] {
  const parts = isObj(v) ? arr(v["date-parts"])[0] : undefined;
  return arr(parts).filter((n): n is number => typeof n === "number");
}

/** A Creative Commons licence URL as a short id (cc-by, cc-by-nc …), else null. */
export function ccLicense(url: string): string | null {
  const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)/i.exec(url);
  if (!m) {
    return null;
  }
  return m[1].toLowerCase() === "publicdomain" ? "public-domain" : `cc-${m[2].toLowerCase()}`;
}

export function normalizeCrossref(w: Obj, abstractChars: number): ScholarRecord | null {
  const doi = cleanDoi(str(w.DOI));
  if (!doi) {
    return null;
  }
  const issued = dateParts(w.issued);
  const years = ["issued", "published", "published-online", "published-print"].map(
    (k) => dateParts(w[k])[0] ?? 0,
  );
  const license =
    arr(w.license)
      .map((l) => (isObj(l) ? ccLicense(str(l.URL)) : null))
      .find((l): l is string => l !== null) ?? null;
  const pdf = arr(w.link).find((l) => isObj(l) && str(l["content-type"]) === "application/pdf") as
    | Obj
    | undefined;
  return makeRecord(
    {
      source: "crossref",
      primary: { kind: "doi", value: doi },
      doi,
      arxivId: null,
      pmid: null,
      openalexId: null,
      title: arr(w.title)[0],
      authors: arr(w.author).map((a) =>
        isObj(a) ? str(a.name) || [str(a.given), str(a.family)].filter(Boolean).join(" ") : "",
      ),
      venue: arr(w["container-title"])[0],
      date: normalizeDate(issued[0], issued[1], issued[2]),
      years,
      abstract: w.abstract,
      url: `https://doi.org/${doi}`,
      // Only an open licence makes the publisher's PDF link an open-access copy.
      isOa: license !== null,
      oaPdfUrl: license && pdf ? safeUrl(pdf.URL) : null,
      license,
    },
    abstractChars,
  );
}

function crossrefUrl(http: ScholarHttp, path: string): URL {
  const u = new URL(`${CROSSREF_API}${path}`);
  if (http.settings.contactEmail) {
    u.searchParams.set("mailto", http.settings.contactEmail);
  }
  return u;
}

export async function crossrefSearch(http: ScholarHttp, p: SearchParams, abstractChars: number) {
  const u = crossrefUrl(http, "/works");
  u.searchParams.set("query", p.query);
  u.searchParams.set("rows", String(p.limit));
  u.searchParams.set("select", CROSSREF_SELECT);
  if (p.since) {
    u.searchParams.set("filter", `from-pub-date:${p.since}`);
    u.searchParams.set("sort", "published");
    u.searchParams.set("order", "desc");
  }
  const body = await http.json<{ message?: { items?: unknown[] } }>("crossref", u.toString());
  return arr(body?.message?.items)
    .filter(isObj)
    .map((w) => normalizeCrossref(w, abstractChars))
    .filter((r): r is ScholarRecord => r !== null);
}

export async function crossrefGet(http: ScholarHttp, doi: string) {
  const path = doi.split("/").map(encodeURIComponent).join("/");
  const body = await http.json<{ message?: unknown }>(
    "crossref",
    crossrefUrl(http, `/works/${path}`).toString(),
  );
  return isObj(body?.message) ? normalizeCrossref(body.message, ABSTRACT_CHARS) : null;
}

/** The best Crossref match for a free-text reference (query.bibliographic, one row). */
export async function crossrefBibliographic(http: ScholarHttp, reference: string) {
  const u = crossrefUrl(http, "/works");
  u.searchParams.set("query.bibliographic", reference.slice(0, 500));
  u.searchParams.set("rows", "1");
  u.searchParams.set("select", CROSSREF_SELECT);
  const body = await http.json<{ message?: { items?: unknown[] } }>("crossref", u.toString());
  const first = arr(body?.message?.items).find(isObj);
  return first ? normalizeCrossref(first, ABSTRACT_CHARS) : null;
}

// ---------------------------------------------------------------- doi.org

export async function doiCsl(http: ScholarHttp, doi: string) {
  const path = doi.split("/").map(encodeURIComponent).join("/");
  const body = await http.json<Obj>(
    "doi",
    `${DOI_RESOLVER}/${path}`,
    "application/vnd.citationstyles.csl+json",
  );
  if (!isObj(body)) {
    return null;
  }
  const issued = dateParts(body.issued);
  const title = Array.isArray(body.title) ? body.title[0] : body.title;
  const venue = Array.isArray(body["container-title"])
    ? body["container-title"][0]
    : body["container-title"] || body.publisher;
  return makeRecord({
    source: "doi",
    primary: { kind: "doi", value: doi },
    doi,
    arxivId: null,
    pmid: null,
    openalexId: null,
    title,
    authors: arr(body.author).map((a) =>
      isObj(a) ? str(a.literal) || [str(a.given), str(a.family)].filter(Boolean).join(" ") : "",
    ),
    venue,
    date: normalizeDate(issued[0], issued[1], issued[2]),
    years: [issued[0] ?? 0],
    abstract: body.abstract,
    url: `https://doi.org/${doi}`,
    isOa: false,
    oaPdfUrl: null,
    license: null,
  });
}

// ---------------------------------------------------------------- PubMed

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthOf(v: string): number | null {
  if (/^\d{1,2}$/.test(v)) {
    return Number(v);
  }
  const i = MONTHS.indexOf(v.slice(0, 3).toLowerCase());
  return i >= 0 ? i + 1 : null;
}

export function parsePubmedXml(xml: string, abstractChars: number): ScholarRecord[] {
  const out: ScholarRecord[] = [];
  for (const art of elements(xml, "PubmedArticle", 100)) {
    // The reference list carries other articles' ids; only this article's ids count.
    const body = art.inner.replace(/<ReferenceList[\s\S]*?<\/ReferenceList>/g, "");
    const pmid = /<PMID[^>]*>(\d{1,9})<\/PMID>/.exec(body)?.[1];
    if (!pmid) {
      continue;
    }
    const pubDate = elements(body, "PubDate", 1)[0]?.inner ?? "";
    const year =
      Number(firstText(pubDate, "Year")) ||
      Number(/\b(\d{4})\b/.exec(firstText(pubDate, "MedlineDate"))?.[1]);
    const month = monthOf(firstText(pubDate, "Month"));
    const day = Number(firstText(pubDate, "Day")) || null;
    const articleYear = Number(firstText(elements(body, "ArticleDate", 1)[0]?.inner ?? "", "Year"));
    const idList = elements(elements(body, "PubmedData", 1)[0]?.inner ?? body, "ArticleId", 20);
    const doiEl = idList.find((a) => attr(a.attrs, "IdType") === "doi");
    const doi = doiEl ? cleanDoi(textOf(doiEl.inner)) : null;
    const abstract = elements(elements(body, "Abstract", 1)[0]?.inner ?? "", "AbstractText", 20)
      .map((a) => {
        const label = attr(a.attrs, "Label");
        const t = textOf(a.inner);
        return label ? `${label}: ${t}` : t;
      })
      .join(" ");
    const authors = elements(elements(body, "AuthorList", 1)[0]?.inner ?? "", "Author", 500).map(
      (a) =>
        firstText(a.inner, "CollectiveName") ||
        [
          firstText(a.inner, "ForeName") || firstText(a.inner, "Initials"),
          firstText(a.inner, "LastName"),
        ]
          .filter(Boolean)
          .join(" "),
    );
    const journal = elements(body, "Journal", 1)[0]?.inner ?? "";
    out.push(
      makeRecord(
        {
          source: "pubmed",
          primary: { kind: "pmid", value: pmid },
          doi,
          arxivId: null,
          pmid,
          openalexId: null,
          title: firstText(body, "ArticleTitle"),
          authors,
          venue: firstText(journal, "Title"),
          date: normalizeDate(year, month, day),
          years: [year, articleYear],
          abstract,
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          isOa: false,
          oaPdfUrl: null,
          license: null,
        },
        abstractChars,
      ),
    );
  }
  return out;
}

function eutilsUrl(http: ScholarHttp, tool: "esearch" | "efetch"): URL {
  const u = new URL(`${EUTILS}/${tool}.fcgi`);
  u.searchParams.set("db", "pubmed");
  u.searchParams.set("tool", http.settings.ncbiTool);
  if (http.settings.contactEmail) {
    u.searchParams.set("email", http.settings.contactEmail);
  }
  return u;
}

async function pubmedFetch(http: ScholarHttp, pmids: string[], abstractChars: number) {
  if (pmids.length === 0) {
    return [];
  }
  const u = eutilsUrl(http, "efetch");
  u.searchParams.set("id", pmids.join(","));
  u.searchParams.set("retmode", "xml");
  const res = await http.get("pubmed", u.toString(), "application/xml");
  return res.status === 404 ? [] : parsePubmedXml(res.text, abstractChars);
}

export async function pubmedSearch(http: ScholarHttp, p: SearchParams, abstractChars: number) {
  const u = eutilsUrl(http, "esearch");
  u.searchParams.set("term", p.query);
  u.searchParams.set("retmax", String(p.limit));
  u.searchParams.set("retmode", "json");
  u.searchParams.set("sort", p.since ? "pub_date" : "relevance");
  if (p.since) {
    u.searchParams.set("datetype", "pdat");
    u.searchParams.set("mindate", p.since.replace(/-/g, "/"));
    u.searchParams.set("maxdate", "3000/12/31");
  }
  const body = await http.json<{ esearchresult?: { idlist?: unknown[] } }>("pubmed", u.toString());
  const ids = arr(body?.esearchresult?.idlist)
    .filter((v): v is string => typeof v === "string" && /^\d{1,9}$/.test(v))
    .slice(0, p.limit);
  return pubmedFetch(http, ids, abstractChars);
}

export async function pubmedGet(http: ScholarHttp, pmid: string) {
  return (await pubmedFetch(http, [pmid], ABSTRACT_CHARS))[0] ?? null;
}

// ---------------------------------------------------------------- dispatch

export const SEARCHERS: Record<
  SourceId,
  (http: ScholarHttp, p: SearchParams, abstractChars: number) => Promise<ScholarRecord[]>
> = {
  arxiv: arxivSearch,
  openalex: openalexSearch,
  crossref: crossrefSearch,
  pubmed: pubmedSearch,
};

/** A full record for one identifier: the id's own source first, then the others. */
export async function getRecord(http: ScholarHttp, id: ScholarId): Promise<ScholarRecord | null> {
  switch (id.kind) {
    case "arxiv":
      return arxivGet(http, id.value);
    case "pmid":
      return pubmedGet(http, id.value);
    case "openalex":
      return openalexGet(http, id);
    case "doi":
      return (
        (await openalexGet(http, id)) ??
        (await crossrefGet(http, id.value)) ??
        (await doiCsl(http, id.value))
      );
  }
  return null;
}
