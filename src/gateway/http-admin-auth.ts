// Auth gate for privileged HTTP routes (KoLo 2.0, M1b / CSO gate M2):
// `/api/admin/*` and `/metrics` require either the gateway shared secret as a Bearer token
// (same check as /tools/invoke) or a valid `kolo_session` with the admin role.
// `/health` and `/api/health` stay open. With `gateway.identity.ssoRequired` every credential
// here passes the shared-secret check (http-shared-secret.ts): gateway host only, and the shared
// secret only as audited break-glass.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { PairScope } from "./scopes.js";
import { getAdminSessionUser } from "./auth-api.js";
import { sendForbidden, sendUnauthorized } from "./http-common.js";
import { mayUseSharedSecret } from "./http-shared-secret.js";
import { getBearerToken } from "./http-utils.js";
import { authorizeHttpBearer, clearHttpPrincipal, isPairAccessToken } from "./pair-auth.js";

export function isProtectedAdminPath(pathname: string): boolean {
  // Matches the handlers' own prefix test (`startsWith("/api/admin")`), so nothing they serve
  // slips past the gate.
  return pathname === "/metrics" || pathname.startsWith("/api/admin");
}

/** Pairing scope the prefix gate requires: /metrics is readable, /api/admin/* needs admin. */
function adminGateMinScope(pathname: string): PairScope {
  return pathname === "/metrics" ? "observe" : "admin";
}

export async function authorizeAdminHttpRequest(
  req: IncomingMessage,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    minScope?: PairScope;
    /** `gateway.identity.ssoRequired` as of this request (default false). */
    ssoRequired?: boolean;
  },
): Promise<true | 401 | 403> {
  const gate = { ssoRequired: opts.ssoRequired === true, trustedProxies: opts.trustedProxies };
  const operation = adminOperation(req);
  const bearerResult = await authorizeHttpBearer(req, {
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    minScope: opts.minScope ?? "admin",
  });
  if (bearerResult.ok) {
    const credential = isPairAccessToken(getBearerToken(req)) ? "pairing" : "shared-secret";
    if (mayUseSharedSecret(req, gate, { credential, operation })) {
      return true;
    }
    clearHttpPrincipal(req);
    return 401;
  }
  if (
    (await getAdminSessionUser(req)) &&
    mayUseSharedSecret(req, gate, { credential: "legacy-session", operation })
  ) {
    return true;
  }
  return bearerResult.status;
}

function adminOperation(req: IncomingMessage): string {
  return `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}`;
}

/**
 * Returns true when the request was for a protected path and has been rejected (401 sent).
 * Returns false when the caller should continue routing.
 */
export async function rejectUnauthorizedAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; trustedProxies?: string[]; ssoRequired?: boolean },
): Promise<boolean> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (!isProtectedAdminPath(pathname)) {
    return false;
  }
  const decision = await authorizeAdminHttpRequest(req, {
    ...opts,
    minScope: adminGateMinScope(pathname),
  });
  if (decision === true) {
    return false;
  }
  if (decision === 403) {
    sendForbidden(res);
    return true;
  }
  sendUnauthorized(res);
  return true;
}
