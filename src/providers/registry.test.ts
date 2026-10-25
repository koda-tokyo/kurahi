import { describe, expect, it } from "vitest";
import {
  getModelPrice,
  getProvider,
  listProviders,
  registryApiToModelApi,
  registryBaseUrlForConfig,
  registryModelsUrl,
  validateRegistry,
} from "./registry.js";

describe("provider registry", () => {
  it("ships a valid document", () => {
    expect(validateRegistry()).toEqual([]);
    const ids = listProviders().map((p) => p.id);
    expect(ids[0]).toBe("sakura");
    for (const required of ["sakura", "openai-compatible", "ollama"]) {
      expect(ids).toContain(required);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is the curated list followed by the generated catalogue, at least fifty providers", () => {
    const list = listProviders();
    expect(list.length).toBeGreaterThanOrEqual(50);
    const firstCatalogue = list.findIndex((entry) => entry.source === "catalogue");
    expect(firstCatalogue).toBeGreaterThanOrEqual(17);
    expect(list.slice(0, firstCatalogue).every((entry) => entry.source === "curated")).toBe(true);
    expect(list.slice(firstCatalogue).every((entry) => entry.source === "catalogue")).toBe(true);
    const generatedIds = list.slice(firstCatalogue).map((entry) => entry.id);
    expect(generatedIds).toEqual([...generatedIds].toSorted());
    for (const entry of list.slice(firstCatalogue)) {
      expect(entry.baseUrl.startsWith("https://"), entry.id).toBe(true);
      expect(entry.modelsEndpoint).toBe("/models");
      expect(entry.regionNote.length).toBeGreaterThan(0);
    }
    expect(validateRegistry({ providers: [{ ...list[0], docUrl: "http://x" }] })).toEqual([
      'provider "sakura": docUrl must start with https://',
    ]);
  });

  it("rejects duplicates, bad urls and unknown styles", () => {
    const issues = validateRegistry({
      providers: [
        {
          id: "a",
          displayName: "A",
          apiStyle: "openai-compatible",
          baseUrl: "http://x.test/v1",
          authHeader: "bearer",
          regionNote: "r",
        },
        {
          id: "a",
          displayName: "A",
          apiStyle: "weird",
          baseUrl: "https://x.test/v1",
          authHeader: "bearer",
          regionNote: "r",
          modelsEndpoint: "models",
        },
        {
          id: "Bad Id",
          displayName: "",
          apiStyle: "ollama",
          baseUrl: "http://localhost:11434",
          authHeader: "nope",
          regionNote: "",
        },
      ],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("baseUrl must be https://"),
        expect.stringContaining("duplicate id"),
        expect.stringContaining('unknown apiStyle "weird"'),
        expect.stringContaining("modelsEndpoint must start with /"),
        expect.stringContaining("id must match"),
        expect.stringContaining("displayName is required"),
        expect.stringContaining('unknown authHeader "nope"'),
        expect.stringContaining("regionNote is required"),
      ]),
    );
  });

  it("looks entries up case-insensitively and copies them", () => {
    const a = getProvider("SAKURA");
    expect(a?.baseUrl).toBe("https://api.ai.sakura.ad.jp/v1");
    expect(getProvider("nope")).toBeUndefined();
    const list = listProviders();
    list[0].id = "mutated";
    expect(listProviders()[0].id).toBe("sakura");
  });

  it("maps api styles and builds urls", () => {
    expect(registryApiToModelApi("openai-compatible")).toBe("openai-completions");
    expect(registryApiToModelApi("anthropic-messages")).toBe("anthropic-messages");
    expect(registryApiToModelApi("gemini")).toBe("google-generative-ai");
    expect(registryApiToModelApi("ollama")).toBe("openai-completions");
    const ollama = getProvider("ollama")!;
    expect(registryBaseUrlForConfig(ollama)).toBe("http://127.0.0.1:11434/v1");
    expect(registryModelsUrl(ollama)).toBe("http://127.0.0.1:11434/api/tags");
    expect(registryModelsUrl(ollama, "http://10.0.0.5:11434/v1")).toBe(
      "http://10.0.0.5:11434/api/tags",
    );
    const sakura = getProvider("sakura")!;
    expect(registryModelsUrl(sakura)).toBe("https://api.ai.sakura.ad.jp/v1/models");
    expect(registryModelsUrl(getProvider("zai")!)).toBeNull();
    expect(registryModelsUrl(getProvider("openai-compatible")!)).toBeNull();
    expect(registryModelsUrl(getProvider("openai-compatible")!, "https://llm.example/v1/")).toBe(
      "https://llm.example/v1/models",
    );
    const watsonx = getProvider("watsonx")!;
    expect(registryApiToModelApi(watsonx.apiStyle)).toBe("watsonx-chat");
    expect(watsonx.requiresBaseUrl).toBe(true);
    expect(
      registryModelsUrl(
        watsonx,
        "https://jp-tok.ml.cloud.ibm.com?project_id=p-1&version=2024-03-14",
      ),
    ).toBe(
      "https://jp-tok.ml.cloud.ibm.com/ml/v1/foundation_model_specs?version=2024-03-14&filters=function_text_chat",
    );
  });

  it("carries published prices for curated providers and validates them", () => {
    expect(getModelPrice("deepseek", "deepseek-flash")).toMatchObject({ currency: "USD" });
    expect(getModelPrice("sakura", "gpt-oss-120b")).toMatchObject({ currency: "JPY", input: 15 });
    expect(getModelPrice("sakura", "no-such-model")).toBeNull();
    expect(getModelPrice("groq", "x")).toBeNull();
    const base = {
      id: "p",
      displayName: "P",
      apiStyle: "openai-compatible",
      baseUrl: "https://p.example/v1",
      authHeader: "bearer",
      modelsEndpoint: "/models",
      regionNote: "somewhere",
    };
    const issues = validateRegistry({
      version: 1,
      providers: [
        {
          ...base,
          pricing: {
            currency: "usd",
            asOf: "today",
            source: "http://x",
            models: { m: { input: -1, output: 1 } },
          },
        },
      ],
    });
    expect(issues.join("\n")).toMatch(/currency/);
    expect(issues.join("\n")).toMatch(/asOf/);
    expect(issues.join("\n")).toMatch(/source/);
    expect(issues.join("\n")).toMatch(/non-negative/);
  });
});
