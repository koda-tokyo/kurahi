// Built-in sign-in (provider `passkey`): Kurahi as its own identity provider for organisations
// without Entra ID or Okta. Free on every plan.
//
// Passkeys (WebAuthn) are the primary method: usernameless sign-in with discoverable
// credentials, user verification required by default. One-time codes from an authenticator app
// (TOTP) are the fallback and can be turned off. Nobody registers themselves: a person already
// in the directory (SCIM-provisioned or created by an identity admin) enrols with a one-time
// enrollment code an identity admin issues (short TTL, audited), or adds another passkey while
// signed in. Every ceremony uses a one-time challenge held server-side (bounded store with a
// per-source quota, like pending OIDC sign-ins) that the finish step takes out whatever the
// outcome.
//
// Step-up: `stepUpWithPasskey` verifies a fresh assertion from one of the session's own
// person's passkeys and records it on the session (SessionStore.refreshAuth) with RFC 8176
// methods (`hwk` / `swk`, plus `user` when the authenticator verified the person).
import { randomBytes } from "node:crypto";
import type { IdentityService, SignInResult } from "./service.js";
import type { SignInAuth } from "./types.js";
import { AuthAttemptLimiter } from "../gateway/rate-limiter.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { type PasskeyCredential } from "./authenticators.js";
import { PendingQuota } from "./oidc.js";
import { checkStepUp, stepUpRefusal } from "./step-up.js";
import { IdentityError } from "./store.js";
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from "./totp.js";
import { SUPPORTED_COSE_ALGS } from "./webauthn/cose.js";
import {
  assertionCredentialId,
  type ExpectedCeremony,
  passkeyAmr,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type WebAuthnFailure,
} from "./webauthn/verify.js";

export const CEREMONY_TTL_MS = 5 * 60_000;
const MAX_CEREMONIES = 2_000;
/** Open ceremonies per source; a source over it replaces its own oldest. */
export const MAX_CEREMONIES_PER_SOURCE = 20;
/** Wrong codes per person (or typed user name) before one-time codes pause for that name. */
export const TOTP_FAILURES_PER_WINDOW = 5;
export const TOTP_FAILURE_WINDOW_MS = 5 * 60_000;
/** Wrong codes per source address and window, across all names (a spray over many names). */
export const TOTP_FAILURES_PER_SOURCE = 30;
/** Wrong codes allowed while confirming a new authenticator app. */
const TOTP_ENROLL_ATTEMPTS = 5;
export const DEFAULT_ENROLLMENT_TTL_MS = 60 * 60_000;
export const MAX_ENROLLMENT_TTL_MS = 72 * 3600_000;

export type PasskeyFailure =
  | WebAuthnFailure
  | "disabled"
  | "totp_disabled"
  | "too_many_pending"
  | "ceremony_unknown"
  | "not_signed_in"
  | "enrollment_invalid"
  | "person_inactive"
  | "unknown_credential"
  | "wrong_person"
  | "no_passkeys"
  | "already_registered"
  | "limit"
  | "code_refused"
  | "locked"
  | "session_ended"
  | "totp_unavailable"
  | "step_up_required"
  | "has_authenticators"
  | SignInFailure;

type SignInFailure = Extract<SignInResult, { ok: false }>["reason"];

export class PasskeyError extends Error {
  constructor(
    readonly reason: PasskeyFailure,
    /** Extra audit detail (never sent to the browser). */
    readonly detail: Record<string, unknown> = {},
    /** Structured detail the client acts on (step_up_required only). */
    readonly client: Record<string, unknown> | null = null,
  ) {
    super(`passkey: ${reason}`);
    this.name = "PasskeyError";
  }
}

type CeremonyKind = "register" | "signin" | "stepup" | "totp-enroll";

