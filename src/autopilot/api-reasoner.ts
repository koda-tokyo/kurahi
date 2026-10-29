// The reasoning step through a model API (backend `api`): an OpenAI-compatible chat completions
// call to a provider from the registry or the operator's `models.providers` (Sakura AI Engine,
// a Qwen endpoint, a local Ollama, …). Tool-less by construction: the request carries no tools and
// no tool choice, so the model is never offered a tool; a reply that still contains tool calls is
// discarded (ReasonerToolUse), as with the CLI backends. The routine names the model as
// `<provider>/<model>`, e.g. `reasoner: { backend: api, model: sakura/gpt-oss-120b }`.
import { Agent, fetch as undiciFetch } from "undici";
import type { KoLoConfig } from "../config/config.js";
import type { Reasoner, ReasonRequest, ReasonResult } from "./reasoner.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { getProvider, registryBaseUrlForConfig } from "../providers/registry.js";
import { ReasonerToolUse } from "./reasoner.js";

export const API_REASONING_BACKEND = "api";
/** A reasoning reply larger than this is refused rather than parsed. */
export const API_REASONER_MAX_RESPONSE_BYTES = 2_000_000;

export type ApiReasonerDeps = {
  fetch?: typeof fetch;
  /** The provider's API key; null for providers without one (a local Ollama). */
  apiKey?: (provider: string, cfg: KoLoConfig) => Promise<string | null>;
};

/** `ollama`: the provider's native chat API, which takes the context size per request. */
type Endpoint = { provider: string; model: string; baseUrl: string; style: "openai" | "ollama" };

/** Smallest and largest context asked of a local Ollama model, in tokens. */
export const OLLAMA_MIN_CONTEXT = 8192;
export const OLLAMA_MAX_CONTEXT = 32768;

/**
 * The context a prompt needs, generously: about one token per 2.5 characters (Japanese text runs
 * close to one per character, so this errs high for English), plus room for the answer.
 */
export function ollamaContextFor(prompt: string): number {
  const need = Math.ceil(prompt.length / 2.5) + 4096;
  const rounded = Math.ceil(need / 1024) * 1024;
  return Math.min(OLLAMA_MAX_CONTEXT, Math.max(OLLAMA_MIN_CONTEXT, rounded));
}

/** Provider and model from `<provider>/<model>`, and the provider's chat base URL. */
export function resolveApiEndpoint(cfg: KoLoConfig, modelRef: string | null): Endpoint {
  const ref = (modelRef ?? "").trim();
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(
      'the api reasoning backend needs model "<provider>/<model>", e.g. sakura/gpt-oss-120b',
    );
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  const configured = cfg.models?.providers?.[provider];
  const entry = getProvider(provider);
  if (entry && entry.apiStyle !== "openai-compatible" && entry.apiStyle !== "ollama") {
    throw new Error(
      `provider ${provider} uses ${entry.apiStyle}; the api reasoning backend speaks OpenAI-compatible chat completions`,
    );
  }
  if (configured?.api && configured.api !== "openai-completions") {
    throw new Error(
      `provider ${provider} is configured with api ${configured.api}; the api reasoning backend needs openai-completions`,
    );
  }
  const raw = configured?.baseUrl ?? (entry ? entry.baseUrl : "");
  if (!raw) {
    throw new Error(`provider ${provider} has no base URL: add it to models.providers`);
  }
  const baseUrl = entry ? registryBaseUrlForConfig(entry, raw) : raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`provider ${provider} has an invalid base URL`);
  }
  // fetch's error for such a URL quotes it whole, which would put the password in the run reason.
  if (url.username || url.password) {
    throw new Error(
      `provider ${provider}: the base URL must not contain a user name or password (use the provider's API key)`,
    );
  }
  // `/chat/completions` is appended as text: after a ? or # it would not be the request path.
  if (/[?#]/.test(baseUrl)) {
    throw new Error(`provider ${provider}: the base URL must not contain a query or fragment`);
  }
  // Plain HTTP only to a model on this machine or a private network (a container's `model`
  // service, a LAN box); anything public must be HTTPS.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost(url.hostname))) {
    throw new Error(
      `provider ${provider}: the base URL must use https (http only for a model on this machine or a private network)`,
    );
  }
  // Ollama's OpenAI-compatible endpoint applies its default context (4,096 tokens) and silently
  // drops the start of a longer prompt; its native API takes num_ctx per request.
  const style = entry?.apiStyle === "ollama" && !configured?.api ? "ollama" : "openai";
  return { provider, model, baseUrl, style };
}

/** Loopback, a single-label name (a container service), RFC 1918 IPv4 or IPv6 ULA. */
function privateHost(host: string): boolean {
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1).toLowerCase();
    // fc00::/7 needs the full first hextet: [fc::1] is 00fc::1, not a ULA.
    return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6);
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes(".");
}

