import { describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import { collectCompactionReserveWarnings } from "./doctor-compaction.js";

const model = (id: string, contextWindow: number) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 2048,
});

const cfg = (contextWindow: number, reserveTokensFloor?: number): KoLoConfig => ({
  models: {
    providers: {
      ollama: { baseUrl: "http://127.0.0.1:11434/v1", models: [model("qwen", contextWindow)] },
    },
  },
  agents: { defaults: { compaction: { reserveTokensFloor } } },
});

describe("collectCompactionReserveWarnings", () => {
  it("warns when the default 20k floor does not fit a 16k window", () => {
    const warnings = collectCompactionReserveWarnings(cfg(16_384));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("models.providers.ollama qwen");
    expect(warnings[0]).toContain("clamped to 8192");
    expect(warnings[0]).toContain("reserveTokensFloor <= 8192");
  });

  it("is quiet when the floor fits the window", () => {
    expect(collectCompactionReserveWarnings(cfg(16_384, 4_096))).toEqual([]);
    expect(collectCompactionReserveWarnings(cfg(32_768, 4_096))).toEqual([]);
  });

  it("checks agents.defaults.contextTokens", () => {
    const warnings = collectCompactionReserveWarnings({
      agents: { defaults: { contextTokens: 8_000 } },
    });
    expect(warnings).toEqual([expect.stringContaining("agents.defaults.contextTokens")]);
  });
});
