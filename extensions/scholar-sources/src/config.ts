// Scholar sources: settings and the providers' published etiquette.
//
// Every provider is free and needs no account. What each one asks of a client (read 2026-10-25):
//   arXiv     no more than one request every three seconds, one connection at a time, for all
//             machines of the user together: https://info.arxiv.org/help/api/tou.html
//             API: https://info.arxiv.org/help/api/user-manual.html
//   OpenAlex  10 requests per second without a key; keyless calls share one small daily budget per
//             IP address (`meta.notice` and `meta.cost_usd` in every response):
//             https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication
//   Crossref  public pool 5 requests per interval with concurrency 1; polite pool (mailto or
//             agent header) 10 with concurrency 3; back off on 429:
//             https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/
//             https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/
//   NCBI      at most 3 requests per second without an API key; `tool` and `email` on every call:
//             https://www.ncbi.nlm.nih.gov/books/NBK25497/
// We stay below each limit, one request at a time per provider, with one limiter per provider
// for the whole gateway process (not per session), so parallel chats share the same budget.

export const PLUGIN_ID = "scholar-sources";
export const SOURCES = ["arxiv", "openalex", "crossref", "pubmed"] as const;
export type SourceId = (typeof SOURCES)[number];

export const isSource = (v: unknown): v is SourceId =>
  typeof v === "string" && (SOURCES as readonly string[]).includes(v);

/** Requests per window per provider (sliding window; see the etiquette above). */
export const RATE: Record<SourceId | "doi", { max: number; windowMs: number }> = {
  arxiv: { max: 1, windowMs: 3_000 },
  openalex: { max: 5, windowMs: 1_000 },
  crossref: { max: 3, windowMs: 1_000 },
  pubmed: { max: 3, windowMs: 1_000 },
  doi: { max: 3, windowMs: 1_000 },
};

export type ScholarSettings = {
  contactEmail: string | null;
  ncbiTool: string;
  sources: SourceId[];
  timeoutMs: number;
};

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export function readSettings(raw: unknown): ScholarSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const email = typeof r.contactEmail === "string" ? r.contactEmail.trim() : "";
  const tool =
    typeof r.ncbiTool === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(r.ncbiTool)
      ? r.ncbiTool
      : "kurahi-scholar-sources";
  const sources = Array.isArray(r.sources) ? [...new Set(r.sources.filter(isSource))] : [];
  const secs =
    typeof r.timeoutSeconds === "number" && Number.isInteger(r.timeoutSeconds)
      ? Math.min(Math.max(r.timeoutSeconds, 5), 120)
      : 30;
  return {
    contactEmail: EMAIL.test(email) ? email : null,
    ncbiTool: tool,
    sources: sources.length ? sources : [...SOURCES],
    timeoutMs: secs * 1000,
  };
}

/** A descriptive User-Agent (arXiv and Crossref ask clients to identify themselves). */
export function userAgent(settings: ScholarSettings): string {
  const contact = settings.contactEmail ? `; mailto:${settings.contactEmail}` : "";
  return `Kurahi-ScholarSources/1.0 (+https://docs.kodasoken.com/connectors/scholar-sources${contact})`;
}
