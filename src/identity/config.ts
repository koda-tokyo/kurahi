// Normalised view of `gateway.identity`: defaults, bounds and the problems that keep SSO off.
import type { KoLoConfig } from "../config/config.js";
import type {
  GatewayIdentityConfig,
  IdentityOidcProviderConfig,
  IdentityProviderConfig,
  IdentitySamlProviderConfig,
} from "../config/types.identity.js";
import { RESERVED_PROVIDER_IDS } from "../config/zod-schema.identity.js";
import { isOrgRole, type OrgRole } from "./types.js";

export const DEFAULT_SESSION_LIFETIME_MIN = 480;
export const MAX_SESSION_LIFETIME_MIN = 1440;
export const DEFAULT_IDLE_MIN = 60;
export const DEFAULT_CLOCK_SKEW_SEC = 120;
export const MAX_CLOCK_SKEW_SEC = 300;
export const DEFAULT_SCIM_RATE_PER_MIN = 600;

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

export function resolveIdentitySettings(
  cfg: KoLoConfig | GatewayIdentityConfig | null | undefined,
): IdentitySettings {
  const raw: GatewayIdentityConfig =
    (cfg && "gateway" in cfg ? cfg.gateway?.identity : (cfg as GatewayIdentityConfig)) ?? {};
  const problems: string[] = [];
  const publicUrl = httpsUrl(raw.publicUrl);
  const providers = (raw.providers ?? []).filter((p) => {
    if (RESERVED_PROVIDER_IDS.has(p.id)) {
      problems.push(`provider ${p.id}: the id is reserved (scim, legacy)`);
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
  if (ssoRequired && providers.length === 0) {
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
  const configured = (raw.providers?.length ?? 0) > 0 || scimEnabled || ssoRequired;
  if (ssoRequired && raw.localPersons === true) {
    problems.push("localPersons is ignored while ssoRequired is set: only SSO and break-glass");
  }
  const localPersons = !ssoRequired && (raw.localPersons ?? !configured);
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
    problems,
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
