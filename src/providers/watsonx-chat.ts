// IBM watsonx.ai model adapter (model api "watsonx-chat").
//
// watsonx.ai is not reachable through the OpenAI-compatible adapter: every call needs a
// `version=YYYY-MM-DD` query parameter, a `project_id` or `space_id` in the body, `model_id`
// instead of `model`, separate paths for streaming, and an IAM bearer token that expires. This
// adapter speaks that API directly and reuses the OpenAI-format message conversion.
//
// Endpoint settings travel in the provider's base URL (models.providers.watsonx.baseUrl), so no
// new configuration keys exist:
//
//   https://jp-tok.ml.cloud.ibm.com?project_id=<id>            SaaS, project (default region)
//   https://jp-tok.ml.cloud.ibm.com?space_id=<id>              SaaS, deployment space
//     &version=2024-03-14                                      API version date (default below)
//     &mode=gateway                                            OpenAI-compatible model gateway
//                                                              (/ml/gateway/v1/chat/completions)
//     &auth=bearer                                             the stored key is already a token
//     &iam_url=https://iam.example.com/identity/token          another IAM token endpoint
//
// The stored key (auth profile store or WATSONX_AI_APIKEY) is an IBM Cloud API key; it is
// exchanged for a bearer token per call through a shared cache that refreshes before expiry.
//
// Paths and body fields follow IBM's watsonx.ai API reference and its Node SDK
// (TEXT.CHAT /ml/v1/text/chat, TEXT.CHAT_STREAM /ml/v1/text/chat_stream, GATEWAY
// /ml/gateway/v1/chat/completions). Not tested against a live account.
import {
  type Api,
  type AssistantMessage,
  type Context,
  calculateCost,
  convertMessages,
  createAssistantMessageEventStream,
  type Model,
  parseStreamingJson,
  registerApiProvider,
  type SimpleStreamOptions,
  type StreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { assertIamTokenUrl, createIbmIamTokenCache, IBM_IAM_TOKEN_URL } from "./ibm-iam.js";

export const WATSONX_API = "watsonx-chat";
export const WATSONX_DEFAULT_BASE_URL = "https://jp-tok.ml.cloud.ibm.com";
/** The API version date IBM lists as active for the /ml/v1 APIs. */
export const WATSONX_DEFAULT_VERSION = "2024-03-14";
export const WATSONX_ENV_VAR = "WATSONX_AI_APIKEY";

export type WatsonxEndpoint = {
  origin: string;
  version: string;
  mode: "chat" | "gateway";
  auth: "iam" | "bearer";
  iamUrl: string;
  projectId?: string;
  spaceId?: string;
};

const ID = /^[A-Za-z0-9-]{1,64}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the provider base URL. Throws a readable error for anything unusable. */
export function parseWatsonxEndpoint(baseUrl: string | undefined): WatsonxEndpoint {
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || WATSONX_DEFAULT_BASE_URL);
  } catch {
    throw new Error("watsonx base URL is not a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("watsonx base URL must use https");
  }
  const q = url.searchParams;
  const projectId = q.get("project_id")?.trim() || undefined;
  const spaceId = q.get("space_id")?.trim() || undefined;
  const version = q.get("version")?.trim() || WATSONX_DEFAULT_VERSION;
  const mode = q.get("mode") === "gateway" ? "gateway" : "chat";
  const auth = q.get("auth") === "bearer" ? "bearer" : "iam";
  for (const [name, value] of [
    ["project_id", projectId],
    ["space_id", spaceId],
  ] as const) {
    if (value && !ID.test(value)) {
      throw new Error(`watsonx ${name} is not an id`);
    }
  }
  if (!VERSION.test(version)) {
    throw new Error("watsonx version must be YYYY-MM-DD");
  }
  if (mode === "chat" && !projectId && !spaceId) {
    throw new Error("watsonx base URL needs ?project_id=<id> or ?space_id=<id>");
  }
  if (projectId && spaceId) {
    throw new Error("watsonx base URL takes project_id or space_id, not both");
  }
  const iamUrl = assertIamTokenUrl(q.get("iam_url")?.trim() || IBM_IAM_TOKEN_URL);
  const path = url.pathname.replace(/\/+$/, "");
  return {
    origin: `${url.origin}${path}`,
    version,
    mode,
    auth,
    iamUrl,
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
  };
}

