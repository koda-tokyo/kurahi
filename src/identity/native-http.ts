// HTTP side of command-line and native app sign-in (see native.ts for the protocol choices).
//
//   POST /api/identity/oauth/device               device authorization (RFC 8628 3.1)
//   GET  /api/identity/device                     verification page (sign in, check, approve)
//   POST /api/identity/device/lookup              the page: what a user code asks for
//   POST /api/identity/device/decision            the page: approve or deny
//   GET  /api/identity/oauth/authorize            native app authorization request (RFC 8252)
//   GET  /api/identity/oauth/continue             sign-in and confirmation page for the app
//   POST /api/identity/oauth/authorize/complete   the page: confirm, get the redirect back
//   POST /api/identity/oauth/token                device_code and authorization_code grants
//
// The pages finish a normal SSO sign-in themselves (the provider's one-time `#sso_code=` comes
// back to them; see http.ts), so they work with every sign-in provider. The browser session they
// get is only used to approve and is ended right after; the app gets a separate session.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { PersonPrincipal, SessionClient, SessionGrant } from "./types.js";
import { CLI_CLIENT_ID } from "../config/zod-schema.identity.js";
import { AuthAttemptLimiter, authAttemptLimiter } from "../gateway/rate-limiter.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { findNativeClient } from "./config.js";
import { getHttpPerson } from "./http.js";
import {
  checkRedirectUri,
  DEVICE_VERIFY_PATH,
  DeviceAuthorizations,
  formatUserCode,
  isS256Challenge,
  NATIVE_CONTINUE_PATH,
  NATIVE_REQUEST_TTL_MS,
  NativeAuthorizations,
  normalizeUserCode,
} from "./native.js";
import { getIdentityService, type IdentityService } from "./service.js";

export const CLI_CLIENT_NAME = "Kurahi CLI";
/** Device authorization requests per source and minute. */
export const DEVICE_STARTS_PER_MINUTE = 10;
export const DEVICE_STARTS_GLOBAL_PER_MINUTE = 100;
/** Native authorization requests per source and minute. */
export const NATIVE_STARTS_PER_MINUTE = 30;
export const NATIVE_STARTS_GLOBAL_PER_MINUTE = 300;
/** Wrong user codes a person (and a source) may enter per window before a lockout. */
export const USER_CODE_FAILURES = 5;
/**
 * Wrong user codes one source address may enter per window (higher than per person: several
 * people may share an office address, and one of them guessing must not lock the others).
 */
export const USER_CODE_FAILURES_PER_SOURCE = 20;
export const USER_CODE_FAILURE_WINDOW_MS = 10 * 60_000;

export type NativeSignInDeps = {
  service?: () => IdentityService;
  /** Client address for limits and quotas; null for local requests. */
  attemptKey: (req: IncomingMessage) => string | null;
  /** The address shown to the approving person (default: attemptKey, else the socket's). */
  clientIp?: (req: IncomingMessage) => string | null;
  deviceStartLimiter?: AuthAttemptLimiter;
  globalDeviceStartLimiter?: AuthAttemptLimiter;
  nativeStartLimiter?: AuthAttemptLimiter;
  globalNativeStartLimiter?: AuthAttemptLimiter;
  userCodeLimiter?: AuthAttemptLimiter;
  userCodeSourceLimiter?: AuthAttemptLimiter;
  now?: () => number;
};

