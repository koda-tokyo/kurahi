// Gateway handshake rules for enterprise identity, and who counts as a person.
//
// 1. An SSO session token (`kss_…`) in `auth.token` authenticates a *person*. The session is
//    checked on connect and again on every request; revocation closes the socket.
// 2. With `gateway.identity.ssoRequired`, people must use SSO. Allowed without SSO:
//    - node connections of a paired device: the device token, or a device identity (key proof)
//      that goes through device pairing; never the shared secret alone;
//    - agent connections (backend mode / gateway-client) from the gateway host itself (audited);
//    - break-glass: the gateway token or password with `auth.breakGlass: "<reason>"`, from the
//      gateway host unless `breakGlass.localOnly: false`. Audited and sealed as evidence.
//    Refused: every other token, password, pairing-credential, device-token or Tailscale login.
// 3. Personhood (work item decisions, autopilot approvals, the global stop, …) comes from the
//    credential the connection authenticated with, never from what the client declares about
//    itself: see `nonPersonReason`.
import type { IdentitySettings } from "./config.js";
import type { PersonPrincipal } from "./types.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { recordIdentityChange } from "./evidence.js";

export type SsoGateInput = {
  settings: IdentitySettings;
  /** How the connection authenticated: token, password, tailscale, pair-credential, device-token, sso. */
  authMethod: string;
  person: PersonPrincipal | null;
  role: string;
  client: { id?: string; mode?: string; displayName?: string };
  localDirect: boolean;
  breakGlass: string | null;
  ip: string | null;
  /** The handshake carried a verified device identity (key proof); it then goes through pairing. */
  hasDevice?: boolean;
};

export type SsoGateResult =
  | { ok: true; breakGlass: boolean }
  | { ok: false; reason: string; message: string };

export function isAgentClient(client: SsoGateInput["client"]): boolean {
  return client.mode === "backend" || client.id === "gateway-client";
}

/** Owner secrets: the gateway token or password (what break-glass is made of). */
function isOwnerSecret(authMethod: string): boolean {
  return authMethod === "token" || authMethod === "password";
}

function recordBreakGlass(input: SsoGateInput, reason: string): void {
  recordAuditEvent({
    action: "identity.breakglass.login",
    outcome: "allowed",
    source: "gateway.ws",
    identity: "owner",
    detail: {
      reason: reason.slice(0, 500),
      client: input.client.id ?? null,
      mode: input.client.mode ?? null,
      ip: input.ip,
    },
  });
  recordIdentityChange({
    action: "identity.breakglass.login",
    actor: "owner",
    authority: "break-glass",
    outcome: "ok",
    detail: {
      reason: reason.slice(0, 500),
      client: input.client.id ?? null,
      local: input.localDirect,
    },
  });
}

export function ssoRequiredGate(input: SsoGateInput): SsoGateResult {
  const { settings } = input;
  const reason = input.breakGlass?.trim() ?? "";
  const ownerSecret = isOwnerSecret(input.authMethod);
  const breakGlassAllowed = input.localDirect || !settings.breakGlassLocalOnly;
  if (input.person) {
    return { ok: true, breakGlass: false };
  }
  if (input.role === "node") {
    // A node is a device: under ssoRequired it connects with its paired device token, or with a
    // device identity that device pairing then checks (and an admin approves). The shared secret
    // without a device would let anyone holding it pose as a node.
    const deviceBound = input.authMethod === "device-token" || input.hasDevice === true;
    if (!settings.ssoRequired || deviceBound) {
      return { ok: true, breakGlass: false };
    }
    recordAuditEvent({
      action: "identity.sso_required.node",
      outcome: "denied",
      source: "gateway.ws",
      identity: input.authMethod,
      detail: { client: input.client.id ?? null, ip: input.ip, local: input.localDirect },
    });
    return {
      ok: false,
      reason: "sso_required_node_device",
      message:
        "SSO is required: nodes connect as a paired device (device identity or device token)",
    };
  }
  if (!settings.ssoRequired) {
    // Identity configured, SSO optional: the owner secret alone is not a person, but an owner
    // who states a reason becomes an audited break-glass person (agents never do).
    if (
      settings.configured &&
      reason &&
      ownerSecret &&
      breakGlassAllowed &&
      !isAgentClient(input.client)
    ) {
      recordBreakGlass(input, reason);
      return { ok: true, breakGlass: true };
    }
    return { ok: true, breakGlass: false };
  }
  if (isAgentClient(input.client)) {
    // The agent exemption is admitted on the gateway host only, and every use is audited: a
    // local process can claim backend mode, so the trail is what keeps the claim honest. Such a
    // connection is never a person (`nonPersonReason`).
    recordAuditEvent({
      action: "identity.sso_required.agent",
      outcome: input.localDirect ? "allowed" : "denied",
      source: "gateway.ws",
      identity: input.authMethod,
      detail: {
        client: input.client.id ?? null,
        mode: input.client.mode ?? null,
        ip: input.ip,
        local: input.localDirect,
      },
    });
    return input.localDirect
      ? { ok: true, breakGlass: false }
      : {
          ok: false,
          reason: "sso_required_agent_remote",
          message: "SSO is required: agent connections are accepted only on the gateway host",
        };
  }
  if (reason && ownerSecret && breakGlassAllowed) {
    recordBreakGlass(input, reason);
    return { ok: true, breakGlass: true };
  }
  recordAuditEvent({
    action: "identity.sso_required",
    outcome: "denied",
    source: "gateway.ws",
    identity: input.authMethod,
    detail: {
      client: input.client.id ?? null,
      ip: input.ip,
      breakGlass: Boolean(reason),
      local: input.localDirect,
    },
  });
  const message =
    reason && ownerSecret
      ? "SSO is required: break-glass logins are accepted only on the gateway host"
      : reason
        ? "SSO is required: break-glass needs the gateway token or password"
        : "SSO is required: sign in with your organisation account";
  return { ok: false, reason: "sso_required", message };
}

