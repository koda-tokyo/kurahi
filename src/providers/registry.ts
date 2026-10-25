// Built-in provider registry (KoLo 2.0, M9c).
//
// `registry.json` lists the providers `kurahi providers` and `kurahi onboard` know how to wire:
// a configuration identifier, an API style, a base URL, how the key travels and whether the
// provider can list its models. Nothing here is product copy; the CLI prints display names as
// data and its own sentences say "provider". Nothing runs at import time beyond parsing the JSON.
import type { ModelApi } from "../config/types.models.js";
import REGISTRY_JSON from "./registry.json" with { type: "json" };

export const PROVIDER_API_STYLES = [
  "openai-compatible",
  "anthropic-messages",
  "gemini",
  "ollama",
  "watsonx",
] as const;
export type ProviderApiStyle = (typeof PROVIDER_API_STYLES)[number];

export const PROVIDER_AUTH_HEADERS = [
  "bearer",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "ibm-iam",
  "none",
] as const;
export type ProviderAuthHeader = (typeof PROVIDER_AUTH_HEADERS)[number];

export type ProviderRegistryEntry = {
  id: string;
  displayName: string;
  apiStyle: ProviderApiStyle;
  /** Base URL; empty when `requiresBaseUrl` (the operator supplies it at `add` time). */
  baseUrl: string;
  authHeader: ProviderAuthHeader;
  /** Relative to `baseUrl` (for `ollama`: relative to the host root); null when none. */
  modelsEndpoint: string | null;
  regionNote: string;
  defaultModel?: string;
  /** Environment variable honoured as an alternative to the stored key. */
  envVar?: string;
  /** The base URL must be given on `add` (generic endpoints, per-resource hosts). */
  requiresBaseUrl?: boolean;
  /** Offered first by `kurahi onboard`. */
  recommended?: boolean;
  /** The provider's own documentation (data for `kurahi providers show`). */
  docUrl?: string;
  /** Published list prices per model (data for cost estimates; curated entries only). */
  pricing?: ProviderPricing;
  /** `curated` entries are hand-maintained; `catalogue` entries come from the public catalogue. */
  source: "curated" | "catalogue";
};

/** Prices per million tokens in `currency`, as published by the provider on `asOf`. */
export type ProviderPricing = {
  currency: string;
  asOf: string;
  source: string;
  note?: string;
  models: Record<string, { input: number; output: number }>;
};

type RawRegistry = {
  version: number;
  providers: Array<Record<string, unknown>>;
};

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function asEntry(raw: Record<string, unknown>): ProviderRegistryEntry {
  return {
    id: str(raw.id),
    displayName: str(raw.displayName),
    apiStyle: raw.apiStyle as ProviderApiStyle,
    baseUrl: str(raw.baseUrl),
    authHeader: raw.authHeader as ProviderAuthHeader,
    modelsEndpoint: typeof raw.modelsEndpoint === "string" ? raw.modelsEndpoint : null,
    regionNote: str(raw.regionNote),
    ...(typeof raw.defaultModel === "string" ? { defaultModel: raw.defaultModel } : {}),
    ...(typeof raw.envVar === "string" ? { envVar: raw.envVar } : {}),
    ...(raw.requiresBaseUrl === true ? { requiresBaseUrl: true } : {}),
    ...(raw.recommended === true ? { recommended: true } : {}),
    ...(typeof raw.docUrl === "string" ? { docUrl: raw.docUrl } : {}),
    ...(raw.pricing && typeof raw.pricing === "object"
      ? { pricing: raw.pricing as ProviderPricing }
      : {}),
    source: raw.source === "catalogue" ? "catalogue" : "curated",
  };
}

function isLocalHttpUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Problems with a registry document; empty when it is valid. */
export function validateRegistry(doc: unknown = REGISTRY_JSON): string[] {
  const issues: string[] = [];
  const raw = doc as Partial<RawRegistry> | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.providers)) {
    return ["registry: providers must be an array"];
  }
  const seen = new Set<string>();
  for (const item of raw.providers) {
    const entry = asEntry(item);
    const where = `provider "${entry.id || "?"}"`;
    if (!PROVIDER_ID.test(entry.id)) {
      issues.push(`${where}: id must match ${PROVIDER_ID}`);
    }
    if (seen.has(entry.id)) {
      issues.push(`${where}: duplicate id`);
    }
    seen.add(entry.id);
    if (!entry.displayName) {
      issues.push(`${where}: displayName is required`);
    }
    if (!PROVIDER_API_STYLES.includes(entry.apiStyle)) {
      issues.push(`${where}: unknown apiStyle "${String(item.apiStyle)}"`);
    }
    if (!PROVIDER_AUTH_HEADERS.includes(entry.authHeader)) {
      issues.push(`${where}: unknown authHeader "${String(item.authHeader)}"`);
    }
    if (!entry.regionNote) {
      issues.push(`${where}: regionNote is required`);
    }
    if (entry.requiresBaseUrl) {
      if (entry.baseUrl && !entry.baseUrl.startsWith("https://")) {
        issues.push(`${where}: template baseUrl must start with https://`);
      }
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(entry.baseUrl);
      } catch {
        issues.push(`${where}: baseUrl is not a URL`);
      }
      if (
        parsed &&
        parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && isLocalHttpUrl(parsed))
      ) {
        issues.push(`${where}: baseUrl must be https:// (http:// only for localhost)`);
      }
    }
    if (entry.modelsEndpoint !== null && !entry.modelsEndpoint.startsWith("/")) {
      issues.push(`${where}: modelsEndpoint must start with /`);
    }
    if (entry.docUrl !== undefined && !entry.docUrl.startsWith("https://")) {
      issues.push(`${where}: docUrl must start with https://`);
    }
    if (entry.pricing !== undefined) {
      issues.push(...validatePricing(entry.pricing).map((issue) => `${where}: ${issue}`));
    }
  }
  return issues;
}

