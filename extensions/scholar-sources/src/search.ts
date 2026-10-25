import type { SourceId } from "./config.js";
import type { ScholarHttp } from "./http.js";
// scholar_search: one or more queries across the chosen sources, one request at a time per
// provider (the limiters space them), merged by DOI / arXiv id / PMID / OpenAlex id, bounded.
// A source that fails is reported by its error code and the others still answer.
import { errorCodeOf } from "../../../src/connectors/business/index.js";
import { mergeRecord, recordKeys, type ScholarRecord, SNIPPET_CHARS } from "./record.js";
import { SEARCHERS } from "./sources.js";

export const MAX_LIMIT = 25;
export const MAX_QUERIES = 5;

export type SearchInput = {
  queries: string[];
  sources: SourceId[];
  since: string | null;
  limit: number;
};

export type SearchOutput = {
  records: ScholarRecord[];
  failures: Array<{ source: SourceId; code: string }>;
  perSource: Partial<Record<SourceId, number>>;
  calls: number;
};

export async function searchAll(http: ScholarHttp, input: SearchInput): Promise<SearchOutput> {
  const lists: ScholarRecord[][] = [];
  const failures: SearchOutput["failures"] = [];
  const perSource: SearchOutput["perSource"] = {};
  let calls = 0;
  const per = Math.min(MAX_LIMIT, input.limit);
  for (const source of input.sources) {
    for (const query of input.queries) {
      calls++;
      try {
        const found = await SEARCHERS[source](
          http,
          { query, since: input.since, limit: per },
          SNIPPET_CHARS,
        );
        perSource[source] = (perSource[source] ?? 0) + found.length;
        lists.push(found);
      } catch (err) {
        if (!failures.some((f) => f.source === source)) {
          failures.push({ source, code: errorCodeOf(err) });
        }
        break; // one failure per source is enough; do not hammer a provider that refuses
      }
    }
  }
  // Round-robin over the lists so every source and every query is represented, then merge
  // duplicates into the first record of the same work.
  const byKey = new Map<string, number>();
  const records: ScholarRecord[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r) {
        continue;
      }
      const keys = recordKeys(r);
      const at = keys.map((k) => byKey.get(k)).find((v) => v !== undefined);
      if (at !== undefined) {
        records[at] = mergeRecord(records[at], r);
        for (const k of recordKeys(records[at])) {
          byKey.set(k, at);
        }
        continue;
      }
      records.push(r);
      for (const k of keys) {
        byKey.set(k, records.length - 1);
      }
    }
  }
  let out = records;
  if (input.since) {
    // Newest first when watching for new work (records without a date go last).
    out = out.toSorted((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }
  return { records: out.slice(0, input.limit), failures, perSource, calls };
}

/** `since` as YYYY-MM-DD: an ISO date or date-time from 1900 on, else an error message. */
export function parseSince(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null || v === "") {
    return { ok: true, value: null };
  }
  if (typeof v !== "string") {
    return { ok: false };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.+-Z]{0,40})?$/.exec(v.trim());
  if (!m) {
    return { ok: false };
  }
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 2999) {
    return { ok: false };
  }
  return { ok: true, value: d.toISOString().slice(0, 10) };
}
