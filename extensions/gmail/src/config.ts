// Gmail connector configuration: the customer's own Google Cloud OAuth client (Desktop app type)
// and least-privilege scopes. The client secret Google issues for desktop clients is read from
// the secret store (`connector.gmail.clientSecret`), never from the config file.
import { intParam, type OAuthClientConfig } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "gmail";
export const CLIENT_SECRET_NAME = "connector.gmail.clientSecret";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const SCOPES = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;

export const GOOGLE_ENDPOINTS = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  // No deviceCodeUrl: Google's device flow does not allow Gmail scopes.
};

export type GmailSettings = {
  clientId?: string;
  allowedDomain?: string;
  send: boolean;
  redirectPort?: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
  approvalTimeoutMs: number;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): GmailSettings {
  const c = rec(raw);
  const write = rec(c.write);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    clientId: str(c.clientId),
    allowedDomain: str(c.allowedDomain)?.toLowerCase(),
    send: write.send === true,
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 15, 5, 1440),
    ratePerSecond: intParam(c.ratePerSecond, 8, 1, 50),
    approvalTimeoutMs: intParam(c.approvalTimeoutSeconds, 120, 30, 600) * 1000,
  };
}

export function requestedScopes(s: GmailSettings): string[] {
  return s.send ? [SCOPES.readonly, SCOPES.send] : [SCOPES.readonly];
}

export function configProblems(s: GmailSettings, clientSecret: string | undefined): string[] {
  const problems: string[] = [];
  if (!s.clientId) {
    problems.push("clientId is not set");
  } else if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(s.clientId)) {
    problems.push("clientId must be an OAuth client ID ending in .apps.googleusercontent.com");
  }
  if (!clientSecret) {
    problems.push(`client secret missing: run kurahi secrets set ${CLIENT_SECRET_NAME}`);
  }
  if (s.allowedDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s.allowedDomain)) {
    problems.push("allowedDomain must be a domain name");
  }
  return problems;
}

export function buildClient(
  s: GmailSettings,
  clientSecret: string | undefined,
): OAuthClientConfig | undefined {
  if (configProblems(s, clientSecret).length > 0) {
    return undefined;
  }
  return {
    clientId: s.clientId!,
    clientSecret,
    endpoints: GOOGLE_ENDPOINTS,
    scopes: requestedScopes(s),
    // offline + consent: Google returns a refresh token; hd hints the Workspace account picker
    // (enforced after sign-in, not trusted from this parameter).
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
      ...(s.allowedDomain ? { hd: s.allowedDomain } : {}),
    },
  };
}
