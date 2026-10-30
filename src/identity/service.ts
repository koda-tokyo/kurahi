// The identity runtime: directory + sessions + SSO clients behind one object.
//
// Created lazily on first use (never at import), keyed to the current `gateway.identity`
// settings. Sign-in maps the IdP's claims to a person: by provider link (issuer + subject, from an
// earlier sign-in or an admin link), else a SCIM-provisioned person whose externalId is the
// subject, else (only for a provider with `trustEmailForLinking` and a verified e-mail) an
// unlinked person with that e-mail, else a new person (unless `requireProvisioned`). A person
// already linked elsewhere is never taken over. A person with no role is refused.
import { isConfigLoadFailure, type KoLoConfig, loadConfig } from "../config/config.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { AuthenticatorStore } from "./authenticators.js";
import { type IdentitySettings, PASSKEY_PROVIDER_ID, resolveIdentitySettings } from "./config.js";
import { OidcClient, type OidcClientOptions } from "./oidc.js";
import { PasskeyService } from "./passkeys.js";
import { buildPersonPrincipal, projectGroupsFor, providerTrustsEmail } from "./rbac.js";
import { SamlServiceProvider } from "./saml/sp.js";
import { SessionStore } from "./sessions.js";
import { IdentityStore } from "./store.js";
import {
  type Person,
  PERSON_PRINCIPAL_PREFIX,
  type PersonPrincipal,
  type SessionClient,
  type SessionGrant,
  type SignInAuth,
  type SignInClaims,
  type SsoSession,
} from "./types.js";

export type SignInResult =
  | { ok: true; token: string; principal: PersonPrincipal }
  | {
      ok: false;
      reason: "not_provisioned" | "inactive" | "no_role" | "link_conflict" | "deprovisioned";
    };

/** How far before the step-up start an IdP's authentication time may be (clock drift only). */
export const STEP_UP_START_SKEW_MS = 5_000;

export type StepUpCompletion =
  | { ok: true; principal: PersonPrincipal }
  | { ok: false; reason: "session_ended" | "person_mismatch" | "not_fresh" };

/** A step-up re-authentication the gateway started for one live session. */
export type StepUpFlow = { sessionId: string; personId: string; startedAt: number };

export type IdentityServiceOptions = {
  store?: IdentityStore;
  sessions?: SessionStore;
  /** Passkeys, TOTP secrets and enrollment codes (default: the identity directory's file). */
  authenticators?: AuthenticatorStore;
  oidc?: OidcClientOptions;
  now?: () => number;
};

export class IdentityService {
  readonly store: IdentityStore;
  readonly sessions: SessionStore;
  readonly oidc: OidcClient;
  readonly saml: SamlServiceProvider;
  /** Built-in passkey and one-time code sign-in (provider `passkey`). */
  readonly passkeys: PasskeyService;
  private authenticatorStore: AuthenticatorStore | null;
  private settingsValue: IdentitySettings;
  private readonly now: () => number;

  constructor(settings: IdentitySettings, opts: IdentityServiceOptions = {}) {
    this.settingsValue = settings;
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new IdentityStore();
    this.sessions = opts.sessions ?? new SessionStore();
    this.oidc = new OidcClient({
      clockSkewSec: settings.clockSkewSec,
      now: opts.now,
      ...opts.oidc,
    });
    this.saml = new SamlServiceProvider({ clockSkewSec: settings.clockSkewSec, now: opts.now });
    this.authenticatorStore = opts.authenticators ?? null;
    this.passkeys = new PasskeyService(this, { now: opts.now });
  }

  /** The authenticator store, opened on first use (most gateways never touch it). */
  get authenticators(): AuthenticatorStore {
    this.authenticatorStore ??= new AuthenticatorStore();
    return this.authenticatorStore;
  }

  get settings(): IdentitySettings {
    return this.settingsValue;
  }

  updateSettings(settings: IdentitySettings): void {
    this.settingsValue = settings;
  }

