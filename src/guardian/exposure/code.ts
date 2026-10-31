// guardian_exposure_code (optional): GitHub code search for the organisation's domains and brand
// terms next to secret-like keywords. Off unless `guardian.exposure.github.enabled` and the token
// `guardian.exposure.githubToken` is in the secrets store (never logged). Only repository and file
// URLs are reported; file content is never requested (no text-match fragments).

import type { ExposureDeps, ExposureResult } from "./common.js";

const GITHUB_SEARCH = "https://api.github.com/search/code";
/** Code search allows 10 requests a minute with a token. */
const GITHUB_INTERVAL_MS = 6500;
const QUERIES_MAX = 20;
const PER_QUERY = 30;

export const CODE_KEYWORDS = ["password", "secret", "api_key", "token"];

export function codeQueries(domains: readonly string[], brandTerms: readonly string[]): string[] {
  const terms = [...domains, ...brandTerms].map((t) => `"${t.replace(/"/g, "")}"`);
  const out: string[] = [];
  for (const t of terms) {
    for (const k of CODE_KEYWORDS) {
      if (out.length < QUERIES_MAX) {
        out.push(`${t} ${k}`);
      }
    }
  }
  return out;
}

export type CodeHit = { repository: string; path: string; url: string; query: number };

export function parseCodeSearch(json: string, query: number): CodeHit[] {
  const data = JSON.parse(json) as { items?: unknown };
  if (!data || !Array.isArray(data.items)) {
    throw new Error("GitHub answer has no items");
  }
  const out: CodeHit[] = [];
  for (const it of data.items as Record<string, unknown>[]) {
    const repo = (it.repository as Record<string, unknown> | undefined)?.full_name;
    if (
      typeof repo === "string" &&
      typeof it.path === "string" &&
      typeof it.html_url === "string"
    ) {
      out.push({ repository: repo, path: it.path, url: it.html_url, query });
    }
  }
  return out;
}

export async function checkCode(
  domains: readonly string[],
  brandTerms: readonly string[],
  deps: ExposureDeps,
  token: string,
): Promise<ExposureResult> {
  const queries = codeQueries(domains, brandTerms);
  const hits = new Map<string, CodeHit>();
  const findings: ExposureResult["findings"] = [];
  let failed = 0;
  for (const [i, q] of queries.entries()) {
    if (i > 0) {
      await deps.sleep(GITHUB_INTERVAL_MS);
    }
    try {
      const res = await deps.http(
        `${GITHUB_SEARCH}?q=${encodeURIComponent(q)}&per_page=${PER_QUERY}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          maxBytes: 5 * 1024 ** 2,
        },
      );
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }
      for (const h of parseCodeSearch(res.body, i + 1)) {
        hits.set(h.url, hits.get(h.url) ?? h);
      }
    } catch (err) {
      failed += 1;
      findings.push({
        subject: `query${i + 1}`,
        detail: `code search failed (${String((err as Error).message ?? err).slice(0, 120)})`,
        rank: 1,
      });
    }
  }
  const list = [...hits.values()];
  findings.unshift(
    ...list.map((h) => ({
      subject: h.url,
      detail: `organisation name or domain next to a secret keyword (query ${h.query}) in ${h.repository}`,
      rank: 0,
    })),
  );
  return {
    facts: {
      queries: queries.length,
      files: list.length,
      repositories: new Set(list.map((h) => h.repository)).size,
      failed,
    },
    findings,
  };
}
