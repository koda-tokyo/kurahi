import type { WatsonxDataConfig } from "./config.js";
import { basicAuth, DataSourceError, isRecord, readJsonBounded, send } from "./http.js";
import { assertReadOnlySql, SqlRefused } from "./sql-guard.js";

// Read-only queries against a watsonx.data Presto or Trino engine over the engines' HTTP client
// protocol (no driver):
//   POST <url>/v1/statement   body: the SQL text
//        X-Presto-User / X-Presto-Catalog / X-Presto-Schema / X-Presto-Source (or X-Trino-*)
//   GET  <nextUri> ... until the answer has no nextUri; rows arrive in `data`, columns in
//        `columns`, failures in `error`.
//   DELETE <nextUri> cancels the query (row or byte limit reached, or timeout).
// Every nextUri must stay on the configured origin, so credentials are never sent elsewhere.

export type QueryResult = {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  truncated: boolean;
  queryId?: string;
  bytes: number;
};

const QUERY_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function prestoHeaders(cfg: WatsonxDataConfig, catalog: string, schema: string) {
  const p = cfg.dialect === "trino" ? "X-Trino" : "X-Presto";
  return {
    [`${p}-User`]: cfg.user,
    [`${p}-Catalog`]: catalog,
    [`${p}-Schema`]: schema,
    [`${p}-Source`]: "kurahi",
    Authorization:
      cfg.auth === "bearer" ? `Bearer ${cfg.password}` : basicAuth(cfg.user, cfg.password),
    Accept: "application/json",
  };
}

export async function runReadOnlyQuery(
  cfg: WatsonxDataConfig,
  params: { sql: string; catalog?: string; schema?: string; maxRows?: number },
  fetchFn: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): Promise<QueryResult> {
  const catalog = (params.catalog ?? cfg.catalogs[0].name).toLowerCase();
  const entry = cfg.catalogs.find((c) => c.name.toLowerCase() === catalog);
  if (!entry) {
    throw new DataSourceError(`catalog "${catalog}" is not allowed`, "refused");
  }
  const schema = (params.schema ?? entry.schemas[0]).toLowerCase();
  if (!entry.schemas.some((s) => s.toLowerCase() === schema)) {
    throw new DataSourceError(`schema "${schema}" is not allowed in "${catalog}"`, "refused");
  }
  let sql: string;
  try {
    sql = assertReadOnlySql(params.sql, cfg.catalogs, { catalog, schema });
  } catch (err) {
    throw new DataSourceError(err instanceof SqlRefused ? err.message : "query refused", "refused");
  }
  const maxRows = Math.min(params.maxRows ?? cfg.maxRows, cfg.maxRows);
  const origin = new URL(cfg.url).origin;
  const headers = prestoHeaders(cfg, catalog, schema);
  const deadline = now() + cfg.timeoutMs;
  const remaining = () => Math.max(1000, deadline - now());

  const sameOrigin = (uri: unknown): string => {
    if (typeof uri !== "string") {
      throw new DataSourceError("the engine returned an invalid nextUri", "protocol");
    }
    const u = new URL(uri, cfg.url);
    if (u.origin !== origin) {
      throw new DataSourceError("the engine pointed to another host; stopped", "protocol");
    }
    return u.toString();
  };
  const cancel = async (uri: string | undefined) => {
    if (uri) {
      await send(fetchFn, uri, { method: "DELETE", headers }, 5000).catch(() => undefined);
    }
  };

  let res = await send(
    fetchFn,
    `${cfg.url.replace(/\/+$/, "")}/v1/statement`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      body: sql,
    },
    remaining(),
  );
  const columns: QueryResult["columns"] = [];
  const rows: unknown[][] = [];
  let bytes = 0;
  let queryId: string | undefined;
  for (;;) {
    if (res.status === 401 || res.status === 403) {
      throw new DataSourceError(
        `the engine refused the credentials (HTTP ${res.status})`,
        "auth",
        res.status,
      );
    }
    if (res.status === 503 || res.status === 429) {
      throw new DataSourceError(`the engine is busy (HTTP ${res.status})`, "remote", res.status);
    }
    if (!res.ok) {
      throw new DataSourceError(`the engine answered HTTP ${res.status}`, "remote", res.status);
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    const body = await readJsonBounded(res, cfg.maxBytes - bytes + 65_536);
    bytes += Number.isFinite(length) && length > 0 ? length : JSON.stringify(body ?? null).length;
    if (!isRecord(body)) {
      throw new DataSourceError("the engine returned an unexpected answer", "protocol");
    }
    if (typeof body.id === "string" && QUERY_ID.test(body.id)) {
      queryId = body.id;
    }
    if (isRecord(body.error)) {
      const name = typeof body.error.errorName === "string" ? body.error.errorName : "QUERY_FAILED";
      const message =
        typeof body.error.message === "string" ? body.error.message.slice(0, 500) : "";
      throw new DataSourceError(`${name}: ${message}`, "remote");
    }
    if (Array.isArray(body.columns) && columns.length === 0) {
      for (const c of body.columns) {
        if (isRecord(c)) {
          columns.push({
            name: typeof c.name === "string" ? c.name : "",
            type: typeof c.type === "string" ? c.type : "",
          });
        }
      }
    }
    const next =
      body.nextUri === undefined || body.nextUri === null ? undefined : sameOrigin(body.nextUri);
    let dropped = false;
    if (Array.isArray(body.data)) {
      for (const row of body.data) {
        if (rows.length >= maxRows) {
          dropped = true;
          break;
        }
        rows.push(Array.isArray(row) ? row : [row]);
      }
    }
    if (rows.length >= maxRows || bytes >= cfg.maxBytes) {
      await cancel(next);
      return { columns, rows, truncated: dropped || next !== undefined, queryId, bytes };
    }
    if (!next) {
      return { columns, rows, truncated: false, queryId, bytes };
    }
    if (now() >= deadline) {
      await cancel(next);
      throw new DataSourceError(`the query did not finish within ${cfg.timeoutMs} ms`, "limit");
    }
    res = await send(fetchFn, next, { method: "GET", headers }, remaining());
  }
}
