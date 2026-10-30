// HTTP side of the built-in sign-in (provider `passkey`): WebAuthn registration, usernameless
// sign-in and step-up, and one-time codes (TOTP). See passkeys.ts for the rules.
//
// Every endpoint is a JSON POST from the console's own page (fetch, never a form or a
// redirect): a request with another Content-Type, or an Origin header that is not one of the
// passkey origins, is refused, so another site cannot drive a ceremony through the browser. A
// sign-in answers with the session token directly in the JSON body (the page that ran the
// ceremony is the one that receives it); there is no redirect and no code in the URL. Starts are
// rate-limited per source and gateway-wide like SSO sign-in starts, and refusals count towards
// the failed-attempt limiter.
import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthAttemptLimiter, authAttemptLimiter } from "../gateway/rate-limiter.js";
import {
  bearer,
  getHttpPerson,
  json,
  LOGIN_STARTS_GLOBAL_PER_MINUTE,
  LOGIN_STARTS_PER_MINUTE,
  readBody,
  type SsoHttpDeps,
} from "./http.js";
import { PasskeyError, type PasskeyFailure, summarizePasskey } from "./passkeys.js";
import { getIdentityService } from "./service.js";
import { isSsoSessionToken } from "./sessions.js";

const MAX_BODY_BYTES = 64 * 1024;

const STATUS: Partial<Record<PasskeyFailure, number>> = {
  disabled: 404,
  totp_disabled: 404,
  not_signed_in: 401,
  session_ended: 401,
  too_many_pending: 429,
  locked: 429,
  totp_unavailable: 503,
  step_up_required: 403,
  has_authenticators: 409,
};

function refuse(
  res: ServerResponse,
  reason: string,
  status = 400,
  details: Record<string, unknown> | null = null,
) {
  json(res, status, {
    error: { message: "passkey request refused", type: reason, ...(details ? { details } : {}) },
  });
}

