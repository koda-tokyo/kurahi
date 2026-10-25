// マネーフォワード クラウド請求書 tools (read-only): billings (請求書) list / get, quotes (見積書) list,
// partners (取引先) list. Paging is bounded (per_page at most 100, the API's maximum; page at most
// 50). PDF download URLs are never returned. Customer-typed text (titles, item names, memo,
// partner names) reaches the model only inside the untrusted-content boundary.
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  asAgentTool,
  ConnectorError,
  type ConnectorRuntime,
  intParam,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { INVOICE_API, SCOPES } from "./config.js";

type Obj = Record<string, unknown>;
type Page = { data?: Obj[]; pagination?: { total_count?: number; total_pages?: number } };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PER_PAGE = 100;
export const MAX_PAGE = 50;
const BILLING_RANGE = [
  "billing_date",
  "due_date",
  "sales_date",
  "created_at",
  "updated_at",
] as const;
const QUOTE_RANGE = ["quote_date", "expired_date", "created_at", "updated_at"] as const;

function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v).replace(/[\r\n]+/g, " ")
    : "";
}

function idParam(v: unknown, label: string): string {
  if (typeof v !== "string" || !ID.test(v)) {
    throw new ConnectorError("bad_request", `invalid ${label}`);
  }
  return v;
}

function dateParam(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") {
    return undefined;
  }
  if (typeof v !== "string" || !DATE.test(v)) {
    throw new ConnectorError("bad_request", `${name} must be YYYY-MM-DD`);
  }
  return v;
}