export function watsonxRequestUrl(endpoint: WatsonxEndpoint, stream: boolean): string {
  if (endpoint.mode === "gateway") {
    return `${endpoint.origin}/ml/gateway/v1/chat/completions`;
  }
  const path = stream ? "/ml/v1/text/chat_stream" : "/ml/v1/text/chat";
  return `${endpoint.origin}${path}?version=${encodeURIComponent(endpoint.version)}`;
}

const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: true,
  requiresMistralToolIds: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: false,
} as const;

/** Request body for text/chat (chat mode) or the OpenAI-compatible gateway. */
export function buildWatsonxBody(
  model: Model<Api>,
  context: Context,
  endpoint: WatsonxEndpoint,
  options: StreamOptions | undefined,
): Record<string, unknown> {
  const messages = convertMessages(
    model as Model<"openai-completions">,
    context,
    COMPAT as unknown as Parameters<typeof convertMessages>[2],
  );
  const tools = context.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const common: Record<string, unknown> = {
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
  if (endpoint.mode === "gateway") {
    return { model: model.id, ...common, stream: true, stream_options: { include_usage: true } };
  }
  // text/chat: tool_choice_option "auto" is documented as not yet supported, so none is sent;
  // with tools present the model decides.
  return {
    model_id: model.id,
    ...(endpoint.projectId ? { project_id: endpoint.projectId } : {}),
    ...(endpoint.spaceId ? { space_id: endpoint.spaceId } : {}),
    ...common,
  };
}

type Chunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Split an SSE body into `data:` payloads (events may be named, as text/chat_stream does). */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    const text = value ? decoder.decode(value, { stream: true }) : decoder.decode();
    buffer += text.replace(/\r\n/g, "\n");
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0 || (done && buffer.trim())) {
      const block = cut >= 0 ? buffer.slice(0, cut) : buffer;
      buffer = cut >= 0 ? buffer.slice(cut + 2) : "";
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        yield data;
      }
      cut = buffer.indexOf("\n\n");
    }
    if (done) {
      return;
    }
  }
}

function mapStopReason(reason: string | null | undefined): AssistantMessage["stopReason"] {
  switch (reason) {
    case "length":
    case "max_tokens":
    case "token_limit":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    default:
      return "stop";
  }
}

const iamCache = createIbmIamTokenCache();

export type WatsonxDeps = { fetchFn?: typeof fetch; tokens?: typeof iamCache };

