// kintone connector configuration: one kintone domain (subdomain + cybozu.com / kintone.com), the
// apps an administrator lists explicitly, and per app the field codes the agent may see (a field
// allow-list; nothing outside it is requested or returned). Read-only unless a write opt-in is set.
//
// Authentication, per kintone domain:
// - `apiToken` (default): one API token per app
//   (https://cybozu.dev/ja/kintone/docs/rest-api/overview/authentication/), sent in
//   `X-Cybozu-API-Token`, always only the token of the app a request is for. Each token carries
//   its own permissions in kintone (view / add / edit records, ...); the connector records logical
//   scopes from the opt-ins so a write tool is refused before any request unless opted in.
// - `oauth`: an OAuth client registered in cybozu.com common settings
//   (https://cybozu.dev/ja/common/docs/oauth-client/add-client/): confidential client, HTTP Basic
//   at the token endpoint, scopes k:app_record:read / k:app_record:write / k:app_settings:read
//   (https://cybozu.dev/ja/common/docs/oauth-client/scope-kintone/). PKCE is sent but kintone does
//   not document it (an unknown parameter is ignored, RFC 6749 section 3.1).
import { intParam, type OAuthClientConfig } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "kintone";

/** Logical scopes recorded at login (from the opt-ins), enforced before every request. */
export const SCOPES = {
  read: "kintone.records.read",
  comment: "kintone.comments.write",
  create: "kintone.records.write",
} as const;

/** Provider scopes in OAuth mode. Comments are covered by the record scopes. */
export const OAUTH_SCOPES = {
  recordRead: "k:app_record:read",
  recordWrite: "k:app_record:write",
  appSettingsRead: "k:app_settings:read",
} as const;

export const CLIENT_SECRET_NAME = "connector.kintone.clientSecret";

/** The scope each tool needs, in the mode the connector runs in. */
export type ToolScopes = { records: string; apps: string; comment: string; create: string };

export const KINTONE_DOMAINS = ["cybozu.com", "kintone.com"] as const;
export type KintoneDomain = (typeof KINTONE_DOMAINS)[number];

/** kintone's documented maximum `limit` for GET records.json is 500; we stay far below. */
export const MAX_RECORDS_PER_CALL = 100;
/** kintone refuses `offset` above 10,000 in a records query. */
export const MAX_OFFSET = 10_000;
/** kintone documents 10,000 API requests per app per day (standard plan). */
export const DEFAULT_DAILY_REQUESTS_PER_APP = 10_000;

// Field codes: kintone allows letters (including Japanese), digits, `_`, and a few symbols; we
// accept a conservative set that can never break out of a query or a URL.
const FIELD_CODE = /^[\p{L}\p{N}_・＿$]{1,128}$/u;
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export type KintoneApp = {
  id: number;
  /** Field codes the agent may read (and write, when a write opt-in is on). */
  fields: string[];
};

