import type { Db2Config, Db2Connection, Db2Service } from "./config.js";
import { basicAuth, DataSourceError, isRecord, readJsonBounded, send } from "./http.js";

// Allowlisted Db2 REST services, called with POST, no driver:
//
//   Db2 for z/OS native REST services (Db2 12 and 13):
//     POST https://<host>:<port>/services/<collection>/<service>[/<version>]   (HTTP Basic)
//     body: the service's input parameters as JSON
//     answer: { "ResultSet Output": [rows], "ResultSet 2 Output": [...], "StatusCode": 200,
//               "StatusDescription": "Execution Successful", <output parameters> }
//   Db2 (LUW) REST server (11.5):
//     POST <url>/v1/auth { dbParms: { dbHost, dbName, dbPort, isSSLConnection, username, password },
//                          expiryTime } -> { token }
//     POST <url>/v1/services/<service>/<version>   header authorization: <token>
//     body { parameters: {...}, sync: true } -> { jobStatus, resultSet: [rows], rowCount }
//
// A service is a package with one static SQL statement; only the administrator decides which
// services are listed, and the tool cannot see their SQL, so the docs ask for read-only services
// only. Parameters are limited to the names the administrator lists and to scalar values.

export type Db2Result = {
  rows: Array<Record<string, unknown>>;
  /** Additional result sets (z/OS "ResultSet <n> Output"), bounded together with rows. */
  extraResultSets: number;
  outputs: Record<string, unknown>;
  truncated: boolean;
  status?: string;
};

type Scalar = string | number | boolean | null;

export function checkParameters(service: Db2Service, raw: unknown): Record<string, Scalar> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new DataSourceError("parameters must be an object", "refused");
  }
  const allowed = new Set(service.parameters);
  const out: Record<string, Scalar> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!allowed.has(name)) {
      throw new DataSourceError(
        `parameter "${name.slice(0, 64)}" is not allowed for ${service.name}` +
          (service.parameters.length
            ? ` (allowed: ${service.parameters.join(", ")})`
            : " (it takes none)"),
        "refused",
      );
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new DataSourceError(
        `parameter "${name}" must be a string, number, boolean or null`,
        "refused",
      );
    }
    if (typeof value === "string" && value.length > 4000) {
      throw new DataSourceError(`parameter "${name}" is longer than 4000 characters`, "refused");
    }
    out[name] = value;
  }
  return out;
}

function boundRows(rows: unknown[], max: number) {
  const kept = rows.slice(0, max).map((r) => (isRecord(r) ? r : { value: r }));
  return { kept, truncated: rows.length > max };
}

