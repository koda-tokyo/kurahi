// Box connector configuration: the customer's own Box Platform app (Custom App, "User
// Authentication (OAuth 2.0)"), signed in by one Box user. Read-only by default (root_readonly);
// uploading Project files to ONE configured folder is a separate opt-in (root_readwrite, Box's only
// write scope for content) and every upload waits for a person's approval.
//
// Facts used here (Box Developer docs, read 2026-10-25):
//   authorize / token endpoints, client secret, error shape
//     https://developer.box.com/guides/authentication/oauth2/without-sdk/
//     https://developer.box.com/reference/post-oauth2-token/
//   revoke (client_id, client_secret, token)  https://developer.box.com/reference/post-oauth2-revoke/
//   token lifetimes (access 60 min; refresh 60 days, single use)
//     https://developer.box.com/guides/authentication/tokens/
//     https://developer.box.com/guides/authentication/tokens/refresh/
//   redirect URI: http allowed for localhost / loopback, any port
//     https://developer.box.com/guides/authentication/oauth2/oauth2-setup
//   scopes                 https://developer.box.com/guides/api-calls/permissions-and-errors/scopes/
//   rate limits (1,000/min per user; search 6/s and 60/min; uploads 240/min)
//     https://developer.box.com/guides/api-calls/permissions-and-errors/rate-limits/
// Not documented (implemented conservatively): PKCE (sent; ignored per RFC 6749 section 3.1 if
// unsupported).
import { intParam, type OAuthClientConfig } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "box";
export const CLIENT_SECRET_NAME = "connector.box.clientSecret";

export const BOX_API = "https://api.box.com/2.0";
export const BOX_UPLOAD = "https://upload.box.com/api/2.0/files/content";

export const BOX_ENDPOINTS = {
  authorizeUrl: "https://account.box.com/api/oauth2/authorize",
  tokenUrl: "https://api.box.com/oauth2/token",
  revokeUrl: "https://api.box.com/oauth2/revoke",
};

export const SCOPES = { read: "root_readonly", write: "root_readwrite" } as const;

const FOLDER_ID = /^[0-9]{1,20}$/;

export function isBoxId(v: unknown): v is string {
  return typeof v === "string" && FOLDER_ID.test(v);
}

export type BoxSettings = {
  clientId?: string;
  /** Searches are limited to these folders (and below) when set. */
  searchFolderIds: string[];
  /** The one folder uploads go to (`write.upload`). */
  uploadFolderId?: string;
  upload: boolean;
  redirectPort?: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
  approvalTimeoutMs: number;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): BoxSettings {
  const c = rec(raw);
  const write = rec(c.write);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    clientId: str(c.clientId),
    searchFolderIds: [
      ...new Set((Array.isArray(c.searchFolderIds) ? c.searchFolderIds : []).filter(isBoxId)),
    ].slice(0, 20),
    uploadFolderId: str(write.uploadFolderId),
    upload: write.upload === true,
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 30, 5, 1440),
    ratePerSecond: intParam(c.ratePerSecond, 4, 1, 10),
    approvalTimeoutMs: intParam(c.approvalTimeoutSeconds, 120, 30, 600) * 1000,
  };
}

export function configProblems(s: BoxSettings, clientSecret: string | undefined): string[] {
  const problems: string[] = [];
  if (!s.clientId) {
    problems.push("clientId is not set");
  } else if (!/^[a-z0-9]{32}$/i.test(s.clientId)) {
    problems.push("clientId must be the Box app's Client ID (32 characters)");
  }
  if (!clientSecret) {
    problems.push(`client secret missing: run kurahi secrets set ${CLIENT_SECRET_NAME}`);
  }
  if (s.upload && !isBoxId(s.uploadFolderId)) {
    problems.push("write.uploadFolderId must be the numeric id of the folder uploads go to");
  }
  if (s.upload && s.uploadFolderId === "0") {
    problems.push("write.uploadFolderId must not be the root folder (0)");
  }
  return problems;
}

export function requestedScopes(s: BoxSettings): string[] {
  // Both with uploads: read tools check root_readonly, the upload tool root_readwrite (the app
  // must have "Read all files and folders" and "Write all files and folders" ticked).
  return s.upload ? [SCOPES.read, SCOPES.write] : [SCOPES.read];
}

export function buildClient(
  s: BoxSettings,
  clientSecret: string | undefined,
): OAuthClientConfig | undefined {
  if (configProblems(s, clientSecret).length > 0) {
    return undefined;
  }
  return {
    clientId: s.clientId!,
    clientSecret,
    endpoints: BOX_ENDPOINTS,
    scopes: requestedScopes(s),
    revokeWithClient: true,
  };
}