export type KintoneSettings = {
  auth: "apiToken" | "oauth";
  clientId?: string;
  redirectPort?: number;
  subdomain?: string;
  domain: KintoneDomain;
  apps: KintoneApp[];
  comment: boolean;
  createRecord: boolean;
  dailyRequestsPerApp: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
  approvalTimeoutMs: number;
  /** Problems found while reading the app list (bad ids, bad field codes). */
  appProblems: string[];
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function isFieldCode(code: unknown): code is string {
  return typeof code === "string" && FIELD_CODE.test(code);
}

export function readSettings(raw: unknown): KintoneSettings {
  const c = rec(raw);
  const write = rec(c.write);
  const problems: string[] = [];
  const apps: KintoneApp[] = [];
  const seen = new Set<number>();
  for (const [i, entry] of (Array.isArray(c.apps) ? c.apps : []).slice(0, 50).entries()) {
    const a = rec(entry);
    const id = Number(a.id);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) {
      problems.push(`apps[${i}].id must be a unique positive app id`);
      continue;
    }
    const fields = (Array.isArray(a.fields) ? a.fields : []).filter(isFieldCode).slice(0, 100);
    if (fields.length === 0) {
      problems.push(`apps[${i}].fields must list at least one valid field code`);
      continue;
    }
    seen.add(id);
    apps.push({ id, fields: [...new Set(fields)] });
  }
  const domain = KINTONE_DOMAINS.includes(c.domain as KintoneDomain)
    ? (c.domain as KintoneDomain)
    : "cybozu.com";
  const sub = typeof c.subdomain === "string" ? c.subdomain.trim().toLowerCase() : "";
  return {
    auth: c.auth === "oauth" ? "oauth" : "apiToken",
    clientId: typeof c.clientId === "string" && c.clientId.trim() ? c.clientId.trim() : undefined,
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    subdomain: sub || undefined,
    domain,
    apps,
    comment: write.comment === true,
    createRecord: write.createRecord === true,
    dailyRequestsPerApp: intParam(c.dailyRequestsPerApp, DEFAULT_DAILY_REQUESTS_PER_APP, 1, 10_000),
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 30, 5, 1440),
    // kintone documents a limit of concurrent requests per domain, not a per-second rate; a
    // low client-side rate keeps one gateway far below it.
    ratePerSecond: intParam(c.ratePerSecond, 5, 1, 10),
    approvalTimeoutMs: intParam(c.approvalTimeoutSeconds, 120, 30, 600) * 1000,
    appProblems: problems,
  };
}

export function configProblems(s: KintoneSettings, clientSecret?: string): string[] {
  const problems: string[] = [];
  if (s.auth === "oauth") {
    if (!s.clientId || !/^[A-Za-z0-9._-]{1,128}$/.test(s.clientId)) {
      problems.push("clientId (the OAuth client id) is not set");
    }
    if (!clientSecret) {
      problems.push(`client secret missing: run kurahi secrets set ${CLIENT_SECRET_NAME}`);
    }
  }
  if (!s.subdomain) {
    problems.push("subdomain is not set");
  } else if (!SUBDOMAIN.test(s.subdomain)) {
    problems.push("subdomain must be the kintone subdomain (letters, digits, hyphens)");
  }
  if (s.apps.length === 0) {
    problems.push("apps must list at least one app with its allowed field codes");
  }
  return [...problems, ...s.appProblems];
}

export function baseUrl(s: KintoneSettings): string {
  return `https://${s.subdomain}.${s.domain}`;
}

export function toolScopes(s: KintoneSettings): ToolScopes {
  return s.auth === "oauth"
    ? {
        records: OAUTH_SCOPES.recordRead,
        apps: OAUTH_SCOPES.appSettingsRead,
        comment: OAUTH_SCOPES.recordWrite,
        create: OAUTH_SCOPES.recordWrite,
      }
    : { records: SCOPES.read, apps: SCOPES.read, comment: SCOPES.comment, create: SCOPES.create };
}

/** OAuth mode: the scopes requested at sign-in (write only with an opt-in). */
export function oauthScopes(s: KintoneSettings): string[] {
  return [
    OAUTH_SCOPES.recordRead,
    OAUTH_SCOPES.appSettingsRead,
    ...(s.comment || s.createRecord ? [OAUTH_SCOPES.recordWrite] : []),
  ];
}

export function buildOAuthClient(
  s: KintoneSettings,
  clientSecret: string | undefined,
): OAuthClientConfig | undefined {
  if (s.auth !== "oauth" || configProblems(s, clientSecret).length > 0) {
    return undefined;
  }
  const base = baseUrl(s);
  return {
    clientId: s.clientId!,
    clientSecret,
    clientAuth: "basic",
    endpoints: { authorizeUrl: `${base}/oauth2/authorization`, tokenUrl: `${base}/oauth2/token` },
    scopes: oauthScopes(s),
  };
}

/** API-token mode: the logical scopes recorded at login. */
export function grantedScopes(s: KintoneSettings): string[] {
  return [
    SCOPES.read,
    ...(s.comment ? [SCOPES.comment] : []),
    ...(s.createRecord ? [SCOPES.create] : []),
  ];
}
