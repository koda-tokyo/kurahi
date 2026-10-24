import type { KoLoConfig } from "../config/config.js";
import {
  MAX_COMPACTION_RESERVE_SHARE,
  resolveCompactionReserveTokensFloor,
  resolveMaxCompactionReserveTokens,
} from "../agents/pi-settings.js";
import { note } from "../terminal/note.js";

/**
 * Configured context windows that the compaction reserve floor does not fit. The runtime clamps
 * the reserve to MAX_COMPACTION_RESERVE_SHARE of the window (otherwise every turn would trigger a
 * summarising call), so these configs compact earlier than the floor says.
 */
export function collectCompactionReserveWarnings(cfg: KoLoConfig): string[] {
  const floor = resolveCompactionReserveTokensFloor(cfg);
  const pct = Math.round(MAX_COMPACTION_RESERVE_SHARE * 100);
  const warnings: string[] = [];
  const check = (label: string, window: unknown) => {
    if (typeof window !== "number") {
      return;
    }
    const max = resolveMaxCompactionReserveTokens(window);
    if (max === undefined || floor <= max) {
      return;
    }
    warnings.push(
      `- ${label}: context window ${window} tokens, compaction reserve floor ${floor} ` +
        `(agents.defaults.compaction.reserveTokensFloor). The reserve is clamped to ${max} ` +
        `(${pct}% of the window); set reserveTokensFloor <= ${max} or use a larger window.`,
    );
  };
  for (const [providerId, provider] of Object.entries(cfg.models?.providers ?? {})) {
    for (const model of provider?.models ?? []) {
      check(`models.providers.${providerId} ${model.id}`, model.contextWindow);
    }
  }
  check("agents.defaults.contextTokens", cfg.agents?.defaults?.contextTokens);
  return warnings;
}

export function noteCompactionReserveWarnings(cfg: KoLoConfig) {
  const warnings = collectCompactionReserveWarnings(cfg);
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Compaction");
  }
}
