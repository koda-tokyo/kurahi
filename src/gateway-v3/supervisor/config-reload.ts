/**
 * Runtime config safety classes, enforced on SIGUSR2 by src/gateway/config-reload.ts.
 *
 *   live    — applied immediately while the gateway is running
 *   drain   — queued; takes effect after active sessions drain (no restart)
 *   restart — refused on SIGUSR2; a full restart is required
 *
 * Paths are dot-separated config keys ("gateway.port"). Unknown keys are "restart" (fail-safe),
 * so a SIGUSR2 can never silently apply a change the runtime cannot take live.
 *
 * Restored in M1d from the archived gateway-v3 implementation ; the
 * previous stub classified file paths and returned an empty diff, which made SIGUSR2 a no-op.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfigReloadClass = "live" | "drain" | "restart";

export type ConfigChange = {
  path: string;
  prev: unknown;
  next: unknown;
  klass: ConfigReloadClass;
};

export type ConfigDiffResult = {
  live: ConfigChange[];
  drain: ConfigChange[];
  restart: ConfigChange[];
  /** True if any restart-required keys changed */
  hasRestartRequired: boolean;
};

export type ConfigReloadOutcome =
  | { ok: true; applied: ConfigChange[]; queued: ConfigChange[]; refused: ConfigChange[] }
  | { ok: false; reason: "invalid-json" | "schema-error"; detail: string };

// ── Safety Map ────────────────────────────────────────────────────────────────

/**
 * Maps dot-separated config paths to reload class.
 * Prefix matches are supported: "auth.profiles" matches "auth.profiles.openai" etc.
 * Most-specific path wins. Unknown paths default to "restart".
 */
export const CONFIG_SAFETY_MAP: ReadonlyArray<[pattern: string, klass: ConfigReloadClass]> = [
  // ── Live-reloadable ───────────────────────────────────────────────────────
  ["logging.level", "live"],
  ["metrics.verbosity", "live"],
  ["gateway.circuitBreaker.openDurationMs", "live"],

  // ── Drain-reloadable ──────────────────────────────────────────────────────
  ["gateway.providers.", "drain"], // provider enable/disable
  ["gateway.fallbackChain", "drain"],
  ["routing.weights.", "drain"],
  ["gateway.v3.memoryBudget.", "drain"], // memory budget changes take effect after sessions drain

  // ── Restart-required ─────────────────────────────────────────────────────
  ["auth.profiles.", "restart"],
  ["gateway.port", "restart"],
  ["gateway.bind", "restart"],
  ["supervisor.leaseTtlMs", "restart"],
] as const;

// Provider URL/model changes override the general provider prefix
const PROVIDER_RESTART_SUFFIXES = [".url", ".model", ".baseUrl", ".backend"] as const;

// ── Classify a single config path ────────────────────────────────────────────

export function classifyPath(path: string): ConfigReloadClass {
  // Provider URL/model/backend are restart-required even though providers are drain
  if (path.startsWith("gateway.providers.")) {
    for (const suffix of PROVIDER_RESTART_SUFFIXES) {
      if (path.endsWith(suffix)) {
        return "restart";
      }
    }
  }

  // Find the most-specific matching prefix in the safety map
  let best: { len: number; klass: ConfigReloadClass } | null = null;
  for (const [pattern, klass] of CONFIG_SAFETY_MAP) {
    const isPrefix = pattern.endsWith(".");
    const matches = isPrefix
      ? path.startsWith(pattern) || path === pattern.slice(0, -1)
      : path === pattern;

    if (matches) {
      const len = pattern.length;
      if (!best || len > best.len) {
        best = { len, klass };
      }
    }
  }

  return best?.klass ?? "restart"; // fail-safe: unknown = restart
}

// ── Config Diff ───────────────────────────────────────────────────────────────

/**
 * Flatten a nested object into dot-separated paths.
 * e.g. { a: { b: 1 } } → { "a.b": 1 }
 */
function flattenConfig(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenConfig(value as Record<string, unknown>, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

/**
 * Diff two configs and classify every changed key by reload class.
 */
export function diffConfigs(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): ConfigDiffResult {
  const flatPrev = flattenConfig(prev);
  const flatNext = flattenConfig(next);

  const allPaths = new Set([...Object.keys(flatPrev), ...Object.keys(flatNext)]);
  const live: ConfigChange[] = [];
  const drain: ConfigChange[] = [];
  const restart: ConfigChange[] = [];

  for (const path of allPaths) {
    const prevVal = flatPrev[path];
    const nextVal = flatNext[path];

    // Skip unchanged
    if (JSON.stringify(prevVal) === JSON.stringify(nextVal)) {
      continue;
    }

    const klass: ConfigReloadClass = classifyPath(path);
    const change: ConfigChange = { path, prev: prevVal, next: nextVal, klass };

    switch (klass) {
      case "live":
        live.push(change);
        break;
      case "drain":
        drain.push(change);
        break;
      case "restart":
        restart.push(change);
        break;
    }
  }

  return { live, drain, restart, hasRestartRequired: restart.length > 0 };
}