/** pi-ai stream function for api "watsonx-chat". */
export function createWatsonxStream(deps: WatsonxDeps = {}) {
  const fetchFn = deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const tokens = deps.tokens ?? iamCache;
  return (model: Model<Api>, context: Context, options?: StreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    void (async () => {
      try {
        const endpoint = parseWatsonxEndpoint(model.baseUrl);
        const key = (options?.apiKey ?? process.env[WATSONX_ENV_VAR] ?? "").trim();
        if (!key) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const bearer = endpoint.auth === "bearer" ? key : await tokens.get(key, endpoint.iamUrl);
        const body = buildWatsonxBody(model, context, endpoint, options);
        options?.onPayload?.(body);
        const res = await fetchFn(watsonxRequestUrl(endpoint, true), {
          method: "POST",
          headers: {
            ...model.headers,
            ...options?.headers,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: options?.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 401 && endpoint.auth === "iam") {
            tokens.invalidate(key, endpoint.iamUrl);
          }
          const detail = await errorDetail(res);
          throw new Error(`watsonx.ai request failed: HTTP ${res.status}${detail}`);
        }
        stream.push({ type: "start", partial: output });
        type Block = TextContent | ThinkingContent | (ToolCall & { partialArgs?: string });
        let current: Block | null = null;
        const index = () => output.content.length - 1;
        const finish = (block: Block | null) => {
          if (!block) {
            return;
          }
          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: index(),
              content: block.text,
              partial: output,
            });
          } else if (block.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: index(),
              content: block.thinking,
              partial: output,
            });
          } else {
            block.arguments = JSON.parse(block.partialArgs || "{}") as Record<string, unknown>;
            delete block.partialArgs;
            stream.push({
              type: "toolcall_end",
              contentIndex: index(),
              toolCall: block,
              partial: output,
            });
          }
        };
        for await (const data of readSseData(res.body)) {
          let chunk: Chunk;
          try {
            chunk = JSON.parse(data) as Chunk;
          } catch {
            continue;
          }
          if (chunk.usage) {
            const input = chunk.usage.prompt_tokens ?? 0;
            const out = chunk.usage.completion_tokens ?? 0;
            output.usage = {
              ...output.usage,
              input,
              output: out,
              totalTokens: input + out,
            };
            calculateCost(model, output.usage);
          }
          const choice = chunk.choices?.[0];
          if (!choice) {
            continue;
          }
          if (choice.finish_reason) {
            output.stopReason = mapStopReason(choice.finish_reason);
          }
          const delta = choice.delta;
          if (!delta) {
            continue;
          }
          if (delta.reasoning_content) {
            if (current?.type !== "thinking") {
              finish(current);
              current = { type: "thinking", thinking: "" };
              output.content.push(current);
              stream.push({ type: "thinking_start", contentIndex: index(), partial: output });
            }
            current.thinking += delta.reasoning_content;
            stream.push({
              type: "thinking_delta",
              contentIndex: index(),
              delta: delta.reasoning_content,
              partial: output,
            });
          }
          if (delta.content) {
            if (current?.type !== "text") {
              finish(current);
              current = { type: "text", text: "" };
              output.content.push(current);
              stream.push({ type: "text_start", contentIndex: index(), partial: output });
            }
            current.text += delta.content;
            stream.push({
              type: "text_delta",
              contentIndex: index(),
              delta: delta.content,
              partial: output,
            });
          }
          for (const call of delta.tool_calls ?? []) {
            if (current?.type !== "toolCall" || (call.id && current.id !== call.id)) {
              finish(current);
              current = {
                type: "toolCall",
                id: call.id ?? "",
                name: call.function?.name ?? "",
                arguments: {},
                partialArgs: "",
              };
              output.content.push(current);
              stream.push({ type: "toolcall_start", contentIndex: index(), partial: output });
            }
            if (call.function?.name) {
              current.name = call.function.name;
            }
            const piece = call.function?.arguments ?? "";
            current.partialArgs = (current.partialArgs ?? "") + piece;
            current.arguments = parseStreamingJson(current.partialArgs);
            stream.push({
              type: "toolcall_delta",
              contentIndex: index(),
              delta: piece,
              partial: output,
            });
          }
        }
        finish(current);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.content.some((b) => b.type === "toolCall")) {
          output.stopReason = "toolUse";
        }
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
      } catch (err) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
}

/** A short, key-free summary of an error answer (IBM errors carry errors[].code/message). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 4000);
    const parsed = JSON.parse(text) as { errors?: Array<{ code?: string; message?: string }> };
    const first = parsed.errors?.[0];
    if (first) {
      return ` (${[first.code, first.message].filter(Boolean).join(": ").slice(0, 300)})`;
    }
  } catch {
    // not JSON
  }
  return "";
}

let registered = false;

/** Register the adapter with the model runtime once; called when a watsonx model is resolved. */
export function ensureWatsonxApiRegistered(): void {
  if (registered) {
    return;
  }
  registered = true;
  const stream = createWatsonxStream();
  registerApiProvider(
    {
      api: WATSONX_API,
      stream,
      streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
        stream(model, context, options),
    },
    "kurahi-watsonx",
  );
}
