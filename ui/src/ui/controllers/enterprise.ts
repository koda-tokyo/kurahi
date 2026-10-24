// Data for the v0.2 enterprise pages: Home, Approvals, Connections > Connectors, Policies,
// Audit log and Models. Pure mappers are exported for tests; loaders fill `host.enterprise`.
//
// Never show credentials: provider API keys, headers, MCP targets and auth profile contents are
// not read into these views at all.
import type { GatewayBrowserClient } from "../gateway";
import type { CronJob, LogEntry } from "../types";
import type { ConnectorRow, ConnectorSourceState, ConnectorStatus } from "./connectors";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approval";
import type { ExecApprovalsFile } from "./exec-approvals";

// ---- state ----

export type ApprovalHistoryEntry = {
  id: string;
  command: string;
  agentId: string | null;
  decision: string | null;
  resolvedBy: string | null;
  ts: number;
};

export type ModelLocation =
  | { kind: "local" }
  | { kind: "remote"; host: string }
  | { kind: "unknown" };

export type ModelProviderRow = { id: string; models: string[]; where: ModelLocation };

export type AuditRecord = {
  time: string;
  level: string;
  source: string;
  action: string;
  target: string;
  user: string;
  message: string;
};

export type AuditSource = "audit" | "logs";

export type EnterpriseState = {
  approvalHistory: ApprovalHistoryEntry[];
  connectorsLoading: boolean;
  connectorsSource: ConnectorSourceState | null;
  connectors: ConnectorRow[] | null;
  connectorsQuery: string;
  connectorsFilter: ConnectorStatus | "all";
  policyStatus: unknown;
  policyError: string | null;
  modelsCatalogCount: number | null;
  auditSource: AuditSource;
  auditQuery: string;
  auditLevel: string;
  auditLoading: boolean;
  auditError: string | null;
  auditEvents: AuditRecord[] | null;
};

export const DEFAULT_ENTERPRISE_STATE: EnterpriseState = {
  approvalHistory: [],
  connectorsLoading: false,
  connectorsSource: null,
  connectors: null,
  connectorsQuery: "",
  connectorsFilter: "all",
  policyStatus: null,
  policyError: null,
  modelsCatalogCount: null,
  auditSource: "logs",
  auditQuery: "",
  auditLevel: "",
  auditLoading: false,
  auditError: null,
  auditEvents: null,
};

type EnterpriseHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enterprise: EnterpriseState;
  settings: { gatewayUrl: string; token: string };
};

function patch(host: EnterpriseHost, next: Partial<EnterpriseState>) {
  host.enterprise = { ...host.enterprise, ...next };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---- header status ----

export type ServiceStatus = "running" | "stopped" | "attention";

export function serviceStatus(
  connected: boolean,
  health: unknown,
  lastError: string | null,
): ServiceStatus {
  if (!connected) {
    return "stopped";
  }
  const status = isRecord(health) ? str(health.status) || str(health.readiness) : "";
  if (lastError || status === "degraded" || status === "unhealthy") {
    return "attention";
  }
  return "running";
}

// ---- approvals ----

const HISTORY_MAX = 20;

export function recordApprovalDecision(
  history: ApprovalHistoryEntry[],
  queue: ExecApprovalRequest[],
  resolved: ExecApprovalResolved,
  now = Date.now(),
): ApprovalHistoryEntry[] {
  if (history.some((h) => h.id === resolved.id)) {
    return history;
  }
  const req = queue.find((q) => q.id === resolved.id);
  const entry: ApprovalHistoryEntry = {
    id: resolved.id,
    command: req?.request.command ?? "",
    agentId: req?.request.agentId ?? null,
    decision: resolved.decision ?? null,
    resolvedBy: resolved.resolvedBy ?? null,
    ts: resolved.ts ?? now,
  };
  return [entry, ...history].slice(0, HISTORY_MAX);
}

// ---- today's actions ----

export function todaysRuns(
  jobs: CronJob[],
  now = Date.now(),
): { remaining: number; nextAtMs: number | null } {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  let remaining = 0;
  let nextAtMs: number | null = null;
  for (const job of jobs) {
    const next = job.state?.nextRunAtMs;
    if (!job.enabled || typeof next !== "number" || next < now) {
      continue;
    }
    if (next < end.getTime()) {
      remaining += 1;
    }
    if (nextAtMs === null || next < nextAtMs) {
      nextAtMs = next;
    }
  }
  return { remaining, nextAtMs };
}

// ---- models ----

export function locationOfBaseUrl(baseUrl: unknown): ModelLocation {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return { kind: "unknown" };
  }
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return { kind: "unknown" };
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  ) {
    return { kind: "local" };
  }
  return { kind: "remote", host };
}

