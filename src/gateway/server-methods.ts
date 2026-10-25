import type { GatewayRequestHandlers, GatewayRequestOptions } from "./server-methods/types.js";
import {
  adminAreaAllows,
  CONFIG_SCOPE,
  IDENTITY_SCOPE,
  legacyScopesForPerson,
  POLICY_SCOPE,
} from "../identity/rbac.js";
import { getIdentityService } from "../identity/service.js";
import { getPolicyEngine } from "../policy/engine.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { voiceApprovalRefusal } from "../voice/approval-guard.js";
import { getCredentialStore } from "./pair-store.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import { scopeSatisfies, wsMethodMinScope } from "./scopes.js";
import { agentHandlers } from "./server-methods/agent.js";
import { agentsHandlers } from "./server-methods/agents.js";
import {
  AUTOPILOT_APPROVAL_METHODS,
  AUTOPILOT_READ_METHODS,
  AUTOPILOT_WRITE_METHODS,
  autopilotHandlers,
} from "./server-methods/autopilot.js";
import { browserHandlers } from "./server-methods/browser.js";
import { channelsHandlers } from "./server-methods/channels.js";
import { chatHandlers } from "./server-methods/chat.js";
import { codeModeHandlers } from "./server-methods/code-mode.js";
import { configHandlers } from "./server-methods/config.js";
import { connectHandlers } from "./server-methods/connect.js";
import { connectorsHandlers } from "./server-methods/connectors.js";
import { cronHandlers } from "./server-methods/cron.js";
import { debugHandlers } from "./server-methods/debug.js";
import { deviceHandlers } from "./server-methods/devices.js";
import { execApprovalsHandlers } from "./server-methods/exec-approvals.js";
import { healthHandlers } from "./server-methods/health.js";
import { IDENTITY_READ_METHODS, identityHandlers } from "./server-methods/identity.js";
import { integrityHandlers } from "./server-methods/integrity.js";
import { jobsHandlers } from "./server-methods/jobs.js";
import { logsHandlers } from "./server-methods/logs.js";
import { modelsHandlers } from "./server-methods/models.js";
import { nodeHandlers } from "./server-methods/nodes.js";
import { pairHandlers } from "./server-methods/pair.js";
import { pluginsHandlers } from "./server-methods/plugins.js";
import { policyHandlers } from "./server-methods/policy.js";
import {
  PROJECT_READ_METHODS,
  PROJECT_WRITE_METHODS,
  projectsHandlers,
} from "./server-methods/projects.js";
import { sendHandlers } from "./server-methods/send.js";
import { sessionAttachHandlers, sessionsHandlers } from "./server-methods/sessions.js";
import { siblingHandlers } from "./server-methods/sibling.js";
import { skillsHandlers } from "./server-methods/skills.js";
import { systemHandlers } from "./server-methods/system.js";
import { talkHandlers } from "./server-methods/talk.js";
import { ttsHandlers } from "./server-methods/tts.js";
import { updateHandlers } from "./server-methods/update.js";
import { usageHandlers } from "./server-methods/usage.js";
import { VOICE_METHODS, voiceHandlers } from "./server-methods/voice.js";
import { voicewakeHandlers } from "./server-methods/voicewake.js";
import { webHandlers } from "./server-methods/web.js";
import { wizardHandlers } from "./server-methods/wizard.js";
import {
  WORKITEMS_READ_METHODS,
  WORKITEMS_WRITE_METHODS,
  workitemsHandlers,
} from "./server-methods/workitems.js";
import { sessionAllowed, sessionIdentityFromKey } from "./session-allowlist.js";

