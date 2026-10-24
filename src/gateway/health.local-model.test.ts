import { describe, expect, it } from "vitest";
import { hasLocalModelFallback } from "./health.js";

// `kurahi init --provider local` writes only agents.defaults.model.primary = "ollama/<model>";
// such an installation has no auth profile by design and must not report a missing credential
// (deep /health "degraded" for ever).
describe("hasLocalModelFallback", () => {
  it("accepts the config `kurahi init --provider local` writes", () => {
    expect(
      hasLocalModelFallback(
        { agents: { defaults: { model: { primary: "ollama/qwen2.5:1.5b" } } } },
        {},
      ),
    ).toBe(true);
    expect(
      // Older configs spell the model as a bare string; the resolvers accept it.
      hasLocalModelFallback({ agents: { defaults: { model: "ollama/gpt-oss:20b" } } } as never, {}),
    ).toBe(true);
  });

  it("keeps the explicit provider and environment signals", () => {
    expect(hasLocalModelFallback({ models: { providers: { ollama: {} } } } as never, {})).toBe(
      true,
    );
    expect(hasLocalModelFallback({}, { OLLAMA_HOST: "127.0.0.1:11434" })).toBe(true);
  });

  it("still reports a missing credential when any configured model needs a hosted provider", () => {
    expect(hasLocalModelFallback({}, {})).toBe(false);
    expect(
      hasLocalModelFallback(
        { agents: { defaults: { model: { primary: "anthropic/claude-x" } } } },
        {},
      ),
    ).toBe(false);
    expect(
      hasLocalModelFallback(
        {
          agents: {
            defaults: { model: { primary: "ollama/qwen2.5:1.5b" } },
            list: [{ id: "ops", model: "openai/gpt-x" }],
          },
        },
        {},
      ),
    ).toBe(false);
  });
});
