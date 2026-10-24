// Microsoft Entra ID connector configuration: sign-in first (openid profile email), directory
// read second and opt-in (User.ReadBasic.All, or Directory.Read.All for groups).
import {
  EntraOidcValidator,
  type FetchLike,
  intParam,
  isValidClientId,
  isValidTenant,
  microsoftEndpoints,
  type OAuthClientConfig,
} from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "entra";

export const SCOPES = {
  user: "User.Read",
  basic: "User.ReadBasic.All",
  full: "Directory.Read.All",
} as const;

export type DirectoryLevel = "off" | "basic" | "full";

export type EntraSettings = {
  tenantId?: string;
  clientId?: string;
  allowedTenants: string[];
  directory: DirectoryLevel;
  redirectPort?: number;
  probeIntervalMinutes: number;
  ratePerSecond: number;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): EntraSettings {
  const c = rec(raw);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const dir = c.directory === "basic" || c.directory === "full" ? c.directory : "off";
  return {
    tenantId: str(c.tenantId),
    clientId: str(c.clientId),
    allowedTenants: Array.isArray(c.allowedTenants)
      ? c.allowedTenants.filter((t): t is string => typeof t === "string").map((t) => t.trim())
      : [],
    directory: dir,
    redirectPort: typeof c.redirectPort === "number" ? c.redirectPort : undefined,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 15, 5, 1440),
    ratePerSecond: intParam(c.ratePerSecond, 8, 1, 50),
  };
}

export function requestedScopes(s: EntraSettings): string[] {
  const out = ["openid", "profile", "email", "offline_access", SCOPES.user];
  if (s.directory === "basic") {
    out.push(SCOPES.basic);
  }
  if (s.directory === "full") {
    out.push(SCOPES.full);
  }
  return out;
}

export function configProblems(s: EntraSettings): string[] {
  const problems: string[] = [];
  if (!s.tenantId) {
    problems.push("tenantId is not set");
  } else if (!isValidTenant(s.tenantId)) {
    problems.push('tenantId must be a tenant GUID, a verified domain or "organizations"');
  }
  if (!s.clientId) {
    problems.push("clientId is not set");
  } else if (!isValidClientId(s.clientId)) {
    problems.push("clientId must be the app registration's Application (client) ID GUID");
  }
  if (s.allowedTenants.some((t) => !GUID.test(t))) {
    problems.push("allowedTenants must contain tenant GUIDs");
  }
  if (s.tenantId === "organizations" && s.allowedTenants.length === 0) {
    problems.push('allowedTenants is required when tenantId is "organizations"');
  }
  return problems;
}

export function buildClient(s: EntraSettings): OAuthClientConfig | undefined {
  if (configProblems(s).length > 0) {
    return undefined;
  }
  return {
    clientId: s.clientId!,
    endpoints: microsoftEndpoints(s.tenantId!),
    scopes: requestedScopes(s),
  };
}

/** The ID token validator for gateway / desktop sign-in, or undefined when not configured. */
export function createSsoValidator(
  s: EntraSettings,
  deps: { fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): EntraOidcValidator | undefined {
  if (configProblems(s).length > 0) {
    return undefined;
  }
  return new EntraOidcValidator({
    tenantId: s.tenantId!,
    clientId: s.clientId!,
    allowedTenants: s.allowedTenants.length > 0 ? s.allowedTenants : undefined,
    fetch: deps.fetch,
    now: deps.now,
    sleep: deps.sleep,
  });
}
