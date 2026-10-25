---
summary: "Scholar sources plugin for Kurahi Scholars: search and look up papers in arXiv, OpenAlex, Crossref and PubMed (free public APIs, no keys), check citations, fetch open-access PDFs into the Project through quarantine and malware scanning, grant deadline reminders; providers' rate limits built in"
read_when:
  - You are setting up the Research & academic template or its autopilot routines
  - You need to know which literature APIs Kurahi calls, how often and with what identification
  - You want to know when a PDF is fetched and when it is refused
title: "Scholar sources"
---

# Scholar sources

日本語: [学術情報源](/ja/connectors/scholar-sources)

| Property  | Value                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Plugin id | `scholar-sources` (bundled, **off by default**; the **Research & academic** template enables it for its Projects)             |
| Access    | Read-only toward every provider. No account, no API key, no credential                                                        |
| Writes    | One: an open-access PDF into the Project's `corpus-inbox/`, only through the [attachment intake](/security/attachment-intake) |
| Providers | arXiv API, OpenAlex, Crossref REST API, NCBI E-utilities (PubMed), doi.org content negotiation                                |
| Status    | Built and tested against responses recorded from the live APIs on 25 October 2026                                             |

## Tools

| Tool                      | What it does                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scholar_search`          | `query` or up to 5 `queries`, `sources` (arxiv, openalex, crossref, pubmed; default all), `since` (YYYY-MM-DD), `limit` ≤ 25. Normalized records merged across sources by DOI, arXiv id, PMID and OpenAlex id                             |
| `scholar_get`             | One paper by DOI, arXiv id, PMID or OpenAlex id: the full record with the abstract (up to 4,000 characters)                                                                                                                               |
| `scholar_cite_check`      | Up to 50 `citations`, or the `path` of a Project draft (a file, or a folder: its newest documents). Each reference: `verified`, `mismatch` or `not_found`, with the reason. `list: true` lists draft versions; `draft` checks one version |
| `scholar_fetch_pdf`       | The open-access PDF of one paper into `corpus-inbox/` (see below). Returns the stored path, never the content                                                                                                                             |
| `scholar_grant_deadlines` | The researcher's own deadline list (for example `knowledge/grants.md`) as reminders due today, 30, 14, 7, 3 and 1 days before each deadline and on the day; each reminder has a stable id                                                 |

A record has: `id` (the DOI when there is one, else `arxiv:`, `pmid:` or `openalex:`), title,
authors (at most 10, with the total), venue, date, every year the source gives, DOI / arXiv id /
PMID / OpenAlex id, URL, open-access status, open-access PDF and licence when known, and an
abstract snippet (at most 800 characters in a search). All provider text reaches the model inside
the untrusted-content boundary; a boundary marker inside a title or an abstract is neutralised.
Audit rows (`connector.scholar-sources.<op>`) carry ids, counts and byte sizes only, never a query,
a title or an abstract.

The tools work in Project chats and in [autopilot](/autopilot) routines, which may call all five
in `gather` (they are declared read tools of this plugin).

## Providers and their etiquette

Verified against each provider's documentation on 25 October 2026. Kurahi sends one request at
a time per provider, with one limiter per provider for the whole gateway process, so parallel
chats and routines share one budget.

| Provider         | Endpoint                                                                       | What the provider asks                                                                                                                                                                                             | Kurahi                                                 |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| arXiv            | `export.arxiv.org/api/query` (Atom)                                            | No more than one request every three seconds, one connection, for all your machines together ([terms](https://info.arxiv.org/help/api/tou.html))                                                                   | 1 request per 3 s; descriptive User-Agent              |
| OpenAlex         | `api.openalex.org/works`                                                       | 10 requests per second without a key; keyless calls share one small daily budget per IP address ([limits](https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication))                            | 5 per second; no key                                   |
| Crossref         | `api.crossref.org/works`                                                       | Public pool 5 per interval, concurrency 1; polite pool (with `mailto`) 10, concurrency 3; back off on 429 ([access](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)) | 3 per second, one at a time; `mailto` when configured  |
| NCBI E-utilities | `eutils.ncbi.nlm.nih.gov/entrez/eutils` (`esearch`, `efetch`)                  | At most 3 requests per second without an API key; `tool` and `email` on every call ([usage](https://www.ncbi.nlm.nih.gov/books/NBK25497/))                                                                         | 3 per second; `tool` and `email` on every call         |
| doi.org          | `https://doi.org/<doi>` with `Accept: application/vnd.citationstyles.csl+json` | Content negotiation for Crossref, DataCite, mEDRA and other agencies ([docs](https://citation.doi.org/docs.html))                                                                                                  | 3 per second; only for DOIs Crossref and OpenAlex lack |

