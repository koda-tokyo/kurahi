// Step-up for decisions: "every important approval is signed by a fresh authentication".
//
// `checkStepUp` is the one policy: given the person's last authentication (session.auth), the
// action and its context, it says whether the action may go ahead now or needs a fresh
// authentication first. Covered actions (gateway.identity.stepUp.actions):
//
//   approval              workitems.decide approve (all, or at/above `amountAtLeast`)
//   autopilotLevel        autopilot.autonomy.accept of a promotion
//   emergencyStopRelease  autopilot.startAll, policy.release
//   identityAdmin         identity.* administrative changes (not session revocation)
//   authenticatorChange   adding a passkey, enrolling or replacing an authenticator app
//   governance            governance holds release, exports, DSR execution, retention runs,
//                         policy changes
//
// Only SSO person sessions are checked. Break-glass, local persons and other non-person paths
// are not persons and are unchanged. A session saved before 2.5 (no `auth`) always needs a
// step-up for a covered action. A step-up is a re-authentication at the session's IdP (OIDC
// `max_age=0` + `prompt=login`, SAML `ForceAuthn`), or a passkey assertion: both only update
// `session.auth` (SessionStore.refreshAuth), never open a new session.
//
// `stepUpGate` applies it to a gateway caller, audits refusals and returns the evidence block
// ({ authAt, methods, context, protocol, stepUp }) the decision records. Never tokens.
import type { StepUpSettings } from "./config.js";
import type { PersonPrincipal, SignInAuth, SignInProtocol } from "./types.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { getIdentityService, type IdentityService } from "./service.js";

export type StepUpAction =
  | "approval"
  | "autopilotLevel"
  | "emergencyStopRelease"
  | "identityAdmin"
  | "authenticatorChange"
  | "governance";

/** Where the console starts a step-up (POST, Bearer session token). */
export const STEP_UP_PATH = "/api/identity/sso/step-up";

export type StepUpContext = {
  /** approval: the item's amount; null when it has none, NaN when it is not a number. */
  amount?: number | null;
  /** approval: covered whatever amountAtLeast says (clearing a fraud flag, for example). */
  always?: boolean;
  /**
   * On top of the configured requireMethods: the authentication must also carry one of these
   * (replacing an authenticator app needs a fresh one-time code or passkey, not only the IdP).
   */
  methods?: string[];
};

export type StepUpRequired = {
  ok: false;
  reason: "step_up_required";
  action: StepUpAction;
  /** no_auth: the session has no recorded authentication; stale: older than maxAgeSeconds;
   *  method: none of requireMethods. */
  why: "no_auth" | "stale" | "method";
  maxAgeSeconds: number;
  requireMethods: string[];
};

export type StepUpResult = { ok: true; covered: boolean } | StepUpRequired;

/** Whether the policy covers this action (with this context) at all. */
export function stepUpCovers(
  settings: StepUpSettings,
  action: StepUpAction,
  ctx: StepUpContext = {},
): boolean {
  if (!settings.enabled) {
    return false;
  }
  switch (action) {
    case "approval": {
      if (!settings.approvals.enabled) {
        return false;
      }
      const min = settings.approvals.amountAtLeast;
      if (min === null || ctx.always) {
        return true;
      }
      const amount = ctx.amount ?? null;
      // No amount: below any threshold. An amount that is not a number: covered (fail closed).
      return amount !== null && (Number.isNaN(amount) || amount >= min);
    }
    case "autopilotLevel":
      return settings.autopilotLevel;
    case "emergencyStopRelease":
      return settings.emergencyStopRelease;
    case "identityAdmin":
      return settings.identityAdmin;
    case "authenticatorChange":
      return settings.authenticatorChange;
    case "governance":
      return settings.governance;
  }
  return true;
}