function noStore(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function json(res: ServerResponse, status: number, body: unknown) {
  noStore(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** RFC 6749 5.2 error response. */
function oauthError(res: ServerResponse, status: number, error: string, description?: string) {
  json(res, status, { error, ...(description ? { error_description: description } : {}) });
}

function apiError(res: ServerResponse, status: number, type: string, message: string) {
  json(res, status, { error: { message, type } });
}

/** A form (`application/x-www-form-urlencoded`, as RFC 6749 asks) or a JSON object body. */
async function readParams(req: IncomingMessage, maxBytes = 8192): Promise<Map<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > maxBytes) {
      return new Map();
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("application/json")) {
    try {
      const body = JSON.parse(text) as unknown;
      return body && typeof body === "object" && !Array.isArray(body)
        ? new Map(Object.entries(body as Record<string, unknown>))
        : new Map();
    } catch {
      return new Map();
    }
  }
  const out = new Map<string, unknown>();
  for (const [k, v] of new URLSearchParams(text)) {
    if (!out.has(k)) {
      out.set(k, v);
    }
  }
  return out;
}

const str = (v: unknown, max = 512): string => (typeof v === "string" && v.length <= max ? v : "");

/** A device's self-description: printable, at most 80 characters, or null. */
function cleanDeviceName(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
  return v ? v.slice(0, 80) : null;
}

// Binds a native authorization request to the browser that opened it.
const OAUTH_COOKIE = "kurahi_oauth_req";
const OAUTH_COOKIE_PATH = "/api/identity/oauth";

function oauthCookie(value: string, secure: boolean, maxAge: number): string {
  const site = secure ? "SameSite=None; Secure" : "SameSite=Lax";
  return `${OAUTH_COOKIE}=${value}; Path=${OAUTH_COOKIE_PATH}; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

function readOauthCookie(req: IncomingMessage): string | null {
  const raw = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === OAUTH_COOKIE) {
      const value = v.join("=");
      return /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** What the approving browser sign-in hands to the new session. */
function grantFrom(svc: IdentityService, p: PersonPrincipal): SessionGrant | null {
  const session = svc.sessions.get(p.sessionId);
  if (!session) {
    return null;
  }
  return {
    personId: session.personId,
    providerId: session.providerId,
    protocol: session.protocol,
    // Never the approving browser's authentication: a command-line or app session starts with
    // none recorded, so every decision covered by step-up needs its own fresh authentication
    // (a fresh browser sign-in cannot lend its freshness to a long-lived client token).
    auth: null,
    // A session never outlives the sign-in it rests on (an IdP session limit carries over).
    notAfterMs: Date.parse(session.expiresAt),
    fromSession: session.id,
  };
}

function withParams(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

export function createNativeSignInHandlers(deps: NativeSignInDeps) {
  const svc = () => (deps.service ?? getIdentityService)();
  const now = deps.now ?? Date.now;
  const device = new DeviceAuthorizations({ now });
  const native = new NativeAuthorizations({ now });
  const deviceStarts =
    deps.deviceStartLimiter ?? new AuthAttemptLimiter(DEVICE_STARTS_PER_MINUTE, 60_000);
  const allDeviceStarts =
    deps.globalDeviceStartLimiter ??
    new AuthAttemptLimiter(DEVICE_STARTS_GLOBAL_PER_MINUTE, 60_000);
  const nativeStarts =
    deps.nativeStartLimiter ?? new AuthAttemptLimiter(NATIVE_STARTS_PER_MINUTE, 60_000);
  const allNativeStarts =
    deps.globalNativeStartLimiter ??
    new AuthAttemptLimiter(NATIVE_STARTS_GLOBAL_PER_MINUTE, 60_000);
  const codeFailures =
    deps.userCodeLimiter ?? new AuthAttemptLimiter(USER_CODE_FAILURES, USER_CODE_FAILURE_WINDOW_MS);
  const sourceCodeFailures =
    deps.userCodeSourceLimiter ??
    new AuthAttemptLimiter(USER_CODE_FAILURES_PER_SOURCE, USER_CODE_FAILURE_WINDOW_MS);
  const ipOf = (req: IncomingMessage) =>
    deps.clientIp?.(req) ?? deps.attemptKey(req) ?? req.socket?.remoteAddress ?? null;

  // Any sign-in the page can run: an SSO provider, or the built-in passkeys / one-time codes.
  const ssoReady = (s: IdentityService) =>
    (s.settings.providers.length > 0 || s.settings.passkeys.enabled) &&
    Boolean(s.settings.publicUrl);
  const deviceOn = (s: IdentityService) => ssoReady(s) && s.settings.deviceSignIn;
  const secureCookies = (s: IdentityService) => (s.settings.publicUrl ?? "").startsWith("https://");

  /** The shared failed-credential gate (same budget as the other sign-in endpoints). */
  const limited = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = deps.attemptKey(req);
    if (key && !authAttemptLimiter.check(key).allowed) {
      oauthError(res, 429, "slow_down", "too many attempts");
      return true;
    }
    return false;
  };
  const recordFailure = (req: IncomingMessage) => {
    const key = deps.attemptKey(req);
    if (key) {
      authAttemptLimiter.record(key);
    }
  };
  const startAllowed = (
    req: IncomingMessage,
    res: ServerResponse,
    perSource: AuthAttemptLimiter,
    global: AuthAttemptLimiter,
  ): boolean => {
    const source = deps.attemptKey(req) ?? "local";
    const one = perSource.consume(source);
    const start = one.allowed ? global.consume("*") : one;
    if (!start.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(start.retryAfterMs / 1000))));
      oauthError(res, 429, "slow_down", "too many sign-in requests");
      return false;
    }
    return true;
  };
  /**
   * User-code guesses: per approving person and per source address (never per pending code);
   * true when locked out (429 written).
   */
  const codeKeys = (req: IncomingMessage, p: PersonPrincipal) =>
    [
      [codeFailures, `person:${p.personId}`],
      [sourceCodeFailures, `ip:${deps.attemptKey(req) ?? "local"}`],
    ] as const;
  const codeLocked = (req: IncomingMessage, res: ServerResponse, p: PersonPrincipal): boolean => {
    const locked = codeKeys(req, p).find(([l, k]) => !l.check(k).allowed);
    if (!locked) {
      return false;
    }
    const retry = locked[0].check(locked[1]).retryAfterMs;
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retry / 1000))));
    apiError(res, 429, "locked", "Too many wrong codes. Wait a few minutes and try again.");
    return true;
  };
  const codeMiss = (req: IncomingMessage, res: ServerResponse, p: PersonPrincipal) => {
    for (const [l, k] of codeKeys(req, p)) {
      l.record(k);
    }
    recordAuditEvent({
      action: "identity.device.lookup",
      outcome: "denied",
      source: "gateway.http",
      identity: p.principal,
      detail: { reason: "code_unknown", ip: ipOf(req) },
    });
    apiError(res, 404, "code_unknown", "That code is not valid, was already used or has expired.");
  };

  const issue = (
    req: IncomingMessage,
    res: ServerResponse,
    action: string,
    grant: SessionGrant,
    client: SessionClient,
  ) => {
    const issued = svc().issueClientSession(grant, client);
    recordAuditEvent({
      action,
      outcome: issued.ok ? "allowed" : "denied",
      source: "gateway.http",
      identity: issued.ok ? issued.principal.principal : `person:${grant.personId}`,
      scope: issued.ok ? issued.principal.scope : undefined,
      detail: {
        client: client.id,
        label: client.label,
        session: issued.ok ? issued.principal.sessionId : null,
        approvedWith: grant.fromSession,
        ip: ipOf(req),
        reason: issued.ok ? null : issued.reason,
      },
    });
    if (!issued.ok) {
      oauthError(res, 400, "access_denied", "the person may no longer sign in");
      return;
    }
    json(res, 200, {
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((Date.parse(issued.principal.expiresAt) - now()) / 1000)),
      session_id: issued.principal.sessionId,
    });
  };

  return {
    /** RFC 8628 3.1: the CLI asks for a device code and a user code. */
    deviceAuthorization: async (req: IncomingMessage, res: ServerResponse) => {
      if (limited(req, res)) {
        return;
      }
      const s = svc();
      if (!deviceOn(s)) {
        oauthError(res, 400, "unauthorized_client", "command-line sign-in is not enabled");
        return;
      }
      const params = await readParams(req);
      const clientId = str(params.get("client_id"), 64);
      const nativeClient =
        clientId === CLI_CLIENT_ID ? null : findNativeClient(s.settings, clientId);
      if (clientId !== CLI_CLIENT_ID && !nativeClient) {
        recordFailure(req);
        oauthError(res, 400, "invalid_client", "unknown client_id");
        return;
      }
      if (!startAllowed(req, res, deviceStarts, allDeviceStarts)) {
        return;
      }
      const clientName = nativeClient?.name ?? CLI_CLIENT_NAME;
      const deviceName = cleanDeviceName(params.get("device_name"));
      const ip = ipOf(req);
      const started = device.start({
        clientId,
        clientName,
        deviceName,
        ip,
        source: deps.attemptKey(req) ?? "local",
      });
      recordAuditEvent({
        action: "identity.device.authorize",
        outcome: started.ok ? "allowed" : "denied",
        source: "gateway.http",
        detail: { client: clientId, deviceName, ip, reason: started.ok ? null : started.reason },
      });
      if (!started.ok) {
        res.setHeader("Retry-After", "60");
        oauthError(res, 429, "slow_down", "too many pending sign-in requests");
        return;
      }
      const verificationUri = `${s.settings.publicUrl}${DEVICE_VERIFY_PATH}`;
      json(res, 200, {
        device_code: started.deviceCode,
        user_code: started.userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${started.userCode}`,
        expires_in: started.expiresIn,
        interval: started.interval,
      });
    },

    /** The verification page (`verification_uri`). */
    deviceVerificationPage: (
      _req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      if (!deviceOn(svc())) {
        htmlPage(res, 404, { mode: "error", message: "Command-line sign-in is not enabled." });
        return;
      }
      const code = normalizeUserCode(ctx.url.searchParams.get("user_code"));
      htmlPage(res, 200, { mode: "device", userCode: code ? formatUserCode(code) : null });
    },

    /** The page: what the typed user code asks for (client, device, address). */
    lookupDeviceCode: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      if (!p) {
        apiError(res, 401, "unauthorized", "Unauthorized");
        return;
      }
      if (!deviceOn(svc())) {
        apiError(res, 404, "not_found", "command-line sign-in is not enabled");
        return;
      }
      if (codeLocked(req, res, p)) {
        return;
      }
      const params = await readParams(req, 4096);
      const found = device.find(params.get("user_code"));
      if (!found) {
        codeMiss(req, res, p);
        return;
      }
      json(res, 200, { request: found });
    },

    /** The page: approve (a new session for this person) or deny. Audited either way. */
    decideDeviceCode: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      if (!p) {
        apiError(res, 401, "unauthorized", "Unauthorized");
        return;
      }
      const s = svc();
      if (!deviceOn(s)) {
        apiError(res, 404, "not_found", "command-line sign-in is not enabled");
        return;
      }
      if (codeLocked(req, res, p)) {
        return;
      }
      const params = await readParams(req, 4096);
      const approve = params.get("approve");
      if (typeof approve !== "boolean") {
        apiError(res, 400, "invalid_request", "approve must be true or false");
        return;
      }
      const grant = approve ? grantFrom(s, p) : null;
      if (approve && !grant) {
        apiError(res, 401, "unauthorized", "Unauthorized");
        return;
      }
      const decided = device.decide(
        params.get("user_code"),
        grant ? { approve: true, grant, by: p.principal } : { approve: false, by: p.principal },
      );
      if (!decided) {
        codeMiss(req, res, p);
        return;
      }
      recordAuditEvent({
        action: approve ? "identity.device.approve" : "identity.device.deny",
        outcome: "allowed",
        source: "gateway.http",
        identity: p.principal,
        scope: p.scope,
        detail: {
          client: decided.clientId,
          deviceName: decided.deviceName,
          requestIp: decided.ip,
          approverIp: ipOf(req),
          userCode: decided.userCode,
          session: p.sessionId,
        },
      });
      json(res, 200, { ok: true, approved: approve });
    },

    /** RFC 8252: a native app opens this in the system browser. */
    authorizeNative: (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      if (limited(req, res)) {
        return;
      }
      const s = svc();
      if (!ssoReady(s)) {
        htmlPage(res, 404, { mode: "error", message: "Single sign-on is not configured." });
        return;
      }
      const q = ctx.url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const client = findNativeClient(s.settings, clientId);
      const redirectUri = client ? checkRedirectUri(client, q.get("redirect_uri")) : null;
      if (!client || !redirectUri) {
        // Never redirect to a URI that is not the client's own.
        recordFailure(req);
        recordAuditEvent({
          action: "identity.native.authorize",
          outcome: "denied",
          source: "gateway.http",
          detail: {
            client: clientId.slice(0, 64),
            reason: client ? "redirect_uri" : "unknown_client",
            ip: ipOf(req),
          },
        });
        htmlPage(res, 400, {
          mode: "error",
          message: client
            ? "This app asked to return to an address it may not use."
            : "This app is not registered with the gateway.",
        });
        return;
      }
      const state = q.get("state") ?? "";
      if (!state || state.length > 512 || /[\p{Cc}]/u.test(state)) {
        htmlPage(res, 400, {
          mode: "error",
          message:
            "The app's sign-in request is incomplete (state is missing). Start again from the app.",
        });
        return;
      }
      const back = (error: string, description: string) => {
        noStore(res);
        res.statusCode = 302;
        res.setHeader(
          "Location",
          withParams(redirectUri, { error, error_description: description, state }),
        );
        res.end();
      };
      if (q.get("response_type") !== "code") {
        back("unsupported_response_type", "response_type must be code");
        return;
      }
      if (q.get("code_challenge_method") !== "S256" || !isS256Challenge(q.get("code_challenge"))) {
        back("invalid_request", "PKCE with code_challenge_method S256 is required");
        return;
      }
      if (!startAllowed(req, res, nativeStarts, allNativeStarts)) {
        return;
      }
      const begun = native.begin({
        clientId: client.id,
        clientName: client.name,
        redirectUri,
        codeChallenge: q.get("code_challenge") ?? "",
        state,
        source: deps.attemptKey(req) ?? "local",
      });
      recordAuditEvent({
        action: "identity.native.authorize",
        outcome: begun.ok ? "allowed" : "denied",
        source: "gateway.http",
        detail: { client: client.id, ip: ipOf(req), reason: begun.ok ? null : begun.reason },
      });
      if (!begun.ok) {
        back("temporarily_unavailable", "too many pending sign-in requests");
        return;
      }
      res.setHeader(
        "Set-Cookie",
        oauthCookie(begun.binding, secureCookies(s), Math.ceil(NATIVE_REQUEST_TTL_MS / 1000)),
      );
      noStore(res);
      res.statusCode = 303;
      res.setHeader("Location", `${NATIVE_CONTINUE_PATH}?request=${begun.id}`);
      res.end();
    },

    /** Sign-in and confirmation page for a native app's request. */
    nativeContinuePage: (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      const id = ctx.url.searchParams.get("request") ?? "";
      const r = ssoReady(svc()) ? native.peek(id, readOauthCookie(req)) : null;
      if (!r) {
        htmlPage(res, 400, {
          mode: "error",
          message:
            "This sign-in request has expired or was opened in another browser. Start again from the app.",
        });
        return;
      }
      htmlPage(res, 200, { mode: "native", request: r.id, clientName: r.clientName });
    },

    /** The page: the person confirms (or cancels); returns where the browser goes next. */
    completeNativeAuthorization: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      if (!p) {
        apiError(res, 401, "unauthorized", "Unauthorized");
        return;
      }
      const s = svc();
      const params = await readParams(req, 4096);
      const approve = params.get("approve");
      if (typeof approve !== "boolean") {
        apiError(res, 400, "invalid_request", "approve must be true or false");
        return;
      }
      const r = native.take(str(params.get("request"), 64), readOauthCookie(req));
      res.setHeader("Set-Cookie", oauthCookie("", secureCookies(s), 0));
      if (!r) {
        recordFailure(req);
        apiError(res, 400, "request_unknown", "This sign-in request has expired. Start again.");
        return;
      }
      const grant = approve ? grantFrom(s, p) : null;
      recordAuditEvent({
        action: approve ? "identity.native.approve" : "identity.native.deny",
        outcome: approve && !grant ? "denied" : "allowed",
        source: "gateway.http",
        identity: p.principal,
        detail: { client: r.clientId, ip: ipOf(req), session: p.sessionId },
      });
      if (!grant) {
        json(res, 200, {
          redirect: withParams(r.redirectUri, {
            error: "access_denied",
            error_description: "the person cancelled the sign-in",
            state: r.state,
          }),
        });
        return;
      }
      const code = native.issueCode(r, grant);
      json(res, 200, {
        // RFC 9207: the issuer identifies this gateway to the app.
        redirect: withParams(r.redirectUri, {
          code,
          state: r.state,
          iss: s.settings.publicUrl ?? "",
        }),
      });
    },

    /** RFC 8628 3.4 and RFC 6749 4.1.3 (+ RFC 7636): one token endpoint for both flows. */
    token: async (req: IncomingMessage, res: ServerResponse) => {
      if (limited(req, res)) {
        return;
      }
      const s = svc();
      const params = await readParams(req);
      const grantType = str(params.get("grant_type"), 128);
      const clientId = str(params.get("client_id"), 64);
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        if (!deviceOn(s)) {
          oauthError(res, 400, "unauthorized_client", "command-line sign-in is not enabled");
          return;
        }
        const polled = device.poll(str(params.get("device_code"), 128), clientId);
        switch (polled.kind) {
          case "authorization_pending":
            oauthError(res, 400, "authorization_pending");
            return;
          case "slow_down":
            json(res, 400, { error: "slow_down", interval: polled.interval });
            return;
          case "expired_token":
            oauthError(res, 400, "expired_token", "the code expired; start again");
            return;
          case "access_denied":
            recordAuditEvent({
              action: "identity.device.token",
              outcome: "denied",
              source: "gateway.http",
              detail: { client: clientId, reason: polled.reason, ip: ipOf(req) },
            });
            oauthError(
              res,
              400,
              "access_denied",
              polled.reason === "locked" ? "the code was locked after wrong guesses" : undefined,
            );
            return;
          case "invalid_grant":
            recordFailure(req);
            oauthError(res, 400, "invalid_grant");
            return;
          case "approved": {
            const name = polled.request.deviceName
              ? `${polled.request.clientName} (${polled.request.deviceName})`
              : polled.request.clientName;
            issue(req, res, "identity.device.token", polled.grant, {
              flow: "device",
              id: polled.request.clientId,
              name: polled.request.clientName,
              label: polled.request.clientId === CLI_CLIENT_ID ? `CLI: ${name}` : name,
            });
            return;
          }
        }
      }
      if (grantType === "authorization_code") {
        const client = ssoReady(s) ? findNativeClient(s.settings, clientId) : null;
        if (!client) {
          recordFailure(req);
          oauthError(res, 400, "invalid_client", "unknown client_id");
          return;
        }
        const redeemed = native.redeem({
          code: str(params.get("code"), 128),
          clientId: client.id,
          redirectUri: str(params.get("redirect_uri")),
          codeVerifier: str(params.get("code_verifier"), 128),
        });
        if (!redeemed.ok) {
          recordFailure(req);
          recordAuditEvent({
            action: "identity.native.token",
            outcome: "denied",
            source: "gateway.http",
            detail: { client: client.id, reason: redeemed.reason, ip: ipOf(req) },
          });
          oauthError(res, 400, "invalid_grant");
          return;
        }
        issue(req, res, "identity.native.token", redeemed.grant, {
          flow: "native",
          id: client.id,
          name: client.name,
          label: client.name,
        });
        return;
      }
      oauthError(res, 400, "unsupported_grant_type");
    },

    /** Tests. */
    _device: device,
    _native: native,
  };
}

