// HTTP side of enterprise identity: SSO sign-in (OIDC callback, SAML ACS and metadata), the
// session endpoint, logout, and the `sso-session` Bearer authenticator for declared routes.
//
// After a successful sign-in the browser is sent back to the console path it came from with a
// one-time code in the URL fragment (`#sso_code=…`), never the session token: the console
// exchanges the code once, by POST /api/identity/sso/exchange with the sign-in's binding cookie,
// for the session token and keeps that in session storage. The code lives 60 seconds, is used
// at most once, and works only in the browser that started the sign-in; a code nobody redeems
// ends its session. `returnTo` must be a console path (the control UI base path), so the code
// never lands on a canvas, A2UI or plugin page. Failures come back as `#sso_error=<reason>`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PersonPrincipal } from "./types.js";
import { AuthAttemptLimiter, authAttemptLimiter } from "../gateway/rate-limiter.js";
import { type PairScope, scopeSatisfies } from "../gateway/scopes.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { acsUrl, callbackUrl, findProvider, spEntityId } from "./config.js";
import { signInPageReturnTo } from "./native.js";
import { OidcError } from "./oidc.js";
import { hasRole } from "./rbac.js";
import { SamlError, spMetadataXml } from "./saml/sp.js";
import { getIdentityService, type IdentityService, type StepUpCompletion } from "./service.js";
import { isSsoSessionToken } from "./sessions.js";

const persons = new WeakMap<IncomingMessage, PersonPrincipal>();

export function getHttpPerson(req: IncomingMessage): PersonPrincipal | undefined {
  return persons.get(req);
}

/** Tests: attach a person to a request as the sso-session authenticator does. */
export function setHttpPersonForTest(req: IncomingMessage, p: PersonPrincipal): void {
  persons.set(req, p);
}

/** Routes an auditor may read whatever their scope (audit chain and evidence). */
export const AUDITOR_READ_OPERATIONS = new Set([
  "getAuditChain",
  "getJobEvidence",
  "listJobEvidenceEvents",
  "getEvidenceView",
  "exportJobEvidence",
]);

export function bearer(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : undefined;
}

/** `sso-session` authenticator: true, false (absent / invalid) or "forbidden" (scope). */
export function authorizeSsoSession(
  req: IncomingMessage,
  route: { operationId: string; minScope: PairScope },
  svc: IdentityService = getIdentityService(),
): boolean | "forbidden" {
  const token = bearer(req);
  if (!isSsoSessionToken(token)) {
    return false;
  }
  const verified = svc.verifyToken(token, { touch: true });
  if (!verified.ok) {
    return false;
  }
  const p = verified.principal;
  const allowed =
    scopeSatisfies(p.scope, route.minScope) ||
    (AUDITOR_READ_OPERATIONS.has(route.operationId) && hasRole(p, "auditor"));
  if (!allowed) {
    return "forbidden";
  }
  persons.set(req, p);
  return true;
}

export type SsoHttpDeps = {
  service?: () => IdentityService;
  /** Client address for the failed-attempt limiter; null for local requests. */
  attemptKey: (req: IncomingMessage) => string | null;
  /** Sign-in starts per source and minute (default 30). */
  loginStartLimiter?: AuthAttemptLimiter;
  /** Sign-in starts per minute across all sources (default 300). */
  globalLoginStartLimiter?: AuthAttemptLimiter;
  /** The control UI base path (`gateway.controlUi.basePath`, normalised; "" for the root). */
  consoleBasePath?: string;
  /** Paths the gateway serves itself (API, canvas, plugins, …): never a return target. */
  isGatewayPath?: (pathname: string) => boolean;
  now?: () => number;
};

/** How long a sign-in's one-time code may be exchanged for the session token. */
export const SSO_CODE_TTL_MS = 60_000;
const MAX_PENDING_CODES = 1_000;

/** First path segments that are never console routes (with the console at the root). */
const NON_CONSOLE_SEGMENTS = new Set([
  "api",
  "v1",
  "tools",
  "metrics",
  "health",
  "doc",
  "avatar",
  "scim",
  "__kolo__",
]);
const CONSOLE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A console path to return to after sign-in, else the console root. On top of `safeReturnTo`:
 * inside the control UI base path, made of plain route segments (no file names, so no static
 * asset or HTML page), and not a path the gateway serves itself.
 */
