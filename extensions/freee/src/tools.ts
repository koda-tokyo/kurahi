// freee 会計 tools (read-only): companies, deals (取引) list / get, partners, account items and
// receipt (証憑) metadata. Only the configured companies can be read. Text a customer typed
// (descriptions, partner names, memo) reaches the model only inside the untrusted-content
// boundary. Receipt files are never downloaded (metadata only).
//
// No write tool: POST /deals has no draft or approval field (status settled/unsettled is the
// payment state), so a created deal always affects the books. Drafts exist only for 各種申請,
// 経費申請 and 支払依頼 (`draft: true`), which are workflow requests, not deals.
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  asAgentTool,
  ConnectorError,
  type ConnectorRuntime,
  intParam,
  runConnectorTool,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { FREEE_API, type FreeeSettings, SCOPES } from "./config.js";

type Obj = Record<string, unknown>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 10_000;

function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).replace(/[\r\n]+/g, " ") : "";
}

function dateParam(v: unknown, name: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) {
      throw new ConnectorError("bad_request", `${name} is required (YYYY-MM-DD)`);
    }
    return undefined;
  }
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ConnectorError("bad_request", `${name} must be YYYY-MM-DD`);
  }
  return v;
}

function positiveId(v: unknown, name: string): string {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    throw new ConnectorError("bad_request", `invalid ${name}`);
  }
  return String(n);
}

export type FreeeToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  settings: FreeeSettings;
};

