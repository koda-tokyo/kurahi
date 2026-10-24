import type { OAuthEndpoints } from "./oauth.js";
// Business connectors: Microsoft identity platform (v2.0) and Graph endpoints.
//
// Only the global cloud is wired. Tenants are a GUID or a verified domain; `organizations` is
// accepted for multi-tenant apps (the SSO validator then requires an explicit tenant allowlist).
// `common` and `consumers` are refused: Business connectors never sign in personal accounts.
import { ConnectorError } from "./errors.js";

export const MICROSOFT_LOGIN_HOST = "login.microsoftonline.com";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function isValidTenant(tenant: string): boolean {
  return GUID.test(tenant) || DOMAIN.test(tenant) || tenant === "organizations";
}

export function isValidClientId(clientId: string): boolean {
  return GUID.test(clientId);
}

export function microsoftEndpoints(tenant: string): OAuthEndpoints {
  if (!isValidTenant(tenant)) {
    throw new ConnectorError("not_configured", "tenantId must be a tenant GUID or verified domain");
  }
  const base = `https://${MICROSOFT_LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  return {
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    deviceCodeUrl: `${base}/devicecode`,
  };
}

/** Graph URL from a path that must start with `/` (no absolute URLs from callers). */
export function graphUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new ConnectorError("bad_request", "invalid Graph path");
  }
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Graph item ids are opaque; refuse anything that could change the path. */
export function graphId(id: unknown, label = "id"): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9!._=+,:/-]{1,512}$/.test(id) || id.includes("..")) {
    throw new ConnectorError("bad_request", `invalid ${label}`);
  }
  return encodeURIComponent(id);
}

/** OData string literal: single quotes doubled. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type GraphPage<T> = { value?: T[]; "@odata.nextLink"?: string };
