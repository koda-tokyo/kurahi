// kintone tools: configured apps, bounded record queries and one record (read), and two opt-in
// writes that always ask a person first: add a record comment, create a record. Only the field
// codes on the app's allow-list are requested (`fields[]`) and returned; record text reaches the
// model only inside the untrusted-content boundary.
//
// REST API references (cybozu.dev, verified 2026-10-25 unless noted in docs/connectors/kintone.md):
//   GET  /k/v1/records.json        https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/
//   GET  /k/v1/record.json         https://cybozu.dev/ja/kintone/docs/rest-api/records/get-record/
//   GET  /k/v1/app.json            https://cybozu.dev/ja/kintone/docs/rest-api/apps/get-app/
//   POST /k/v1/record/comment.json https://cybozu.dev/ja/kintone/docs/rest-api/records/add-comment/
//   POST /k/v1/record.json         https://cybozu.dev/ja/kintone/docs/rest-api/records/add-record/
//   Query syntax                   https://cybozu.dev/ja/kintone/docs/overview/query/
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  type ApprovalAsk,
  asAgentTool,
  assertScopes,
  clip,
  ConnectorError,
  type ConnectorRuntime,
  intParam,
  requireWriteApproval,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import {
  baseUrl,
  isFieldCode,
  type KintoneApp,
  type KintoneSettings,
  MAX_OFFSET,
  MAX_RECORDS_PER_CALL,
  toolScopes,
} from "./config.js";

export type KintoneField = { type?: string; value?: unknown };
export type KintoneRecord = Record<string, KintoneField>;

const OPS = ["=", "!=", ">", "<", ">=", "<=", "like", "not like"] as const;
type Op = (typeof OPS)[number];
const RECORD_ID = /^[1-9][0-9]{0,18}$/;
/** System fields always allowed: the record number and revision (no content). */
const SYSTEM_FIELDS = ["$id", "$revision"];

/** kintone string literal: double quotes, with `\` and `"` escaped by a backslash. */
export function queryString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type Filter = { field: string; op: Op; value: string };

/**
 * Build a records query from structured filters on allow-listed fields only, so the agent cannot
 * filter (and so infer values) on a field it may not read. Always ends with limit and offset.
 */
export function buildQuery(
  app: KintoneApp,
  filters: Filter[],
  order: { field: string; desc: boolean } | undefined,
  limit: number,
  offset: number,
): string {
  const allowed = new Set([...app.fields, ...SYSTEM_FIELDS]);
  const parts: string[] = [];
  for (const f of filters) {
    if (!allowed.has(f.field)) {
      throw new ConnectorError(
        "bad_request",
        "filter field not allowed",
        undefined,
        "filters may only use the app's allowed field codes",
      );
    }
    if (!OPS.includes(f.op)) {
      throw new ConnectorError("bad_request", "invalid operator");
    }
    parts.push(`${f.field} ${f.op} ${queryString(f.value)}`);
  }
  let q = parts.join(" and ");
  if (order) {
    if (!allowed.has(order.field)) {
      throw new ConnectorError("bad_request", "order field not allowed");
    }
    q += `${q ? " " : ""}order by ${order.field} ${order.desc ? "desc" : "asc"}`;
  }
  return `${q}${q ? " " : ""}limit ${limit} offset ${offset}`;
}

/** Field value as short text; files and tables are counted, never expanded. */
export function fieldText(f: KintoneField | undefined): string {
  const v = f?.value;
  if (v === null || v === undefined) {
    return "";
  }
  if (f?.type === "FILE") {
    return `[${Array.isArray(v) ? v.length : 0} file(s)]`;
  }
  if (f?.type === "SUBTABLE") {
    return `[table: ${Array.isArray(v) ? v.length : 0} row(s)]`;
  }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  const name = (x: unknown) =>
    x && typeof x === "object" && "name" in x
      ? String((x as { name: unknown }).name)
      : typeof x === "string"
        ? x
        : "";
  if (Array.isArray(v)) {
    return v.map(name).filter(Boolean).join(", ");
  }
  return name(v);
}

