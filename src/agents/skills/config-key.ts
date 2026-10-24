import crypto from "node:crypto";
import type { KoLoConfig } from "../../config/config.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = canonical(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * A fingerprint of the configuration that decides which skills a snapshot holds: `skills`
 * (allowBundled, entries, load dirs), `plugins` (plugin skill dirs) and the per-run skill filter.
 * A stored snapshot whose key differs was built under another config and must be rebuilt; the
 * in-memory snapshot version alone misses config edits and resets to 0 on every restart.
 */
export function resolveSkillsConfigKey(config?: KoLoConfig, skillFilter?: string[]): string {
  const filter = skillFilter ? skillFilter.map((s) => s.trim()).toSorted() : null;
  const material = JSON.stringify(
    canonical({ skills: config?.skills ?? null, plugins: config?.plugins ?? null, filter }),
  );
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}