export function consoleReturnTo(
  raw: string | null | undefined,
  opts: { basePath?: string; isGatewayPath?: (pathname: string) => boolean } = {},
): string {
  const base = (opts.basePath ?? "").replace(/\/+$/, "");
  const home = `${base}/`;
  const v = safeReturnTo(raw);
  const pathname = v.split("?")[0] ?? "/";
  if (base && pathname !== base && !pathname.startsWith(`${base}/`)) {
    return home;
  }
  const segments = pathname
    .slice(base.length)
    .split("/")
    .filter((x) => x.length > 0);
  if (
    segments.length > 4 ||
    !segments.every((x) => CONSOLE_SEGMENT_RE.test(x)) ||
    (!base && segments[0] !== undefined && NON_CONSOLE_SEGMENTS.has(segments[0].toLowerCase())) ||
    opts.isGatewayPath?.(pathname)
  ) {
    return home;
  }
  return v;
}

type PendingCode = { token: string; sessionId: string; binding: string; expiresAt: number };

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sign-in starts allowed per source per minute (each one holds a pending state for 10 min). */
export const LOGIN_STARTS_PER_MINUTE = 30;
/**
 * Sign-in starts allowed per minute across all sources: many sources (or forged forwarding
 * headers behind a misconfigured proxy) cannot fill the pending store or hammer the IdP.
 */
export const LOGIN_STARTS_GLOBAL_PER_MINUTE = 300;