export function createMoneyForwardTools(deps: { runtime: ConnectorRuntime; ctx: ToolContext }) {
  const { runtime, ctx } = deps;
  const read = [SCOPES.invoiceRead];
  const url = (path: string, query: Array<[string, string | undefined]>) => {
    const u = new URL(`${INVOICE_API}${path}`);
    for (const [k, v] of query) {
      if (v !== undefined) {
        u.searchParams.set(k, v);
      }
    }
    return u.toString();
  };
  const paging = (params: Obj) => ({
    page: intParam(params.page, 1, 1, MAX_PAGE),
    perPage: intParam(params.perPage, 20, 1, MAX_PER_PAGE),
  });
  const more = (res: Page, page: number) =>
    (res.pagination?.total_pages ?? 0) > page ? `\n(more pages: next page ${page + 1})` : "";
  const range = (params: Obj, keys: readonly string[]): Array<[string, string | undefined]> => {
    const key = params.rangeKey === undefined ? undefined : str(params.rangeKey);
    if (key !== undefined && !keys.includes(key)) {
      throw new ConnectorError("bad_request", "invalid rangeKey");
    }
    const from = dateParam(params.from, "from");
    const to = dateParam(params.to, "to");
    return key && (from || to)
      ? [
          ["range_key", key],
          ["from", from],
          ["to", to],
        ]
      : [];
  };

  const billingLine = (b: Obj) =>
    `- billing ${str(b.id)}: no. ${str(b.billing_number)} ${str(b.title)} partner ${str(b.partner_id)} ${str(b.partner_name)} billed ${str(b.billing_date)} due ${str(b.due_date)} total ${str(b.total_price)} payment ${str(b.payment_status)} posting ${str(b.posting_status)}`;

  const billings = asAgentTool({
    name: "mf_invoice_billings_list",
    label: "Money Forward: list billings",
    description:
      "List billings (請求書) in マネーフォワード クラウド請求書, optionally for a partner and a date range (rangeKey billing_date, due_date, sales_date, created_at or updated_at, with from/to as YYYY-MM-DD). At most 100 per page. Read-only.",
    parameters: Type.Object({
      partnerId: Type.Optional(Type.String()),
      rangeKey: Type.Optional(stringEnum(BILLING_RANGE)),
      from: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
      perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "billings.list",
        async () => {
          const p = paging(params);
          const res = await runtime.json<Page>({
            url: url("/billings", [
              ["page", String(p.page)],
              ["per_page", String(p.perPage)],
              [
                "partner_id",
                params.partnerId === undefined
                  ? undefined
                  : idParam(params.partnerId, "partner id"),
              ],
              ...range(params, BILLING_RANGE),
            ]),
            scopes: read,
          });
          const value = (res.data ?? []).slice(0, p.perPage);
          const text = value.length
            ? wrapUntrusted(value.map(billingLine).join("\n"), { source: "api" })
            : "No billings.";
          return {
            value: value.map((b) => str(b.id)),
            result: textResult(`${text}${more(res, p.page)}`, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const billing = asAgentTool({
    name: "mf_invoice_billing_get",
    label: "Money Forward: get billing",
    description:
      "Get one billing (請求書) with its items (name, quantity, unit price, price). Read-only.",
    parameters: Type.Object({ id: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "billings.get",
        async () => {
          const id = idParam(params.id, "billing id");
          const b = await runtime.json<Obj>({ url: url(`/billings/${id}`, []), scopes: read });
          const items = Array.isArray(b.items) ? (b.items as Obj[]) : [];
          const text = [
            billingLine(b),
            ...items
              .slice(0, 100)
              .map(
                (it) =>
                  `  item: ${str(it.name)} qty ${str(it.quantity)} ${str(it.unit)} unit price ${str(it.price)} ${str(it.detail).slice(0, 200)}`,
              ),
            ...(typeof b.memo === "string" && b.memo
              ? [`  memo: ${str(b.memo).slice(0, 500)}`]
              : []),
          ].join("\n");
          return { value: id, result: textResult(wrapUntrusted(text, { source: "api" })) };
        },
        (id) => ({ ids: [id], count: 1 }),
      ),
  });

  const quotes = asAgentTool({
    name: "mf_invoice_quotes_list",
    label: "Money Forward: list quotes",
    description:
      "List quotes (見積書), optionally for a date range (rangeKey quote_date, expired_date, created_at or updated_at). At most 100 per page. Read-only.",
    parameters: Type.Object({
      rangeKey: Type.Optional(stringEnum(QUOTE_RANGE)),
      from: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
      perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "quotes.list",
        async () => {
          const p = paging(params);
          const res = await runtime.json<Page>({
            url: url("/quotes", [
              ["page", String(p.page)],
              ["per_page", String(p.perPage)],
              ...range(params, QUOTE_RANGE),
            ]),
            scopes: read,
          });
          const value = (res.data ?? []).slice(0, p.perPage);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (q) =>
                      `- quote ${str(q.id)}: no. ${str(q.quote_number)} ${str(q.title)} partner ${str(q.partner_id)} dated ${str(q.quote_date)} expires ${str(q.expired_date)} total ${str(q.total_price)}`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "No quotes.";
          return {
            value: value.map((q) => str(q.id)),
            result: textResult(`${text}${more(res, p.page)}`, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const partners = asAgentTool({
    name: "mf_invoice_partners_list",
    label: "Money Forward: list partners",
    description:
      "List partners (取引先) of クラウド請求書, optionally filtered by name or code: id, code, name. Addresses and contacts are not read. Read-only.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      code: Type.Optional(Type.String()),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
      perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "partners.list",
        async () => {
          const p = paging(params);
          const res = await runtime.json<Page>({
            url: url("/partners", [
              ["page", String(p.page)],
              ["per_page", String(p.perPage)],
              ["name", strParam(params.name, "name", { max: 100 })],
              ["code", strParam(params.code, "code", { max: 100 })],
            ]),
            scopes: read,
          });
          const value = (res.data ?? []).slice(0, p.perPage);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map((x) => `- partner ${str(x.id)}: ${str(x.name)} (code ${str(x.code)})`)
                  .join("\n"),
                { source: "api" },
              )
            : "No partners.";
          return {
            value: value.map((x) => str(x.id)),
            result: textResult(`${text}${more(res, p.page)}`, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  return [billings, billing, quotes, partners];
}