export function createPasskeyHttpHandlers(deps: SsoHttpDeps) {
  const svc = () => (deps.service ?? getIdentityService)();
  const starts = deps.loginStartLimiter ?? new AuthAttemptLimiter(LOGIN_STARTS_PER_MINUTE, 60_000);
  const allStarts =
    deps.globalLoginStartLimiter ?? new AuthAttemptLimiter(LOGIN_STARTS_GLOBAL_PER_MINUTE, 60_000);

  /** Shared checks; returns the parsed body, or null after answering. */
  const accept = async (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { start?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    const key = deps.attemptKey(req);
    if (key && !authAttemptLimiter.check(key).allowed) {
      refuse(res, "rate_limited", 429);
      return null;
    }
    const s = svc().settings.passkeys;
    if (!s.enabled) {
      refuse(res, "disabled", 404);
      return null;
    }
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!type.startsWith("application/json")) {
      refuse(res, "content_type", 415);
      return null;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && !s.origins.includes(origin)) {
      refuse(res, "origin_mismatch", 403);
      return null;
    }
    if (opts.start) {
      // Every start holds a ceremony: per source first, then the gateway-wide budget.
      const perSource = starts.consume(key ?? "local");
      const start = perSource.allowed ? allStarts.consume("*") : perSource;
      if (!start.allowed) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(start.retryAfterMs / 1000))));
        refuse(res, "rate_limited", 429);
        return null;
      }
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      refuse(res, "too_large", 413);
      return null;
    }
    try {
      const body = raw ? (JSON.parse(raw) as unknown) : {};
      if (body && typeof body === "object" && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    refuse(res, "malformed");
    return null;
  };

  /** A Bearer SSO session on a route that also works without one: the person, or "invalid". */
  const optionalPerson = (
    req: IncomingMessage,
  ): { personId: string; sessionId: string } | null | "invalid" => {
    const token = bearer(req);
    if (token === undefined) {
      return null;
    }
    if (!isSsoSessionToken(token)) {
      return "invalid";
    }
    const verified = svc().verifyToken(token, { touch: true });
    return verified.ok
      ? { personId: verified.principal.personId, sessionId: verified.principal.sessionId }
      : "invalid";
  };

  const run = (req: IncomingMessage, res: ServerResponse, fn: () => unknown) => {
    try {
      json(res, 200, fn());
    } catch (err) {
      if (!(err instanceof PasskeyError)) {
        throw err;
      }
      const status = STATUS[err.reason] ?? 400;
      if (status === 400 || status === 401) {
        const key = deps.attemptKey(req);
        if (key) {
          authAttemptLimiter.record(key);
        }
      }
      refuse(res, err.reason, status, err.client);
    }
  };

  const source = (req: IncomingMessage) => deps.attemptKey(req) ?? "local";

  /**
   * Registration and TOTP enrollment: an enrollment code, or the signed-in person's session
   * (which then needs a fresh authentication: step-up `authenticatorChange`).
   */
  const enrollee = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => {
    const who = optionalPerson(req);
    if (who === "invalid") {
      refuse(res, "not_signed_in", 401);
      return null;
    }
    return (
      who ?? {
        enrollmentCode: typeof body.enrollmentCode === "string" ? body.enrollmentCode : null,
      }
    );
  };

  const signedIn = (out: {
    token: string;
    principal: { principal: string; sessionId: string; expiresAt: string };
    auth: { methods: string[] };
  }) => ({
    token: out.token,
    principal: out.principal.principal,
    session: { id: out.principal.sessionId, expiresAt: out.principal.expiresAt },
    methods: out.auth.methods,
  });

  return {
    beginPasskeyRegistration: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res, { start: true });
      const who = body && enrollee(req, res, body);
      if (who) {
        run(req, res, () => svc().passkeys.beginRegistration({ ...who, source: source(req) }));
      }
    },

    finishPasskeyRegistration: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res);
      if (body) {
        run(req, res, () => ({
          ok: true,
          passkey: svc().passkeys.finishRegistration({
            ceremonyId: body.ceremonyId,
            credential: body.credential,
            label: body.label,
          }),
        }));
      }
    },

    beginPasskeyLogin: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res, { start: true });
      if (body) {
        run(req, res, () => svc().passkeys.beginSignIn({ source: source(req) }));
      }
    },

    finishPasskeyLogin: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res);
      if (body) {
        run(req, res, () =>
          signedIn(
            svc().passkeys.finishSignIn({
              ceremonyId: body.ceremonyId,
              credential: body.credential,
            }),
          ),
        );
      }
    },

    beginPasskeyStepUp: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      const body = p ? await accept(req, res, { start: true }) : null;
      if (!p) {
        refuse(res, "not_signed_in", 401);
      } else if (body) {
        run(req, res, () =>
          svc().passkeys.beginStepUp({ source: source(req), sessionId: p.sessionId }),
        );
      }
    },

    finishPasskeyStepUp: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      const body = p ? await accept(req, res) : null;
      if (!p) {
        refuse(res, "not_signed_in", 401);
      } else if (body) {
        run(req, res, () => ({
          ok: true,
          auth: svc().passkeys.finishStepUp({
            ceremonyId: body.ceremonyId,
            sessionId: p.sessionId,
            credential: body.credential,
          }),
        }));
      }
    },

    beginTotpEnrollment: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res, { start: true });
      const who = body && enrollee(req, res, body);
      if (who) {
        run(req, res, () => svc().passkeys.beginTotpEnrollment({ ...who, source: source(req) }));
      }
    },

    finishTotpEnrollment: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res);
      if (body) {
        run(req, res, () => ({
          ok: true,
          ...svc().passkeys.finishTotpEnrollment({
            ceremonyId: body.ceremonyId,
            code: body.code,
            label: body.label,
          }),
        }));
      }
    },

    verifyTotp: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await accept(req, res, { start: true });
      if (body) {
        run(req, res, () =>
          signedIn(
            svc().passkeys.signInWithTotp({
              userName: body.userName,
              code: body.code,
              source: source(req),
            }),
          ),
        );
      }
    },

    stepUpTotp: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      const body = p ? await accept(req, res) : null;
      if (!p) {
        refuse(res, "not_signed_in", 401);
      } else if (body) {
        run(req, res, () => ({
          ok: true,
          auth: svc().passkeys.stepUpWithTotp({
            sessionId: p.sessionId,
            code: body.code,
            source: source(req),
          }),
        }));
      }
    },

    /** The signed-in person's own passkeys and whether an authenticator app is enrolled. */
    listOwnAuthenticators: (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      if (!p) {
        refuse(res, "not_signed_in", 401);
        return;
      }
      const s = svc();
      json(res, 200, {
        passkeys: s.authenticators.listPasskeys(p.personId).map(summarizePasskey),
        totp: s.authenticators.totpInfo(p.personId),
      });
    },
  };
}