  /** Map verified IdP claims to a person and open a session. */
  signIn(claims: SignInClaims, extra: { notAfterMs?: number | null } = {}): SignInResult {
    const s = this.settingsValue;
    const store = this.store;
    // E-mail counts for linking only when the IdP verified it and the provider is trusted for it.
    const trustedEmail =
      claims.emailVerified && claims.email && providerTrustsEmail(s, claims.providerId)
        ? claims.email
        : null;
    const link = { providerId: claims.providerId, issuer: claims.issuer, subject: claims.subject };
    const conflict = (detail: Record<string, unknown>): SignInResult => {
      recordAuditEvent({
        action: "identity.sso.link",
        outcome: "denied",
        source: "gateway.identity",
        detail: { provider: claims.providerId, ...detail },
      });
      return { ok: false, reason: "link_conflict" };
    };
    // 1. An existing link (made at an earlier sign-in or by an admin with identity.persons.link).
    let person = store.findByLink(claims.providerId, claims.issuer, claims.subject);
    // 2. A SCIM-provisioned person whose externalId is this subject, only from the provider
    //    the directory's externalIds belong to.
    if (!person && s.scim.providerId === claims.providerId) {
      const candidate = store.findByExternalId(claims.subject);
      if (candidate) {
        // Never attach to a person already linked (to another subject, or to another provider:
        // an admin links that explicitly).
        if (candidate.links.length > 0) {
          return conflict({ person: candidate.id, via: "externalId" });
        }
        person = store.addLink(candidate.id, link);
      }
    }
    // 3. A verified e-mail from a provider with `trustEmailForLinking`, onto an unlinked person.
    if (!person && claims.email) {
      const candidate = store.findByEmail(claims.email);
      if (candidate) {
        if (!trustedEmail || candidate.links.length > 0) {
          // An unverified or untrusted e-mail never takes an existing person over; nor does a
          // trusted one take over a person linked elsewhere.
          return conflict({ person: candidate.id, via: "email", trusted: Boolean(trustedEmail) });
        }
        person = store.addLink(candidate.id, link);
      }
    }
    if (!person) {
      // A person SCIM deleted does not come back by signing in: an admin restores them
      // (identity.persons.restore) or SCIM provisions them again.
      const tombstone = store.findTombstone(claims);
      if (tombstone) {
        recordAuditEvent({
          action: "identity.sso.login",
          outcome: "denied",
          source: "gateway.identity",
          detail: { provider: claims.providerId, reason: "deprovisioned", tombstone: tombstone.id },
        });
        return { ok: false, reason: "deprovisioned" };
      }
      if (s.requireProvisioned) {
        return { ok: false, reason: "not_provisioned" };
      }
      person = store.createPerson({
        userName: trustedEmail ?? `${claims.providerId}:${claims.subject}`.slice(0, 256),
        email: claims.email,
        emailVerifiedBy: trustedEmail ? claims.providerId : null,
        displayName: claims.displayName,
        givenName: claims.givenName,
        familyName: claims.familyName,
        links: [link],
        source: "sso",
      });
    }
    if (!person.active) {
      return { ok: false, reason: "inactive" };
    }
    if (s.requireProvisioned && person.source !== "scim") {
      return { ok: false, reason: "not_provisioned" };
    }
    // Provisioned attributes win; sign-in fills only what SCIM did not set, and records whether
    // a trusted provider vouched for the e-mail it filled in.
    const fillEmail = person.email === null && claims.email !== null;
    person = store.updatePerson(person.id, {
      claimGroups: claims.groups,
      claimGroupsFrom: claims.providerId,
      lastLoginAt: new Date().toISOString(),
      ...(fillEmail
        ? {
            email: claims.email,
            emailVerifiedBy: trustedEmail ? claims.providerId : null,
          }
        : {}),
      displayName: person.displayName ?? claims.displayName,
    });
    return this.openSession(person, {
      providerId: claims.providerId,
      protocol: claims.protocol,
      idTokenHint: claims.idTokenHint,
      auth: claims.auth,
      notAfterMs: extra.notAfterMs ?? null,
    });
  }