export function defaultModelSelection(config: unknown): {
  primary: string | null;
  fallbacks: string[];
} {
  const model =
    isRecord(config) && isRecord(config.agents) && isRecord(config.agents.defaults)
      ? config.agents.defaults.model
      : undefined;
  if (typeof model === "string") {
    return { primary: model, fallbacks: [] };
  }
  if (isRecord(model)) {
    return {
      primary: str(model.primary) || null,
      fallbacks: Array.isArray(model.fallbacks) ? model.fallbacks.map(str).filter(Boolean) : [],
    };
  }
  return { primary: null, fallbacks: [] };
}

/** Providers exactly as the config names them; only the base URL's host is read. */
export function modelProviderRows(config: unknown): ModelProviderRow[] {
  const rows = new Map<string, ModelProviderRow>();
  const providers =
    isRecord(config) && isRecord(config.models) && isRecord(config.models.providers)
      ? config.models.providers
      : {};
  for (const [id, p] of Object.entries(providers)) {
    const models =
      isRecord(p) && Array.isArray(p.models)
        ? p.models.map((m) => (isRecord(m) ? str(m.id) || str(m.name) : str(m))).filter(Boolean)
        : [];
    rows.set(id, { id, models, where: locationOfBaseUrl(isRecord(p) ? p.baseUrl : undefined) });
  }
  // Providers referenced by the default model selection but not defined under models.providers.
  const sel = defaultModelSelection(config);
  for (const ref of [sel.primary, ...sel.fallbacks].filter((r): r is string => Boolean(r))) {
    const slash = ref.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const id = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    const row = rows.get(id) ?? { id, models: [], where: { kind: "unknown" as const } };
    if (!row.models.includes(model)) {
      row.models = [...row.models, model];
    }
    rows.set(id, row);
  }
  return [...rows.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

// ---- policies ----

export function credentialPolicy(config: unknown): {
  isolation: "inherit" | "explicit" | null;
  grants: Array<{ agent: string; profiles: string[] }>;
} {
  const auth = isRecord(config) && isRecord(config.auth) ? config.auth : {};
  const isolation =
    auth.isolation === "explicit" || auth.isolation === "inherit" ? auth.isolation : null;
  const grants = isRecord(auth.grants)
    ? Object.entries(auth.grants).map(([agent, profiles]) => ({
        agent,
        profiles: Array.isArray(profiles) ? profiles.map(str).filter(Boolean) : [],
      }))
    : [];
  return { isolation, grants: grants.toSorted((a, b) => a.agent.localeCompare(b.agent)) };
}

export type ApprovalRule = { scope: string; security: string; ask: string; allowlist: number };

export function approvalRules(file: ExecApprovalsFile | null | undefined): ApprovalRule[] {
  if (!file) {
    return [];
  }
  const rules: ApprovalRule[] = [];
  if (file.defaults) {
    rules.push({
      scope: "*",
      security: file.defaults.security ?? "",
      ask: file.defaults.ask ?? "",
      allowlist: 0,
    });
  }
  for (const [agent, a] of Object.entries(file.agents ?? {})) {
    rules.push({
      scope: agent,
      security: a.security ?? "",
      ask: a.ask ?? "",
      allowlist: Array.isArray(a.allowlist) ? a.allowlist.length : 0,
    });
  }
  return rules;
}

// ---- audit ----

export function auditRecordsFromLogs(entries: LogEntry[]): AuditRecord[] {
  return entries.map((e) => ({
    time: e.time ?? "",
    level: e.level ?? "",
    source: e.subsystem ?? "",
    action: "",
    target: "",
    user: "",
    message: e.message ?? e.raw,
  }));
}

export function auditRecordsFromEvents(events: unknown): AuditRecord[] {
  if (!Array.isArray(events)) {
    return [];
  }
  return events.filter(isRecord).map((e) => ({
    time: str(e.timestamp),
    level: "",
    source: "audit",
    action: str(e.action),
    target: [str(e.targetType), str(e.targetId)].filter(Boolean).join(":"),
    user: str(e.userId),
    message: "",
  }));
}

export function filterAuditRecords(
  rows: AuditRecord[],
  query: string,
  level: string,
): AuditRecord[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (level && r.level !== level) {
      return false;
    }
    if (!q) {
      return true;
    }
    return [r.time, r.level, r.source, r.action, r.target, r.user, r.message].some((f) =>
      f.toLowerCase().includes(q),
    );
  });
}

