/**
 * Fleet controller — single-pane fleet-wide view data layer.
 * Provides state types and load functions for all gateways, PM2 processes, disk, and alerts.
 * Rendering is wired in app-render.ts / app.ts (tab="fleet").
 *
 * Fleet page: one card per gateway this UI can reach.
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GateCard {
  name: string;
  port: number;
  status: "ok" | "degraded" | "down" | "known-down";
  uptime: string; // human-readable, e.g. "9D+", "122h+"
  healthy: boolean; // raw /health/ready 200
  lastSeen: number; // Date.now() when last polled
}

export interface Pm2Process {
  name: string;
  status: "online" | "stopped" | "errored";
  uptime: string;
  restarts: number;
  cpu: string; // e.g. "0.3%"
  mem: string; // e.g. "128MB"
}

export interface FleetDisk {
  mount: string;
  usedPct: number; // 0-100
  total: string; // e.g. "256G"
  used: string; // e.g. "98G"
}

export interface FleetBackup {
  lastRun: string; // ISO timestamp or "never"
  lastStatus: "ok" | "fail" | "unknown";
  lastFile: string; // filename or empty
  consecutivePasses: number;
}

export interface FleetOAuth {
  expiresIn: string; // human-readable, e.g. "3.2h"
  expiresAt: string; // ISO timestamp
  autoHealNights: number;
}

export interface FleetAlert {
  id: string;
  level: "info" | "warn" | "error";
  timestamp: string; // ISO
  source: string; // e.g. "watchdog", "oauth", "pm2"
  message: string;
  archived: boolean;
}

export type FleetState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  loading: boolean;
  lastError: string | null;

  // Data
  gates: GateCard[];
  processes: Pm2Process[];
  disks: FleetDisk[];
  backup: FleetBackup | null;
  oauth: FleetOAuth | null;
  alerts: FleetAlert[];
};

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_FLEET_STATE: FleetState = {
  client: null,
  connected: false,
  loading: false,
  lastError: null,
  gates: [],
  processes: [],
  disks: [],
  backup: null,
  oauth: null,
  alerts: [],
};

// ── Data loaders ─────────────────────────────────────────────────────────────

/**
 * Poll all fleet data sources: gate health, PM2 processes, disk, backup, OAuth.
 * Graceful degradation: individual source failures don't block the whole poll.
 */
export async function loadFleet(state: FleetState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.loading) {
    return;
  }

  state.loading = true;
  if (!opts?.quiet) {
    state.lastError = null;
  }

  const errors: string[] = [];

  try {
    // Each load is independent — failures don't cascade
    await Promise.allSettled([
      loadGates(state).catch((e) => errors.push(`gates: ${e}`)),
      loadProcesses(state).catch((e) => errors.push(`pm2: ${e}`)),
      loadDisks(state).catch((e) => errors.push(`disk: ${e}`)),
      loadBackup(state).catch((e) => errors.push(`backup: ${e}`)),
      loadOAuth(state).catch((e) => errors.push(`oauth: ${e}`)),
    ]);
  } finally {
    state.loading = false;
    if (errors.length > 0 && !opts?.quiet) {
      state.lastError = errors.join("; ");
    }
  }
}

async function loadGates(state: FleetState) {
  if (!state.client) {
    return;
  }

  // The gateways to show come from the serving gateway (own port first) plus any extra
  // gateways configured on the page as `?fleet=name:port,name:port`; nothing is hardcoded.
  const ownPort = Number(
    window.location.port || (window.location.protocol === "https:" ? 443 : 80),
  );
  const extra = new URLSearchParams(window.location.search).get("fleet") ?? "";
  const knownGates: Array<{ name: string; port: number }> = [
    { name: "This gateway", port: ownPort },
  ];
  for (const entry of extra.split(",")) {
    const [name, portText] = entry.split(":");
    const port = Number(portText);
    if (name && Number.isInteger(port) && port > 0) {
      knownGates.push({ name: name.trim(), port });
    }
  }

  const cards: GateCard[] = [];
  for (const gate of knownGates) {
    try {
      const res = await state.client.request<{ healthy: boolean; uptime?: string }>(
        "gateway.healthCheck",
        {
          port: gate.port,
        },
      );
      cards.push({
        name: gate.name,
        port: gate.port,
        status: res.healthy ? "ok" : "degraded",
        healthy: !!res.healthy,
        uptime: res.uptime ?? "?",
        lastSeen: Date.now(),
      });
    } catch {
      // Gate unreachable — mark as known-down for chronic cases, down for fresh ones
      cards.push({
        name: gate.name,
        port: gate.port,
        status: "down",
        healthy: false,
        uptime: "—",
        lastSeen: Date.now(),
      });
    }
  }
  state.gates = cards;
}

async function loadProcesses(state: FleetState) {
  if (!state.client) {
    return;
  }
  // PM2 jlist via gateway exec or dedicated endpoint
  // For now: use health endpoint process list if available
  const res = await state.client
    .request<{ processes?: Array<Partial<Omit<Pm2Process, "status">> & { status?: string }> }>(
      "gateway.pm2List",
      {},
    )
    .catch(() => null);
  if (res?.processes) {
    state.processes = res.processes.map((p) => ({
      name: String(p.name ?? "?"),
      status: mapPm2Status(String(p.status ?? "stopped")),
      uptime: String(p.uptime ?? "—"),
      restarts: Number(p.restarts ?? 0),
      cpu: String(p.cpu ?? "—"),
      mem: String(p.mem ?? "—"),
    }));
  }
}

async function loadDisks(state: FleetState) {
  if (!state.client) {
    return;
  }
  const res = await state.client
    .request<{ disks?: Array<Partial<FleetDisk>> }>("gateway.diskUsage", {})
    .catch(() => null);
  if (res?.disks) {
    state.disks = res.disks.map((d) => ({
      mount: String(d.mount ?? "?"),
      usedPct: Number(d.usedPct ?? 0),
      total: String(d.total ?? "—"),
      used: String(d.used ?? "—"),
    }));
  }
}

async function loadBackup(state: FleetState) {
  if (!state.client) {
    return;
  }
  const res = await state.client
    .request<{ lastRun?: string; status?: string; lastFile?: string; consecutivePasses?: number }>(
      "gateway.backupStatus",
      {},
    )
    .catch(() => null);
  if (res) {
    state.backup = {
      lastRun: String(res.lastRun ?? "never"),
      lastStatus: mapBackupStatus(String(res.status ?? "unknown")),
      lastFile: String(res.lastFile ?? ""),
      consecutivePasses: Number(res.consecutivePasses ?? 0),
    };
  }
}

async function loadOAuth(state: FleetState) {
  if (!state.client) {
    return;
  }
  const res = await state.client
    .request<Partial<FleetOAuth>>("gateway.oauthStatus", {})
    .catch(() => null);
  if (res) {
    state.oauth = {
      expiresIn: String(res.expiresIn ?? "?"),
      expiresAt: String(res.expiresAt ?? ""),
      autoHealNights: Number(res.autoHealNights ?? 0),
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapPm2Status(status: string): "online" | "stopped" | "errored" {
  switch (status) {
    case "online":
      return "online";
    case "stopped":
    case "stopping":
      return "stopped";
    default:
      return "errored";
  }
}

function mapBackupStatus(status: string): "ok" | "fail" | "unknown" {
  switch (status) {
    case "ok":
    case "success":
      return "ok";
    case "fail":
    case "error":
      return "fail";
    default:
      return "unknown";
  }
}
