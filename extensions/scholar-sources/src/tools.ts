import { Type } from "@sinclair/typebox";
// Scholar sources: the agent tools. All read-only toward the providers; scholar_fetch_pdf is the
// one tool that stores something, and only an open-access PDF that passed the attachment intake,
// in the Project's corpus-inbox/. Every provider text reaches the model inside the
// untrusted-content boundary; audit rows carry ids and counts only, never queries or text.
import type { AnyAgentTool } from "../../../src/agents/pi-tools.types.js";
import type { LookupFn } from "../../../src/infra/net/ssrf.js";
import type {
  AttachmentIntakeInput,
  AttachmentIntakeResult,
} from "../../../src/security/attachment-intake.js";
import type { Limiters, ScholarHttp } from "./http.js";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  asAgentTool,
  audited,
  ConnectorError,
  type ConnectorAuditSink,
  type ConnectorCallAudit,
  errorResult,
  intParam,
  strParam,
  textResult,
  type ToolContext,
  type ToolResult,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import {
  checkCitations,
  extractReferences,
  formatCiteResults,
  MAX_CITATIONS,
} from "./citecheck.js";
import { isSource, PLUGIN_ID, SOURCES, type SourceId } from "./config.js";
import {
  DEFAULT_REMIND_DAYS,
  dayIn,
  dueReminders,
  formatReminders,
  parseDeadlines,
} from "./deadlines.js";
import { draftRef, parseDraftRef, projectOf, readDrafts } from "./drafts.js";
import { auditId, parseScholarId, type ScholarId } from "./ids.js";
import { FETCH_PDF_TOOL, fetchOpenAccessPdf, type PdfFetch } from "./pdf.js";
import { formatRecord } from "./record.js";
import { MAX_LIMIT, MAX_QUERIES, parseSince, searchAll } from "./search.js";
import { getRecord } from "./sources.js";

export const SCHOLAR_TOOL_NAMES = [
  "scholar_search",
  "scholar_get",
  "scholar_cite_check",
  FETCH_PDF_TOOL,
  "scholar_grant_deadlines",
] as const;

export type ScholarToolDeps = {
  http: ScholarHttp;
  limiters: Limiters;
  ctx: ToolContext;
  audit?: ConnectorAuditSink;
  /** PDF downloads (tests): fetch, DNS lookup and pinning of the SSRF guard. */
  pdfFetch?: PdfFetch;
  lookupFn?: LookupFn;
  pinDns?: boolean;
  intake?: (input: AttachmentIntakeInput) => Promise<AttachmentIntakeResult>;
  now?: () => Date;
};

const wrap = (text: string) => wrapUntrusted(text, { source: "api" });

function idParam(v: unknown): ScholarId {
  const id = parseScholarId(v);
  if (!id) {
    throw new ConnectorError(
      "bad_request",
      "invalid id",
      undefined,
      "id must be a DOI (10.…), an arXiv id (2401.01234), a PMID (pmid:123) or an OpenAlex id (W123…)",
    );
  }
  return id;
}

function sinceParam(v: unknown): string | null {
  const s = parseSince(v);
  if (!s.ok) {
    throw new ConnectorError(
      "bad_request",
      "invalid since",
      undefined,
      "since must be an ISO date (YYYY-MM-DD)",
    );
  }
  return s.value;
}