export function createFreeeTools(deps: FreeeToolDeps) {
  const { runtime, ctx, settings } = deps;
  const read = [SCOPES.read];
  const url = (path: string, query: Array<[string, string | undefined]>) => {
    const u = new URL(`${FREEE_API}${path}`);
    for (const [k, v] of query) {
      if (v !== undefined && v !== "") {
        u.searchParams.set(k, v);
      }
    }
    return u.toString();
  };
  const company = (v: unknown): string => {
    if (v === undefined && settings.companyIds.length > 1) {
      throw new ConnectorError("bad_request", "companyId is required");
    }
    const id = v === undefined ? settings.companyIds[0] : Number(v);
    if (!settings.companyIds.includes(id)) {
      throw new ConnectorError(
        "forbidden",
        "company not configured",
        undefined,
        "this company is not in the connector's configured company list",
      );
    }
    return String(id);
  };
  const companyParam = Type.Optional(
    Type.Integer({ description: "freee company id (optional when only one is configured)" }),
  );
  const page = (params: Obj) => ({
    limit: intParam(params.limit, 20, 1, MAX_LIMIT),
    offset: intParam(params.offset, 0, 0, MAX_OFFSET),
  });
  const more = (n: number, p: { limit: number; offset: number }) =>
    n === p.limit ? `\n(more may exist: offset ${p.offset + p.limit})` : "";

  const companies = asAgentTool({
    name: "freee_companies_list",
    label: "freee: list companies",
    description:
      "List the freee companies (事業所) this connector may read: id and name. Read-only.",
    parameters: Type.Object({}),
    execute: () =>
      runConnectorTool(
        runtime,
        ctx,
        "companies.list",
        async () => {
          const res = await runtime.json<{ companies?: Obj[] }>({
            url: url("/companies", []),
            scopes: read,
          });
          const value = (res.companies ?? []).filter((c) =>
            settings.companyIds.includes(Number(c.id)),
          );
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (c) =>
                      `- company ${str(c.id)}: ${str(c.display_name ?? c.name)} (${str(c.role)})`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "None of the configured companies is accessible to this sign-in.";
          return { value: value.map((c) => str(c.id)), result: textResult(text) };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const formatDeal = (d: Obj, withDetails: boolean) => {
    const details = Array.isArray(d.details) ? (d.details as Obj[]) : [];
    const head = `- deal ${str(d.id)}: ${str(d.type)} ${str(d.issue_date)} amount ${str(d.amount)} (due ${str(d.due_amount)} by ${str(d.due_date)}) status ${str(d.status)} partner ${str(d.partner_id)} ref ${str(d.ref_number)}`;
    if (!withDetails) {
      return `${head}\n  lines: ${details.length}`;
    }
    return [
      head,
      ...details
        .slice(0, 50)
        .map(
          (l) =>
            `  line ${str(l.id)}: account_item ${str(l.account_item_id)} tax ${str(l.tax_code)} amount ${str(l.amount)} vat ${str(l.vat)} ${str(l.description)}`,
        ),
    ].join("\n");
  };

  const deals = asAgentTool({
    name: "freee_deals_list",
    label: "freee: list deals",
    description:
      "List deals (取引) of a configured company, newest first, with optional type, payment status, partner and issue-date range. At most 100 per call. Read-only.",
    parameters: Type.Object({
      companyId: companyParam,
      type: Type.Optional(stringEnum(["income", "expense"] as const)),
      status: Type.Optional(stringEnum(["unsettled", "settled"] as const)),
      partnerId: Type.Optional(Type.Integer({ minimum: 1 })),
      startIssueDate: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      endIssueDate: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "deals.list",
        async () => {
          const p = page(params);
          const type = params.type === undefined ? undefined : str(params.type);
          const status = params.status === undefined ? undefined : str(params.status);
          if (type && type !== "income" && type !== "expense") {
            throw new ConnectorError("bad_request", "invalid type");
          }
          if (status && status !== "unsettled" && status !== "settled") {
            throw new ConnectorError("bad_request", "invalid status");
          }
          const res = await runtime.json<{ deals?: Obj[] }>({
            url: url("/deals", [
              ["company_id", company(params.companyId)],
              ["type", type],
              ["status", status],
              [
                "partner_id",
                params.partnerId === undefined
                  ? undefined
                  : positiveId(params.partnerId, "partner id"),
              ],
              ["start_issue_date", dateParam(params.startIssueDate, "startIssueDate")],
              ["end_issue_date", dateParam(params.endIssueDate, "endIssueDate")],
              ["limit", String(p.limit)],
              ["offset", String(p.offset)],
            ]),
            scopes: read,
          });
          const value = (res.deals ?? []).slice(0, p.limit);
          const text = value.length
            ? wrapUntrusted(value.map((d) => formatDeal(d, false)).join("\n"), { source: "api" })
            : "No deals.";
          return {
            value: value.map((d) => str(d.id)),
            result: textResult(`${text}${more(value.length, p)}`, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const deal = asAgentTool({
    name: "freee_deal_get",
    label: "freee: get deal",
    description:
      "Get one deal (取引) with its lines (account item, tax code, amount, description). Read-only.",
    parameters: Type.Object({ companyId: companyParam, id: Type.Integer({ minimum: 1 }) }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "deals.get",
        async () => {
          const id = positiveId(params.id, "deal id");
          const res = await runtime.json<{ deal?: Obj }>({
            url: url(`/deals/${id}`, [["company_id", company(params.companyId)]]),
            scopes: read,
          });
          return {
            value: id,
            result: textResult(wrapUntrusted(formatDeal(res.deal ?? {}, true), { source: "api" })),
          };
        },
        (id) => ({ ids: [id], count: 1 }),
      ),
  });

  const partners = asAgentTool({
    name: "freee_partners_list",
    label: "freee: list partners",
    description:
      "List partners (取引先) of a configured company: id, code, name, long name. At most 100 per call. Bank and address details are not read. Read-only.",
    parameters: Type.Object({
      companyId: companyParam,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "partners.list",
        async () => {
          const p = page(params);
          const res = await runtime.json<{ partners?: Obj[] }>({
            url: url("/partners", [
              ["company_id", company(params.companyId)],
              ["limit", String(p.limit)],
              ["offset", String(p.offset)],
            ]),
            scopes: read,
          });
          const value = (res.partners ?? []).slice(0, p.limit);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (x) =>
                      `- partner ${str(x.id)}: ${str(x.name)} / ${str(x.long_name)} (code ${str(x.code)})`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "No partners.";
          return {
            value: value.map((x) => str(x.id)),
            result: textResult(`${text}${more(value.length, p)}`, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const accountItems = asAgentTool({
    name: "freee_account_items_list",
    label: "freee: list account items",
    description:
      "List the account items (勘定科目) of a configured company: id, name, category. Read-only.",
    parameters: Type.Object({ companyId: companyParam }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "account_items.list",
        async () => {
          // No pagination in the API; the response is read with a byte cap and listed up to 500.
          const res = await runtime.json<{ account_items?: Obj[] }>(
            {
              url: url("/account_items", [["company_id", company(params.companyId)]]),
              scopes: read,
            },
            2 * 1024 * 1024,
          );
          const all = res.account_items ?? [];
          const value = all.slice(0, 500);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map((a) => `- ${str(a.id)}: ${str(a.name)} (${str(a.account_category)})`)
                  .join("\n"),
                { source: "api" },
              )
            : "No account items.";
          const cut =
            all.length > value.length ? `\n(${all.length - value.length} more not listed)` : "";
          return {
            value: value.length,
            result: textResult(`${text}${cut}`, { count: value.length }),
          };
        },
        (count) => ({ count }),
      ),
  });

  const receipts = asAgentTool({
    name: "freee_receipts_list",
    label: "freee: list receipts (metadata)",
    description:
      "List receipt / document (証憑) metadata of a configured company for a date range: id, status, issue date, file type, description. The files themselves are not downloaded. Read-only.",
    parameters: Type.Object({
      companyId: companyParam,
      startDate: Type.String({ description: "YYYY-MM-DD" }),
      endDate: Type.String({ description: "YYYY-MM-DD" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "receipts.list",
        async () => {
          const p = page(params);
          const res = await runtime.json<{ receipts?: Obj[] }>({
            url: url("/receipts", [
              ["company_id", company(params.companyId)],
              ["start_date", dateParam(params.startDate, "startDate", true)],
              ["end_date", dateParam(params.endDate, "endDate", true)],
              ["limit", String(p.limit)],
              ["offset", String(p.offset)],
            ]),
            scopes: read,
          });
          const value = (res.receipts ?? []).slice(0, p.limit);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (r) =>
                      `- receipt ${str(r.id)}: ${str(r.status)} issued ${str(r.issue_date)} type ${str(r.mime_type)} created ${str(r.created_at)} ${str(r.description).slice(0, 200)}`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "No receipts.";
          return {
            value: value.map((r) => str(r.id)),
            result: textResult(`${text}${more(value.length, p)}`, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  return [companies, deals, deal, partners, accountItems, receipts];
}
