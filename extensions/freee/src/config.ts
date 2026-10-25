// freee 会計 connector configuration: the customer's own freee app (OAuth 2.0 authorization code,
// confidential client), the company ids the agent may read, and read-only tools. There is no write
// tool: freee's POST /deals has no draft state (a created deal always books), see below.
//
// Facts used here (read 2026-10-25):
//   authorize / token endpoints, client_secret in the token request
//     https://developer.freee.co.jp/startguide/getting-access-token
//   revoke endpoint (param `token`)
//     https://developer.freee.co.jp/reference/%e8%aa%8d%e5%8f%af%e3%82%b3%e3%83%bc%e3%83%89
//   token lifetimes (access 6 h; refresh 90 days, single use)
//     https://developer.freee.co.jp/reference/faq/token_lifetime
//   accounting API paths, parameters and limits (OpenAPI schema)
//     https://raw.githubusercontent.com/freee/freee-api-schema/master/v2020_06_15/open-api-3/api-schema.json
// Not documented by freee (implemented conservatively, see docs/connectors/freee.md): PKCE
// (sent; an unknown parameter is ignored per RFC 6749 section 3.1), and whether a loopback
// `http://localhost` callback URL is accepted.
import { intParam, type OAuthClientConfig } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "freee";
export const CLIENT_SECRET_NAME = "connector.freee.clientSecret";

export const FREEE_API = "https://api.freee.co.jp/api/1";

export const FREEE_ENDPOINTS = {
  authorizeUrl: "https://accounts.secure.freee.co.jp/public_api/authorize",
  tokenUrl: "https://accounts.secure.freee.co.jp/public_api/token",
  revokeUrl: "https://accounts.secure.freee.co.jp/public_api/revoke",
};

/**
 * freee takes no scope parameter: permissions are chosen on the app and confirmed at consent; the
 * token response reports them as `read` / `write`. Every tool needs `read`.
 */
export const SCOPES = { read: "read" } as const;

export type FreeeSettings = {
  clientId?: string;
  /** Company ids the agent may read; requests for any other company are refused. */
  companyIds: number[];
  redirectPort?: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): FreeeSettings {
  const c = rec(raw);
  const ids = (Array.isArray(c.companyIds) ? c.companyIds : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 20);
  return {
    clientId: typeof c.clientId === "string" && c.clientId.trim() ? c.clientId.trim() : undefined,
    companyIds: [...new Set(ids)],
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 60, 5, 1440),
    // freee counts calls per company per day (3,000 to 10,000 by plan) and answers 403 to bursts.
    ratePerSecond: intParam(c.ratePerSecond, 3, 1, 10),
  };
}

export function configProblems(s: FreeeSettings, clientSecret: string | undefined): string[] {
  const problems: string[] = [];
  if (!s.clientId) {
    problems.push("clientId is not set");
  } else if (!/^[A-Za-z0-9_-]{8,128}$/.test(s.clientId)) {
    problems.push("clientId must be the freee app's Client ID");
  }
  if (!clientSecret) {
    problems.push(`client secret missing: run kurahi secrets set ${CLIENT_SECRET_NAME}`);
  }
  if (s.companyIds.length === 0) {
    problems.push("companyIds must list at least one freee company id");
  }
  if (s.redirectPort === undefined) {
    problems.push("redirectPort must be set (it must match the app's registered callback URL)");
  }
  return problems;
}

export function buildClient(
  s: FreeeSettings,
  clientSecret: string | undefined,
): OAuthClientConfig | undefined {
  if (configProblems(s, clientSecret).length > 0) {
    return undefined;
  }
  return {
    clientId: s.clientId!,
    clientSecret,
    endpoints: FREEE_ENDPOINTS,
    scopes: [],
    revokeWithClient: true,
  };
}
