import type { KoLoConfig } from "../config/config.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

type PiSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  applyOverrides: (overrides: { compaction: { reserveTokens: number } }) => void;
};

/**
 * The compaction reserve may take at most this share of the model's context window. Pi compacts
 * once the context exceeds `contextWindow - reserveTokens`; a reserve at or above the window
 * (the 20k default floor on a 16k model) makes that threshold <= 0, so every turn pays one more
 * summarising model call.
 */
export const MAX_COMPACTION_RESERVE_SHARE = 0.5;

export function resolveMaxCompactionReserveTokens(
  contextWindowTokens?: number,
): number | undefined {
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }
  return Math.floor(contextWindowTokens * MAX_COMPACTION_RESERVE_SHARE);
}

export function ensurePiCompactionReserveTokens(params: {
  settingsManager: PiSettingsManagerLike;
  minReserveTokens?: number;
  /** The model's context window; the reserve is clamped to MAX_COMPACTION_RESERVE_SHARE of it. */
  contextWindowTokens?: number;
}): { didOverride: boolean; reserveTokens: number; clampedToWindow: boolean } {
  const minReserveTokens = params.minReserveTokens ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const current = params.settingsManager.getCompactionReserveTokens();
  let target = Math.max(current, minReserveTokens);
  const max = resolveMaxCompactionReserveTokens(params.contextWindowTokens);
  const clampedToWindow = max !== undefined && target > max;
  if (clampedToWindow) {
    target = max;
  }

  if (target === current) {
    return { didOverride: false, reserveTokens: current, clampedToWindow };
  }

  params.settingsManager.applyOverrides({
    compaction: { reserveTokens: target },
  });

  return { didOverride: true, reserveTokens: target, clampedToWindow };
}

export function resolveCompactionReserveTokensFloor(cfg?: KoLoConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}
