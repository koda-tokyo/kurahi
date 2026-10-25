// Test helpers: recorded provider responses (test-fixtures/, recorded 2026-10-25 from the live
// keyless APIs) behind a fake fetch, and a fake clock for the rate limiters.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../../src/connectors/business/index.js";
import { readSettings } from "./src/config.js";
import { createLimiters, ScholarHttp } from "./src/http.js";
import { createScholarTools, type ScholarToolDeps } from "./src/tools.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-fixtures");
export const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

export type Call = { url: URL; at: number; headers: Record<string, string> };
export type Route = (url: URL) => Response | null | undefined;

export function fakeClock() {
  const clock = { t: 1_000_000 };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const text = (body: string, status = 200, type = "application/xml") =>
  new Response(body, { status, headers: { "content-type": type } });

export function fakeFetch(routes: Route[], clock: { t: number }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, at: clock.t, headers });
    for (const r of routes) {
      const res = r(url);
      if (res) {
        return res;
      }
    }
    return new Response("Resource not found.", { status: 404 });
  };
  return { fetch, calls };
}

/** Standard routes over the recorded fixtures. */
export const recorded: Route[] = [
  (u) =>
    u.hostname === "export.arxiv.org" && u.searchParams.get("id_list") === "1706.03762"
      ? text(fixture("arxiv-get.xml"), 200, "application/atom+xml")
      : null,
  (u) =>
    u.hostname === "api.openalex.org" && u.pathname === "/works"
      ? json(JSON.parse(fixture("openalex-search.json")))
      : null,
  (u) =>
    u.hostname === "api.crossref.org" && u.pathname === "/works/10.1038/nature14539"
      ? json(JSON.parse(fixture("crossref-work.json")))
      : null,
  (u) =>
    u.hostname === "api.crossref.org" && u.pathname === "/works"
      ? json(JSON.parse(fixture("crossref-search.json")))
      : null,
  (u) =>
    u.hostname === "eutils.ncbi.nlm.nih.gov" && u.pathname.endsWith("/esearch.fcgi")
      ? json(JSON.parse(fixture("pubmed-esearch.json")))
      : null,
  (u) =>
    u.hostname === "eutils.ncbi.nlm.nih.gov" && u.pathname.endsWith("/efetch.fcgi")
      ? text(fixture("pubmed-efetch.xml"))
      : null,
  (u) =>
    u.hostname === "doi.org" && u.pathname === "/10.5281/zenodo.7108361"
      ? json(JSON.parse(fixture("doi-csl.json")))
      : null,
];

export function makeTools(
  routes: Route[],
  opts: {
    config?: Record<string, unknown>;
    ctx?: ScholarToolDeps["ctx"];
    extra?: Partial<ScholarToolDeps>;
  } = {},
) {
  const c = fakeClock();
  const f = fakeFetch(routes, c.clock);
  const settings = readSettings(opts.config ?? { contactEmail: "lab@example.org" });
  const limiters = createLimiters(c.now, c.sleep);
  const http = new ScholarHttp(settings, limiters, {
    fetch: f.fetch,
    now: c.now,
    sleep: c.sleep,
    random: () => 0,
  });
  const audits: Array<{ action: string; outcome?: string; detail?: Record<string, unknown> }> = [];
  const tools = createScholarTools({
    http,
    limiters,
    ctx: opts.ctx ?? { agentId: "main" },
    audit: (row) => audits.push(row),
    ...opts.extra,
  });
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
    const res = (await tool.execute("call-1", params as never)) as {
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    };
    return { text: res.content[0]?.text ?? "", details: res.details ?? {} };
  };
  return { ...c, ...f, http, limiters, tools, run, audits };
}