const ADMIN_SCOPE = "operator.admin";
const READ_SCOPE = "operator.read";
const WRITE_SCOPE = "operator.write";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const APPROVAL_METHODS = new Set([
  "exec.approval.request",
  "exec.approval.resolve",
  "workitems.decide",
  "workitems.delegate",
  "workitems.clearFlag",
  ...AUTOPILOT_APPROVAL_METHODS,
]);
const NODE_ROLE_METHODS = new Set(["node.invoke.result", "node.event", "skills.bins"]);
const PAIRING_METHODS = new Set([
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "device.pair.list",
  "device.pair.approve",
  "device.pair.reject",
  "device.token.rotate",
  "device.token.revoke",
  "node.rename",
]);
const ADMIN_METHOD_PREFIXES = ["exec.approvals."];
const READ_METHODS = new Set([
  "health",
  "health.deep",
  "integrity.status",
  "policy.status",
  "logs.tail",
  "channels.status",
  "status",
  "usage.status",
  "usage.cost",
  "tts.status",
  "tts.providers",
  "models.list",
  "agents.list",
  "agent.identity.get",
  "skills.status",
  "voicewake.get",
  "sessions.list",
  "sessions.preview",
  "sessions.discover",
  "jobs.list",
  "jobs.get",
  "cron.list",
  "cron.status",
  "cron.runs",
  "system-presence",
  "last-heartbeat",
  "node.list",
  "node.describe",
  "chat.history",
  "sibling.history",
  "pair.nonce",
  "pair.redeem",
  "pair.refresh",
  "pair.me",
  "mcp.status",
  "connectors.status",
  "plugins.list",
  ...PROJECT_READ_METHODS,
  ...WORKITEMS_READ_METHODS,
  ...IDENTITY_READ_METHODS,
  ...AUTOPILOT_READ_METHODS,
]);
const WRITE_METHODS = new Set([
  "send",
  "agent",
  "agent.wait",
  "wake",
  "talk.mode",
  "tts.enable",
  "tts.disable",
  "tts.convert",
  "tts.setProvider",
  "voicewake.set",
  "node.invoke",
  "chat.send",
  "chat.abort",
  "browser.request",
  "sibling.send",
  "sibling.subscribe",
  "sibling.read",
  "session.attach",
  "session.detach",
  "codeMode.run",
  ...VOICE_METHODS,
  ...PROJECT_WRITE_METHODS,
  ...WORKITEMS_WRITE_METHODS.filter(
    (m) => m !== "workitems.decide" && m !== "workitems.delegate" && m !== "workitems.clearFlag",
  ),
  ...AUTOPILOT_WRITE_METHODS,
]);

function authorizeGatewayMethod(method: string, client: GatewayRequestOptions["client"]) {
  if (!client?.connect) {
    return null;
  }
  const role = client.connect.role ?? "operator";
  const scopes = client.connect.scopes ?? [];
  if (NODE_ROLE_METHODS.has(method)) {
    if (role === "node") {
      return null;
    }
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role === "node") {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role !== "operator") {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return null;
  }
  // Enterprise identity admin areas: narrow scopes, never operator.admin. identity.* handlers
  // check the org role themselves.
  if (method.startsWith("identity.") && !READ_METHODS.has(method)) {
    return scopes.includes(IDENTITY_SCOPE)
      ? null
      : errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.identity");
  }
  if ((method === "policy.kill" || method === "policy.release") && scopes.includes(POLICY_SCOPE)) {
    return null;
  }
  if (APPROVAL_METHODS.has(method) && !scopes.includes(APPROVALS_SCOPE)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.approvals");
  }
  if (PAIRING_METHODS.has(method) && !scopes.includes(PAIRING_SCOPE)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.pairing");
  }
  if (READ_METHODS.has(method) && !(scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE))) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.read");
  }
  if (WRITE_METHODS.has(method) && !scopes.includes(WRITE_SCOPE)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.write");
  }
  if (APPROVAL_METHODS.has(method)) {
    return null;
  }
  if (PAIRING_METHODS.has(method)) {
    return null;
  }
  if (READ_METHODS.has(method)) {
    return null;
  }
  if (WRITE_METHODS.has(method)) {
    return null;
  }
  // Host-level methods (config.*, cron edits, skills, updates, …): the owner (operator.admin) or
  // the explicit operator.config scope, which no IdP role holds unless configRoles names it.
  if (scopes.includes(CONFIG_SCOPE)) {
    return null;
  }
  if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin");
  }
  if (
    method.startsWith("config.") ||
    method.startsWith("wizard.") ||
    method.startsWith("update.") ||
    method === "channels.logout" ||
    method === "skills.install" ||
    method === "skills.update" ||
    method === "cron.add" ||
    method === "cron.update" ||
    method === "cron.remove" ||
    method === "cron.run" ||
    method === "sessions.patch" ||
    method === "sessions.reset" ||
    method === "sessions.delete" ||
    method === "sessions.compact" ||
    method === "jobs.cancel"
  ) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin");
  }
  return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin");
}

/**
 * M3b: a paired credential with a session allowlist may only address sessions it may see. The
 * check is generic: any request naming a `sessionKey` (chat.send, chat.history, chat.abort,
 * agent, send, sessions.patch, …) or an `agentId` (agent, agent.wait) is refused when the
 * session or agent is outside the allowlist. Discovery/attach apply the same list themselves.
 */
function sessionAllowlistError(
  method: string,
  params: Record<string, unknown>,
  allowlist: string[] | undefined,
) {
  if (!allowlist || allowlist.length === 0) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (sessionKey && !sessionAllowed(allowlist, sessionIdentityFromKey(sessionKey))) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `session not allowed for this credential`);
  }
  const key = typeof params.key === "string" ? params.key.trim() : "";
  if (
    key &&
    method.startsWith("sessions.") &&
    !sessionAllowed(allowlist, sessionIdentityFromKey(key))
  ) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `session not allowed for this credential`);
  }
  const agentId = typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
  if (
    agentId &&
    !sessionKey &&
    !sessionAllowed(allowlist, { key: `agent:${agentId}:*`, agentId })
  ) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `agent not allowed for this credential`);
  }
  return null;
}

