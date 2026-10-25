import { describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { KoLoConfig } from "../../config/config.js";
import { buildInlineProviderModels, resolveModel } from "./model.js";

const makeModel = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

describe("buildInlineProviderModels", () => {
  it("attaches provider ids to inline models", () => {
    const providers = {
      " alpha ": { baseUrl: "http://alpha.local", models: [makeModel("alpha-model")] },
      beta: { baseUrl: "http://beta.local", models: [makeModel("beta-model")] },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toEqual([
      {
        ...makeModel("alpha-model"),
        provider: "alpha",
        baseUrl: "http://alpha.local",
        api: undefined,
      },
      {
        ...makeModel("beta-model"),
        provider: "beta",
        baseUrl: "http://beta.local",
        api: undefined,
      },
    ]);
  });

  it("inherits baseUrl from provider when model does not specify it", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].baseUrl).toBe("http://localhost:8000");
  });

  it("inherits api from provider when model does not specify it", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "anthropic-messages",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("model-level api takes precedence over provider-level api", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        api: "openai-responses",
        models: [{ ...makeModel("custom-model"), api: "anthropic-messages" as const }],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0].api).toBe("anthropic-messages");
  });

  it("inherits both baseUrl and api from provider config", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:10000",
        api: "anthropic-messages",
        models: [makeModel("claude-opus-4.5")],
      },
    };

    const result = buildInlineProviderModels(providers);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "custom",
      baseUrl: "http://localhost:10000",
      api: "anthropic-messages",
      name: "claude-opus-4.5",
    });
  });
});

describe("resolveModel", () => {
  it("includes provider baseUrl in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [],
          },
        },
      },
    } as KoLoConfig;

    const result = resolveModel("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("http://localhost:9000");
    expect(result.model?.provider).toBe("custom");
    expect(result.model?.id).toBe("missing-model");
  });
});

describe("resolveModel adapters", () => {
  it("registers the watsonx adapter when a watsonx model is resolved", async () => {
    const { getApiProvider } = await import("@mariozechner/pi-ai");
    const cfg = {
      models: {
        providers: {
          watsonx: {
            baseUrl: "https://jp-tok.ml.cloud.ibm.com?project_id=p-1",
            api: "watsonx-chat",
            models: [makeModel("ibm/granite-3-8b-instruct")],
          },
        },
      },
    } as unknown as KoLoConfig;
    const result = resolveModel("watsonx", "ibm/granite-3-8b-instruct", "/tmp/agent", cfg);
    expect(result.model?.api).toBe("watsonx-chat");
    expect(getApiProvider("watsonx-chat")).toBeDefined();
  });
});
