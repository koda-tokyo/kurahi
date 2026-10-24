// src/gateway/health.ts
// Health check endpoint for monitoring and deployment verification
//
// Deep health (KoLo v2 hardening — Phase 0):
//   GET /health      → deep health: status + auth profiles + sessions + inference
//   GET /api/health  → lightweight build/status probe (unchanged)
//
// The deep health response computes an aggregate status from auth profile TTLs
// and cooldown state so that monitoring tools get a single "healthy | degraded |
// unhealthy" signal rather than a perpetual "ok".

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { KoLoConfig } from "../config/config.js";
import {
  buildAuthHealthSummary,
  formatRemainingShort,
  type AuthHealthSummary,
  type AuthProfileHealth,
  type AuthProviderHealth,
} from "../agents/auth-health.js";
import { loadAuthProfileStore } from "../agents/auth-profiles.js";
import { loadConfig } from "../config/config.js";
import {
  getGatewayLeaseState,
  getV3HealthSnapshot,
  type V3HealthSnapshot,
  type NodePosture,
} from "../gateway-v3/health.js";
import { integrityHealthField, type IntegrityHealth } from "../integrity/gate.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";

let gatewayStartedAt = new Date().toISOString();
/** Called each time the gateway server (re)starts, including in-place restarts. */
export function markGatewayStarted(at: Date = new Date()): void {
  gatewayStartedAt = at.toISOString();
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Lightweight /api/health response (backwards-compatible).
 */
interface HealthResponse {
  status: "ok" | "degraded" | "unhealthy";
  build: {
    sha: string;
    time: string;
  };
  time: string;
}

/**
 * Deep /health response — the real health picture.
 */
interface DeepHealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  /**
   * Readiness levels — four distinct states, not one binary.
   * Rule: one "ok" should not lie about actual capability.
   *
   *   process_up        — Node.js process alive, HTTP responding
   *   gateway_ready     — lease held, auth ok, accepting connections
   *   consciousness_ready — v3 consciousness dispatchers registered (gateway.v3.enabled)
   *   degraded          — serving but with issues (auth expiring, etc.)
   */
  readiness: "process_up" | "gateway_ready" | "consciousness_ready" | "degraded";
  /**
   * Inter-node posture for v4 mesh handshakes.
   * Machine-readable: other nodes consume this to decide load sharing and failover.
   *   alive          — lease held, accepting sessions
   *   serviceable    — serving with issues, limited capacity
   *   handoff_ready  — no lease, stable, ready to accept if leader drops
   */
  posture: NodePosture;
  /** Single-instance lease on the state root; null when disabled. */
  lease?: { held: boolean; holdingMs: number } | null;
  /** Boot integrity gate (M2b): constitution files vs the signed registry. */
  integrity: IntegrityHealth;
  timestamp: string;
  uptime: number;
  /** When the current gateway instance started; changes on every restart, in-place or supervised. */
  startedAt: string;
  version: string;
  pid: number;
  memory: {
    rss: number;
    heapUsed: number;
  };
  auth: {
    status: "ok" | "expiring" | "expired" | "missing";
    profiles: DeepHealthAuthProfile[];
    providers: DeepHealthAuthProvider[];
  };
  sessions: {
    active: number;
    total: number;
  };
  /** V3 runtime health — present only when gateway.v3.health=true. */
  v3?: V3HealthSnapshot;
}

interface DeepHealthAuthProfile {
  profileId: string;
  provider: string;
  type: string;
  status: string;
  expiresIn: string | null;
  cooldown: boolean;
}