export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...logsHandlers,
  ...voicewakeHandlers,
  ...healthHandlers,
  ...integrityHandlers,
  ...policyHandlers,
  ...identityHandlers,
  ...projectsHandlers,
  ...workitemsHandlers,
  ...autopilotHandlers,
  ...jobsHandlers,
  ...channelsHandlers,
  ...chatHandlers,
  ...cronHandlers,
  ...deviceHandlers,
  ...execApprovalsHandlers,
  ...webHandlers,
  ...modelsHandlers,
  ...configHandlers,
  ...wizardHandlers,
  ...talkHandlers,
  ...ttsHandlers,
  ...skillsHandlers,
  ...sessionsHandlers,
  ...sessionAttachHandlers,
  ...codeModeHandlers,
  ...connectorsHandlers,
  ...pluginsHandlers,
  ...systemHandlers,
  ...updateHandlers,
  ...nodeHandlers,
  ...pairHandlers,
  ...sendHandlers,
  ...usageHandlers,
  ...agentHandlers,
  ...agentsHandlers,
  ...browserHandlers,
  ...siblingHandlers,
  ...voiceHandlers,
  ...debugHandlers,
};

export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;
  // M3a: a paired connection is re-checked on every request (family revocation, device
  // status, re-consent) and gated by the WS scope matrix before the legacy operator gate.
  if (client?.pairing) {
    const live = getCredentialStore().verifyPrincipal(client.pairing);
    if (!live.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.NOT_PAIRED, `credential ${live.reason}; pair again`),
      );
      return;
    }
    const required = wsMethodMinScope(req.method);
    if (!scopeSatisfies(client.pairing.scope, required)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${required}`),
      );
      return;
    }
    const allowlistError = sessionAllowlistError(
      req.method,
      (req.params ?? {}) as Record<string, unknown>,
      client.pairing.sessions,
    );
    if (allowlistError) {
      respond(false, undefined, allowlistError);
      return;
    }
  }
  // Enterprise identity: an SSO person is re-resolved on every request (logout, SCIM
  // deactivation, revocation and role changes apply at once) and gated by the same WS scope
  // matrix as pairing credentials. Its legacy operator scopes follow its roles.
  if (client?.person) {
    const live = getIdentityService().principalForSession(client.person.sessionId, {
      touch: true,
    });
    if (!live.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.NOT_PAIRED, `sign-in ${live.reason}; sign in again`),
      );
      return;
    }
    client.person = live.principal;
    client.connect.scopes = legacyScopesForPerson(live.principal);
    const required = wsMethodMinScope(req.method);
    const areaAllowed =
      required === "admin" &&
      adminAreaAllows(live.principal, req.method, {
        pairing: PAIRING_METHODS.has(req.method),
        hostLevel: !req.method.startsWith("identity."),
      });
    if (!scopeSatisfies(live.principal.scope, required) && !areaAllowed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${required}`),
      );
      return;
    }
  }
  const authError = authorizeGatewayMethod(req.method, client);
  if (authError) {
    respond(false, undefined, authError);
    return;
  }
  // Consequential actions are never approved by voice: an approval-type method carrying any
  // voice-origin marker is refused before validation and before its handler runs.
  {
    const refusal = voiceApprovalRefusal(req.method, req.params);
    if (refusal) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, refusal));
      return;
    }
  }
  // M13: every WS request is a policy decision point (kill switch on agent-driving methods,
  // `requests.deny` by operation and scope). Decided after auth so a refusal carries a rule id.
  {
    const p = (req.params ?? {}) as Record<string, unknown>;
    const agentId =
      typeof p.agentId === "string"
        ? p.agentId.trim().toLowerCase()
        : typeof p.sessionKey === "string"
          ? resolveAgentIdFromSessionKey(p.sessionKey)
          : undefined;
    const decision = getPolicyEngine().evaluate("request", {
      surface: "ws",
      operation: req.method,
      scope: client?.pairing?.scope ?? client?.person?.scope ?? "owner",
      agentId: agentId || undefined,
    });
    if (decision.effect !== "allow") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `policy: ${decision.reason} (rule ${decision.ruleId})`,
          {
            details: { rule: decision.ruleId, effect: decision.effect },
          },
        ),
      );
      return;
    }
  }
  const handler = opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
  if (!handler) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`),
    );
    return;
  }
  await handler({
    req,
    params: (req.params ?? {}) as Record<string, unknown>,
    client,
    isWebchatConnect,
    respond,
    context,
  });
}
