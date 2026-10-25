// マネーフォワード クラウド connector configuration. This release covers マネーフォワード クラウド請求書
// (invoicing) API v3, read-only, with the customer's own app on the Money Forward Cloud developer
// portal (OAuth 2.0 authorization code). Other products are documented in
// docs/connectors/money-forward.md (what has a public API and what this connector does not cover).
//
// Facts used here (read 2026-10-25):
//   developer portal, product list          https://developers.biz.moneyforward.com/
//   OAuth endpoints, token lifetimes          https://developers.biz.moneyforward.com/docs/common/oauth/overview
//   client auth CLIENT_SECRET_BASIC or _POST  https://developers.biz.moneyforward.com/docs/api/auth/create-token
//   revocation                                https://developers.biz.moneyforward.com/docs/api/auth/revoke-token
//   scopes mfc/invoice/data.read|write        https://biz.moneyforward.com/support/invoice/guide/api-guide/a03.html
//   請求書 API v3 paths, parameters, shapes    https://invoice.moneyforward.com/docs/api/v3/reference/iv_web_api.yaml
// Not documented (implemented conservatively): PKCE (sent; ignored per RFC 6749 section 3.1 if
// unsupported) and the exact revocation parameter names (`token` plus client credentials, RFC 7009).
import { intParam, type OAuthClientConfig } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "money-forward";
export const CLIENT_SECRET_NAME = "connector.money-forward.clientSecret";

export const INVOICE_API = "https://invoice.moneyforward.com/api/v3";

export const MF_ENDPOINTS = {
  authorizeUrl: "https://api.biz.moneyforward.com/authorize",
  tokenUrl: "https://api.biz.moneyforward.com/token",
  revokeUrl: "https://api.biz.moneyforward.com/revoke",
};

/** Read scope only: the write scope (mfc/invoice/data.write) is never requested. */
export const SCOPES = { invoiceRead: "mfc/invoice/data.read" } as const;

export type MoneyForwardSettings = {
  clientId?: string;
  clientAuth: "basic" | "post";
  redirectPort?: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): MoneyForwardSettings {
  const c = rec(raw);
  return {
    clientId: typeof c.clientId === "string" && c.clientId.trim() ? c.clientId.trim() : undefined,
    clientAuth: c.clientAuth === "post" ? "post" : "basic",
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 60, 5, 1440),
    ratePerSecond: intParam(c.ratePerSecond, 3, 1, 10),
  };
}

export function configProblems(
  s: MoneyForwardSettings,
  clientSecret: string | undefined,
): string[] {
  const problems: string[] = [];
  if (!s.clientId) {
    problems.push("clientId is not set");
  } else if (!/^[A-Za-z0-9._-]{4,128}$/.test(s.clientId)) {
    problems.push("clientId must be the app's Client ID");
  }
  if (!clientSecret) {
    problems.push(`client secret missing: run kurahi secrets set ${CLIENT_SECRET_NAME}`);
  }
  if (s.redirectPort === undefined) {
    problems.push("redirectPort must be set (it must match the app's registered redirect URI)");
  }
  return problems;
}

export function buildClient(
  s: MoneyForwardSettings,
  clientSecret: string | undefined,
): OAuthClientConfig | undefined {
  if (configProblems(s, clientSecret).length > 0) {
    return undefined;
  }
  return {
    clientId: s.clientId!,
    clientSecret,
    clientAuth: s.clientAuth,
    endpoints: MF_ENDPOINTS,
    scopes: [SCOPES.invoiceRead],
    revokeWithClient: true,
  };
}