interface DeepHealthAuthProvider {
  provider: string;
  status: string;
  expiresIn: string | null;
  profileCount: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

// Resolve package version once at module load time to avoid repeated FS reads.
function resolveVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // Walk up from src/gateway to the package root.
    const pkg = require("../../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const PACKAGE_VERSION = resolveVersion();

/** How long (ms) before token expiry we start warning — matches auth-health default. */
const DEEP_HEALTH_WARN_MS = 2 * 60 * 60 * 1000; // 2h (aggressive for operational awareness)

/** Sessions updated within this window count as "active". */
const SESSION_ACTIVE_WINDOW_MS = 30 * 60 * 1000; // 30 min

// ── Deep Health Builder ─────────────────────────────────────────────────────

function buildDeepHealthAuthProfile(
  profile: AuthProfileHealth,
  store: ReturnType<typeof loadAuthProfileStore>,
): DeepHealthAuthProfile {
  const cooldown = store.usageStats?.[profile.profileId]?.cooldownUntil;
  const inCooldown = typeof cooldown === "number" && cooldown > Date.now();
  return {
    profileId: profile.profileId,
    provider: profile.provider,
    type: profile.type,
    status: inCooldown ? "cooldown" : profile.status,
    expiresIn: profile.remainingMs != null ? formatRemainingShort(profile.remainingMs) : null,
    cooldown: inCooldown,
  };
}

function buildDeepHealthAuthProvider(provider: AuthProviderHealth): DeepHealthAuthProvider {
  return {
    provider: provider.provider,
    status: provider.status,
    expiresIn: provider.remainingMs != null ? formatRemainingShort(provider.remainingMs) : null,
    profileCount: provider.profiles.length,
  };
}

const primaryOf = (model: unknown): string =>
  typeof model === "string"
    ? model.trim()
    : model &&
        typeof model === "object" &&
        typeof (model as { primary?: unknown }).primary === "string"
      ? ((model as { primary: string }).primary ?? "").trim()
      : "";

/**
 * A local model server needs no credential, so "no auth profile" is not a missing credential
 * when the installation uses one: an explicit `models.providers.ollama`, OLLAMA_BASE_URL /
 * OLLAMA_HOST, or a primary model on the `ollama/` provider (what `kurahi init --provider local`
 * writes as `agents.defaults.model.primary`).
 */
export function hasLocalModelFallback(
  cfg: Pick<KoLoConfig, "models" | "agents">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (cfg.models?.providers?.ollama || env.OLLAMA_BASE_URL?.trim() || env.OLLAMA_HOST?.trim()) {
    return true;
  }
  const primaries = [
    primaryOf(cfg.agents?.defaults?.model),
    ...(cfg.agents?.list ?? []).map((agent) => primaryOf(agent.model)),
  ].filter(Boolean);
  return primaries.length > 0 && primaries.every((ref) => ref.toLowerCase().startsWith("ollama/"));
}

function resolveAggregateAuthStatus(
  summary: AuthHealthSummary,
  store: ReturnType<typeof loadAuthProfileStore>,
  cfg: ReturnType<typeof loadConfig>,
): "ok" | "expiring" | "expired" | "missing" {
  if (summary.profiles.length === 0) {
    return hasLocalModelFallback(cfg) ? "ok" : "missing";
  }

  let hasExpired = false;
  let hasExpiring = false;
  let hasCooldown = false;

  for (const profile of summary.profiles) {
    const cooldownUntil = store.usageStats?.[profile.profileId]?.cooldownUntil;
    if (typeof cooldownUntil === "number" && cooldownUntil > Date.now()) {
      hasCooldown = true;
    }
    if (profile.status === "expired") {
      hasExpired = true;
    } else if (profile.status === "expiring") {
      hasExpiring = true;
    }
  }

  if (hasExpired) return "expired";
  if (hasExpiring || hasCooldown) return "expiring";
  return "ok";
}

function resolveOverallStatus(authStatus: string): "healthy" | "degraded" | "unhealthy" {
  // No provider configured yet is a fresh installation, not a failure: the gateway serves
  // (pairing, sessions, admin) and reports degraded until a credential is added.
  if (authStatus === "expired") return "unhealthy";
  if (authStatus === "expiring" || authStatus === "missing") return "degraded";
  return "healthy";
}

/**
 * Resolve readiness level — four distinct states.
 *
 * Rule: one "ok" must not lie about actual capability.
 * A gateway reporting "healthy" with no consciousness dispatcher is deceptive.
 *
 *   process_up        — this function is running, HTTP is responding
 *   gateway_ready     — auth ok, lease held (v3 lease if enabled), accepting connections
 *   consciousness_ready — v3 consciousness dispatchers registered (gateway.v3.enabled)
 *   degraded          — serving but with issues (auth expiring)
 */
export function resolveReadiness(
  authStatus: string,
  v3: ReturnType<typeof getV3HealthSnapshot> | undefined,
  lease: ReturnType<typeof getGatewayLeaseState> = getGatewayLeaseState(),
): DeepHealthResponse["readiness"] {
  // Auth failure → can't be more than process_up
  if (authStatus === "expired") return "process_up";

  // The real lease (<KOLO_HOME>/run/gateway.lock) gates readiness whenever it
  // is enabled: a gateway that does not own its state root is not ready.
  if (lease && !lease.held) return "process_up";

  // Auth expiring → degraded (serving, but not reliable)
  if (authStatus === "expiring") return "degraded";

  // Auth ok — check v3 if present
  if (v3) {
    if (v3.dispatchers != null && v3.dispatchers.count > 0) return "consciousness_ready";
    return "gateway_ready"; // lease held but no consciousness dispatcher registered
  }

  // No v3 — auth ok (and lease held when enabled)
  return "gateway_ready";
}

function buildSessionCounts(cfg: ReturnType<typeof loadConfig>): { active: number; total: number } {
  try {
    const { store } = loadCombinedSessionStoreForGateway(cfg);
    const now = Date.now();
    let total = 0;
    let active = 0;
    for (const [key, entry] of Object.entries(store)) {
      if (key === "global" || key === "unknown") continue;
      total++;
      if (entry?.updatedAt && now - entry.updatedAt < SESSION_ACTIVE_WINDOW_MS) {
        active++;
      }
    }
    return { active, total };
  } catch {
    return { active: 0, total: 0 };
  }
}

function buildDeepHealthResponse(): DeepHealthResponse {
  const cfg = loadConfig();
  const store = loadAuthProfileStore();
  const authSummary = buildAuthHealthSummary({
    store,
    cfg,
    warnAfterMs: DEEP_HEALTH_WARN_MS,
  });

  const profiles = authSummary.profiles.map((p) => buildDeepHealthAuthProfile(p, store));
  const providers = authSummary.providers.map(buildDeepHealthAuthProvider);
  const authStatus = resolveAggregateAuthStatus(authSummary, store, cfg);
  const integrity = integrityHealthField();
  const authOverall = resolveOverallStatus(authStatus);
  // A constitution file changed while running: still serving, but never "healthy".
  const overallStatus =
    integrity === "failed" && authOverall === "healthy" ? "degraded" : authOverall;
  const sessions = buildSessionCounts(cfg);
  const mem = process.memoryUsage();

  // Compute v3 snapshot first so readiness can use it
  const v3Snapshot = (cfg as any).gateway?.v3?.health ? getV3HealthSnapshot() : undefined;
  const leaseState = getGatewayLeaseState();
  const readiness = resolveReadiness(authStatus, v3Snapshot, leaseState);

  // Posture: from v3 snapshot when available, otherwise inferred from readiness
  const posture: NodePosture = v3Snapshot
    ? v3Snapshot.posture
    : readiness === "consciousness_ready" || readiness === "gateway_ready"
      ? "alive"
      : readiness === "degraded"
        ? "serviceable"
        : "handoff_ready";

  const response: DeepHealthResponse = {
    status: overallStatus,
    readiness,
    posture,
    lease: leaseState,
    integrity,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    startedAt: gatewayStartedAt,
    version: PACKAGE_VERSION,
    pid: process.pid,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
    },
    auth: {
      status: authStatus,
      profiles,
      providers,
    },
    sessions,
  };

  // Include v3 runtime health when flag is enabled
  if (v3Snapshot) {
    response.v3 = v3Snapshot;
  }

  return response;
}

// ── HTTP Handler ────────────────────────────────────────────────────────────

/**
 * Handle health check request.
 *
 * GET /health     → deep health (auth profiles + sessions + aggregate status)
 * GET /api/health → lightweight build probe (backwards-compatible)
 *
 * Returns true if handled, false to pass to next handler.
 */
export type HealthAuthorizer = (req: IncomingMessage) => Promise<boolean> | boolean;

/** What an unauthenticated caller gets from /health: enough for a probe, nothing to enumerate. */
export function buildPublicHealthResponse(): {
  status: DeepHealthResponse["status"];
  version: string;
  uptime: number;
} {
  const deep = buildDeepHealthResponse();
  return { status: deep.status, version: deep.version, uptime: deep.uptime };
}

export async function handleHealthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { authorize?: HealthAuthorizer } = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    // Full detail (pid, memory, auth profiles, sessions, lease) only for a credential holding
    // at least the observe scope; anonymous probes get status, version and uptime.
    const authorized = opts.authorize ? await opts.authorize(req) : false;
    const response = authorized ? buildDeepHealthResponse() : buildPublicHealthResponse();
    // Return 200 for healthy/degraded (monitoring tools can key on .status),
    // 503 for unhealthy so load balancers can route away.
    res.statusCode = response.status === "unhealthy" ? 503 : 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(JSON.stringify(response));
    return true;
  }

  if (url.pathname !== "/api/health") {
    return false;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const response: HealthResponse = {
    status: "ok",
    build: {
      sha: process.env.BUILD_SHA ?? "dev",
      time: process.env.BUILD_TIME ?? "unknown",
    },
    time: new Date().toISOString(),
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(response));

  return true;
}
