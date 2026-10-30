// Normalised view of `gateway.identity`: defaults, bounds and the problems that keep SSO off.
import type { KoLoConfig } from "../config/config.js";
import type {
  GatewayIdentityConfig,
  IdentityNativeClientConfig,
  IdentityOidcProviderConfig,
  IdentityProviderConfig,
  IdentitySamlProviderConfig,
} from "../config/types.identity.js";
import { PASSKEY_PROVIDER_ID, RESERVED_PROVIDER_IDS } from "../config/zod-schema.identity.js";
import { isOrgRole, type OrgRole } from "./types.js";

export const DEFAULT_SESSION_LIFETIME_MIN = 480;
export const MAX_SESSION_LIFETIME_MIN = 1440;
export const DEFAULT_IDLE_MIN = 60;
export const DEFAULT_CLOCK_SKEW_SEC = 120;
export const MAX_CLOCK_SKEW_SEC = 300;
export const DEFAULT_SCIM_RATE_PER_MIN = 600;
export const DEFAULT_STEP_UP_MAX_AGE_SEC = 300;
export const MIN_STEP_UP_MAX_AGE_SEC = 30;
export const MAX_STEP_UP_MAX_AGE_SEC = 3600;

/** Normalised `gateway.identity.stepUp` (see step-up.ts). */
export type StepUpSettings = {
  enabled: boolean;
  maxAgeSec: number;
  /** Any-of RFC 8176 `amr` values; empty = any method. */
  requireMethods: string[];
  approvals: { enabled: boolean; amountAtLeast: number | null; amountField: string };
  autopilotLevel: boolean;
  emergencyStopRelease: boolean;
  identityAdmin: boolean;
  authenticatorChange: boolean;
  governance: boolean;
};

/** Kurahi Desktop: the native client every gateway knows unless `nativeClients` is set. */
export const DESKTOP_CLIENT_ID = "kurahi-desktop";
export const DEFAULT_NATIVE_CLIENTS: readonly IdentityNativeClientConfig[] = [
  { id: DESKTOP_CLIENT_ID, name: "Kurahi Desktop", redirect: "loopback" },
];
export { PASSKEY_PROVIDER_ID };

/** Built-in passkey / one-time code sign-in, resolved. `enabled` only when usable. */
export type PasskeySettings = {
  enabled: boolean;
  rpId: string | null;
  rpName: string;
  /** Exact origins (scheme://host[:port]) the browser may sign in from. */
  origins: string[];
  userVerification: "required" | "preferred";
  /** One-time codes (TOTP) as a fallback; only while passkeys are enabled. */
  totp: boolean;
};

export type IdentitySettings = {
  publicUrl: string | null;
  providers: IdentityProviderConfig[];
  ssoRequired: boolean;
  /** `gateway.identity` names providers, SCIM or ssoRequired (even when they are unusable). */
  configured: boolean;
  /**
   * Shared-secret, device-token and pairing connections count as the local person for the
   * person-only methods. On by default only when identity is not configured; never with
   * ssoRequired.
   */
  localPersons: boolean;
  breakGlassLocalOnly: boolean;
  lifetimeMs: number;
  idleMs: number;
  defaultRole: OrgRole | null;
  /** Roles that also get the host-level `operator.config` scope (default none). */
  configRoles: OrgRole[];
  clockSkewSec: number;
  /** `providerId`: the only provider whose subject may match a SCIM externalId. */
  scim: {
    enabled: boolean;
    token: string | null;
    ratePerMinute: number;
    providerId: string | null;
  };
  requireProvisioned: boolean;
  stepUp: StepUpSettings;
  /** Native apps (RFC 8252) that may sign people in; ids are unique. */
  nativeClients: IdentityNativeClientConfig[];
  /** Command-line sign-in (device authorization grant). */
  deviceSignIn: boolean;
  passkeys: PasskeySettings;
  /** Why a configured feature cannot run (missing publicUrl, http publicUrl, …). */
  problems: string[];
};

function httpsUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const u = new URL(raw);
    // Loopback http is allowed for development; anything else must be https.
    const loopback =
      u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
      return null;
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function resolvePasskeys(
  raw: GatewayIdentityConfig["passkeys"],
  publicUrl: string | null,
  problems: string[],
): PasskeySettings {
  const off: PasskeySettings = {
    enabled: false,
    rpId: null,
    rpName: raw?.rpName ?? "Kurahi",
    origins: [],
    userVerification: raw?.userVerification ?? "required",
    totp: false,
  };
  if (raw?.enabled !== true) {
    return off;
  }
  const origins: string[] = [];
  for (const o of raw.allowedOrigins ?? (publicUrl ? [publicUrl] : [])) {
    const ok = httpsUrl(o);
    if (!ok) {
      problems.push(`passkeys: origin ${o} must be https (http only for localhost)`);
      continue;
    }
    origins.push(new URL(ok).origin);
  }
  if (origins.length === 0) {
    problems.push(
      "passkeys: gateway.identity.publicUrl (https) or passkeys.allowedOrigins is required",
    );
    return off;
  }
  const rpId = (raw.rpId ?? new URL(publicUrl ?? origins[0]).hostname).toLowerCase();
  // Browsers refuse IP addresses as an RP id; every origin must be the RP id or below it.
  if (/^[\d.]+$/.test(rpId) || rpId.includes(":") || rpId.startsWith("[")) {
    problems.push(`passkeys: rpId ${rpId} must be a domain name, not an IP address`);
    return off;
  }
  for (const o of origins) {
    const host = new URL(o).hostname.toLowerCase();
    if (host !== rpId && !host.endsWith(`.${rpId}`)) {
      problems.push(`passkeys: origin ${o} is not ${rpId} or a subdomain of it`);
      return off;
    }
  }
  return { ...off, enabled: true, rpId, origins: [...new Set(origins)], totp: raw.totp !== false };
}

export function resolveIdentitySettings(
  cfg: KoLoConfig | GatewayIdentityConfig | null | undefined,
): IdentitySettings {
  const raw: GatewayIdentityConfig =
    (cfg && "gateway" in cfg ? cfg.gateway?.identity : (cfg as GatewayIdentityConfig)) ?? {};
  const problems: string[] = [];
  const publicUrl = httpsUrl(raw.publicUrl);
  const providers = (raw.providers ?? []).filter((p) => {
    if (RESERVED_PROVIDER_IDS.has(p.id)) {
      problems.push(`provider ${p.id}: the id is reserved (scim, legacy, passkey)`);
      return false;
    }
    if (!publicUrl) {
      problems.push(`provider ${p.id}: gateway.identity.publicUrl (https) is required for SSO`);
      return false;
    }
    if (p.kind === "oidc" && !httpsUrl(p.issuer)) {
      problems.push(`provider ${p.id}: issuer must be an https URL`);
      return false;
    }
    if (p.kind === "saml" && !httpsUrl(p.idpSsoUrl)) {
      problems.push(`provider ${p.id}: idpSsoUrl must be an https URL`);
      return false;
    }
    return true;
  });
  const seen = new Set<string>();
  for (const p of providers) {
    if (seen.has(p.id)) {
      problems.push(`provider ${p.id}: listed twice`);
    }
    seen.add(p.id);
  }
  const ssoRequired = raw.ssoRequired === true;
  const passkeys = resolvePasskeys(raw.passkeys, publicUrl, problems);
  if (ssoRequired && providers.length === 0 && !passkeys.enabled) {
    problems.push("ssoRequired is set but no SSO provider is usable: only break-glass logins work");
  }
  const lifetimeMin = Math.min(
    raw.session?.lifetimeMinutes ?? DEFAULT_SESSION_LIFETIME_MIN,
    MAX_SESSION_LIFETIME_MIN,
  );
  const idleMin = Math.min(raw.session?.idleMinutes ?? DEFAULT_IDLE_MIN, lifetimeMin);
  const scimToken =
    typeof raw.scim?.token === "string" && raw.scim.token.length >= 32 ? raw.scim.token : null;
  const scimEnabled = raw.scim?.enabled === true;
  if (scimEnabled && !scimToken) {
    problems.push("scim.enabled is set but scim.token (at least 32 characters) is missing");
  }
  // A SCIM externalId is one IdP's subject: never let another provider claim it.
  let scimProviderId: string | null = null;
  if (raw.scim?.providerId !== undefined) {
    if (providers.some((p) => p.id === raw.scim?.providerId)) {
      scimProviderId = raw.scim.providerId;
    } else {
      problems.push(`scim.providerId ${raw.scim.providerId}: no such usable provider`);
    }
  } else if (providers.length === 1) {
    scimProviderId = providers[0].id;
  } else if (scimEnabled && providers.length > 1) {
    problems.push(
      "scim.providerId is not set and several providers are configured: SCIM persons are not matched by externalId until an admin links them",
    );
  }
  const configured =
    (raw.providers?.length ?? 0) > 0 ||
    scimEnabled ||
    ssoRequired ||
    raw.passkeys?.enabled === true;
  if (ssoRequired && raw.localPersons === true) {
    problems.push("localPersons is ignored while ssoRequired is set: only SSO and break-glass");
  }
  const localPersons = !ssoRequired && (raw.localPersons ?? !configured);
  const nativeClients: IdentityNativeClientConfig[] = [];
  for (const c of raw.nativeClients ?? DEFAULT_NATIVE_CLIENTS) {
    if (nativeClients.some((x) => x.id === c.id)) {
      problems.push(`native client ${c.id}: listed twice (the first one is used)`);
      continue;
    }
    nativeClients.push({ ...c });
  }
  return {
    publicUrl,
    providers,
    ssoRequired,
    configured,
    localPersons,
    breakGlassLocalOnly: raw.breakGlass?.localOnly !== false,
    lifetimeMs: lifetimeMin * 60_000,
    idleMs: idleMin * 60_000,
    defaultRole: isOrgRole(raw.defaultRole) ? raw.defaultRole : null,
    configRoles: (raw.configRoles ?? []).filter(isOrgRole),
    clockSkewSec: Math.min(
      Math.max(raw.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SEC, 0),
      MAX_CLOCK_SKEW_SEC,
    ),
    scim: {
      enabled: scimEnabled && Boolean(scimToken),
      token: scimToken,
      ratePerMinute: raw.scim?.rateLimitPerMinute ?? DEFAULT_SCIM_RATE_PER_MIN,
      providerId: scimProviderId,
    },
    // With SCIM on, the directory is the source of truth: only provisioned persons sign in,
    // unless requireProvisioned is explicitly false. Also while the SCIM token is missing (SCIM
    // cannot run yet): the intent is a provisioned directory, so nobody is created just in time.
    requireProvisioned: raw.requireProvisioned ?? scimEnabled,
    stepUp: resolveStepUp(raw.stepUp, configured),
    nativeClients,
    deviceSignIn: raw.deviceSignIn !== false,
    passkeys,
    problems,
  };
}