function csvCell(value: string): string {
  // Spreadsheet formula injection: neutralise cells starting with = + - @ (and tab / CR).
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const AUDIT_CSV_COLUMNS: Array<keyof AuditRecord> = [
  "time",
  "level",
  "source",
  "action",
  "target",
  "user",
  "message",
];

export function auditCsv(rows: AuditRecord[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(AUDIT_CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  }
  // BOM so Excel opens UTF-8 (Japanese text) correctly.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function httpBaseFromGatewayUrl(gatewayUrl: string): string | null {
  try {
    const u = new URL(gatewayUrl);
    if (u.protocol === "ws:" || u.protocol === "http:") {
      return `http://${u.host}`;
    }
    if (u.protocol === "wss:" || u.protocol === "https:") {
      return `https://${u.host}`;
    }
  } catch {
    // fall through
  }
  return null;
}

// ---- loaders ----

export async function loadPolicyStatus(host: EnterpriseHost) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = (await host.client.request("policy.status", {})) as { status?: unknown };
    patch(host, { policyStatus: res?.status ?? null, policyError: null });
  } catch (err) {
    patch(host, { policyStatus: null, policyError: String(err) });
  }
}

export async function loadModelsCatalog(host: EnterpriseHost) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = (await host.client.request("models.list", {})) as { models?: unknown[] };
    patch(host, { modelsCatalogCount: Array.isArray(res?.models) ? res.models.length : null });
  } catch {
    patch(host, { modelsCatalogCount: null });
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Whitelisted `/api/admin/audit` query parameters (the gateway's AuditQuery). */
export type AuditQueryParams = {
  userId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: string;
};

/** Resolves to the gateway's JSON body; rejects with the error text. */
export type HostAuditFetcher = (params: AuditQueryParams) => Promise<unknown>;

let hostAuditFetcher: HostAuditFetcher | null = null;

/**
 * A host that cannot reach the gateway's HTTP API from the page (Kurahi Desktop: the webview is
 * another origin and the gateway sends no CORS headers) installs a fetcher that makes the call
 * natively. The browser build leaves this unset and uses same-origin fetch.
 */
export function installHostAuditFetcher(fn: HostAuditFetcher | null): void {
  hostAuditFetcher = fn;
}

/** `/api/admin/audit` over HTTP. Works when the page is served by the gateway (same origin). */
export async function loadAuditEvents(
  host: EnterpriseHost,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
) {
  if (hostAuditFetcher) {
    patch(host, { auditLoading: true, auditError: null });
    try {
      const body = (await hostAuditFetcher({ limit: 100 })) as { events?: unknown } | null;
      patch(host, { auditLoading: false, auditEvents: auditRecordsFromEvents(body?.events) });
    } catch (err) {
      patch(host, {
        auditLoading: false,
        auditEvents: [],
        auditError: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  const base = httpBaseFromGatewayUrl(host.settings.gatewayUrl);
  if (!base) {
    patch(host, { auditError: "invalid gateway URL", auditEvents: [] });
    return;
  }
  patch(host, { auditLoading: true, auditError: null });
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (host.settings.token) {
      headers.authorization = `Bearer ${host.settings.token}`;
    }
    const res = await fetchImpl(`${base}/api/admin/audit?limit=100`, { headers });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      events?: unknown;
      error?: unknown;
    };
    if (!res.ok || body.ok === false) {
      throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
    }
    patch(host, { auditLoading: false, auditEvents: auditRecordsFromEvents(body.events) });
  } catch (err) {
    patch(host, {
      auditLoading: false,
      auditEvents: [],
      auditError: err instanceof Error ? err.message : String(err),
    });
  }
}