/** What personhood is decided from: the authenticated credential, plus the declared client. */
export type PersonhoodClient = {
  connect?: {
    role?: string;
    client?: { id?: string; mode?: string; displayName?: string };
  } | null;
  person?: PersonPrincipal | null;
  pairing?: unknown;
  /** Credential the handshake verified (token, password, tailscale, device-token, …, sso). */
  authMethod?: string;
  breakGlass?: boolean;
};

/**
 * Why a connection is an agent (or not an operator) by what it declares, or null. Declared
 * agent fields only ever take personhood away: they never grant it.
 */
export function declaredAgentOrigin(client: PersonhoodClient | null | undefined): string | null {
  if (!client?.connect) {
    return "no client connection";
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return `role ${role}`;
  }
  const info = client.connect.client;
  if (info?.mode === "backend" || info?.id === "gateway-client") {
    return "agent tool connection";
  }
  if (typeof info?.displayName === "string" && /^agent$/i.test(info.displayName.trim())) {
    return "agent connection";
  }
  return null;
}

/**
 * The one person check for every person-only method: why the connection is not a person, or
 * null when it is.
 *
 * - Agent runtimes and gateway-client connections are never persons (`declaredAgentOrigin`).
 * - An SSO session is a person.
 * - With identity configured (`gateway.identity` has providers, SCIM or `ssoRequired`), nothing
 *   else is, except an audited break-glass login with a reason.
 * - Without it (single-user installs), or with `gateway.identity.localPersons: true` while SSO
 *   is not required, the gateway token, password, Tailscale login, device tokens and pairing
 *   credentials count as the local person, as before.
 */
export function nonPersonReason(
  client: PersonhoodClient | null | undefined,
  settings: Pick<IdentitySettings, "localPersons">,
): string | null {
  const declared = declaredAgentOrigin(client);
  if (declared) {
    return declared;
  }
  if (client?.person) {
    return null;
  }
  if (client?.breakGlass) {
    return null;
  }
  if (settings.localPersons) {
    return null;
  }
  return `${client?.authMethod ?? "unknown"} credential is not a person under enterprise identity`;
}

/**
 * The highest-impact person-only decisions. With identity configured they need an SSO person
 * session: break-glass (and `localPersons`) prove only that the caller holds the gateway secret,
 * which an agent with shell access on the gateway host can read, so they keep admin and recovery
 * powers (identity admin, the global stop, pause) but not these decisions. Single-user installs
 * without identity config are unchanged.
 *
 * `autopilot.stopAll` is deliberately not here: the emergency stop must keep working during an
 * IdP outage, and an agent that can read the gateway secret can stop the gateway anyway.
 */
export const SSO_PERSON_DECISIONS: ReadonlySet<string> = new Set([
  "workitems.decide",
  "workitems.clearFlag",
  "autopilot.approvals.create",
  "autopilot.approvals.revoke",
  "autopilot.autonomy.accept",
  "autopilot.startAll",
]);

/** `nonPersonReason` for an `SSO_PERSON_DECISIONS` method: why the caller may not decide, or null. */
export function nonDeciderReason(
  client: PersonhoodClient | null | undefined,
  settings: Pick<IdentitySettings, "localPersons" | "configured">,
): string | null {
  const notPerson = nonPersonReason(client, settings);
  if (notPerson || !settings.configured || client?.person) {
    return notPerson;
  }
  const via = client?.breakGlass ? "break-glass" : `${client?.authMethod ?? "unknown"} credential`;
  return `${via} login: this decision needs an SSO sign-in under enterprise identity`;
}