/** Safe defaults: on when identity is configured, every covered action on, 5 minutes. */
export function resolveStepUp(
  raw: GatewayIdentityConfig["stepUp"],
  configured: boolean,
): StepUpSettings {
  const a = raw?.actions ?? {};
  const approvals =
    a.approvals === undefined || a.approvals === true
      ? { enabled: true, amountAtLeast: null, amountField: "amount" }
      : a.approvals === false
        ? { enabled: false, amountAtLeast: null, amountField: "amount" }
        : {
            enabled: true,
            amountAtLeast:
              typeof a.approvals.amountAtLeast === "number" &&
              Number.isFinite(a.approvals.amountAtLeast)
                ? a.approvals.amountAtLeast
                : null,
            amountField: a.approvals.amountField ?? "amount",
          };
  return {
    enabled: raw?.enabled ?? configured,
    maxAgeSec: Math.min(
      Math.max(raw?.maxAgeSeconds ?? DEFAULT_STEP_UP_MAX_AGE_SEC, MIN_STEP_UP_MAX_AGE_SEC),
      MAX_STEP_UP_MAX_AGE_SEC,
    ),
    requireMethods: [...new Set((raw?.requireMethods ?? []).filter((m) => m.length > 0))],
    approvals,
    autopilotLevel: a.autopilotLevel !== false,
    emergencyStopRelease: a.emergencyStopRelease !== false,
    identityAdmin: a.identityAdmin !== false,
    authenticatorChange: a.authenticatorChange !== false,
    governance: a.governance !== false,
  };
}

export function findProvider(
  settings: IdentitySettings,
  id: string,
): IdentityOidcProviderConfig | IdentitySamlProviderConfig | null {
  return settings.providers.find((p) => p.id === id) ?? null;
}

export function callbackUrl(settings: IdentitySettings, providerId: string): string {
  return `${settings.publicUrl ?? ""}/api/identity/sso/${providerId}/callback`;
}

export function acsUrl(settings: IdentitySettings, providerId: string): string {
  return `${settings.publicUrl ?? ""}/api/identity/sso/${providerId}/acs`;
}

export function spEntityId(settings: IdentitySettings, p: IdentitySamlProviderConfig): string {
  return p.spEntityId ?? `${settings.publicUrl ?? ""}/api/identity/sso/${p.id}/metadata`;
}

export function findNativeClient(
  settings: IdentitySettings,
  id: string,
): IdentityNativeClientConfig | null {
  return settings.nativeClients.find((c) => c.id === id) ?? null;
}