export function noStore(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export function json(res: ServerResponse, status: number, body: unknown) {
  noStore(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, status = 302) {
  noStore(res);
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}

/** A local path: one leading `/`, never `//` or `/\\` (a protocol-relative URL to another host). */
const LOCAL_PATH_RE = /^\/(?![/\\])/;

/**
 * A same-origin path to return to after sign-in; anything else becomes "/".
 *
 * The URL parser resolves dot segments, so `/.//evil.example` or `/%2e%2e//evil.example` would
 * normalise to `//evil.example` (another host). Dot segments (also percent-encoded), encoded
 * slashes and backslashes and control characters are refused outright, and the normalised result
 * must still be a local path.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  let control = false;
  for (let i = 0; i < v.length; i += 1) {
    const code = v.charCodeAt(i);
    control ||= code < 0x20 || code === 0x7f;
  }
  if (!v || v.length > 512 || !LOCAL_PATH_RE.test(v) || control || /[\\#\s]/.test(v)) {
    return "/";
  }
  // Encoded slashes, backslashes and control characters have no business in a console path.
  const pathPart = v.split("?")[0] ?? "";
  if (/%(?:2f|5c|[01][0-9a-f]|7f)/i.test(pathPart)) {
    return "/";
  }
  for (const segment of pathPart.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return "/";
    }
    if (decoded === "." || decoded === "..") {
      return "/";
    }
  }
  try {
    const u = new URL(v, "http://gateway.invalid");
    const out = `${u.pathname}${u.search}`;
    return u.origin === "http://gateway.invalid" && LOCAL_PATH_RE.test(out) ? out : "/";
  } catch {
    return "/";
  }
}

/** Last line of defence before a token goes into a Location header: local paths only. */
function localLocation(returnTo: string): string {
  return LOCAL_PATH_RE.test(returnTo) && !/[\\\s]/.test(returnTo) ? returnTo : "/";
}

// Login CSRF defence: a random value in an HttpOnly cookie, set when the sign-in starts and
// required when the IdP sends the browser back. SameSite=None so the IdP's cross-site POST to
// the SAML ACS carries it (Secure is required for that; plain-http loopback uses Lax).
const BINDING_COOKIE = "kurahi_sso_bind";
const BINDING_PATH = "/api/identity/sso";

function bindingCookie(value: string, secure: boolean, maxAge: number): string {
  const site = secure ? "SameSite=None; Secure" : "SameSite=Lax";
  return `${BINDING_COOKIE}=${value}; Path=${BINDING_PATH}; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

export function readBindingCookie(req: IncomingMessage): string | null {
  const raw = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === BINDING_COOKIE) {
      const value = v.join("=");
      return /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
    }
  }
  return null;
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > maxBytes) {
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage, maxBytes: number): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > maxBytes) {
      return null;
    }
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function createSsoHttpHandlers(deps: SsoHttpDeps) {
  const svc = () => (deps.service ?? getIdentityService)();
  const starts = deps.loginStartLimiter ?? new AuthAttemptLimiter(LOGIN_STARTS_PER_MINUTE, 60_000);
  const allStarts =
    deps.globalLoginStartLimiter ?? new AuthAttemptLimiter(LOGIN_STARTS_GLOBAL_PER_MINUTE, 60_000);
  const now = deps.now ?? Date.now;
  const consoleHome = `${(deps.consoleBasePath ?? "").replace(/\/+$/, "")}/`;
  // The command-line and native app sign-in pages finish a sign-in themselves.
  const returnTarget = (raw: string | null) =>
    signInPageReturnTo(raw) ??
    consoleReturnTo(raw, { basePath: deps.consoleBasePath, isGatewayPath: deps.isGatewayPath });

  // One-time codes waiting for the console's exchange. A code that expires unredeemed (or is
  // pushed out by the cap) ends its session: nobody holds that session's token.
  const codes = new Map<string, PendingCode>();
  const dropCode = (code: string, entry: PendingCode, reason: string) => {
    codes.delete(code);
    svc().sessions.revoke(entry.sessionId, reason);
  };
  const pruneCodes = () => {
    const t = now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= t) {
        dropCode(code, entry, "sso_code_expired");
      }
    }
    while (codes.size >= MAX_PENDING_CODES) {
      const [oldest] = codes;
      if (!oldest) {
        break;
      }
      dropCode(oldest[0], oldest[1], "sso_code_evicted");
    }
  };
  const issueCode = (token: string, sessionId: string, binding: string): string => {
    pruneCodes();
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { token, sessionId, binding, expiresAt: now() + SSO_CODE_TTL_MS });
    return code;
  };

  const limited = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = deps.attemptKey(req);
    if (key && !authAttemptLimiter.check(key).allowed) {
      json(res, 429, { error: { message: "too many sign-in attempts", type: "rate_limited" } });
      return true;
    }
    return false;
  };

  const finish = (
    req: IncomingMessage,
    res: ServerResponse,
    providerId: string,
    outcome:
      | { ok: true; token: string; principal: PersonPrincipal; returnTo: string }
      | { ok: false; reason: string; returnTo: string },
    status = 302,
  ) => {
    const secure = (svc().settings.publicUrl ?? "").startsWith("https://");
    // The binding cookie stays for the code exchange on success, and goes on failure.
    const binding = outcome.ok ? readBindingCookie(req) : null;
    res.setHeader(
      "Set-Cookie",
      binding
        ? bindingCookie(binding, secure, Math.ceil(SSO_CODE_TTL_MS / 1000))
        : bindingCookie("", secure, 0),
    );
    if (outcome.ok && !binding) {
      // complete() already proved the binding; without the cookie no exchange could succeed.
      svc().sessions.revoke(outcome.principal.sessionId, "sso_binding_missing");
      outcome = { ok: false, reason: "browser_mismatch", returnTo: outcome.returnTo };
    }
    recordAuditEvent({
      action: "identity.sso.login",
      outcome: outcome.ok ? "allowed" : "denied",
      source: "gateway.http",
      identity: outcome.ok ? outcome.principal.principal : undefined,
      scope: outcome.ok ? outcome.principal.scope : undefined,
      detail: { provider: providerId, reason: outcome.ok ? null : outcome.reason },
    });
    if (!outcome.ok) {
      const key = deps.attemptKey(req);
      if (key) {
        authAttemptLimiter.record(key);
      }
      redirect(
        res,
        `${localLocation(outcome.returnTo)}#sso_error=${encodeURIComponent(outcome.reason)}`,
        status,
      );
      return;
    }
    const code = issueCode(outcome.token, outcome.principal.sessionId, binding ?? "");
    redirect(res, `${localLocation(outcome.returnTo)}#sso_code=${code}`, status);
  };

  /** Step-up came back: the session's auth is refreshed (or not); no code, no new session. */
  const finishStepUp = (
    req: IncomingMessage,
    res: ServerResponse,
    returnTo: string,
    result: StepUpCompletion,
    status = 302,
  ) => {
    const secure = (svc().settings.publicUrl ?? "").startsWith("https://");
    res.setHeader("Set-Cookie", bindingCookie("", secure, 0));
    if (!result.ok) {
      const key = deps.attemptKey(req);
      if (key) {
        authAttemptLimiter.record(key);
      }
      redirect(
        res,
        `${localLocation(returnTo)}#sso_error=${encodeURIComponent(result.reason)}`,
        status,
      );
      return;
    }
    redirect(res, `${localLocation(returnTo)}#sso_stepup=ok`, status);
  };

  /** Shared start budget for sign-ins and step-ups (per source, then gateway-wide). */
  const startAllowed = (req: IncomingMessage, res: ServerResponse): string | null => {
    const source = deps.attemptKey(req) ?? "local";
    const perSource = starts.consume(source);
    const start = perSource.allowed ? allStarts.consume("*") : perSource;
    if (!start.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(start.retryAfterMs / 1000))));
      json(res, 429, { error: { message: "too many sign-in starts", type: "rate_limited" } });
      return null;
    }
    return source;
  };

  return {
    getSsoConfig: (_req: IncomingMessage, res: ServerResponse) => {
      const s = svc().settings;
      json(res, 200, {
        enabled: s.providers.length > 0 || s.passkeys.enabled,
        required: s.ssoRequired,
        providers: s.providers.map((p) => ({
          id: p.id,
          kind: p.kind,
          label: p.label ?? p.id,
          loginPath: `/api/identity/sso/${p.id}/login`,
        })),
        // Built-in sign-in (passkeys first, one-time codes as the fallback).
        passkeys: { enabled: s.passkeys.enabled, totp: s.passkeys.enabled && s.passkeys.totp },
      });
    },

    startSsoLogin: async (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      if (limited(req, res)) {
        return;
      }
      // Every start holds a pending sign-in: starts are rate-limited per source as well. The
      // gateway-wide budget is spent only by starts the per-source limit let through.
      const source = startAllowed(req, res);
      if (source === null) {
        return;
      }
      const s = svc();
      const p = findProvider(s.settings, ctx.params.provider ?? "");
      if (!p) {
        json(res, 404, { error: { message: "unknown sign-in provider", type: "not_found" } });
        return;
      }
      const returnTo = returnTarget(ctx.url.searchParams.get("returnTo"));
      const binding = randomBytes(24).toString("base64url");
      const secure = (s.settings.publicUrl ?? "").startsWith("https://");
      res.setHeader("Set-Cookie", bindingCookie(binding, secure, 600));
      try {
        if (p.kind === "oidc") {
          const { url } = await s.oidc.begin(p, {
            redirectUri: callbackUrl(s.settings, p.id),
            returnTo,
            binding,
            source,
          });
          redirect(res, url);
        } else {
          const { url } = s.saml.begin(p, {
            spEntityId: spEntityId(s.settings, p),
            acsUrl: acsUrl(s.settings, p.id),
            returnTo,
            binding,
            source,
          });
          redirect(res, url);
        }
      } catch (err) {
        const reason =
          err instanceof OidcError || err instanceof SamlError
            ? err.reason
            : "provider_unavailable";
        finish(req, res, p.id, { ok: false, reason, returnTo });
      }
    },

    ssoCallback: async (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      if (limited(req, res)) {
        return;
      }
      const s = svc();
      const p = findProvider(s.settings, ctx.params.provider ?? "");
      if (!p || p.kind !== "oidc") {
        json(res, 404, { error: { message: "unknown sign-in provider", type: "not_found" } });
        return;
      }
      const q = ctx.url.searchParams;
      let returnTo = consoleHome;
      try {
        const done = await s.oidc.complete(
          p,
          { code: q.get("code"), state: q.get("state"), error: q.get("error") },
          { redirectUri: callbackUrl(s.settings, p.id), binding: readBindingCookie(req) },
        );
        returnTo = done.returnTo;
        if (done.stepUp) {
          finishStepUp(req, res, returnTo, s.completeStepUp(done.claims, done.stepUp));
          return;
        }
        const signed = s.signIn(done.claims);
        finish(
          req,
          res,
          p.id,
          signed.ok ? { ...signed, returnTo } : { ok: false, reason: signed.reason, returnTo },
        );
      } catch (err) {
        finish(req, res, p.id, {
          ok: false,
          reason: err instanceof OidcError ? err.reason : "error",
          returnTo,
        });
      }
    },

    samlAcs: async (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      if (limited(req, res)) {
        return;
      }
      const s = svc();
      const p = findProvider(s.settings, ctx.params.provider ?? "");
      if (!p || p.kind !== "saml") {
        json(res, 404, { error: { message: "unknown sign-in provider", type: "not_found" } });
        return;
      }
      const form = await readForm(req, 1024 * 1024);
      if (!form) {
        json(res, 413, { error: { message: "request too large", type: "invalid_request_error" } });
        return;
      }
      try {
        const done = s.saml.complete(
          p,
          { SAMLResponse: form.get("SAMLResponse"), RelayState: form.get("RelayState") },
          {
            spEntityId: spEntityId(s.settings, p),
            acsUrl: acsUrl(s.settings, p.id),
            binding: readBindingCookie(req),
          },
        );
        if (done.stepUp) {
          finishStepUp(req, res, done.returnTo, s.completeStepUp(done.claims, done.stepUp), 303);
          return;
        }
        const signed = s.signIn(done.claims, { notAfterMs: done.sessionNotOnOrAfter });
        // 303: the browser follows a POST with a GET.
        finish(
          req,
          res,
          p.id,
          signed.ok
            ? { ...signed, returnTo: done.returnTo }
            : { ok: false, reason: signed.reason, returnTo: done.returnTo },
          303,
        );
      } catch (err) {
        finish(
          req,
          res,
          p.id,
          {
            ok: false,
            reason: err instanceof SamlError ? err.reason : "error",
            returnTo: consoleHome,
          },
          303,
        );
      }
    },

    /**
     * Step-up: re-authenticate the person of the presenting session at the IdP (OIDC
     * `max_age=0` + `prompt=login`, SAML `ForceAuthn`). Returns the IdP URL for the console to
     * open (popup or same window); the callback records the fresh authentication on this
     * session only. The provider is the session's own unless the body names another provider
     * the person is linked to.
     */
    startStepUp: async (req: IncomingMessage, res: ServerResponse) => {
      const person = getHttpPerson(req);
      if (!person) {
        json(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
        return;
      }
      if (limited(req, res)) {
        return;
      }
      const raw = await readBody(req, 4096);
      let body: { returnTo?: unknown; provider?: unknown } = {};
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        body = parsed && typeof parsed === "object" ? (parsed as typeof body) : {};
      } catch {
        json(res, 400, { error: { message: "invalid JSON", type: "invalid_request_error" } });
        return;
      }
      const source = startAllowed(req, res);
      if (source === null) {
        return;
      }
      const s = svc();
      const session = s.sessions.get(person.sessionId);
      const providerId = typeof body.provider === "string" ? body.provider : person.providerId;
      const p = findProvider(s.settings, providerId);
      const linked = s.store
        .getPerson(person.personId)
        ?.links.some((l) => l.providerId === providerId);
      const refuse = (status: number, type: string, message: string) => {
        recordAuditEvent({
          action: "identity.stepup.start",
          outcome: "denied",
          source: "gateway.http",
          identity: person.principal,
          detail: { provider: providerId, session: person.sessionId, reason: type },
        });
        json(res, status, { error: { message, type } });
      };
      if (!session) {
        refuse(401, "unauthorized", "Unauthorized");
        return;
      }
      if (!p || !linked) {
        refuse(400, "no_provider", "no sign-in provider linked to this person for a step-up");
        return;
      }
      const returnTo = returnTarget(typeof body.returnTo === "string" ? body.returnTo : null);
      const binding = randomBytes(24).toString("base64url");
      const secure = (s.settings.publicUrl ?? "").startsWith("https://");
      const stepUp = { sessionId: session.id, personId: person.personId };
      try {
        const { url } =
          p.kind === "oidc"
            ? await s.oidc.begin(p, {
                redirectUri: callbackUrl(s.settings, p.id),
                returnTo,
                binding,
                source,
                stepUp,
              })
            : s.saml.begin(p, {
                spEntityId: spEntityId(s.settings, p),
                acsUrl: acsUrl(s.settings, p.id),
                returnTo,
                binding,
                source,
                stepUp,
              });
        res.setHeader("Set-Cookie", bindingCookie(binding, secure, 600));
        recordAuditEvent({
          action: "identity.stepup.start",
          outcome: "allowed",
          source: "gateway.http",
          identity: person.principal,
          detail: { provider: p.id, protocol: p.kind, session: session.id },
        });
        json(res, 200, { ok: true, url, provider: p.id });
      } catch (err) {
        const reason =
          err instanceof OidcError || err instanceof SamlError
            ? err.reason
            : "provider_unavailable";
        refuse(502, reason, "the sign-in provider could not start a step-up");
      }
    },

    /** The console trades the one-time code from `#sso_code=` for the session token, once. */
    exchangeSsoCode: async (req: IncomingMessage, res: ServerResponse) => {
      if (limited(req, res)) {
        return;
      }
      const raw = await readBody(req, 4096);
      let code = "";
      try {
        const body = raw ? (JSON.parse(raw) as { code?: unknown }) : null;
        code = typeof body?.code === "string" ? body.code : "";
      } catch {
        code = "";
      }
      const entry = code ? codes.get(code) : undefined;
      const binding = readBindingCookie(req);
      const secure = (svc().settings.publicUrl ?? "").startsWith("https://");
      res.setHeader("Set-Cookie", bindingCookie("", secure, 0));
      if (entry) {
        // Single use, whatever the outcome: a guessed or replayed code burns the sign-in.
        codes.delete(code);
      }
      const reason = !entry
        ? "code_unknown"
        : entry.expiresAt <= now()
          ? "code_expired"
          : !binding || !sameSecret(binding, entry.binding)
            ? "browser_mismatch"
            : null;
      recordAuditEvent({
        action: "identity.sso.exchange",
        outcome: reason ? "denied" : "allowed",
        source: "gateway.http",
        detail: { reason, session: entry?.sessionId ?? null },
      });
      if (reason || !entry) {
        if (entry) {
          svc().sessions.revoke(entry.sessionId, `sso_${reason}`);
        }
        const key = deps.attemptKey(req);
        if (key) {
          authAttemptLimiter.record(key);
        }
        json(res, 400, { error: { message: "sign-in code refused", type: reason } });
        return;
      }
      json(res, 200, { token: entry.token });
    },

    samlMetadata: (
      _req: IncomingMessage,
      res: ServerResponse,
      ctx: { url: URL; params: Record<string, string> },
    ) => {
      const s = svc().settings;
      const p = findProvider(s, ctx.params.provider ?? "");
      if (!p || p.kind !== "saml") {
        json(res, 404, { error: { message: "unknown sign-in provider", type: "not_found" } });
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/samlmetadata+xml; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(spMetadataXml({ spEntityId: spEntityId(s, p), acsUrl: acsUrl(s, p.id) }));
    },

    getIdentitySession: (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      if (!p) {
        json(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
        return;
      }
      json(res, 200, {
        ok: true,
        principal: p.principal,
        person: {
          id: p.personId,
          email: p.email,
          displayName: p.displayName,
          providerId: p.providerId,
        },
        roles: p.roles,
        units: p.units,
        scope: p.scope,
        approvals: p.approvals,
        session: { id: p.sessionId, expiresAt: p.expiresAt },
        // When and how the person last authenticated (sign-in or step-up); null for old sessions.
        auth: p.auth,
      });
    },

    logoutIdentity: async (req: IncomingMessage, res: ServerResponse) => {
      const p = getHttpPerson(req);
      if (!p) {
        json(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
        return;
      }
      const s = svc();
      const session = s.sessions.get(p.sessionId);
      const hint = session?.idTokenHint ?? null;
      s.sessions.revoke(p.sessionId, "logout");
      recordAuditEvent({
        action: "identity.sso.logout",
        outcome: "allowed",
        source: "gateway.http",
        identity: p.principal,
        detail: { provider: p.providerId, session: p.sessionId },
      });
      const provider = findProvider(s.settings, p.providerId);
      const endSessionUrl =
        provider?.kind === "oidc"
          ? await s.oidc.endSessionUrl(provider, {
              idTokenHint: hint,
              postLogoutRedirectUri: `${s.settings.publicUrl ?? ""}/`,
            })
          : null;
      json(res, 200, { ok: true, endSessionUrl });
    },
  };
}