Every call retries at most twice on 429 and 5xx (honouring `Retry-After` up to 30 seconds) and
then reports `rate_limited` or `provider_unavailable`. In a search, a source that refuses is named
(`Not available this time: arxiv (rate_limited)`) and the other sources still answer.

Notes from the live recording: arXiv answered `429 Rate exceeded.` (no `Retry-After`) to search
queries although they were minutes apart, while `id_list` lookups succeeded; Kurahi then reports
arXiv as not available and the other sources still answer. OpenAlex reports in every
keyless response that the address shares a daily budget of US$0.10 (about 100 list requests). A
weekly literature watch stays well inside both.

## Configuration

```json5
{
  plugins: {
    entries: {
      "scholar-sources": {
        config: {
          contactEmail: "lab@example.ac.jp", // Crossref mailto, NCBI email, User-Agent
          ncbiTool: "kurahi-scholar-sources", // register tool + email with NCBI
          sources: ["arxiv", "openalex", "crossref", "pubmed"], // scholar_search default
          timeoutSeconds: 30,
        },
      },
    },
  },
}
```

Nothing is required: without `contactEmail` the tools still work (Crossref's public pool, NCBI
without `email`). With it, use the researcher's or the lab's address.

## Citation check

`scholar_cite_check` resolves each reference by its identifier: a DOI through Crossref
(`/works/{doi}`), then doi.org content negotiation (DataCite and other agencies); an arXiv id
through the arXiv API; a PMID through PubMed. It then compares what the reference says with the
record: at least 60% of the record's title words must appear in the reference (when the reference
has text besides the identifier), and a year written in the reference must be one of the record's
years (issued, online, print, first version). A reference without an identifier is searched in
Crossref (`query.bibliographic`) and counts as `verified` only on a close match (80% of the title
words and the year). A provider error is reported as "could not be checked", never as a wrong
reference.

From a draft, the tool reads the part after the last References heading (`References`,
`Bibliography`, `参考文献`, `引用文献`, `文献`), one entry per numbered or bulleted line.

## Open-access PDFs only

`scholar_fetch_pdf` stores a PDF only when it is open access:

- an arXiv e-print (arXiv's terms allow retrieval for research use; the copy stays in the
  researcher's own Project and is not re-served), or
- a work whose best open-access location (OpenAlex) or Crossref licence is an **open licence**
  (Creative Commons or public domain) and names a direct PDF.

Anything else is refused before a byte is downloaded, including free-to-read copies without a
licence. The download goes through the SSRF guard (public hosts only, at most 5 redirects), is
capped at 20 MB and must start with `%PDF-` (a landing page is refused). The bytes then go through
the [attachment intake](/security/attachment-intake): quarantine, static policy, malware scan (fail
closed), and only on a clean verdict a copy in `corpus-inbox/` (a writable folder; 実行 Act mode).
A refusal by the intake is audited and sealed like any attachment refusal, and in an autopilot run
it flags the item `malicious_attachment`.

## Grant deadlines

`scholar_grant_deadlines` reads one `- YYYY-MM-DD | name | note` line per deadline (lines in HTML
comments are ignored) and computes the reminders due today in the given time zone (default
`Asia/Tokyo`): a deadline `n` days away falls in the smallest distance at least `n` (30, 14, 7, 3,
1, or 0 on the day; `remindDays` changes the distances). Each reminder's id
(`grant:<name>:<date>:d<distance>`) is stable, so a routine that fans out over the ids files each
reminder once. Nothing is submitted anywhere.

## Never

Never submits a paper or an application, never contacts anyone, never downloads a paywalled copy,
never sends a credential. See the Scholars never-list in [Autopilot](/autopilot#scholars).