class ReplyTooLarge extends Error {}

type OllamaChat = {
  error?: unknown;
  message?: { content?: unknown; tool_calls?: unknown[] };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
};

/**
 * Ollama's native reply in the chat-completion shape the checks below read. A prompt that filled
 * the context was cut by Ollama (it keeps the end), so the answer rests on part of the evidence.
 */
function fromOllamaChat(reply: OllamaChat, numCtx: number, model: string) {
  if (
    typeof reply.prompt_eval_count === "number" &&
    numCtx > 0 &&
    reply.prompt_eval_count >= numCtx - 64
  ) {
    throw new Error(
      `reasoning model ${model}: the prompt filled the model's context (${numCtx} tokens) and was cut; output discarded`,
    );
  }
  return {
    error: reply.error,
    choices: reply.message
      ? [
          {
            message: { content: reply.message.content, tool_calls: reply.message.tool_calls },
            finish_reason: reply.done_reason === "length" ? "length" : "stop",
          },
        ]
      : [],
  };
}

/** The reply body as text, refused as soon as it passes the byte cap instead of after buffering. */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ReplyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** fetch's own message is only "fetch failed"; why (ECONNREFUSED, ENOTFOUND, TLS) is its cause. */
function fetchErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return cause && cause !== msg ? `${msg} (${cause})` : msg;
}

async function defaultApiKey(provider: string, cfg: KoLoConfig): Promise<string | null> {
  if (provider === "ollama") {
    return null;
  }
  const auth = await resolveApiKeyForProvider({ provider, cfg });
  return auth.apiKey ?? null;
}

/** The text of an OpenAI-compatible message: a string or a list of text parts. */
function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * fetch with the routine's own time limit for headers and body. The global fetch gives up after
 * 300 s without response headers (undici's headersTimeout), and a non-streaming chat completion
 * sends its headers only when the answer is complete: a local model on a busy CPU never answered.
 */
function fetchWithin(dispatcher: Agent): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(
      input as string,
      { ...(init as object), dispatcher } as never,
    ) as unknown as Promise<Response>) as typeof fetch;
}

