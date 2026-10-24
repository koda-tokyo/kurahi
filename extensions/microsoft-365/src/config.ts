// Microsoft 365 connector configuration: admin-supplied tenant and client id, least-privilege
// scopes derived from what is switched on. Read scopes only unless a write opt-in is set.
import {
  intParam,
  isValidClientId,
  isValidTenant,
  microsoftEndpoints,
  type OAuthClientConfig,
} from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "microsoft-365";

export const SCOPES = {
  user: "User.Read",
  mail: "Mail.Read",
  calendar: "Calendars.Read",
  files: "Files.Read.All",
  sites: "Sites.Read.All",
  mailSend: "Mail.Send",
  calendarWrite: "Calendars.ReadWrite",
} as const;

export type M365Settings = {
  tenantId?: string;
  clientId?: string;
  mail: boolean;
  calendar: boolean;
  files: boolean;
  sharePoint: boolean;
  maxFileBytes: number;
  mailSend: boolean;
  calendarWrite: boolean;
  redirectPort?: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
  approvalTimeoutMs: number;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): M365Settings {
  const c = rec(raw);
  const files = rec(c.files);
  const write = rec(c.write);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    tenantId: str(c.tenantId),
    clientId: str(c.clientId),
    mail: c.mail !== false,
    calendar: c.calendar !== false,
    files: files.enabled === true,
    sharePoint: files.sharePoint === true,
    maxFileBytes: intParam(files.maxFileBytes, 10 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    mailSend: write.mailSend === true,
    calendarWrite: write.calendarWrite === true,
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 15, 5, 1440),
    ratePerSecond: intParam(c.ratePerSecond, 8, 1, 50),
    approvalTimeoutMs: intParam(c.approvalTimeoutSeconds, 120, 30, 600) * 1000,
  };
}

/** Scopes requested at sign-in. `offline_access` gives the refresh token. */
export function requestedScopes(s: M365Settings): string[] {
  const out: string[] = ["offline_access", SCOPES.user];
  if (s.mail) {
    out.push(SCOPES.mail);
  }
  if (s.calendar && !s.calendarWrite) {
    out.push(SCOPES.calendar);
  }
  if (s.files) {
    out.push(SCOPES.files);
  }
  if (s.sharePoint) {
    out.push(SCOPES.sites);
  }
  if (s.mailSend) {
    out.push(SCOPES.mailSend);
  }
  if (s.calendarWrite) {
    out.push(SCOPES.calendarWrite);
  }
  return out;
}

export function configProblems(s: M365Settings): string[] {
  const problems: string[] = [];
  if (!s.tenantId) {
    problems.push("tenantId is not set");
  } else if (!isValidTenant(s.tenantId) || s.tenantId === "organizations") {
    problems.push("tenantId must be the customer's tenant GUID or verified domain");
  }
  if (!s.clientId) {
    problems.push("clientId is not set");
  } else if (!isValidClientId(s.clientId)) {
    problems.push("clientId must be the app registration's Application (client) ID GUID");
  }
  return problems;
}

export function buildClient(s: M365Settings): OAuthClientConfig | undefined {
  if (configProblems(s).length > 0) {
    return undefined;
  }
  return {
    clientId: s.clientId!,
    endpoints: microsoftEndpoints(s.tenantId!),
    scopes: requestedScopes(s),
  };
}
