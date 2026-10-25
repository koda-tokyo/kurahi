// The one check for "may the gateway's shared secret be used here" over HTTP.
//
// Every HTTP gate that accepts the gateway token or password (the route registry's gateway-token
// authenticator, the /api/admin/* and /metrics prefix gate, the canvas / A2UI / avatar gate)
// asks this function after the credential itself verified, so `gateway.identity.ssoRequired`
// means the same thing on every path:
//
//   - SSO not required: the shared secret works as before.
//   - SSO required, request from another host: refused (people use their SSO session).
//   - SSO required, request on the gateway host: break-glass only, i.e. a stated reason in
//     `X-KoLo-Break-Glass` and an audit entry per request, or refused.
//
// Pairing credentials and the legacy admin session (`kolo_session`) are not the shared secret,
// but they are not SSO either: under ssoRequired they work from the gateway host only (no
// reason needed), as the route registry already did for pairing credentials.
import type { IncomingMessage } from "node:http";
import { recordAuditEvent } from "../security/audit-log.js";
import { isLocalDirectRequest } from "./auth.js";

/** Header carrying the break-glass reason of an HTTP request made with the gateway token. */
export const BREAK_GLASS_HEADER = "x-kolo-break-glass";

/** Break-glass check for a gateway-token HTTP request while SSO is required (audited). */
export function httpBreakGlass(req: IncomingMessage, operation: string | null): boolean {
  const raw = req.headers[BREAK_GLASS_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  let reason = value;
  try {
    // Clients percent-encode the reason (header values are ASCII); a plain value passes as is.
    reason = decodeURIComponent(value);
  } catch {
    // not percent-encoded: keep the raw value
  }
  reason = reason.trim().slice(0, 500);
  recordAuditEvent({
    action: "identity.breakglass.http",
    outcome: reason ? "allowed" : "denied",
    source: "gateway.http",
    identity: "owner",
    detail: { reason: reason || null, operation, path: pathOf(req) },
  });
  return Boolean(reason);
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? "").split("?")[0] ?? "";
}

export type SharedSecretGate = {
  /** `gateway.identity.ssoRequired` as of this request. */
  ssoRequired: boolean;
  trustedProxies?: string[];
};

/** What verified: the shared secret (token, password, Tailscale owner), or a non-SSO credential. */
export type HttpCredentialKind = "shared-secret" | "pairing" | "legacy-session";

/**
 * May this already-verified credential authenticate this HTTP request? See the file header.
 * Refusals of a valid credential from another host are audited (`identity.sso_required`).
 */
export function mayUseSharedSecret(
  req: IncomingMessage,
  gate: SharedSecretGate,
  use: { credential: HttpCredentialKind; operation: string | null },
): boolean {
  if (!gate.ssoRequired) {
    return true;
  }
  if (!isLocalDirectRequest(req, gate.trustedProxies)) {
    recordAuditEvent({
      action: "identity.sso_required",
      outcome: "denied",
      source: "gateway.http",
      identity: use.credential,
      detail: { operation: use.operation, path: pathOf(req), local: false },
    });
    return false;
  }
  return use.credential === "shared-secret" ? httpBreakGlass(req, use.operation) : true;
}