export class Db2RestClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly cfg: Db2Config,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {}

  serviceNames(): string[] {
    return this.cfg.services.map((s) => s.name);
  }

  resolve(name: string): { service: Db2Service; connection: Db2Connection } {
    const service = this.cfg.services.find((s) => s.name === name);
    const connection = service && this.cfg.connections.find((c) => c.id === service.connection);
    if (!service || !connection) {
      throw new DataSourceError(
        `unknown Db2 service "${String(name).slice(0, 64)}"; configured: ${this.serviceNames().join(", ") || "(none)"}`,
        "config",
      );
    }
    return { service, connection };
  }

  async call(name: string, rawParams: unknown, maxRows?: number): Promise<Db2Result> {
    const { service, connection } = this.resolve(name);
    const params = checkParameters(service, rawParams);
    const limit = Math.min(maxRows ?? this.cfg.maxRows, this.cfg.maxRows);
    return connection.kind === "zos"
      ? this.callZos(connection, service, params, limit)
      : this.callLuw(connection, service, params, limit);
  }

  private async post(url: string, headers: Record<string, string>, body: unknown) {
    const res = await send(
      this.fetchFn,
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body),
      },
      this.cfg.timeoutMs,
    );
    const json = await readJsonBounded(res, this.cfg.maxBytes);
    return { res, json };
  }

  private async callZos(
    conn: Db2Connection,
    service: Db2Service,
    params: Record<string, Scalar>,
    limit: number,
  ): Promise<Db2Result> {
    const path = [service.collection ?? "", service.service, service.version]
      .filter((p): p is string => Boolean(p))
      .map(encodeURIComponent)
      .join("/");
    const { res, json } = await this.post(
      `${conn.url.replace(/\/+$/, "")}/services/${path}`,
      { Authorization: basicAuth(conn.user, conn.password) },
      params,
    );
    if (res.status === 401 || res.status === 403) {
      throw new DataSourceError(
        `Db2 refused the credentials (HTTP ${res.status})`,
        "auth",
        res.status,
      );
    }
    const body = isRecord(json) ? json : {};
    if (!res.ok) {
      const desc =
        typeof body.StatusDescription === "string" ? body.StatusDescription.slice(0, 300) : "";
      throw new DataSourceError(
        `Db2 answered HTTP ${res.status}${desc ? `: ${desc}` : ""}`,
        "remote",
        res.status,
      );
    }
    let rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    let extra = 0;
    const outputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "ResultSet Output" && Array.isArray(value)) {
        const b = boundRows(value, limit);
        rows = b.kept;
        truncated ||= b.truncated;
      } else if (/^ResultSet \d+ Output$/.test(key) && Array.isArray(value)) {
        extra += 1;
        truncated ||= value.length > 0;
      } else if (key !== "StatusCode" && key !== "StatusDescription") {
        outputs[key] = value;
      }
    }
    return {
      rows,
      extraResultSets: extra,
      outputs,
      truncated,
      ...(typeof body.StatusDescription === "string"
        ? { status: body.StatusDescription.slice(0, 200) }
        : {}),
    };
  }

  private async luwToken(conn: Db2Connection, fresh = false): Promise<string> {
    const cached = this.tokens.get(conn.id);
    if (!fresh && cached && cached.expiresAt > this.now()) {
      return cached.token;
    }
    const db = conn.database;
    if (!db) {
      throw new DataSourceError("the LUW connection has no database settings", "config");
    }
    const { res, json } = await this.post(
      `${conn.url.replace(/\/+$/, "")}/v1/auth`,
      {},
      {
        dbParms: {
          dbHost: db.host,
          dbName: db.name,
          dbPort: db.port,
          isSSLConnection: db.ssl,
          username: conn.user,
          password: conn.password,
        },
        expiryTime: "1h",
      },
    );
    const token = isRecord(json) && typeof json.token === "string" ? json.token : "";
    if (!res.ok || !token) {
      throw new DataSourceError(
        `Db2 REST authentication failed (HTTP ${res.status})`,
        "auth",
        res.status,
      );
    }
    this.tokens.set(conn.id, { token, expiresAt: this.now() + 50 * 60_000 });
    return token;
  }

  private async callLuw(
    conn: Db2Connection,
    service: Db2Service,
    params: Record<string, Scalar>,
    limit: number,
  ): Promise<Db2Result> {
    const url = `${conn.url.replace(/\/+$/, "")}/v1/services/${encodeURIComponent(service.service)}/${encodeURIComponent(service.version ?? "")}`;
    const body = { parameters: params, sync: true };
    let { res, json } = await this.post(url, { authorization: await this.luwToken(conn) }, body);
    if (res.status === 401) {
      ({ res, json } = await this.post(
        url,
        { authorization: await this.luwToken(conn, true) },
        body,
      ));
    }
    if (res.status === 401 || res.status === 403) {
      throw new DataSourceError(`Db2 refused the token (HTTP ${res.status})`, "auth", res.status);
    }
    const rec = isRecord(json) ? json : {};
    if (!res.ok) {
      const msg = typeof rec.message === "string" ? rec.message.slice(0, 300) : "";
      throw new DataSourceError(
        `Db2 answered HTTP ${res.status}${msg ? `: ${msg}` : ""}`,
        "remote",
        res.status,
      );
    }
    const resultSet = Array.isArray(rec.resultSet) ? rec.resultSet : [];
    const b = boundRows(resultSet, limit);
    return {
      rows: b.kept,
      extraResultSets: 0,
      outputs: {},
      truncated: b.truncated,
      ...(typeof rec.jobStatusDescription === "string"
        ? { status: rec.jobStatusDescription.slice(0, 200) }
        : {}),
    };
  }
}