type Ceremony = {
  kind: CeremonyKind;
  source: string;
  createdAt: number;
  challenge: string;
  /** Who is enrolling or stepping up (null for usernameless sign-in). */
  personId: string | null;
  sessionId: string | null;
  enrollmentId: string | null;
  totpSecret: Buffer | null;
  attempts: number;
};

/**
 * Who may enrol: the signed-in person (their session, which needs a fresh authentication:
 * step-up `authenticatorChange`), or the holder of an identity admin's enrollment code (only
 * for a person with no authenticator yet).
 */
export type Enrollee = {
  personId?: string | null;
  sessionId?: string | null;
  enrollmentCode?: string | null;
};

/** Methods that prove the person holds one of their built-in authenticators right now. */
const AUTHENTICATOR_PROOF = ["otp", "hwk", "swk"];

export type PublicKeyCreationOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout: number;
  attestation: "none";
  authenticatorSelection: {
    residentKey: "required";
    requireResidentKey: true;
    userVerification: "required" | "preferred";
  };
  excludeCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
};

export type PublicKeyRequestOptions = {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "required" | "preferred";
  allowCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
};

export type PasskeySummary = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  synced: boolean;
  transports: string[];
};

export function summarizePasskey(c: PasskeyCredential): PasskeySummary {
  return {
    id: c.id,
    label: c.label,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    synced: c.backupEligible,
    transports: c.transports,
  };
}

function audit(
  action: string,
  outcome: "allowed" | "denied",
  detail: Record<string, unknown>,
  identity?: string,
) {
  recordAuditEvent({ action, outcome, source: "gateway.identity", identity, detail });
}

const person$ = (id: string | null | undefined) => (id ? `person:${id}` : undefined);

export class PasskeyService {
  private readonly ceremonies: PendingQuota<Ceremony>;
  private readonly totpFailures: AuthAttemptLimiter;
  private readonly totpSourceFailures: AuthAttemptLimiter;
  private readonly now: () => number;

  constructor(
    private readonly svc: IdentityService,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.ceremonies = new PendingQuota<Ceremony>(
      MAX_CEREMONIES,
      MAX_CEREMONIES_PER_SOURCE,
      CEREMONY_TTL_MS,
      this.now,
    );
    this.totpFailures = new AuthAttemptLimiter(
      TOTP_FAILURES_PER_WINDOW,
      TOTP_FAILURE_WINDOW_MS,
      this.now,
    );
    this.totpSourceFailures = new AuthAttemptLimiter(
      TOTP_FAILURES_PER_SOURCE,
      TOTP_FAILURE_WINDOW_MS,
      this.now,
    );
  }

  private get settings() {
    return this.svc.settings.passkeys;
  }

  private requireEnabled(): { rpId: string } {
    const s = this.settings;
    if (!s.enabled || !s.rpId) {
      throw new PasskeyError("disabled");
    }
    return { rpId: s.rpId };
  }

  private requireTotp(): void {
    this.requireEnabled();
    if (!this.settings.totp) {
      throw new PasskeyError("totp_disabled");
    }
  }

  private open(kind: CeremonyKind, source: string, patch: Partial<Ceremony> = {}) {
    const ceremonyId = randomBytes(32).toString("base64url");
    const ceremony: Ceremony = {
      kind,
      source,
      createdAt: this.now(),
      challenge: randomBytes(32).toString("base64url"),
      personId: null,
      sessionId: null,
      enrollmentId: null,
      totpSecret: null,
      attempts: 0,
      ...patch,
    };
    if (!this.ceremonies.add(ceremonyId, ceremony)) {
      throw new PasskeyError("too_many_pending");
    }
    return { ceremonyId, ceremony };
  }

  /** Take a ceremony out (one use, whatever the outcome); it must be of this kind and live. */
  private take(ceremonyId: unknown, kind: CeremonyKind): Ceremony {
    const c = typeof ceremonyId === "string" ? this.ceremonies.take(ceremonyId) : undefined;
    if (!c || c.kind !== kind || this.now() - c.createdAt > CEREMONY_TTL_MS) {
      throw new PasskeyError("ceremony_unknown");
    }
    return c;
  }