function stringList(v: unknown, name: string, max: number, maxChars: number): string[] {
  if (v === undefined || v === null) {
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConnectorError("bad_request", `${name} must be a list of strings`);
  }
  const out = [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
  if (out.length > max) {
    throw new ConnectorError("bad_request", `${name}: at most ${max}`);
  }
  if (out.some((s) => s.length > maxChars)) {
    throw new ConnectorError("bad_request", `${name}: each at most ${maxChars} characters`);
  }
  return out;
}

export function createScholarTools(deps: ScholarToolDeps): AnyAgentTool[] {
  const { http, ctx } = deps;
  const run = async <T>(
    op: string,
    body: () => Promise<{ value: T; result: ToolResult }>,
    meta?: (v: T) => Pick<ConnectorCallAudit, "ids" | "count" | "bytes" | "kind">,
  ): Promise<ToolResult> => {
    try {
      const out = await audited(
        deps.audit,
        { connectorId: PLUGIN_ID, op, agentId: ctx.agentId, sessionKey: ctx.sessionKey },
        body,
        (o) => meta?.(o.value) ?? {},
      );
      return out.result;
    } catch (err) {
      return errorResult(err);
    }
  };

  const search = asAgentTool({
    name: "scholar_search",
    label: "Scholar: search the literature",
    description: `Search arXiv, OpenAlex, Crossref and PubMed (free public APIs) for papers. Give a query, or up to ${MAX_QUERIES} queries; optionally the sources, a since date (YYYY-MM-DD: only work published or submitted on or after it) and a limit (≤ ${MAX_LIMIT}). Returns normalized records: id, title, authors, venue, date, DOI / arXiv id / PMID, URL, open-access PDF when there is one, and an abstract snippet. Results are merged across sources. Read-only.`,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 300 })),
      queries: Type.Optional(
        Type.Array(Type.String({ maxLength: 300 }), { maxItems: MAX_QUERIES }),
      ),
      sources: Type.Optional(Type.Array(stringEnum(SOURCES), { maxItems: SOURCES.length })),
      since: Type.Optional(Type.String({ description: "ISO date YYYY-MM-DD" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
    }),
    execute: (_id, params) =>
      run(
        "search",
        async () => {
          const single = strParam(params.query, "query", { max: 300 });
          const queries = [
            ...new Set([
              ...(single ? [single] : []),
              ...stringList(params.queries, "queries", MAX_QUERIES, 300),
            ]),
          ].slice(0, MAX_QUERIES);
          if (queries.length === 0 || queries.some((q) => q.length < 2)) {
            throw new ConnectorError("bad_request", "query is required");
          }
          const wanted = stringList(params.sources, "sources", SOURCES.length, 16);
          if (wanted.some((s) => !isSource(s))) {
            throw new ConnectorError("bad_request", `sources must be among ${SOURCES.join(", ")}`);
          }
          const sources = (wanted.length ? wanted : http.settings.sources) as SourceId[];
          const since = sinceParam(params.since);
          const limit = intParam(params.limit, 10, 1, MAX_LIMIT);
          const found = await searchAll(http, { queries, sources, since, limit });
          const head = [
            `Found ${found.records.length} record(s) for ${queries.length} query(ies) in ${sources.join(", ")}${since ? ` since ${since}` : ""}.`,
            ...(found.failures.length
              ? [
                  `Not available this time: ${found.failures.map((f) => `${f.source} (${f.code})`).join(", ")}.`,
                ]
              : []),
          ];
          const body = found.records.map((r, i) => formatRecord(r, i + 1)).join("\n\n");
          return {
            value: found,
            result: textResult(wrap([...head, "", body].join("\n").trim()), {
              count: found.records.length,
              ids: found.records.map((r) => r.id),
              failures: found.failures,
            }),
          };
        },
        (f) => ({
          count: f.records.length,
          ids: f.records.map((r) => auditId(parseScholarId(r.id) ?? { kind: "doi", value: "x" })),
        }),
      ),
  });

  const get = asAgentTool({
    name: "scholar_get",
    label: "Scholar: get one paper",
    description:
      "Get the full record of one paper by DOI, arXiv id, PMID or OpenAlex id: title, authors, venue, date, identifiers, URL, open-access status and the abstract (bounded). Read-only.",
    parameters: Type.Object({ id: Type.String({ maxLength: 300 }) }),
    execute: (_id, params) =>
      run(
        "get",
        async () => {
          const id = idParam(params.id);
          const record = await getRecord(http, id);
          const text = record ? wrap(formatRecord(record, 1)) : `Not found: ${id.kind}:${id.value}`;
          return {
            value: { id, found: Boolean(record) },
            result: textResult(text, { found: Boolean(record), id: record?.id ?? null }),
          };
        },
        (v) => ({ ids: [auditId(v.id)], count: v.found ? 1 : 0 }),
      ),
  });

  const citeCheck = asAgentTool({
    name: "scholar_cite_check",
    label: "Scholar: check citations",
    description: `Check that references resolve and match: each DOI (Crossref, then doi.org), arXiv id or PMID is looked up and its title words and year are compared with the reference; a reference without an identifier is searched in Crossref and verified only on a close match. Give up to ${MAX_CITATIONS} citations, or the path of a Project draft (or a folder: its newest documents, optionally changed since a date) to read its References section. Status per reference: verified, mismatch or not_found. With list: true and a folder path, only list the newest drafts as versioned ids; pass one as draft to check that version. Read-only.`,
    parameters: Type.Object({
      citations: Type.Optional(
        Type.Array(Type.String({ maxLength: 1000 }), { maxItems: MAX_CITATIONS }),
      ),
      path: Type.Optional(Type.String({ maxLength: 500 })),
      since: Type.Optional(Type.String({ description: "ISO date YYYY-MM-DD (folder paths)" })),
      list: Type.Optional(Type.Boolean()),
      draft: Type.Optional(Type.String({ maxLength: 1600 })),
    }),
    execute: (_id, params) =>
      run(
        "cite_check",
        async () => {
          const given = stringList(params.citations, "citations", MAX_CITATIONS, 1000);
          const p = strParam(params.path, "path", { max: 500 });
          const draft = strParam(params.draft, "draft", { max: 1600 });
          const since = sinceParam(params.since);
          if (params.list === true) {
            if (!p) {
              throw new ConnectorError("bad_request", "list needs a folder path");
            }
            const drafts = await readDrafts(ctx, p, since, { text: false });
            const text = [
              `Drafts in ${p} (newest first): ${drafts.length}`,
              ...drafts.map(
                (d, i) =>
                  `${i + 1}. id: ${draftRef(d)}\n   path: ${d.path} · modified ${d.modifiedAt.slice(0, 10)} · version ${d.sha12}`,
              ),
            ].join("\n");
            return {
              value: { counts: { verified: 0, mismatch: 0, not_found: 0 }, n: 0 },
              result: textResult(wrap(text), { drafts: drafts.map((d) => draftRef(d)) }),
            };
          }
          if (!given.length && !p && !draft) {
            throw new ConnectorError("bad_request", "citations, path or draft is required");
          }
          const groups: Array<{ label: string | null; refs: string[] }> = [];
          if (given.length) {
            groups.push({ label: null, refs: given });
          }
          const files = [];
          if (draft) {
            const ref = parseDraftRef(draft);
            if (!ref) {
              throw new ConnectorError("bad_request", "invalid draft id");
            }
            for (const d of await readDrafts(ctx, ref.path, null)) {
              files.push({ ...d, changed: d.sha12 !== ref.sha12 });
            }
          }
          if (p) {
            for (const d of await readDrafts(ctx, p, since)) {
              files.push({ ...d, changed: false });
            }
          }
          for (const d of files) {
            groups.push({
              label: `${d.path} (version ${d.sha12}, modified ${d.modifiedAt.slice(0, 10)}${d.changed ? "; changed since it was listed, the current version was checked" : ""})`,
              refs: extractReferences(d.text),
            });
          }
          let budget = MAX_CITATIONS;
          const sections: string[] = [];
          const all: Awaited<ReturnType<typeof checkCitations>> = [];
          for (const g of groups) {
            const refs = g.refs.slice(0, Math.max(0, budget));
            budget -= refs.length;
            const results = await checkCitations(http, refs);
            all.push(...results);
            sections.push(
              `${g.label ? `Draft ${g.label}\n` : ""}${refs.length ? formatCiteResults(results) : "No references found."}`,
            );
          }
          if ((p || draft) && groups.every((g) => g.label === null)) {
            sections.push(
              `No draft in ${p ?? "the Project"} ${since ? `changed since ${since}` : "to read"}.`,
            );
          }
          const counts = { verified: 0, mismatch: 0, not_found: 0 };
          for (const r of all) {
            counts[r.status]++;
          }
          return {
            value: { counts, n: all.length },
            result: textResult(wrap(sections.join("\n\n")), {
              counts,
              results: all.map((r) => ({
                index: r.index,
                status: r.status,
                identifier: r.identifier,
              })),
            }),
          };
        },
        (v) => ({ count: v.n }),
      ),
  });

  const fetchPdf = asAgentTool({
    name: FETCH_PDF_TOOL,
    label: "Scholar: fetch an open-access PDF into the Project",
    description:
      "Fetch the open-access PDF of one paper (arXiv e-print, or a work whose open copy carries an open licence such as CC BY) into the Project's corpus-inbox/ folder. The file is quarantined, checked and scanned for malware first; only a clean file is stored. Returns the stored path, never the content. Refuses works without an open-access licence. Needs a Project in Act mode with corpus-inbox writable.",
    parameters: Type.Object({ id: Type.String({ maxLength: 300 }) }),
    execute: (_id, params) =>
      run(
        "fetch_pdf",
        async () => {
          const id = idParam(params.id);
          const project = projectOf(ctx);
          const out = await fetchOpenAccessPdf(
            {
              http,
              limiters: deps.limiters,
              fetch: deps.pdfFetch,
              lookupFn: deps.lookupFn,
              pinDns: deps.pinDns,
              intake: deps.intake,
            },
            project,
            ctx,
            id,
          );
          const ref = auditId(id);
          if (!out.decision.ok) {
            return {
              value: { id, status: "not_open_access", bytes: 0 },
              result: textResult(`Refused: ${out.decision.reason}. Nothing was downloaded.`, {
                status: "not_open_access",
              }),
            };
          }
          const r = out.result!;
          if (r.status === "refused") {
            return {
              value: { id, status: "refused", bytes: r.size },
              result: textResult(
                `The attachment intake refused the PDF (${r.code}): ${r.reason}. Nothing was stored.`,
                {
                  status: "refused",
                  attachment: { status: "refused", code: r.code, messageId: ref },
                },
              ),
            };
          }
          return {
            value: { id, status: "accepted", bytes: r.size },
            result: textResult(
              `Stored ${r.path} (${r.size} bytes, sha256 ${r.sha256.slice(0, 16)}…, scan ${r.verdict}, licence ${out.decision.license}). The text is not returned here; read the file from the Project when needed.`,
              {
                status: "accepted",
                path: r.path,
                sha256: r.sha256,
                size: r.size,
                license: out.decision.license,
                attachment: { status: "accepted", messageId: ref },
              },
            ),
          };
        },
        (v) => ({ ids: [auditId(v.id)], bytes: v.bytes, kind: "pdf" }),
      ),
  });

  const deadlines = asAgentTool({
    name: "scholar_grant_deadlines",
    label: "Scholar: grant deadline reminders",
    description:
      "Read a deadline list kept in the Project (e.g. knowledge/grants.md, one `- YYYY-MM-DD | name | note` line per deadline) and list the reminders due today: each deadline once at each distance before it (default 30, 14, 7, 3 and 1 days, and on the day). Give id to get one reminder. Read-only; nothing is submitted.",
    parameters: Type.Object({
      path: Type.String({ maxLength: 500 }),
      remindDays: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 365 }), { maxItems: 6 }),
      ),
      id: Type.Optional(Type.String({ maxLength: 200 })),
      tz: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    execute: (_id, params) =>
      run(
        "grant_deadlines",
        async () => {
          const p = strParam(params.path, "path", { required: true, max: 500 })!;
          const tz = strParam(params.tz, "tz", { max: 64 }) ?? "Asia/Tokyo";
          try {
            new Intl.DateTimeFormat("en-CA", { timeZone: tz });
          } catch {
            throw new ConnectorError("bad_request", "invalid tz");
          }
          const remind = Array.isArray(params.remindDays)
            ? params.remindDays.filter(
                (n): n is number =>
                  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 365,
              )
            : DEFAULT_REMIND_DAYS;
          const [file] = await readDrafts(ctx, p, null);
          if (!file) {
            throw new ConnectorError(
              "not_found",
              "no file",
              undefined,
              "no deadline list at that path",
            );
          }
          const today = dayIn(deps.now?.() ?? new Date(), tz);
          let due = dueReminders(
            parseDeadlines(file.text),
            today,
            remind.length ? remind : DEFAULT_REMIND_DAYS,
          );
          const one = strParam(params.id, "id", { max: 200 });
          if (one) {
            due = due.filter((r) => r.id === one);
          }
          const text =
            one && due.length === 0
              ? `No reminder ${one} is due today (${today}).`
              : formatReminders(due, { path: file.path, today, tz });
          return {
            value: due.length,
            result: textResult(wrap(text), { count: due.length, ids: due.map((r) => r.id) }),
          };
        },
        (n) => ({ count: n }),
      ),
  });

  return [search, get, citeCheck, fetchPdf, deadlines];
}