function validatePricing(pricing: ProviderPricing): string[] {
  const issues: string[] = [];
  if (!/^[A-Z]{3}$/.test(pricing.currency ?? "")) {
    issues.push("pricing.currency must be an ISO 4217 code");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pricing.asOf ?? "")) {
    issues.push("pricing.asOf must be YYYY-MM-DD");
  }
  if (typeof pricing.source !== "string" || !pricing.source.startsWith("https://")) {
    issues.push("pricing.source must start with https://");
  }
  if (!pricing.models || typeof pricing.models !== "object") {
    issues.push("pricing.models must be an object");
    return issues;
  }
  for (const [model, price] of Object.entries(pricing.models)) {
    if (
      !price ||
      typeof price.input !== "number" ||
      typeof price.output !== "number" ||
      price.input < 0 ||
      price.output < 0
    ) {
      issues.push(`pricing.models[${model}] needs non-negative input and output prices`);
    }
  }
  return issues;
}

let cached: ProviderRegistryEntry[] | null = null;

/** Every registry entry, in file order: curated entries first (the recommended one leading), then the catalogue. */
export function listProviders(): ProviderRegistryEntry[] {
  if (!cached) {
    const raw = REGISTRY_JSON as RawRegistry;
    cached = raw.providers.map(asEntry);
  }
  return cached.map((entry) => ({ ...entry }));
}

export function getProvider(id: string): ProviderRegistryEntry | undefined {
  const key = id.trim().toLowerCase();
  return listProviders().find((entry) => entry.id === key);
}

/** Published price of `provider/model` per million tokens, or null when the registry has none. */
export function getModelPrice(
  providerId: string,
  modelId: string,
): { input: number; output: number; currency: string; source: string; asOf: string } | null {
  const pricing = getProvider(providerId)?.pricing;
  const price = pricing?.models[modelId];
  if (!pricing || !price) {
    return null;
  }
  return {
    input: price.input,
    output: price.output,
    currency: pricing.currency,
    source: pricing.source,
    asOf: pricing.asOf,
  };
}

/** The Kurahi model adapter for a registry API style. */
export function registryApiToModelApi(style: ProviderApiStyle): ModelApi {
  switch (style) {
    case "anthropic-messages":
      return "anthropic-messages";
    case "gemini":
      return "google-generative-ai";
    case "openai-compatible":
    case "ollama":
      return "openai-completions";
    case "watsonx":
      return "watsonx-chat";
  }
}

/**
 * The base URL Kurahi stores in `models.providers.<id>.baseUrl`. Ollama exposes its
 * OpenAI-compatible surface under `/v1`; the registry keeps the host root because the
 * models endpoint (`/api/tags`) lives beside it.
 */
export function registryBaseUrlForConfig(entry: ProviderRegistryEntry, baseUrl?: string): string {
  const raw = (baseUrl ?? entry.baseUrl).trim().replace(/\/+$/, "");
  if (entry.apiStyle === "ollama") {
    return raw.endsWith("/v1") ? raw : `${raw}/v1`;
  }
  return raw;
}

/** The absolute URL of the provider's models listing, or null when it has none. */
export function registryModelsUrl(entry: ProviderRegistryEntry, baseUrl?: string): string | null {
  if (!entry.modelsEndpoint) {
    return null;
  }
  const root = (baseUrl ?? entry.baseUrl).trim().replace(/\/+$/, "");
  if (!root) {
    return null;
  }
  if (entry.apiStyle === "ollama") {
    return `${root.endsWith("/v1") ? root.slice(0, -3) : root}${entry.modelsEndpoint}`;
  }
  if (entry.apiStyle === "watsonx") {
    // The configured base URL carries project and version settings as query parameters.
    try {
      const url = new URL(root);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}${entry.modelsEndpoint}`;
    } catch {
      return null;
    }
  }
  return `${root}${entry.modelsEndpoint}`;
}