/** Only allow-listed (and system) fields of a record, whatever the service returned. */
export function projectRecord(app: KintoneApp, record: KintoneRecord): KintoneRecord {
  const out: KintoneRecord = {};
  for (const code of [...SYSTEM_FIELDS, ...app.fields]) {
    if (record[code]) {
      out[code] = record[code];
    }
  }
  return out;
}

function formatRecord(app: KintoneApp, r: KintoneRecord): string {
  const lines = [`record: ${fieldText(r.$id)} (revision ${fieldText(r.$revision)})`];
  for (const code of app.fields) {
    if (r[code]) {
      lines.push(`  ${code}: ${clip(fieldText(r[code]).replace(/[\r\n]+/g, " "), 500)}`);
    }
  }
  return lines.join("\n");
}

export type KintoneToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  ask: ApprovalAsk;
  settings: KintoneSettings;
  /** Per-app daily request budget (kintone's documented per-app daily limit). */
  budget: DailyBudget;
};

/** Requests per app per day, counted in this process (resets on restart; see the docs). */
export class DailyBudget {
  private day = "";
  private counts = new Map<number, number>();
  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(appId: number): void {
    // kintone counts per day in the domain's time zone; JST is used for the Japanese cloud.
    const day = new Date(this.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
    }
    const n = this.counts.get(appId) ?? 0;
    if (n >= this.max) {
      throw new ConnectorError(
        "rate_limited",
        "daily request budget used",
        undefined,
        "the app's daily kintone request budget is used up; try again tomorrow",
      );
    }
    this.counts.set(appId, n + 1);
  }
}

function appParam(settings: KintoneSettings, v: unknown): KintoneApp {
  const id = Number(v);
  const app = settings.apps.find((a) => a.id === id);
  if (!app) {
    throw new ConnectorError(
      "forbidden",
      "app not configured",
      undefined,
      "this app is not in the connector's configured app list",
    );
  }
  return app;
}

function recordIdParam(v: unknown): string {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!RECORD_ID.test(s)) {
    throw new ConnectorError("bad_request", "invalid record id");
  }
  return s;
}

function filtersParam(v: unknown): Filter[] {
  if (v === undefined || v === null) {
    return [];
  }
  if (!Array.isArray(v) || v.length > 10) {
    throw new ConnectorError("bad_request", "filters: at most 10");
  }
  return v.map((raw) => {
    const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const op = (typeof f.op === "string" ? f.op : "=") as Op;
    if (!isFieldCode(f.field) && !SYSTEM_FIELDS.includes(String(f.field))) {
      throw new ConnectorError("bad_request", "invalid filter field");
    }
    if (!OPS.includes(op)) {
      throw new ConnectorError("bad_request", "invalid operator");
    }
    const value =
      typeof f.value === "number"
        ? String(f.value)
        : (strParam(f.value, "value", { max: 200 }) ?? "");
    return { field: String(f.field), op, value };
  });
}

