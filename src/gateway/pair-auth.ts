// Bearer authorization for HTTP with the M3a scope model.
//
// A Bearer value is either the gateway's own secret (owner) or a pairing access token
// (`kpa_…`, bound to a device key, carrying one scope). Routes resolve the principal once here;
// handlers read it back with getHttpPrincipal().
import type { IncomingMessage } from "node:http";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken } from "./http-utils.js";
import {
  ACCESS_TOKEN_PREFIX,
  type CredentialStore,
  getCredentialStore,
  type HttpPrincipal,
} from "./pair-store.js";
import { type PairScope, scopeSatisfies } from "./scopes.js";

const principals = new WeakMap<IncomingMessage, HttpPrincipal>();

export function setHttpPrincipal(req: IncomingMessage, principal: HttpPrincipal): void {
  principals.set(req, principal);
}

export function getHttpPrincipal(req: IncomingMessage): HttpPrincipal | undefined {
  return principals.get(req);
}

/**
 * Drop the principal of a credential that verified but a later gate refused (SSO required, not
 * from the gateway host), so policy and audit never see "owner" for a request that another
 * authenticator (an SSO session) then admits.
 */
export function clearHttpPrincipal(req: IncomingMessage): void {
  principals.delete(req);
}

/** Identity string for audit lines: "owner:token", "device:<fingerprint>" … */
export function principalIdentity(principal: HttpPrincipal): string {
  return principal.kind === "owner"
    ? `owner:${principal.user ?? principal.method}`
    : `device:${principal.fingerprint}`;
}

export function isPairAccessToken(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(ACCESS_TOKEN_PREFIX);
}

export type BearerAuthResult =
  | { ok: true; principal: HttpPrincipal }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Resolve the request's Bearer credential. Owner secrets (token/password/Tailscale) satisfy
 * any scope; a pairing access token must be live (family not revoked, device approved, not
 * expired, no re-consent due) and hold at least `minScope`.
 */
export async function authorizeHttpBearer(
  req: IncomingMessage,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    minScope?: PairScope;
    store?: CredentialStore;
  },
): Promise<BearerAuthResult> {
  const bearer = getBearerToken(req);
  if (isPairAccessToken(bearer)) {
    const store = opts.store ?? getCredentialStore();
    const verified = store.verifyAccess(bearer);
    if (!verified.ok) {
      return { ok: false, status: 401, reason: verified.reason };
    }
    const required = opts.minScope ?? "admin";
    if (!scopeSatisfies(verified.principal.scope, required)) {
      return { ok: false, status: 403, reason: `scope_insufficient:${required}` };
    }
    setHttpPrincipal(req, verified.principal);
    return { ok: true, principal: verified.principal };
  }
  const result = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: bearer ? { token: bearer, password: bearer } : null,
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!result.ok) {
    return { ok: false, status: 401, reason: result.reason ?? "unauthorized" };
  }
  const method =
    result.method === "tailscale"
      ? "tailscale"
      : result.method === "password"
        ? "password"
        : "token";
  const principal: HttpPrincipal = { kind: "owner", scope: "owner", method, user: result.user };
  setHttpPrincipal(req, principal);
  return { ok: true, principal };
}