// ---------------------------------------------------------------------------------------------
// The sign-in page (device verification and native app confirmation)

type PageData =
  | { mode: "error"; message: string }
  | { mode: "device"; userCode: string | null }
  | { mode: "native"; request: string; clientName: string };

function htmlPage(res: ServerResponse, status: number, data: PageData) {
  const nonce = randomBytes(16).toString("base64");
  noStore(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  // JSON in a script element: `<` escaped so the data cannot close the element.
  const cfg = JSON.stringify(data).replace(/</g, "\\u003c");
  res.end(PAGE.replaceAll("__NONCE__", nonce).replace("__CFG__", cfg));
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kurahi sign-in</title>
<style nonce="__NONCE__">
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#f5f5f7;--card:#fff;--line:#d2d2d7;--accent:#0b5cad;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#1c1c1e;--card:#2c2c2e;--line:#3a3a3c;--accent:#4c9ef0;--danger:#f2726b}}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:28rem;margin:10vh auto;padding:0 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.9rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 16px}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
input{font:inherit;font-size:1.25rem;letter-spacing:.15em;text-transform:uppercase;width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
button,a.button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:var(--accent)!important;border-color:var(--accent)!important;color:#fff!important}.err{color:var(--danger)}
input.plain{font-size:1rem;letter-spacing:normal;text-transform:none}.warn{border-left:4px solid var(--danger);padding-left:12px}
</style></head><body><main>
<section id="loading"><p class="muted">Loading…</p></section>
<section id="signin" hidden><h1>Sign in</h1><p>Sign in to continue.</p><div class="row" id="providers"></div>
<div id="builtin" hidden><div class="row"><button class="primary" id="passkey" type="button">Sign in with a passkey</button></div>
<form id="totp-form" hidden><p class="muted">Or use a one-time code from your authenticator app.</p>
<p><label for="totp-user">User name or e-mail</label><input class="plain" id="totp-user" autocomplete="username"></p>
<p><label for="totp-code">One-time code</label><input class="plain" id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></p>
<div class="row"><button type="submit">Sign in with the code</button></div></form></div>
<p class="err" id="signin-error"></p></section>
<section id="code" hidden><h1>Sign in on the command line</h1><p>Signed in as <strong id="who"></strong>.</p>
<p class="muted" id="link-code" hidden></p>
<form id="code-form"><p><label for="user-code">Type the code the command line shows:</label></p>
<input id="user-code" autocomplete="off" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX">
<p class="err" id="code-error"></p><div class="row"><button class="primary" type="submit">Continue</button></div></form></section>
<section id="confirm" hidden><h1>Allow this sign-in?</h1>
<p class="warn"><strong id="grant-text"></strong></p>
<p>Approve only if you started this sign-in yourself, just now, and the code matches.</p>
<dl><dt>Code</dt><dd id="shown-code"></dd><dt>App</dt><dd id="client-name"></dd><dt>Device says</dt><dd id="device-name"></dd><dt>From address</dt><dd id="ip"></dd><dt>Requested</dt><dd id="requested"></dd><dt>As</dt><dd id="who2"></dd></dl>
<div class="row"><button class="primary" id="approve" type="button">Approve</button><button id="deny" type="button">Deny</button></div></section>
<section id="native" hidden><h1>Sign in to <span id="app-name"></span></h1>
<p class="warn"><strong id="grant-native"></strong></p><p class="muted">Continue only if you just started this sign-in from the app.</p>
<div class="row"><button class="primary" id="allow" type="button">Continue</button><button id="cancel" type="button">Cancel</button></div></section>
<section id="done" hidden><h1>Done</h1><p id="done-text"></p></section>
<section id="error" hidden><h1>Sign-in not completed</h1><p id="error-text"></p><div class="row"><a class="button" id="retry" href="">Try again</a></div></section>
</main>
<script type="application/json" id="cfg">__CFG__</script>
<script nonce="__NONCE__">
(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const KEY = "kurahi.signin.token";
  const $ = (id) => document.getElementById(id);
  const say = (id, text) => { $(id).textContent = text; };
  const show = (id) => { for (const s of document.querySelectorAll("section")) s.hidden = s.id !== id; };
  const store = {
    get() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} },
  };
  const here = location.pathname + location.search;
  $("retry").href = here;
  const fail = (msg) => { say("error-text", msg); show("error"); };
  async function api(path, body, token) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}), credentials: "same-origin" });
    let data = {};
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  // The browser session served only this approval: end it.
  async function signOut(token) { store.set(null); try { await api("/api/identity/logout", {}, token); } catch {} }
  async function token() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (location.hash) history.replaceState(null, "", here);
    if (h.get("sso_error")) { fail("Sign-in failed (" + h.get("sso_error") + ")."); return ""; }
    const code = h.get("sso_code");
    if (code) {
      const r = await api("/api/identity/sso/exchange", { code });
      if (r.status === 200 && r.data.token) { store.set(r.data.token); return r.data.token; }
      fail("Sign-in could not be completed."); return "";
    }
    return store.get();
  }
  // base64url without regular expressions (this page is served from a template string).
  const b64u = {
    dec(v) {
      const s = v.split("-").join("+").split("_").join("/");
      const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out.buffer;
    },
    enc(buf) {
      if (!buf) return "";
      const u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      let bin = "";
      for (const x of u) bin += String.fromCharCode(x);
      return btoa(bin).split("+").join("-").split("/").join("_").split("=").join("");
    },
  };
  const signedIn = (r) => {
    if (r.status === 200 && r.data.token) { store.set(r.data.token); main(); return; }
    say("signin-error", "Sign-in was refused (" + ((r.data.error && r.data.error.type) || "error") + ").");
  };
  // Built-in sign-in: a usernameless passkey (as the console does), or a one-time code.
  async function passkeySignIn() {
    say("signin-error", "");
    const b = await api("/api/identity/passkey/login/begin", {});
    if (b.status !== 200) return signedIn(b);
    const o = b.data.publicKey;
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: { ...o, challenge: b64u.dec(o.challenge),
        allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) } });
    } catch { say("signin-error", "The passkey sign-in was cancelled."); return; }
    let json;
    if (typeof cred.toJSON === "function") json = cred.toJSON();
    else {
      const r = cred.response;
      const id = b64u.enc(cred.rawId);
      json = { id, rawId: id, type: cred.type, response: { clientDataJSON: b64u.enc(r.clientDataJSON),
        authenticatorData: b64u.enc(r.authenticatorData), signature: b64u.enc(r.signature),
        ...(r.userHandle ? { userHandle: b64u.enc(r.userHandle) } : {}) } };
    }
    signedIn(await api("/api/identity/passkey/login/finish", { ceremonyId: b.data.ceremonyId, credential: json }));
  }
  async function signIn() {
    show("signin");
    const r = await fetch("/api/identity/sso");
    const data = await r.json();
    const list = $("providers");
    list.textContent = "";
    for (const p of data.providers || []) {
      const a = document.createElement("a");
      a.className = "button primary";
      a.textContent = p.label;
      a.href = p.loginPath + "?returnTo=" + encodeURIComponent(here);
      list.append(a);
    }
    const builtin = data.passkeys && data.passkeys.enabled;
    if (builtin) {
      $("builtin").hidden = false;
      $("passkey").hidden = typeof window.PublicKeyCredential === "undefined";
      $("passkey").onclick = () => { passkeySignIn().catch(() => say("signin-error", "Something went wrong.")); };
      if (data.passkeys.totp) {
        $("totp-form").hidden = false;
        $("totp-form").onsubmit = async (e) => {
          e.preventDefault();
          say("signin-error", "");
          signedIn(await api("/api/identity/passkey/totp/verify", { userName: $("totp-user").value.trim(), code: $("totp-code").value.split(" ").join("") }));
        };
      }
    }
    // One company sign-in and nothing else: go straight there.
    if (!builtin && list.children.length === 1) location.assign(list.firstChild.href);
  }
  function device(tok, who) {
    show("code");
    say("who", who);
    // The person types the code: a link's prefilled code is never accepted silently (someone
    // else's link would otherwise sign their command line in as this person).
    $("user-code").value = "";
    if (cfg.userCode) {
      say("link-code", "The link you opened names the code " + cfg.userCode + ". Type the code your own command line shows; approve only if they match.");
      $("link-code").hidden = false;
    }
    $("code-form").onsubmit = async (e) => {
      e.preventDefault();
      say("code-error", "");
      const r = await api("/api/identity/device/lookup", { user_code: $("user-code").value }, tok);
      if (r.status === 401) { store.set(null); return signIn(); }
      if (r.status !== 200) { say("code-error", (r.data.error && r.data.error.message) || "That code is not valid."); return; }
      const d = r.data.request;
      say("shown-code", d.userCode); say("client-name", d.clientName);
      say("device-name", d.deviceName || "(not stated)"); say("ip", d.ip || "unknown");
      say("requested", new Date(d.requestedAt).toLocaleString()); say("who2", who);
      say("grant-text", "This will give " + d.clientName + " full access to Kurahi as " + who + ", requested " + new Date(d.requestedAt).toLocaleString() + " from " + (d.ip || "an unknown address") + ".");
      show("confirm");
      const decide = async (approve) => {
        const x = await api("/api/identity/device/decision", { user_code: d.userCode, approve }, tok);
        await signOut(tok);
        if (x.status !== 200) return fail((x.data.error && x.data.error.message) || "The request is no longer valid.");
        say("done-text", approve ? "Approved. Return to the command line; you can close this window." : "Denied. The command line was not signed in.");
        show("done");
      };
      $("approve").onclick = () => decide(true);
      $("deny").onclick = () => decide(false);
    };
  }
  function nativeApp(tok, who) {
    show("native");
    say("app-name", cfg.clientName);
    say("grant-native", "This will give " + cfg.clientName + " full access to Kurahi as " + who + ".");
    const finish = async (approve) => {
      const r = await api("/api/identity/oauth/authorize/complete", { request: cfg.request, approve }, tok);
      await signOut(tok);
      if (r.status !== 200 || !r.data.redirect) return fail((r.data.error && r.data.error.message) || "The request is no longer valid.");
      say("done-text", approve ? "Returning to " + cfg.clientName + "…" : "Cancelled.");
      show("done");
      location.replace(r.data.redirect);
    };
    $("allow").onclick = () => finish(true);
    $("cancel").onclick = () => finish(false);
  }
  async function main() {
    if (cfg.mode === "error") { $("retry").hidden = true; return fail(cfg.message); }
    try {
      const tok = await token();
      if (tok === "") return;
      if (!tok) return await signIn();
      const r = await fetch("/api/identity/session", { headers: { authorization: "Bearer " + tok } });
      if (r.status !== 200) { store.set(null); return await signIn(); }
      const s = await r.json();
      const who = (s.person && (s.person.displayName || s.person.email)) || s.principal;
      if (cfg.mode === "device") device(tok, who); else nativeApp(tok, who);
    } catch { fail("Something went wrong."); }
  }
  main();
})();
</script></body></html>`;