/** Pure: may a person whose last authentication is `auth` take `action` at `now` (ms)? */
export function checkStepUp(input: {
  settings: StepUpSettings;
  auth: SignInAuth | null | undefined;
  action: StepUpAction;
  context?: StepUpContext;
  now: number;
  /** Allowed clock skew for an authentication time slightly in the future (seconds). */
  skewSec?: number;
}): StepUpResult {
  const { settings, auth, action } = input;
  if (!stepUpCovers(settings, action, input.context)) {
    return { ok: true, covered: false };
  }
  const required = (why: StepUpRequired["why"]): StepUpRequired => ({
    ok: false,
    reason: "step_up_required",
    action,
    why,
    maxAgeSeconds: settings.maxAgeSec,
    requireMethods: [...settings.requireMethods],
  });
  const at = auth ? Date.parse(auth.at) : NaN;
  if (!auth || !Number.isFinite(at)) {
    return required("no_auth");
  }
  const skewMs = Math.max(0, input.skewSec ?? 0) * 1000;
  // An authentication "from the future" beyond the skew is not trusted as fresh.
  if (at > input.now + skewMs || input.now - at > settings.maxAgeSec * 1000) {
    return required("stale");
  }
  if (
    settings.requireMethods.length > 0 &&
    !settings.requireMethods.some((m) => auth.methods.includes(m))
  ) {
    return required("method");
  }
  const extra = input.context?.methods ?? [];
  if (extra.length > 0 && !extra.some((m) => auth.methods.includes(m))) {
    return { ...required("method"), requireMethods: [...extra] };
  }
  return { ok: true, covered: true };
}

/** What a decision records about how its person authenticated. Never tokens. */
export type AuthnEvidence = {
  authAt: string | null;
  methods: string[];
  context: string | null;
  protocol: SignInProtocol | null;
  /** The decision was covered by step-up and the authentication was fresh enough. */
  stepUp: boolean;
};

export function authnEvidence(
  auth: SignInAuth | null | undefined,
  protocol: SignInProtocol | null,
  stepUp: boolean,
): AuthnEvidence {
  return {
    authAt: auth?.at ?? null,
    methods: auth ? [...auth.methods] : [],
    context: auth?.context ?? null,
    protocol,
    stepUp,
  };
}

/** How a person caller authenticated, for a decision step-up does not cover (stepUp: false). */
export function personAuthn(
  person: PersonPrincipal | null | undefined,
  svc: IdentityService = getIdentityService(),
): AuthnEvidence | null {
  if (!person) {
    return null;
  }
  const session = svc.sessions.get(person.sessionId);
  return authnEvidence(
    session ? (session.auth ?? null) : person.auth,
    session?.protocol ?? null,
    false,
  );
}

/** The structured refusal clients act on (`error.details` of the gateway method). */
export function stepUpRefusal(r: StepUpRequired, auth: SignInAuth | null | undefined) {
  return {
    message:
      r.why === "method"
        ? `this decision needs a fresh sign-in with ${r.requireMethods.join(" or ")} (step-up)`
        : `this decision needs a fresh sign-in within ${r.maxAgeSeconds} seconds (step-up)`,
    details: {
      code: "step_up_required" as const,
      action: r.action,
      why: r.why,
      maxAgeSeconds: r.maxAgeSeconds,
      requireMethods: r.requireMethods,
      authAt: auth?.at ?? null,
      stepUpPath: STEP_UP_PATH,
    },
  };
}

export type StepUpGateResult =
  | { ok: true; evidence: AuthnEvidence | null }
  | {
      ok: false;
      required: StepUpRequired;
      message: string;
      details: ReturnType<typeof stepUpRefusal>["details"];
    };

/**
 * Step-up for a gateway caller. Not a person (break-glass, local persons, agents): allowed with
 * no evidence block, as before. A person: the policy decides; a refusal is audited.
 */
export function stepUpGate(
  person: PersonPrincipal | null | undefined,
  action: StepUpAction,
  context: StepUpContext = {},
  opts: { service?: IdentityService; now?: number; method?: string } = {},
): StepUpGateResult {
  if (!person) {
    return { ok: true, evidence: null };
  }
  const svc = opts.service ?? getIdentityService();
  // The session as it is now, not the principal the connection resolved earlier: a step-up
  // (IdP, passkey or one-time code) that just landed counts for the very next request.
  const session = svc.sessions.get(person.sessionId);
  const protocol = session?.protocol ?? null;
  const auth = session ? (session.auth ?? null) : person.auth;
  const result = checkStepUp({
    settings: svc.settings.stepUp,
    auth,
    action,
    context,
    now: opts.now ?? Date.now(),
    skewSec: svc.settings.clockSkewSec,
  });
  if (result.ok) {
    return { ok: true, evidence: authnEvidence(auth, protocol, result.covered) };
  }
  recordAuditEvent({
    action: "identity.stepup.required",
    outcome: "denied",
    source: "gateway.identity",
    identity: person.principal,
    detail: {
      method: opts.method ?? null,
      action,
      why: result.why,
      session: person.sessionId,
      authAt: auth?.at ?? null,
    },
  });
  const refusal = stepUpRefusal(result, auth);
  return { ok: false, required: result, ...refusal };
}