  /**
   * Built-in sign-in: the person proved a passkey or one-time code of their own (verified by
   * PasskeyService). Opens a session with provider and protocol `passkey`. The same rules as an
   * IdP sign-in apply: active, provisioned when `requireProvisioned`, and holding a role.
   */
  signInPerson(personId: string, auth: SignInAuth): SignInResult {
    const s = this.settingsValue;
    const found = this.store.getPerson(personId);
    if (!found) {
      return { ok: false, reason: "deprovisioned" };
    }
    if (!found.active) {
      return { ok: false, reason: "inactive" };
    }
    if (s.requireProvisioned && found.source !== "scim") {
      return { ok: false, reason: "not_provisioned" };
    }
    const person = this.store.updatePerson(found.id, { lastLoginAt: new Date().toISOString() });
    return this.openSession(person, {
      providerId: PASSKEY_PROVIDER_ID,
      protocol: "passkey",
      idTokenHint: null,
      auth,
      notAfterMs: null,
    });
  }

  private openSession(
    person: Person,
    opts: {
      providerId: string;
      protocol: SsoSession["protocol"];
      idTokenHint: string | null;
      auth: SignInAuth;
      notAfterMs: number | null;
    },
  ): SignInResult {
    const s = this.settingsValue;
    const { token, session } = this.sessions.create({
      personId: person.id,
      providerId: opts.providerId,
      protocol: opts.protocol,
      lifetimeMs: s.lifetimeMs,
      idleMs: s.idleMs,
      idTokenHint: opts.idTokenHint,
      auth: opts.auth,
      notAfterMs: opts.notAfterMs,
    });
    const built = buildPersonPrincipal(this.store, s, session);
    if (!built.ok) {
      this.sessions.revoke(session.id, built.reason);
      return { ok: false, reason: built.reason === "no_role" ? "no_role" : "inactive" };
    }
    return { ok: true, token, principal: built.principal };
  }

  /**
   * Finish a step-up: the IdP re-authenticated someone; record it on the session only when it is
   * the session's own person (same provider link: issuer + subject) and the authentication
   * happened after the step-up started. Never opens a session or switches persons. Audited.
   */
  completeStepUp(claims: SignInClaims, flow: StepUpFlow): StepUpCompletion {
    const skewMs = this.settingsValue.clockSkewSec * 1000;
    const session = this.sessions.get(flow.sessionId);
    const linked = this.store.findByLink(claims.providerId, claims.issuer, claims.subject);
    const at = Date.parse(claims.auth.at);
    const now = this.now();
    let result: StepUpCompletion;
    if (!session || session.personId !== flow.personId) {
      result = { ok: false, reason: "session_ended" };
    } else if (!linked || linked.id !== session.personId) {
      result = { ok: false, reason: "person_mismatch" };
    } else if (
      !Number.isFinite(at) ||
      at < flow.startedAt - STEP_UP_START_SKEW_MS ||
      at > now + skewMs
    ) {
      result = { ok: false, reason: "not_fresh" };
    } else if (!this.sessions.refreshAuth(session.id, claims.auth)) {
      result = { ok: false, reason: "session_ended" };
    } else {
      const built = this.principalForSession(session.id);
      result = built.ok
        ? { ok: true, principal: built.principal }
        : { ok: false, reason: "session_ended" };
    }
    recordAuditEvent({
      action: "identity.stepup.complete",
      outcome: result.ok ? "allowed" : "denied",
      source: "gateway.identity",
      identity: `${PERSON_PRINCIPAL_PREFIX}${flow.personId}`,
      detail: {
        provider: claims.providerId,
        protocol: claims.protocol,
        session: flow.sessionId,
        reason: result.ok ? null : result.reason,
        authAt: claims.auth.at,
        methods: claims.auth.methods,
        context: claims.auth.context,
      },
    });
    return result;
  }

  /**
   * A new session for a command-line or native app, for the person a browser sign-in approved
   * (`grant`). Distinct from the browser session, so it is listed and revoked on its own. Refused
   * when the person is no longer active, lost every role, or the provider is gone.
   */
  issueClientSession(
    grant: SessionGrant,
    client: SessionClient,
  ): { ok: true; token: string; principal: PersonPrincipal } | { ok: false; reason: string } {
    const s = this.settingsValue;
    const end = Math.min(Date.now() + s.lifetimeMs, grant.notAfterMs);
    // Check the person as of now before a token exists.
    const precheck = buildPersonPrincipal(this.store, s, {
      id: "",
      personId: grant.personId,
      providerId: grant.providerId,
      expiresAt: new Date(end).toISOString(),
      auth: grant.auth ?? undefined,
    });
    if (!precheck.ok) {
      return precheck;
    }
    const { token, session } = this.sessions.create({
      personId: grant.personId,
      providerId: grant.providerId,
      protocol: grant.protocol,
      lifetimeMs: s.lifetimeMs,
      idleMs: s.idleMs,
      auth: grant.auth ?? undefined,
      notAfterMs: grant.notAfterMs,
      client,
    });
    const built = buildPersonPrincipal(this.store, s, session);
    if (!built.ok) {
      this.sessions.revoke(session.id, built.reason);
      return built;
    }
    return { ok: true, token, principal: built.principal };
  }

