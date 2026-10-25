// HTTP gates for exposed gateways (KoLo 2.0, M2a — CSO Gap C).
//
// 1. Credential attempt limiter: credential-bearing requests from a source that exceeded
//    20 attempts/min get 429 + Retry-After. Every POST to /api/auth/* counts; any other
//    credential-bearing request counts when it ends in 401/403. Local direct requests are exempt.
// 2. Routes that used to be open to any client (canvas host, A2UI, control UI avatars) require
//    gateway auth for non-local clients. Route inventory (non-local client):
//      /health, /api/health ........... open (liveness only)
//      /api/admin/*, /metrics ......... gateway token or admin session (http-admin-auth.ts)
//      /tools/invoke, /v1/* ........... gateway token/password
//      hooks base path ................ hooks token
//      /api/auth/* .................... public login flow, rate limited
//      /api/migrate, /api/bootstrap-invite  X-Migrate-Key, rate limited
//      Slack + plugin channel webhooks  provider signature verification
//      control UI static assets ....... public bundle; all data flows over the authenticated WS
//      /__KOLO__/*, <ui>/avatar/* ..... gateway auth or an SSO session (this file)
// With `gateway.identity.ssoRequired` the shared secret no longer opens these routes from other
// hosts (http-shared-secret.ts): people use their SSO session.
import type { IncomingMessage, ServerResponse } from "node:http";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../canvas-host/a2ui.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { authorizeGatewayConnect, isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { sendUnauthorized } from "./http-common.js";
import { mayUseSharedSecret } from "./http-shared-secret.js";
import { getBearerToken } from "./http-utils.js";
import { resolveGatewayClientIp } from "./net.js";
import {
  type AuthAttemptLimiter,
  authAttemptLimiter,
  isAuthBearingPath,
  sendAuthRateLimited,
} from "./rate-limiter.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveAttemptKey(req: IncomingMessage, trustedProxies?: string[]): string {
  return (
    resolveGatewayClientIp({
      remoteAddr: req.socket?.remoteAddress ?? "",
      forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
      realIp: headerValue(req.headers?.["x-real-ip"]),
      trustedProxies,
    }) ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function carriesCredentials(req: IncomingMessage): boolean {
  return Boolean(
    req.headers?.authorization ||
    req.headers?.["x-migrate-key"] ||
    req.headers?.["x-kolo-token"] ||
    req.headers?.["x-kolo-hook-token"],
  );
}

/**
 * Returns true when the request was rejected (429 written). Otherwise registers the attempt
 * accounting and returns false.
 */
export function applyAuthAttemptGate(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { trustedProxies?: string[]; limiter?: AuthAttemptLimiter } = {},
): boolean {
  const limiter = opts.limiter ?? authAttemptLimiter;
  const pathname = pathnameOf(req);
  if (!isAuthBearingPath(pathname) && !carriesCredentials(req)) {
    return false;
  }
  if (isLocalDirectRequest(req, opts.trustedProxies)) {
    return false;
  }
  const key = resolveAttemptKey(req, opts.trustedProxies);
  const decision = limiter.check(key);
  if (!decision.allowed) {
    recordAuditEvent({
      action: "auth.rate_limited",
      outcome: "denied",
      source: "gateway.http",
      detail: { path: pathname, ip: key, retryAfterMs: decision.retryAfterMs },
    });
    sendAuthRateLimited(res, decision.retryAfterMs, limiter.maxAttempts);
    return true;
  }
  const isLoginAttempt =
    (pathname.startsWith("/api/auth/") || pathname.startsWith("/auth/")) && req.method === "POST";
  if (isLoginAttempt) {
    limiter.record(key);
    return false;
  }
  res.once("finish", () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      limiter.record(key);
    }
  });
  return false;
}

export function isRemoteGatedPath(pathname: string, controlUiBasePath = ""): boolean {
  if (
    pathname.startsWith(A2UI_PATH) ||
    pathname.startsWith(CANVAS_HOST_PATH) ||
    pathname.startsWith(CANVAS_WS_PATH) ||
    pathname.startsWith("/__KOLO__/")
  ) {
    return true;
  }
  const avatarPrefix = `${controlUiBasePath}/avatar/`;
  return pathname.startsWith(avatarPrefix);
}

export type RemoteGateOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  controlUiBasePath?: string;
  /** `gateway.identity.ssoRequired` as of this request (default false). */
  ssoRequired?: boolean;
  /** A valid SSO session (Bearer `kss_…`) of a person who may observe. */
  ssoSession?: (req: IncomingMessage) => boolean;
};

/** Credentials a non-local client may open the remote-gated routes with. */
async function remoteCredentialOk(req: IncomingMessage, opts: RemoteGateOptions): Promise<boolean> {
  if (opts.ssoSession?.(req)) {
    return true;
  }
  const bearer = getBearerToken(req);
  const result = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: bearer ? { token: bearer, password: bearer } : null,
    req,
    trustedProxies: opts.trustedProxies,
  });
  return (
    result.ok &&
    mayUseSharedSecret(
      req,
      { ssoRequired: opts.ssoRequired === true, trustedProxies: opts.trustedProxies },
      { credential: "shared-secret", operation: "remote-gated" },
    )
  );
}

/**
 * Returns true when the request was rejected (401 written): a non-local client asked for a
 * route that used to be open (canvas, A2UI, avatars) without gateway credentials.
 */
export async function rejectUnauthenticatedRemoteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RemoteGateOptions,
): Promise<boolean> {
  if (!isRemoteGatedPath(pathnameOf(req), opts.controlUiBasePath ?? "")) {
    return false;
  }
  if (isLocalDirectRequest(req, opts.trustedProxies)) {
    return false;
  }
  if (await remoteCredentialOk(req, opts)) {
    return false;
  }
  sendUnauthorized(res);
  return true;
}

export function upgradePathname(req: IncomingMessage): string {
  return pathnameOf(req);
}

/** Upgrade (WS) variant of the remote gate: local direct clients pass; others need credentials. */
export async function isRemoteUpgradeAuthorized(
  req: IncomingMessage,
  auth: ResolvedGatewayAuth,
  trustedProxies: string[],
  extra: Pick<RemoteGateOptions, "ssoRequired" | "ssoSession"> = {},
): Promise<boolean> {
  if (isLocalDirectRequest(req, trustedProxies)) {
    return true;
  }
  return await remoteCredentialOk(req, { auth, trustedProxies, ...extra });
}