  private expected(c: Ceremony, rpId: string): ExpectedCeremony {
    return {
      challenge: c.challenge,
      origins: this.settings.origins,
      rpId,
      requireUserVerification: this.settings.userVerification === "required",
    };
  }

  private activePerson(personId: string) {
    const p = this.svc.store.getPerson(personId);
    if (!p || !p.active) {
      throw new PasskeyError("person_inactive", { person: person$(personId) });
    }
    return p;
  }

  /** The person already holds a passkey or an authenticator app. */
  private hasAuthenticators(personId: string): boolean {
    return (
      this.svc.authenticators.listPasskeys(personId).length > 0 ||
      this.svc.authenticators.hasTotp(personId)
    );
  }

  /**
   * A signed-in change of authenticators: the session must be live and freshly authenticated
   * (step-up `authenticatorChange`); `methods` adds a proof one of the person's own built-in
   * authenticators must have given (replacing an authenticator app). Refusals are audited.
   */
  private requireFreshSession(
    personId: string,
    sessionId: string | null | undefined,
    change: "passkey" | "totp",
    methods: string[] = [],
  ): string {
    const live = sessionId ? this.svc.sessions.verifyId(sessionId) : null;
    if (!live?.ok || live.session.personId !== personId) {
      throw new PasskeyError("session_ended", { person: person$(personId) });
    }
    const auth = live.session.auth ?? null;
    const r = checkStepUp({
      settings: this.svc.settings.stepUp,
      auth,
      action: "authenticatorChange",
      context: { methods },
      now: this.now(),
      skewSec: this.svc.settings.clockSkewSec,
    });
    if (!r.ok) {
      const refusal = stepUpRefusal(r, auth);
      throw new PasskeyError(
        "step_up_required",
        { person: person$(personId), session: sessionId, change, why: r.why },
        { message: refusal.message, ...refusal.details },
      );
    }
    return live.session.id;
  }

  /** Resolve who is enrolling; refuses unknown, used, revoked or expired codes alike. */
  private enrollee(
    who: Enrollee,
    change: "passkey" | "totp",
  ): { personId: string; enrollmentId: string | null; sessionId: string | null } {
    if (who.personId) {
      this.activePerson(who.personId);
      // Replacing an authenticator app takes a fresh code from it, or a passkey: the IdP alone
      // (or a stolen session that re-authenticated there) does not replace the second factor.
      const replacing = change === "totp" && this.svc.authenticators.hasTotp(who.personId);
      const sessionId = this.requireFreshSession(
        who.personId,
        who.sessionId,
        change,
        replacing ? AUTHENTICATOR_PROOF : [],
      );
      return { personId: who.personId, enrollmentId: null, sessionId };
    }
    const code = typeof who.enrollmentCode === "string" ? who.enrollmentCode.trim() : "";
    if (!code) {
      throw new PasskeyError("not_signed_in");
    }
    const e = this.svc.authenticators.findEnrollmentByCode(code);
    const state = e ? this.svc.authenticators.stateOf(e) : "unknown";
    if (!e || state !== "pending") {
      throw new PasskeyError("enrollment_invalid", { enrollment: e?.id ?? null, state });
    }
    this.activePerson(e.personId);
    // An admin's code only sets up a person's first authenticator; later ones are added by the
    // person while signed in (with a step-up), never by whoever holds an admin's code.
    if (this.hasAuthenticators(e.personId)) {
      throw new PasskeyError("has_authenticators", { enrollment: e.id });
    }
    return { personId: e.personId, enrollmentId: e.id, sessionId: null };
  }