export function createApiReasoner(cfg: KoLoConfig, deps: ApiReasonerDeps = {}): Reasoner {
  const getKey = deps.apiKey ?? defaultApiKey;
  return {
    async reason(req: ReasonRequest): Promise<ReasonResult> {
      const ep = resolveApiEndpoint(cfg, req.model);
      const key = await getKey(ep.provider, cfg);
      if (key === null && ep.provider !== "ollama") {
        throw new Error(`provider ${ep.provider} has no API key configured`);
      }
      // fetch rejects such a header with an error that quotes it whole, key included.
      // oxlint-disable-next-line no-control-regex
      if (key && /[\u0000-\u001f\u007f]/.test(key)) {
        throw new Error(
          `the API key for ${ep.provider} contains a line break or control character`,
        );
      }
      // Keys are plain ASCII. A zero-width space or a full-width letter from a paste makes fetch
      // fail with a cryptic ByteString error; a Latin-1 letter is sent mangled and comes back 401.
      if (key && /[^\x20-\x7e]/.test(key)) {
        throw new Error(
          `the API key for ${ep.provider} contains a character that is not plain ASCII`,
        );
      }
      // The provider's error text, bounded. Some gateways echo the key they rejected, so it is
      // redacted before truncation (a cut must not leave part of it).
      const errorText = (text: string) =>
        (key ? text.split(key).join("[redacted]") : text).replace(/\s+/g, " ").slice(0, 200);
      const ctrl = new AbortController();
      const budgetMs = Math.max(1000, req.timeoutMs);
      const timer = setTimeout(() => ctrl.abort(), budgetMs);
      const numCtx = ep.style === "ollama" ? ollamaContextFor(req.prompt) : null;
      const messages = [{ role: "user", content: req.prompt }];
      const url =
        ep.style === "ollama"
          ? `${ep.baseUrl.replace(/\/v1$/, "")}/api/chat`
          : `${ep.baseUrl}/chat/completions`;
      const requestBody =
        ep.style === "ollama"
          ? {
              model: ep.model,
              messages,
              stream: false,
              options: { temperature: 0, num_ctx: numCtx },
            }
          : { model: ep.model, messages, temperature: 0, stream: false };
      const dispatcher = deps.fetch
        ? null
        : new Agent({ headersTimeout: budgetMs, bodyTimeout: budgetMs });
      const doFetch = deps.fetch ?? fetchWithin(dispatcher as Agent);
      // The timeout covers the reply body too: a provider that sends headers and then stalls
      // must not hold the routine past its budget.
      let res: Response;
      let body: string;
      try {
        res = await doFetch(url, {
          method: "POST",
          signal: ctrl.signal,
          // A 307/308 would re-send the prompt to a URL the https/private-network check never saw.
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          // No tools, no tool_choice: the model is never offered a tool.
          body: JSON.stringify(requestBody),
        });
        body = await readCappedText(res, API_REASONER_MAX_RESPONSE_BYTES);
      } catch (err) {
        if (err instanceof ReplyTooLarge) {
          throw new Error(
            `reasoning reply from ${ep.provider} is larger than ${API_REASONER_MAX_RESPONSE_BYTES} bytes`,
            { cause: err },
          );
        }
        throw new Error(
          ctrl.signal.aborted
            ? `reasoning call to ${ep.provider} timed out after ${req.timeoutMs} ms`
            : `reasoning call to ${ep.provider} failed: ${errorText(fetchErrorText(err))}`,
          { cause: err },
        );
      } finally {
        clearTimeout(timer);
        void dispatcher?.close().catch(() => {});
      }
      if (!res.ok) {
        throw new Error(
          `reasoning call to ${ep.provider} returned ${res.status}: ${errorText(body)}`,
        );
      }
      let parsed: {
        error?: unknown;
        choices?: Array<{
          message?: {
            content?: unknown;
            refusal?: unknown;
            tool_calls?: unknown[];
            function_call?: unknown;
          };
          finish_reason?: unknown;
        }>;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        throw new Error(`reasoning reply from ${ep.provider} is not JSON`);
      }
      // Valid JSON such as `null` or `42` would otherwise surface as a TypeError.
      if (!parsed || typeof parsed !== "object") {
        throw new Error(`reasoning reply from ${ep.provider} is not a chat completion`);
      }
      if (ep.style === "ollama") {
        parsed = fromOllamaChat(parsed as OllamaChat, numCtx ?? 0, `${ep.provider}/${ep.model}`);
      }
      // Some gateways send a failure with status 200: an error object and no choices.
      if (!parsed.choices?.length && parsed.error !== undefined && parsed.error !== null) {
        const e = parsed.error as { message?: unknown };
        const detail =
          typeof parsed.error === "string"
            ? parsed.error
            : typeof e.message === "string"
              ? e.message
              : JSON.stringify(parsed.error);
        throw new Error(`reasoning call to ${ep.provider} returned an error: ${errorText(detail)}`);
      }
      const message = parsed.choices?.[0]?.message;
      // `function_call` is the older single-call form some OpenAI-compatible servers still send.
      if (
        (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
        (message?.function_call !== undefined && message.function_call !== null)
      ) {
        throw new ReasonerToolUse(
          `reasoning model ${ep.provider}/${ep.model} returned tool calls; output discarded`,
        );
      }
      // A reply stopped by the token limit is a prefix of the answer, not the answer.
      if (parsed.choices?.[0]?.finish_reason === "length") {
        throw new Error(
          `reasoning model ${ep.provider}/${ep.model} was cut off at the token limit; output discarded`,
        );
      }
      // So is a reply a content filter stopped partway (OpenAI, Azure).
      if (parsed.choices?.[0]?.finish_reason === "content_filter") {
        throw new Error(
          `reasoning model ${ep.provider}/${ep.model} was stopped by the provider's content filter; output discarded`,
        );
      }
      // A refusal (OpenAI and compatible servers) is not a plan, even with text beside it, and
      // its wording is the reason the operator needs.
      if (typeof message?.refusal === "string" && message.refusal.trim()) {
        throw new Error(
          `reasoning model ${ep.provider}/${ep.model} refused: ${errorText(message.refusal.trim())}`,
        );
      }
      // Reasoning models served without a reasoning parser (qwen3, deepseek-r1 on Ollama or vLLM)
      // put their thinking first, in a <think> block. It is not the plan, and a brace in it would
      // break the plan parser's outermost-object fallback.
      const text = messageText(message?.content)
        .replace(/^\s*<think>[\s\S]*?<\/think>/, "")
        .trim();
      if (!text) {
        throw new Error(`reasoning model ${ep.provider}/${ep.model} returned no answer`);
      }
      return { text, backend: API_REASONING_BACKEND, model: `${ep.provider}/${ep.model}` };
    },
  };
}

/** The reasoner a routine gets: the API backend for `backend: api`, the CLI backends otherwise. */
export function createRoutingReasoner(cli: Reasoner, api: Reasoner): Reasoner {
  return {
    reason(req) {
      return (req.backend ?? "").trim().toLowerCase() === API_REASONING_BACKEND
        ? api.reason(req)
        : cli.reason(req);
    },
  };
}