  /** Verify a presented session token and resolve the person as of now. */
  verifyToken(
    token: string,
    opts: { touch?: boolean } = {},
  ): { ok: true; principal: PersonPrincipal } | { ok: false; reason: string } {
    const check = this.sessions.verify(token, opts);
    if (!check.ok) {
      return { ok: false, reason: `session_${check.reason}` };
    }
    return this.principalForSession(check.session.id, opts);
  }

  /** Re-check an open connection's session by id (revocation, deactivation, role changes). */
  principalForSession(
    sessionId: string,
    opts: { touch?: boolean } = {},
  ): { ok: true; principal: PersonPrincipal } | { ok: false; reason: string } {
    const check = this.sessions.verifyId(sessionId, opts);
    if (!check.ok) {
      return { ok: false, reason: `session_${check.reason}` };
    }
    const built = buildPersonPrincipal(this.store, this.settingsValue, check.session);
    if (!built.ok) {
      this.sessions.revoke(sessionId, built.reason);
    }
    return built;
  }

  /** Deprovisioning: end every session of the person now; audited. */
  revokePersonSessions(personId: string, reason: string, by: string): number {
    const n = this.sessions.revokePerson(personId, reason);
    recordAuditEvent({
      action: "identity.sessions.revoke",
      outcome: "allowed",
      source: "gateway.identity",
      identity: by,
      detail: { person: `${PERSON_PRINCIPAL_PREFIX}${personId}`, reason, sessions: n },
    });
    return n;
  }

  /** Groups a `person:<id>` principal exports to Project access policies. */
  projectGroupsForPrincipal(principal: string): string[] | null {
    if (!principal.startsWith(PERSON_PRINCIPAL_PREFIX)) {
      return null;
    }
    const personId = principal.slice(PERSON_PRINCIPAL_PREFIX.length);
    // Groups do not depend on a session: resolve the grants for the person alone.
    const built = buildPersonPrincipal(this.store, this.settingsValue, {
      id: "",
      personId,
      providerId: "",
      expiresAt: "",
    });
    return built.ok ? projectGroupsFor(built.principal) : null;
  }
}

let service: IdentityService | null = null;
let pinned = false;

let keptAfterFailure = false;

/**
 * The process-wide identity runtime for the current config.
 *
 * Fails closed: when the config file cannot be read, parsed or validated, loadConfig returns an
 * empty config, which would read as "identity not configured" (SSO optional, local persons). The
 * last good settings stay in force instead until the file loads again; the first such load is
 * audited (`identity.config.load_failed`). The gateway refuses to start on an invalid config, so
 * a running gateway always has good settings to keep.
 */
export function getIdentityService(cfg?: KoLoConfig | null): IdentityService {
  if (service && (pinned || cfg === undefined)) {
    return service;
  }
  const source = cfg === undefined ? loadConfig() : cfg;
  if (service && isConfigLoadFailure(source)) {
    if (!keptAfterFailure) {
      keptAfterFailure = true;
      recordAuditEvent({
        action: "identity.config.load_failed",
        outcome: "denied",
        source: "gateway.identity",
        detail: { kept: "last good identity settings", ssoRequired: service.settings.ssoRequired },
      });
    }
    return service;
  }
  keptAfterFailure = false;
  const settings = resolveIdentitySettings(source);
  if (!service) {
    service = new IdentityService(settings);
  } else {
    service.updateSettings(settings);
  }
  return service;
}

/** Tests: install a service (with its own settings) that config reloads do not replace. */
export function setIdentityServiceForTest(next: IdentityService | null): void {
  service = next;
  pinned = next !== null;
}
