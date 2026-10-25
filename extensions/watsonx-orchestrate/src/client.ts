import type { OrchestrateAgent, OrchestrateConfig } from "./config.js";
import {
  createIbmIamTokenCache,
  IBM_IAM_TOKEN_URL,
  type IbmIamTokenCache,
} from "../../../src/providers/ibm-iam.js";

// Client for the watsonx Orchestrate "Chat with agents" API:
//   POST <instanceUrl>/v1/orchestrate/{agent_id}/chat/completions
//   Authorization: Bearer <IAM token>     X-IBM-THREAD-ID: <thread>   (optional, continues a thread)
//   { "messages": [{ "role": "user", "content": "<text>" }], "stream": false }
// The answer carries `thread_id` and `choices`. IBM does not document the shape of a choice;
// the text is read leniently (OpenAI-style message.content as a string or as content items with
// `text`). The model names an agent; it never supplies a URL or an agent id.

export class OrchestrateError extends Error {
  constructor(
    message: string,
    readonly reason: "config" | "auth" | "network" | "protocol" | "remote",
    readonly status?: number,
  ) {
    super(message);
    this.name = "OrchestrateError";
  }
}

export type ChatResult = { text: string; threadId?: string; responseId?: string };

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value);
}

/** Read at most `limit` bytes of a response body. */
export async function readBounded(res: Response, limit: number): Promise<string> {
  if (!res.body) {
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new OrchestrateError(`response exceeds ${limit} bytes`, "protocol");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        isRecord(item) && typeof item.text === "string"
          ? item.text
          : typeof item === "string"
            ? item
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Text of a chat completion answer, across the shapes the API may use. */
export function extractChatText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return "";
  }
  return body.choices
    .map((choice) => {
      if (!isRecord(choice)) {
        return "";
      }
      const message = isRecord(choice.message)
        ? choice.message
        : isRecord(choice.delta)
          ? choice.delta
          : null;
      return message
        ? contentText(message.content)
        : typeof choice.text === "string"
          ? choice.text
          : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export class OrchestrateClient {
  private readonly fetchImpl: typeof fetch;
  private readonly iam: IbmIamTokenCache;

  constructor(
    private readonly cfg: OrchestrateConfig,
    deps: { fetch?: typeof fetch; iam?: IbmIamTokenCache } = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.iam = deps.iam ?? createIbmIamTokenCache({ fetchFn: this.fetchImpl });
  }

  agentNames(): string[] {
    return this.cfg.agents.map((a) => a.name);
  }

  resolveAgent(name: string): OrchestrateAgent {
    const agent = this.cfg.agents.find((a) => a.name === name);
    if (!agent) {
      throw new OrchestrateError(
        `unknown Orchestrate agent "${String(name).slice(0, 64)}"; configured: ${this.agentNames().join(", ") || "(none)"}`,
        "config",
      );
    }
    return agent;
  }

  private async bearer(): Promise<string> {
    const key = this.cfg.apiKey ?? "";
    if (!key) {
      throw new OrchestrateError("no API key is configured", "config");
    }
    if (this.cfg.auth === "bearer") {
      return key;
    }
    try {
      return await this.iam.get(key, this.cfg.iamUrl ?? IBM_IAM_TOKEN_URL);
    } catch (err) {
      throw new OrchestrateError(
        err instanceof Error ? err.message : "IAM exchange failed",
        "auth",
      );
    }
  }

  async chat(name: string, text: string, opts: { threadId?: string } = {}): Promise<ChatResult> {
    const agent = this.resolveAgent(name);
    if (!text.trim()) {
      throw new OrchestrateError("message is empty", "config");
    }
    if (text.length > this.cfg.maxMessageChars) {
      throw new OrchestrateError(
        `message exceeds ${this.cfg.maxMessageChars} characters`,
        "config",
      );
    }
    if (opts.threadId !== undefined && !isThreadId(opts.threadId)) {
      throw new OrchestrateError("threadId is not a valid id", "config");
    }
    const base = (this.cfg.instanceUrl ?? "").replace(/\/+$/, "");
    const url = `${base}/v1/orchestrate/${encodeURIComponent(agent.agentId)}/chat/completions`;
    const send = async (token: string) => {
      try {
        return await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(opts.threadId ? { "X-IBM-THREAD-ID": opts.threadId } : {}),
          },
          body: JSON.stringify({ messages: [{ role: "user", content: text }], stream: false }),
          redirect: "error",
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (err) {
        const timedOut =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new OrchestrateError(
          timedOut ? `no answer within ${this.cfg.timeoutMs} ms` : "Orchestrate is unreachable",
          "network",
        );
      }
    };
    let res = await send(await this.bearer());
    if (res.status === 401 && this.cfg.auth === "iam" && this.cfg.apiKey) {
      // The cached token may have been revoked early: one fresh exchange, one retry.
      this.iam.invalidate(this.cfg.apiKey, this.cfg.iamUrl ?? IBM_IAM_TOKEN_URL);
      res = await send(await this.bearer());
    }
    const raw = await readBounded(res, this.cfg.maxResponseBytes);
    if (res.status === 401 || res.status === 403) {
      throw new OrchestrateError(
        `Orchestrate refused the credentials (HTTP ${res.status})`,
        "auth",
        res.status,
      );
    }
    if (!res.ok) {
      // Remote-authored detail: kept short, wrapped as untrusted by the tool layer.
      throw new OrchestrateError(
        `Orchestrate error HTTP ${res.status}: ${raw.slice(0, 300)}`,
        "remote",
        res.status,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new OrchestrateError("Orchestrate returned invalid JSON", "protocol");
    }
    const rec = isRecord(body) ? body : {};
    return {
      text: extractChatText(body),
      ...(isThreadId(rec.thread_id) ? { threadId: rec.thread_id } : {}),
      ...(isThreadId(rec.id) ? { responseId: rec.id } : {}),
    };
  }
}