export function createKintoneTools(deps: KintoneToolDeps) {
  const { runtime, ctx, settings } = deps;
  const base = baseUrl(settings);
  const api = (path: string, query: Array<[string, string]> = []) => {
    const url = new URL(`${base}/k/v1${path}`);
    for (const [k, v] of query) {
      url.searchParams.append(k, v);
    }
    return url.toString();
  };
  const scopes = toolScopes(settings);
  const read = [scopes.records];

  const appsList = asAgentTool({
    name: "kintone_apps_list",
    label: "kintone: list apps",
    description:
      "List the kintone apps this connector may read (app id, name, the field codes it may see). Read-only.",
    parameters: Type.Object({}),
    execute: () =>
      runConnectorTool(
        runtime,
        ctx,
        "apps.list",
        async () => {
          const rows: string[] = [];
          for (const app of settings.apps) {
            deps.budget.take(app.id);
            // GET app.json works with the app's own API token (view permission).
            const info = await runtime.json<{ appId?: string; name?: string }>(
              {
                url: api("/app.json", [["id", String(app.id)]]),
                scopes: [scopes.apps],
                credentialKey: String(app.id),
              },
              64 * 1024,
            );
            rows.push(
              `app ${app.id}: ${(info.name ?? "").replace(/[\r\n]+/g, " ")}\n  fields: ${app.fields.join(", ")}`,
            );
          }
          const text = rows.length
            ? wrapUntrusted(rows.join("\n"), { source: "api" })
            : "No apps configured.";
          return { value: settings.apps.map((a) => String(a.id)), result: textResult(text) };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const query = asAgentTool({
    name: "kintone_records_query",
    label: "kintone: query records",
    description:
      'Query records of one configured app. Filters and ordering may use only the app\'s allowed field codes (see kintone_apps_list); returns at most 100 records with the allowed fields only. Example filters: [{"field":"ステータス","op":"=","value":"未対応"}]. Read-only.',
    parameters: Type.Object({
      app: Type.Integer({ minimum: 1 }),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Optional(stringEnum(OPS)),
            value: Type.String({ maxLength: 200 }),
          }),
          { maxItems: 10 },
        ),
      ),
      orderBy: Type.Optional(Type.String()),
      desc: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RECORDS_PER_CALL })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "records.query",
        async () => {
          const app = appParam(settings, params.app);
          const limit = intParam(params.limit, 20, 1, MAX_RECORDS_PER_CALL);
          const offset = intParam(params.offset, 0, 0, MAX_OFFSET);
          if (offset + limit > MAX_OFFSET + MAX_RECORDS_PER_CALL) {
            throw new ConnectorError("bad_request", "offset too large");
          }
          const orderBy = strParam(params.orderBy, "orderBy", { max: 128 });
          const q = buildQuery(
            app,
            filtersParam(params.filters),
            orderBy ? { field: orderBy, desc: params.desc === true } : undefined,
            limit,
            offset,
          );
          const fields = [...SYSTEM_FIELDS, ...app.fields].map(
            (f, i) => [`fields[${i}]`, f] as [string, string],
          );
          deps.budget.take(app.id);
          const page = await runtime.json<{ records?: KintoneRecord[] }>({
            url: api("/records.json", [["app", String(app.id)], ["query", q], ...fields]),
            scopes: read,
            credentialKey: String(app.id),
          });
          const records = (page.records ?? []).slice(0, limit).map((r) => projectRecord(app, r));
          const text = records.length
            ? wrapUntrusted(records.map((r) => formatRecord(app, r)).join("\n"), {
                source: "api",
              })
            : "No records.";
          const more =
            records.length === limit ? `\n(more may exist: offset ${offset + limit})` : "";
          return {
            value: records.map((r) => fieldText(r.$id)),
            result: textResult(`${text}${more}`, { count: records.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const get = asAgentTool({
    name: "kintone_record_get",
    label: "kintone: get record",
    description:
      "Get one record of a configured app by record id, with the allowed fields only. Read-only.",
    parameters: Type.Object({ app: Type.Integer({ minimum: 1 }), id: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "records.get",
        async () => {
          const app = appParam(settings, params.app);
          const id = recordIdParam(params.id);
          deps.budget.take(app.id);
          const res = await runtime.json<{ record?: KintoneRecord }>({
            url: api("/record.json", [
              ["app", String(app.id)],
              ["id", id],
            ]),
            scopes: read,
            credentialKey: String(app.id),
          });
          const r = projectRecord(app, res.record ?? {});
          return {
            value: id,
            result: textResult(wrapUntrusted(formatRecord(app, r), { source: "api" })),
          };
        },
        (id) => ({ ids: [id], count: 1 }),
      ),
  });

  const tools = [appsList, query, get];

  if (settings.comment) {
    tools.push(
      asAgentTool({
        name: "kintone_record_comment_add",
        label: "kintone: add record comment",
        description:
          "Add a plain-text comment to one record of a configured app. A person must approve every comment before it is posted.",
        parameters: Type.Object({
          app: Type.Integer({ minimum: 1 }),
          id: Type.String(),
          text: Type.String({ maxLength: 2000 }),
        }),
        execute: (_id, params) =>
          runConnectorTool(
            runtime,
            ctx,
            "comments.add",
            async () => {
              const app = appParam(settings, params.app);
              const record = recordIdParam(params.id);
              const text = strParam(params.text, "text", { required: true, max: 2000 })!;
              // Refused before asking anyone when the grant cannot do it anyway.
              assertScopes(runtime.grantedScopes() ?? [], [scopes.comment]);
              await requireWriteApproval(
                {
                  connectorId: runtime.id,
                  tool: "kintone_record_comment_add",
                  agentId: ctx.agentId ?? "main",
                  sessionKey: ctx.sessionKey,
                  preview: { app: app.id, record, chars: text.length, text: text.slice(0, 500) },
                  timeoutMs: settings.approvalTimeoutMs,
                },
                deps.ask,
              );
              deps.budget.take(app.id);
              const res = await runtime.json<{ id?: string }>({
                url: api("/record/comment.json"),
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ app: app.id, record: Number(record), comment: { text } }),
                scopes: [scopes.comment],
                credentialKey: String(app.id),
              });
              return {
                value: [record, String(res.id ?? "")].filter(Boolean),
                result: textResult(`Comment ${res.id ?? ""} added to record ${record}.`),
              };
            },
            (ids) => ({ ids, count: 1 }),
          ),
      }),
    );
  }

  if (settings.createRecord) {
    tools.push(
      asAgentTool({
        name: "kintone_record_create",
        label: "kintone: create record",
        description:
          'Create one record in a configured app. Only the app\'s allowed field codes may be set, as text values (e.g. {"顧客名":"株式会社サンプル"}). A person must approve every record before it is created.',
        parameters: Type.Object({
          app: Type.Integer({ minimum: 1 }),
          values: Type.Record(Type.String(), Type.String({ maxLength: 5000 })),
        }),
        execute: (_id, params) =>
          runConnectorTool(
            runtime,
            ctx,
            "records.create",
            async () => {
              const app = appParam(settings, params.app);
              const raw =
                params.values && typeof params.values === "object"
                  ? (params.values as Record<string, unknown>)
                  : {};
              const entries = Object.entries(raw);
              if (entries.length === 0 || entries.length > app.fields.length) {
                throw new ConnectorError("bad_request", "values must set allowed fields");
              }
              const record: Record<string, { value: string }> = {};
              for (const [code, value] of entries) {
                if (!app.fields.includes(code)) {
                  throw new ConnectorError(
                    "bad_request",
                    "field not allowed",
                    undefined,
                    "only the app's allowed field codes may be set",
                  );
                }
                record[code] = { value: typeof value === "string" ? value.slice(0, 5000) : "" };
              }
              assertScopes(runtime.grantedScopes() ?? [], [scopes.create]);
              await requireWriteApproval(
                {
                  connectorId: runtime.id,
                  tool: "kintone_record_create",
                  agentId: ctx.agentId ?? "main",
                  sessionKey: ctx.sessionKey,
                  preview: {
                    app: app.id,
                    values: Object.fromEntries(
                      Object.entries(record).map(([k, v]) => [k, v.value.slice(0, 200)]),
                    ),
                  },
                  timeoutMs: settings.approvalTimeoutMs,
                },
                deps.ask,
              );
              deps.budget.take(app.id);
              const res = await runtime.json<{ id?: string; revision?: string }>({
                url: api("/record.json"),
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ app: app.id, record }),
                scopes: [scopes.create],
                credentialKey: String(app.id),
              });
              const id = String(res.id ?? "");
              return {
                value: id,
                result: textResult(`Record ${id} created in app ${app.id}.`, { id }),
              };
            },
            (id) => ({ ids: id ? [id] : [], count: 1 }),
          ),
      }),
    );
  }
  return tools;
}
