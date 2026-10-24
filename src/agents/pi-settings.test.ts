import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "./pi-settings.js";

describe("ensurePiCompactionReserveTokens", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({
      didOverride: true,
      reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
      clampedToWindow: false,
    });
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not override when already above floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({ didOverride: false, reserveTokens: 32_000, clampedToWindow: false });
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });
});

describe("ensurePiCompactionReserveTokens with a small context window", () => {
  const manager = (current: number) => ({
    getCompactionReserveTokens: () => current,
    applyOverrides: vi.fn(),
  });

  it("clamps the default floor to half of a 16k window, so a turn does not always compact", () => {
    const settingsManager = manager(16_384);
    const result = ensurePiCompactionReserveTokens({
      settingsManager,
      contextWindowTokens: 16_384,
    });
    expect(result).toEqual({ didOverride: true, reserveTokens: 8_192, clampedToWindow: true });
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 8_192 },
    });
    // pi compacts when contextTokens > window - reserve: the threshold is now positive.
    expect(16_384 - result.reserveTokens).toBeGreaterThan(0);
  });

  it("clamps a pi default reserve that already exceeds the window", () => {
    const settingsManager = manager(16_384);
    const result = ensurePiCompactionReserveTokens({
      settingsManager,
      minReserveTokens: 0,
      contextWindowTokens: 4_096,
    });
    expect(result).toEqual({ didOverride: true, reserveTokens: 2_048, clampedToWindow: true });
  });

  it("leaves a floor that fits the window alone", () => {
    const settingsManager = manager(16_384);
    const result = ensurePiCompactionReserveTokens({
      settingsManager,
      minReserveTokens: 4_096,
      contextWindowTokens: 32_768,
    });
    expect(result).toEqual({ didOverride: false, reserveTokens: 16_384, clampedToWindow: false });
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("ignores an unknown window", () => {
    const settingsManager = manager(16_384);
    expect(
      ensurePiCompactionReserveTokens({ settingsManager, contextWindowTokens: 0 }).reserveTokens,
    ).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });
});

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor()).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("accepts configured floors, including zero", () => {
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 24_000 } } },
      }),
    ).toBe(24_000);
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 0 } } },
      }),
    ).toBe(0);
  });
});
