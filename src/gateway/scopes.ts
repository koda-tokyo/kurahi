// Scope model for pairing credentials (KoLo 2.0, M3a).
//
//   owner  > admin > attach > observe
//
// `owner` is the per-gateway token file (and password mode / verified Tailscale identity): it is
// the surface that can mint anything. `admin` manages the gateway (config, pairing, cron, …).
// `attach` can drive sessions (chat, agent turns, tool invocation). `observe` can only read.
//
// Every HTTP route in the registry declares its minimum scope (default admin, so nothing is
// accidentally open to a lesser credential) and every WebSocket method resolves to one through
// the table below (default admin as well). Both tables are enforced server-side: the HTTP router
// answers 403 and the WS dispatcher refuses the request before any handler runs.

export const PAIR_SCOPES = ["observe", "attach", "admin", "owner"] as const;
export type PairScope = (typeof PAIR_SCOPES)[number];

/** Scopes an invitation may grant: everything below owner. */
export const INVITABLE_SCOPES = ["observe", "attach", "admin"] as const;
export type InvitableScope = (typeof INVITABLE_SCOPES)[number];

const RANK: Record<PairScope, number> = { observe: 0, attach: 1, admin: 2, owner: 3 };

export function parsePairScope(raw: unknown): PairScope | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  return (PAIR_SCOPES as readonly string[]).includes(value) ? (value as PairScope) : null;
}

export function parseInvitableScope(raw: unknown): InvitableScope | null {
  const scope = parsePairScope(raw);
  return scope && scope !== "owner" ? scope : null;
}

/** True when a credential holding `granted` may use something that needs `required`. */
export function scopeSatisfies(granted: PairScope, required: PairScope): boolean {
  return RANK[granted] >= RANK[required];
}

/** The lower of two scopes (an invitation can never grant more than its creator holds). */
export function minScope(a: PairScope, b: PairScope): PairScope {
  return RANK[a] <= RANK[b] ? a : b;
}

export const DEFAULT_MIN_SCOPE: PairScope = "admin";

// ── HTTP: minimum scope per operationId ────────────────────────────────────────────────────
// Routes not listed here need `admin`. Public routes (auth: none) are never consulted.
export const HTTP_ROUTE_MIN_SCOPE: Readonly<Record<string, PairScope>> = {
  getMetrics: "observe",
  getOpenApiDocument: "observe",
  getPairPrincipal: "observe",
  invokeTool: "attach",
  createResponse: "attach",
  createChatCompletion: "attach",
  listSessions: "attach",
  getSession: "attach",
  listSnapshots: "attach",
  restoreSnapshot: "attach",
  getJobEvidence: "attach",
  listJobEvidenceEvents: "attach",
  getEvidenceView: "attach",
  exportJobEvidence: "admin",
  listFactoryBoards: "attach",
  listFactoryCards: "attach",
  getFactoryCard: "attach",
  createFactoryCard: "admin",
  moveFactoryCard: "admin",
  runFactoryCard: "admin",
  cancelFactoryCard: "admin",
  runCodeMode: "attach",
  listMcpServers: "observe",
  listPlugins: "observe",
  reloadPlugin: "admin",
  getAdminStatus: "admin",
  listAuditEvents: "admin",
  listWorkspaces: "admin",
  listUsers: "admin",
  listCovenants: "admin",
  getCovenant: "admin",
  createPairInvitation: "admin",
  listPairInvitations: "admin",
  revokePairInvitation: "admin",
  listPairDevices: "admin",
  approvePairDevice: "admin",
  revokePairDevice: "admin",
  // M13: policy status is readable; the kill switch is owner/admin (kill.mayFlip can narrow it).
  getPolicyStatus: "observe",
  killPolicy: "admin",
  releasePolicy: "admin",
};

export function httpRouteMinScope(operationId: string): PairScope {
  return HTTP_ROUTE_MIN_SCOPE[operationId] ?? DEFAULT_MIN_SCOPE;
}

/** Effective minimum scope of a registry route: explicit declaration, else the table above. */
export function routeMinScope(route: { operationId: string; minScope?: PairScope }): PairScope {
  return route.minScope ?? httpRouteMinScope(route.operationId);
}

