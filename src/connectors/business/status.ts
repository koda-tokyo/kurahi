// Business connectors: the status registry behind the `connectors.status` gateway method.
//
// Connector plugins report what a real health probe found; the gateway method returns a
// sanitized copy. The desktop catalogue shows "Active" only for an entry that is configured,
// authenticated and whose last probe succeeded. The registry lives on globalThis because a
// plugin module and the gateway can load this file as two module instances.
import { errorCodeOf, isConnectorErrorCode, type ConnectorErrorCode } from "./errors.js";
import { sanitizeScopeNames } from "./scopes.js";

export type ConnectorStatusEntry = {
  id: string;
  configured: boolean;
  authenticated: boolean;
  lastProbeOk: boolean | null;
  lastProbeAt: string | null;
  scopes: string[];
  error: ConnectorErrorCode | null;
};

type Registry = Map<string, ConnectorStatusEntry>;

const KEY = Symbol.for("kurahi.connectors.business.status");

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let reg = g[KEY];
  if (!reg) {
    reg = new Map();
    g[KEY] = reg;
  }
  return reg;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Strict copy: unknown fields dropped, free text replaced by codes, scopes reduced to names. */
export function sanitizeStatusEntry(raw: unknown): ConnectorStatusEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) {
    return null;
  }
  const configured = r.configured === true;
  const authenticated = configured && r.authenticated === true;
  const lastProbeAt =
    typeof r.lastProbeAt === "string" && ISO_PATTERN.test(r.lastProbeAt) ? r.lastProbeAt : null;
  const lastProbeOk = lastProbeAt && typeof r.lastProbeOk === "boolean" ? r.lastProbeOk : null;
  const error = isConnectorErrorCode(r.error) ? r.error : r.error == null ? null : "unknown";
  return {
    id: r.id,
    configured,
    authenticated,
    // A probe cannot have succeeded for an unauthenticated connector.
    lastProbeOk: authenticated || lastProbeOk === false ? lastProbeOk : null,
    lastProbeAt,
    scopes: Array.isArray(r.scopes) ? sanitizeScopeNames(r.scopes) : [],
    error: lastProbeOk === true && authenticated ? null : error,
  };
}

export function reportConnectorStatus(entry: ConnectorStatusEntry): void {
  const clean = sanitizeStatusEntry(entry);
  if (clean) {
    registry().set(clean.id, clean);
  }
}

export function removeConnectorStatus(id: string): void {
  registry().delete(id);
}

/** Every reported connector, sanitized again on the way out, sorted by id. */
export function listConnectorStatus(): ConnectorStatusEntry[] {
  return [...registry().values()]
    .map((e) => sanitizeStatusEntry(e))
    .filter((e): e is ConnectorStatusEntry => e !== null)
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export function clearConnectorStatusForTest(): void {
  registry().clear();
}

export type ProbeInput = {
  id: string;
  configured: boolean;
  /** Granted scopes of the stored sign-in, or undefined when there is none. */
  grantedScopes: string[] | undefined;
  /** The real health call. Runs only when configured and signed in. */
  probe: () => Promise<void>;
  now?: () => number;
};

/** Run one probe and record the result. Never throws. */
export async function runConnectorProbe(input: ProbeInput): Promise<ConnectorStatusEntry> {
  const now = input.now ?? Date.now;
  const base = {
    id: input.id,
    configured: input.configured,
    authenticated: input.configured && input.grantedScopes !== undefined,
    scopes: input.grantedScopes ?? [],
  };
  let entry: ConnectorStatusEntry;
  if (!input.configured) {
    entry = { ...base, lastProbeOk: null, lastProbeAt: null, error: "not_configured" };
  } else if (!base.authenticated) {
    entry = { ...base, lastProbeOk: null, lastProbeAt: null, error: "not_authenticated" };
  } else {
    try {
      await input.probe();
      entry = {
        ...base,
        lastProbeOk: true,
        lastProbeAt: new Date(now()).toISOString(),
        error: null,
      };
    } catch (err) {
      const code = errorCodeOf(err);
      entry = {
        ...base,
        authenticated: code !== "not_authenticated" && code !== "reauth_required",
        lastProbeOk: false,
        lastProbeAt: new Date(now()).toISOString(),
        error: code,
      };
    }
  }
  reportConnectorStatus(entry);
  return sanitizeStatusEntry(entry)!;
}