  /** At finish: the code must still be pending (an admin may have revoked it meanwhile). */
  private recheckEnrollee(c: Ceremony): string {
    const personId = c.personId ?? "";
    this.activePerson(personId);
    if (c.enrollmentId) {
      const e = this.svc.authenticators.getEnrollment(c.enrollmentId);
      const state = e ? this.svc.authenticators.stateOf(e) : "unknown";
      if (!e || state !== "pending" || e.personId !== personId) {
        throw new PasskeyError("enrollment_invalid", { enrollment: c.enrollmentId, state });
      }
      if (this.hasAuthenticators(personId)) {
        throw new PasskeyError("has_authenticators", { enrollment: c.enrollmentId });
      }
    } else {
      // A signed-in change: the session that started it must still be live.
      const live = c.sessionId ? this.svc.sessions.verifyId(c.sessionId) : null;
      if (!live?.ok || live.session.personId !== personId) {
        throw new PasskeyError("session_ended", { session: c.sessionId });
      }
    }
    return personId;
  }

  // ── registration ───────────────────────────────────────────────────────────────────────

  beginRegistration(input: Enrollee & { source: string }): {
    ceremonyId: string;
    publicKey: PublicKeyCreationOptions;
  } {
    const { rpId } = this.requireEnabled();
    const { personId, enrollmentId, sessionId } = this.enrollee(input, "passkey");
    const person = this.activePerson(personId);
    const { ceremonyId, ceremony } = this.open("register", input.source, {
      personId,
      enrollmentId,
      sessionId,
    });
    return {
      ceremonyId,
      publicKey: {
        challenge: ceremony.challenge,
        rp: { id: rpId, name: this.settings.rpName },
        user: {
          id: this.svc.authenticators.userHandle(personId),
          name: person.userName,
          displayName: person.displayName ?? person.email ?? person.userName,
        },
        pubKeyCredParams: SUPPORTED_COSE_ALGS.map((alg) => ({ type: "public-key", alg })),
        timeout: CEREMONY_TTL_MS,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: this.settings.userVerification,
        },
        // An authenticator that already holds one of this person's passkeys says so.
        excludeCredentials: this.svc.authenticators.listPasskeys(personId).map((c) => ({
          type: "public-key" as const,
          id: c.id,
          ...(c.transports.length ? { transports: c.transports } : {}),
        })),
      },
    };
  }

  finishRegistration(input: {
    ceremonyId: unknown;
    credential: unknown;
    label?: unknown;
  }): PasskeySummary {
    const { rpId } = this.requireEnabled();
    let c: Ceremony | null = null;
    try {
      c = this.take(input.ceremonyId, "register");
      const personId = this.recheckEnrollee(c);
      const v = verifyRegistration(input.credential, this.expected(c, rpId));
      if (this.svc.authenticators.getPasskey(v.credentialId)) {
        throw new PasskeyError("already_registered");
      }
      if (c.enrollmentId && !this.svc.authenticators.consumeEnrollment(c.enrollmentId, "passkey")) {
        throw new PasskeyError("enrollment_invalid", { enrollment: c.enrollmentId });
      }
      const label = typeof input.label === "string" ? input.label : "";
      const cred = this.svc.authenticators.addPasskey({
        id: v.credentialId,
        personId,
        publicKey: v.publicKey,
        alg: v.alg,
        signCount: v.signCount,
        transports: v.transports,
        backupEligible: v.backupEligible,
        backedUp: v.backedUp,
        aaguid: v.aaguid,
        label: label || (v.backupEligible ? "Synced passkey" : "Security key or device"),
        enrolledVia: c.enrollmentId ? "admin" : "self",
      });
      audit(
        "identity.passkey.register",
        "allowed",
        {
          person: person$(personId),
          credential: cred.id.slice(0, 16),
          via: c.enrollmentId ? `enrollment:${c.enrollmentId}` : "session",
          session: c.sessionId,
          alg: v.alg,
          synced: v.backupEligible,
          userVerified: v.userVerified,
          attestation: v.attestationFormat,
        },
        person$(personId),
      );
      this.notice(personId, "passkey_added", c);
      return summarizePasskey(cred);
    } catch (err) {
      throw this.fail("identity.passkey.register", err, c);
    }
  }

  // ── sign-in ────────────────────────────────────────────────────────────────────────────

  /** Usernameless sign-in: no credential list, the authenticator offers its passkeys. */
  beginSignIn(input: { source: string }): {
    ceremonyId: string;
    publicKey: PublicKeyRequestOptions;
  } {
    const { rpId } = this.requireEnabled();
    const { ceremonyId, ceremony } = this.open("signin", input.source);
    return {
      ceremonyId,
      publicKey: {
        challenge: ceremony.challenge,
        rpId,
        timeout: CEREMONY_TTL_MS,
        userVerification: this.settings.userVerification,
        allowCredentials: [],
      },
    };
  }

  /** Verify an assertion against the stored passkey it names; returns it and the auth record. */
  private assertWith(
    c: Ceremony,
    credential: unknown,
    rpId: string,
  ): { cred: PasskeyCredential; auth: SignInAuth } {
    const cred = this.svc.authenticators.getPasskey(assertionCredentialId(credential));
    if (!cred || !this.svc.store.getPerson(cred.personId)) {
      throw new PasskeyError("unknown_credential");
    }
    const handle = this.svc.authenticators.peekUserHandle(cred.personId) ?? "";
    let v;
    try {
      v = verifyAssertion(credential, this.expected(c, rpId), {
        credentialId: cred.id,
        publicKey: cred.publicKey,
        alg: cred.alg,
        signCount: cred.signCount,
        userHandle: handle,
      });
    } catch (err) {
      if (err instanceof WebAuthnError) {
        throw new PasskeyError(err.reason, {
          person: person$(cred.personId),
          credential: cred.id.slice(0, 16),
        });
      }
      throw err;
    }
    this.svc.authenticators.recordPasskeyUse(cred.id, v.signCount);
    return {
      cred,
      auth: { at: new Date(this.now()).toISOString(), methods: passkeyAmr(v), context: null },
    };
  }

  finishSignIn(input: {
    ceremonyId: unknown;
    credential: unknown;
  }): Extract<SignInResult, { ok: true }> & { auth: SignInAuth } {
    const { rpId } = this.requireEnabled();
    let c: Ceremony | null = null;
    try {
      c = this.take(input.ceremonyId, "signin");
      const { cred, auth } = this.assertWith(c, input.credential, rpId);
      const signed = this.svc.signInPerson(cred.personId, auth);
      if (!signed.ok) {
        throw new PasskeyError(signed.reason, { person: person$(cred.personId) });
      }
      audit(
        "identity.passkey.login",
        "allowed",
        {
          provider: "passkey",
          methods: auth.methods,
          credential: cred.id.slice(0, 16),
          // "admin": the passkey was set up with an identity admin's enrollment code.
          credentialSource: cred.enrolledVia ?? "self",
          session: signed.principal.sessionId,
        },
        signed.principal.principal,
      );
      return { ...signed, auth };
    } catch (err) {
      throw this.fail("identity.passkey.login", err, c);
    }
  }

  // ── step-up ────────────────────────────────────────────────────────────────────────────

  beginStepUp(input: { source: string; sessionId: string }): {
    ceremonyId: string;
    publicKey: PublicKeyRequestOptions;
  } {
    const { rpId } = this.requireEnabled();
    const session = this.svc.sessions.verifyId(input.sessionId);
    if (!session.ok) {
      throw new PasskeyError("session_ended");
    }
    const personId = session.session.personId;
    const creds = this.svc.authenticators.listPasskeys(personId);
    if (creds.length === 0) {
      throw new PasskeyError("no_passkeys");
    }
    const { ceremonyId, ceremony } = this.open("stepup", input.source, {
      personId,
      sessionId: input.sessionId,
    });
    return {
      ceremonyId,
      publicKey: {
        challenge: ceremony.challenge,
        rpId,
        timeout: CEREMONY_TTL_MS,
        userVerification: this.settings.userVerification,
        allowCredentials: creds.map((x) => ({
          type: "public-key" as const,
          id: x.id,
          ...(x.transports.length ? { transports: x.transports } : {}),
        })),
      },
    };
  }

  finishStepUp(input: { ceremonyId: unknown; sessionId: string; credential: unknown }): SignInAuth {
    const { rpId } = this.requireEnabled();
    let c: Ceremony | null = null;
    try {
      c = this.take(input.ceremonyId, "stepup");
      const session = this.svc.sessions.verifyId(input.sessionId);
      if (!session.ok || c.sessionId !== input.sessionId) {
        throw new PasskeyError("session_ended");
      }
      const personId = session.session.personId;
      this.activePerson(personId);
      const cred = this.svc.authenticators.getPasskey(assertionCredentialId(input.credential));
      // Only one of the session's own person's passkeys steps that session up.
      if (cred && cred.personId !== personId) {
        throw new PasskeyError("wrong_person", { credentialOf: person$(cred.personId) });
      }
      const { auth } = this.assertWith(c, input.credential, rpId);
      if (!this.svc.sessions.refreshAuth(input.sessionId, auth)) {
        throw new PasskeyError("session_ended");
      }
      audit(
        "identity.passkey.stepup",
        "allowed",
        { session: input.sessionId, methods: auth.methods },
        person$(personId),
      );
      return auth;
    } catch (err) {
      throw this.fail("identity.passkey.stepup", err, c);
    }
  }

  // ── one-time codes (TOTP) ──────────────────────────────────────────────────────────────

  beginTotpEnrollment(input: Enrollee & { source: string }): {
    ceremonyId: string;
    secret: string;
    otpauthUri: string;
  } {
    this.requireTotp();
    const { personId, enrollmentId, sessionId } = this.enrollee(input, "totp");
    const person = this.activePerson(personId);
    const secret = newTotpSecret();
    const { ceremonyId } = this.open("totp-enroll", input.source, {
      personId,
      enrollmentId,
      sessionId,
      totpSecret: secret,
    });
    return {
      ceremonyId,
      secret: base32Encode(secret),
      otpauthUri: otpauthUri({
        secret,
        issuer: this.settings.rpName,
        account: person.email ?? person.userName,
      }),
    };
  }

  /** Confirm the app with a first code; a few wrong codes are allowed before it starts over. */
  finishTotpEnrollment(input: { ceremonyId: unknown; code: unknown; label?: unknown }): {
    label: string;
  } {
    this.requireTotp();
    const id = typeof input.ceremonyId === "string" ? input.ceremonyId : "";
    const c = id ? this.ceremonies.get(id) : undefined;
    try {
      if (!c || c.kind !== "totp-enroll" || this.now() - c.createdAt > CEREMONY_TTL_MS) {
        throw new PasskeyError("ceremony_unknown");
      }
      const personId = this.recheckEnrollee(c);
      const code = typeof input.code === "string" ? input.code.trim() : "";
      const step = c.totpSecret ? verifyTotp(c.totpSecret, code, this.now() / 1000, null) : null;
      if (step === null) {
        c.attempts += 1;
        if (c.attempts >= TOTP_ENROLL_ATTEMPTS) {
          this.ceremonies.take(id);
        }
        throw new PasskeyError("code_refused", { attempts: c.attempts });
      }
      this.ceremonies.take(id);
      if (c.enrollmentId && !this.svc.authenticators.consumeEnrollment(c.enrollmentId, "totp")) {
        throw new PasskeyError("enrollment_invalid", { enrollment: c.enrollmentId });
      }
      const label = typeof input.label === "string" && input.label.trim() ? input.label : "";
      const replaced = this.svc.authenticators.hasTotp(personId);
      try {
        this.svc.authenticators.setTotp(
          personId,
          c.totpSecret as Buffer,
          label,
          c.enrollmentId ? "admin" : "self",
        );
      } catch (err) {
        throw new PasskeyError("totp_unavailable", {
          error: err instanceof Error ? err.message.slice(0, 200) : "error",
        });
      }
      // The confirming code is spent: it cannot also sign in.
      this.svc.authenticators.recordTotpUse(personId, step);
      audit(
        "identity.totp.register",
        "allowed",
        {
          person: person$(personId),
          via: c.enrollmentId ? `enrollment:${c.enrollmentId}` : "session",
          session: c.sessionId,
          replaced,
        },
        person$(personId),
      );
      this.notice(personId, replaced ? "totp_replaced" : "totp_enrolled", c);
      return { label: this.svc.authenticators.totpInfo(personId)?.label ?? label };
    } catch (err) {
      throw this.fail("identity.totp.register", err, c ?? null);
    }
  }

  /**
   * Check a one-time code for a person. Wrong codes count per person (and per typed name, so
   * unknown names behave the same); after TOTP_FAILURES_PER_WINDOW the name pauses. They also
   * count per source address (TOTP_FAILURES_PER_SOURCE), so one address cannot spray many
   * names. Only one-time codes pause: passkey sign-in and step-up are never locked by this.
   */
  private checkCode(
    personId: string | null,
    nameKey: string,
    code: unknown,
    source: string,
  ): SignInAuth {
    const keys = [`name:${nameKey}`, ...(personId ? [`person:${personId}`] : [])];
    const sourceKey = `ip:${source}`;
    if (
      keys.some((k) => !this.totpFailures.check(k).allowed) ||
      !this.totpSourceFailures.check(sourceKey).allowed
    ) {
      throw new PasskeyError("locked", { person: person$(personId) });
    }
    let stored: ReturnType<IdentityService["authenticators"]["readTotp"]> = null;
    try {
      stored = personId ? this.svc.authenticators.readTotp(personId) : null;
    } catch (err) {
      throw new PasskeyError("totp_unavailable", {
        error: err instanceof Error ? err.message.slice(0, 200) : "error",
      });
    }
    const text = typeof code === "string" ? code.trim() : "";
    const step = stored
      ? verifyTotp(stored.secret, text, this.now() / 1000, stored.lastStep)
      : null;
    if (step === null || !personId) {
      for (const k of keys) {
        this.totpFailures.record(k);
      }
      this.totpSourceFailures.record(sourceKey);
      throw new PasskeyError("code_refused", { person: person$(personId) });
    }
    this.svc.authenticators.recordTotpUse(personId, step);
    return { at: new Date(this.now()).toISOString(), methods: ["otp"], context: null };
  }

  /** Sign in with a user name (or e-mail) and a one-time code. */
  signInWithTotp(input: {
    userName: unknown;
    code: unknown;
    /** Client address (or "local"): per-source cap on wrong codes. */
    source?: string;
  }): Extract<SignInResult, { ok: true }> & { auth: SignInAuth } {
    this.requireTotp();
    try {
      const name = typeof input.userName === "string" ? input.userName.trim().slice(0, 256) : "";
      const person = name
        ? (this.svc.store.findByUserName(name) ?? this.svc.store.findByEmail(name))
        : null;
      const auth = this.checkCode(
        person?.id ?? null,
        name.toLowerCase(),
        input.code,
        input.source ?? "local",
      );
      const signed = this.svc.signInPerson(person?.id ?? "", auth);
      if (!signed.ok) {
        throw new PasskeyError(signed.reason, { person: person$(person?.id) });
      }
      audit(
        "identity.totp.login",
        "allowed",
        {
          provider: "passkey",
          methods: auth.methods,
          credentialSource:
            this.svc.authenticators.totpInfo(signed.principal.personId)?.enrolledVia ?? "self",
          session: signed.principal.sessionId,
        },
        signed.principal.principal,
      );
      return { ...signed, auth };
    } catch (err) {
      throw this.fail("identity.totp.login", err, null);
    }
  }

  /** Step up a session with a one-time code of the session's own person. */
  stepUpWithTotp(input: { sessionId: string; code: unknown; source?: string }): SignInAuth {
    this.requireTotp();
    try {
      const session = this.svc.sessions.verifyId(input.sessionId);
      if (!session.ok) {
        throw new PasskeyError("session_ended");
      }
      const personId = session.session.personId;
      this.activePerson(personId);
      const auth = this.checkCode(
        personId,
        `session:${input.sessionId}`,
        input.code,
        input.source ?? "local",
      );
      if (!this.svc.sessions.refreshAuth(input.sessionId, auth)) {
        throw new PasskeyError("session_ended");
      }
      audit(
        "identity.totp.stepup",
        "allowed",
        { session: input.sessionId, methods: auth.methods },
        person$(personId),
      );
      return auth;
    } catch (err) {
      throw this.fail("identity.totp.stepup", err, null);
    }
  }

  // ── administration ─────────────────────────────────────────────────────────────────────

  /** Issue a one-time enrollment code for a person (identity admins; audited by the caller). */
  issueEnrollment(personId: string, by: string, ttlMs = DEFAULT_ENROLLMENT_TTL_MS) {
    this.requireEnabled();
    this.activePerson(personId);
    if (this.hasAuthenticators(personId)) {
      throw new PasskeyError("has_authenticators", { person: person$(personId) });
    }
    const ttl = Math.min(Math.max(ttlMs, 60_000), MAX_ENROLLMENT_TTL_MS);
    return this.svc.authenticators.issueEnrollment(personId, by, ttl);
  }

  /**
   * Tell the person (and security admins) that an authenticator changed. Identity has no
   * person-facing notification channel yet: the notice is this audit entry, which a SIEM can
   * forward; it names the session that made the change.
   */
  private notice(personId: string, event: string, c: Ceremony): void {
    audit(
      "identity.authenticators.notice",
      "allowed",
      {
        notify: ["person", "security-admin"],
        event,
        session: c.sessionId,
        via: c.enrollmentId ? `enrollment:${c.enrollmentId}` : "session",
      },
      person$(personId),
    );
  }

  /** Audit a refusal and turn it into a PasskeyError. */
  private fail(action: string, err: unknown, c: Ceremony | null): PasskeyError {
    const e =
      err instanceof PasskeyError
        ? err
        : err instanceof WebAuthnError
          ? new PasskeyError(err.reason)
          : err instanceof IdentityError && (err.code === "conflict" || err.code === "limit")
            ? new PasskeyError(err.code === "conflict" ? "already_registered" : "limit", {
                error: err.message,
              })
            : null;
    if (!e) {
      throw err;
    }
    audit(action, "denied", {
      reason: e.reason,
      ceremony: c?.kind ?? null,
      ...(c?.personId ? { person: person$(c.personId) } : {}),
      ...e.detail,
    });
    return e;
  }
}

export type PasskeyStepUpResult =
  | { ok: true; auth: SignInAuth }
  | { ok: false; reason: PasskeyFailure };

/**
 * Step-up with a passkey: verify `credential` (PublicKeyCredential.toJSON() of an assertion
 * answering the step-up ceremony `ceremonyId`, begun for this session) against one of the
 * session's own person's passkeys, then record it on the session with
 * `SessionStore.refreshAuth` (methods `hwk` / `swk`, plus `user` when verified). Refusals are
 * audited; the ceremony is spent either way.
 */
export function stepUpWithPasskey(
  svc: IdentityService,
  input: { sessionId: string; ceremonyId: string; credential: unknown },
): PasskeyStepUpResult {
  try {
    return { ok: true, auth: svc.passkeys.finishStepUp(input) };
  } catch (err) {
    if (err instanceof PasskeyError) {
      return { ok: false, reason: err.reason };
    }
    throw err;
  }
}
