// One tiny request against a provider (KoLo 2.0, M9c): `kurahi providers test` and
// `kurahi models list --live`. Never logs the key; reports latency and the models seen.
import { fetchJson } from "../../infra/provider-usage.fetch.shared.js";
import { exchangeIbmIamToken, IbmIamError } from "../../providers/ibm-iam.js";
import {
  type ProviderRegistryEntry,
  registryBaseUrlForConfig,
  registryModelsUrl,
} from "../../providers/registry.js";
import { PROVIDERS_EXIT } from "./shared.js";

export type ProbeResult =
  | { ok: true; latencyMs: number; models: string[]; via: "models" | "chat" }
  | { ok: false; latencyMs: number; exitCode: number; error: string };

export type ProbeParams = {
  entry: ProviderRegistryEntry;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

function authHeaders(entry: ProviderRegistryEntry, apiKey?: string): Record<string, string> {
  if (!apiKey || entry.authHeader === "none") {
    return {};
  }
  switch (entry.authHeader) {
    case "bearer":
      return { Authorization: `Bearer ${apiKey}` };
    case "x-api-key":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "x-goog-api-key":
      return { "x-goog-api-key": apiKey };
    case "api-key":
      return { "api-key": apiKey };
    case "ibm-iam":
      // apiKey is the bearer token exchanged by probeProvider.
      return { Authorization: `Bearer ${apiKey}` };
  }
}

function extractModelIds(entry: ProviderRegistryEntry, body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const rec = body as Record<string, unknown>;
  const list = Array.isArray(rec.data)
    ? rec.data
    : Array.isArray(rec.models)
      ? rec.models
      : Array.isArray(rec.resources)
        ? rec.resources
        : Array.isArray(body)
          ? (body as unknown[])
          : [];
  const ids: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const m = item as Record<string, unknown>;
    const raw =
      typeof m.model_id === "string"
        ? m.model_id
        : typeof m.id === "string"
          ? m.id
          : typeof m.name === "string"
            ? m.name
            : typeof m.model === "string"
              ? m.model
              : "";
    if (!raw) {
      continue;
    }
    // The Gemini API names models "models/<id>".
    ids.push(entry.apiStyle === "gemini" ? raw.replace(/^models\//, "") : raw);
  }
  return ids.toSorted();
}

function statusToExit(status: number): number {
  return status === 401 || status === 403 ? PROVIDERS_EXIT.auth : PROVIDERS_EXIT.error;
}

function chatRequest(
  entry: ProviderRegistryEntry,
  baseUrl: string,
  model: string,
): { url: string; init: RequestInit } {
  const root = registryBaseUrlForConfig(entry, baseUrl);
  if (entry.apiStyle === "anthropic-messages") {
    return {
      url: `${root}/messages`,
      init: {
        method: "POST",
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      },
    };
  }
  if (entry.apiStyle === "gemini") {
    return {
      url: `${root}/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
    };
  }
  return {
    url: `${root}/chat/completions`,
    init: {
      method: "POST",
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    },
  };
}

export async function probeProvider(params: ProbeParams): Promise<ProbeResult> {
  const { entry } = params;
  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = params.timeoutMs ?? 10_000;
  let credential = params.apiKey;
  if (entry.authHeader === "ibm-iam" && credential) {
    // The stored key is an IBM Cloud API key: exchanging it is the authentication check.
    const started = performance.now();
    try {
      credential = (await exchangeIbmIamToken({ apiKey: credential, fetchFn, timeoutMs })).token;
    } catch (err) {
      const status = err instanceof IbmIamError ? err.status : undefined;
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        exitCode: status ? PROVIDERS_EXIT.auth : PROVIDERS_EXIT.unreachable,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(entry, credential),
  };
  const modelsUrl = registryModelsUrl(entry, params.baseUrl);
  const via: "models" | "chat" = modelsUrl ? "models" : "chat";
  let target: { url: string; init: RequestInit };
  if (modelsUrl) {
    target = { url: modelsUrl, init: { method: "GET" } };
  } else {
    const model = params.model?.trim() || entry.defaultModel;
    if (!model) {
      return {
        ok: false,
        latencyMs: 0,
        exitCode: PROVIDERS_EXIT.usage,
        error:
          "this provider has no models endpoint; give --model <id> to send a one-token request",
      };
    }
    target = chatRequest(entry, params.baseUrl ?? entry.baseUrl, model);
  }
  const started = performance.now();
  let res: Response;
  try {
    res = await fetchJson(target.url, { ...target.init, headers }, timeoutMs, fetchFn);
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      latencyMs,
      exitCode: PROVIDERS_EXIT.unreachable,
      error: timedOut ? `no answer within ${timeoutMs} ms` : `unreachable (${reason})`,
    };
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!res.ok) {
    return {
      ok: false,
      latencyMs,
      exitCode: statusToExit(res.status),
      error: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the key)" : ""}`,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: true, latencyMs, models: via === "models" ? extractModelIds(entry, body) : [], via };
}