// ── WebSocket: minimum scope per method ────────────────────────────────────────────────────
// Kurahi v0.3 (projects, uploads, artifacts, chat history): reads are observe, chat-side writes
// attach; projects.create / update / archive stay admin (the default).
const PROJECT_OBSERVE = [
  "projects.templates",
  "projects.pack",
  "projects.list",
  "projects.get",
  "projects.files",
  "artifacts.list",
  "artifacts.get",
  "chats.archived",
  "chats.search",
  // Business work queue reads.
  "workitems.list",
  "workitems.get",
  "workitems.config",
  "workitems.evidence",
  "workitems.document",
  "workitems.draftDiff",
  "workitems.stats",
  // Autopilot reads (routines, runs, approvals, metrics).
  "autopilot.routines.list",
  "autopilot.runs.list",
  "autopilot.runs.get",
  "autopilot.approvals.list",
  "autopilot.stats",
  "autopilot.autonomy.proposals",
  // The caller's own morning brief (person only, items the caller can already read).
  "autopilot.brief.get",
];
const PROJECT_ATTACH = [
  "projects.chatKey",
  "files.upload.begin",
  "files.upload.chunk",
  "files.upload.abort",
  "files.upload.commit",
  "artifacts.save",
  "artifacts.version",
  "artifacts.setStatus",
  "chats.archive",
  // Business work queue: agents draft, people decide (decide refuses non-person origins).
  "workitems.create",
  "workitems.update",
  "workitems.assignAgent",
  "workitems.decide",
  "workitems.delegate",
  "workitems.intakeEmail",
  "workitems.clearFlag",
  // Autopilot: manual run; pause / resume and standing approvals are person-only in the handler.
  "autopilot.run",
  "autopilot.pause",
  "autopilot.resume",
  "autopilot.approvals.create",
  "autopilot.approvals.revoke",
  "autopilot.autonomy.accept",
  "autopilot.autonomy.decline",
  "autopilot.reportError",
  // Global kill switch: person-only, operator.approvals, voice refused (handler + guard).
  "autopilot.stopAll",
  "autopilot.startAll",
];

const WS_OBSERVE = new Set([
  "health",
  "health.deep",
  "integrity.status",
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
  "cron.list",
  "cron.status",
  "cron.runs",
  "system-presence",
  "last-heartbeat",
  "node.list",
  "node.describe",
  "chat.history",
  "sibling.history",
  "channels.status",
  "logs.tail",
  "pair.nonce",
  "pair.redeem",
  "pair.refresh",
  "pair.me",
  "mcp.status",
  // Business connectors: sanitized configuration/sign-in/probe state, read-only.
  "connectors.status",
  "plugins.list",
  // M13: the kill switch state is observable; policy.kill / policy.release stay admin.
  "policy.status",
  // Enterprise identity: who am I, and the org directory (the handler filters by role).
  "identity.whoami",
  "identity.org.get",
  "identity.sessions.list",
  ...PROJECT_OBSERVE,
]);

const WS_ATTACH = new Set([
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
  "exec.approval.request",
  "exec.approval.resolve",
  // M3b: session discovery and attach are the attach scope's reason to exist.
  "sessions.discover",
  "session.attach",
  "session.detach",
  // M6: Code Mode drives tools, like node.invoke; attach scope.
  "codeMode.run",
  // Work Console push-to-talk: drives a chat-side capture, like chat.send; attach scope.
  "voice.start",
  "voice.audio",
  "voice.stop",
  "voice.speak",
  "voice.cancel",
  ...PROJECT_ATTACH,
]);

/** Minimum scope for one WS method. `connect` is the handshake and is never dispatched here. */
export function wsMethodMinScope(method: string): PairScope {
  if (WS_OBSERVE.has(method)) {
    return "observe";
  }
  if (WS_ATTACH.has(method)) {
    return "attach";
  }
  return DEFAULT_MIN_SCOPE;
}

/**
 * The legacy `operator.*` scopes a pairing credential maps to, so the pre-M3 method gate
 * (`authorizeGatewayMethod`) and presence/broadcast filters keep working for paired clients.
 */
export function legacyOperatorScopesFor(scope: PairScope): string[] {
  switch (scope) {
    case "owner":
    case "admin":
      return ["operator.admin", "operator.approvals", "operator.pairing"];
    case "attach":
      return ["operator.read", "operator.write", "operator.approvals"];
    case "observe":
      return ["operator.read"];
  }
}
