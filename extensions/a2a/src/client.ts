import { randomUUID } from "node:crypto";
import type { A2aClientConfig, A2aRemoteAgent } from "./config.js";
import { type Dialect, parseTaskState, type TaskState } from "./protocol.js";

// A2A client for operator-configured remote agents. The model names a remote agent; it never
// supplies a URL. Every URL (card and endpoint) must be HTTPS unless its host is loopback,
// redirects are refused, a card cannot move the endpoint to another origin, and responses are
// size- and time-bounded. Results are plain data; the tool layer wraps them as untrusted.

export class A2aClientError extends Error {
  constructor(
    message: string,
    public readonly reason: "config" | "insecure" | "network" | "protocol" | "remote",
  ) {
    super(message);
    this.name = "A2aClientError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** HTTPS, or plain HTTP to a loopback host. No credentials in the URL. */
export function assertSafeRemoteUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2aClientError(`${what} is not a valid URL`, "config");
  }
  if (url.username || url.password) {
    throw new A2aClientError(`${what} must not embed credentials`, "insecure");
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return url;
  }
  throw new A2aClientError(
    `${what} must use https (plain http is allowed only for loopback)`,
    "insecure",
  );
}

export type RemoteCard = {
  name?: string;
  description?: string;
  rpcUrl: string;
  dialect: Dialect;
  skills: Array<{ id?: string; name?: string; description?: string }>;
};

export type RemoteResult = {
  kind: "task" | "message";
  taskId?: string;
  contextId?: string;
  state?: TaskState | "unknown";
  text: string;
};

type FetchLike = typeof fetch;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safeId = (v: unknown) => (typeof v === "string" && SAFE_ID.test(v) ? v : undefined);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class A2aClient {
  private readonly cards = new Map<string, { card: RemoteCard; at: number }>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly cfg: A2aClientConfig,
    deps: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  agentNames(): string[] {
    return this.cfg.agents.map((a) => a.name);
  }

  resolveAgent(name: string): A2aRemoteAgent {
    const agent = this.cfg.agents.find((a) => a.name === name);
    if (!agent) {
      throw new A2aClientError(
        `unknown A2A agent "${String(name).slice(0, 64)}"; configured: ${this.agentNames().join(", ") || "(none)"}`,
        "config",
      );
    }
    return agent;
  }

  async getCard(name: string): Promise<RemoteCard> {
    const agent = this.resolveAgent(name);
    const cached = this.cards.get(agent.name);
    if (cached && this.now() - cached.at < this.cfg.cardTtlSeconds * 1000) {
      return cached.card;
    }
    const cardUrl = assertSafeRemoteUrl(agent.cardUrl, "cardUrl");
    const body = await this.request(agent, cardUrl, {
      method: "GET",
      headers: { "A2A-Version": "1.0" },
    });
    const card = parseCard(body, agent, cardUrl);
    this.cards.set(agent.name, { card, at: this.now() });
    return card;
  }

  async send(
    name: string,
    text: string,
    opts: { contextId?: string; taskId?: string } = {},
  ): Promise<RemoteResult> {
    if (text.length > this.cfg.maxMessageChars) {
      throw new A2aClientError(`message exceeds ${this.cfg.maxMessageChars} characters`, "config");
    }
    const agent = this.resolveAgent(name);
    const card = await this.getCard(name);
    const v1 = card.dialect === "1.0";
    const message = {
      ...(v1 ? {} : { kind: "message" }),
      messageId: randomUUID(),
      role: v1 ? "ROLE_USER" : "user",
      parts: [v1 ? { text } : { kind: "text", text }],
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    };
    const result = await this.rpc(agent, card, v1 ? "SendMessage" : "message/send", {
      message,
      configuration: v1
        ? { acceptedOutputModes: ["text/plain", "application/json"] }
        : { acceptedOutputModes: ["text/plain", "application/json"], blocking: true },
    });
    return normalizeResult(result);
  }

  async getTask(name: string, taskId: string): Promise<RemoteResult> {
    const agent = this.resolveAgent(name);
    const card = await this.getCard(name);
    const result = await this.rpc(agent, card, card.dialect === "1.0" ? "GetTask" : "tasks/get", {
      id: taskId,
    });
    return normalizeResult(result);
  }

  private async rpc(agent: A2aRemoteAgent, card: RemoteCard, method: string, params: unknown) {
    const url = assertSafeRemoteUrl(card.rpcUrl, "rpcUrl");
    const id = randomUUID();
    const body = await this.request(agent, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(card.dialect === "1.0" ? { "A2A-Version": "1.0" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!isRecord(body)) {
      throw new A2aClientError("remote returned a non-object JSON-RPC response", "protocol");
    }
    if (isRecord(body.error)) {
      const code = typeof body.error.code === "number" ? body.error.code : "?";
      const msg = typeof body.error.message === "string" ? body.error.message.slice(0, 300) : "";
      throw new A2aClientError(`remote error ${code}: ${msg}`, "remote");
    }
    if (!("result" in body)) {
      throw new A2aClientError("remote response has no result", "protocol");
    }
    return body.result;
  }

  private async request(
    agent: A2aRemoteAgent,
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          Accept: "application/json",
          ...init.headers,
          ...(agent.token ? { Authorization: `Bearer ${agent.token}` } : {}),
        },
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new A2aClientError(
        timedOut ? `request to ${agent.name} timed out` : `request to ${agent.name} failed`,
        "network",
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new A2aClientError(
        `${agent.name} answered with a redirect; redirects are refused`,
        "insecure",
      );
    }
    const text = await readCapped(res, this.cfg.maxResponseBytes);
    if (!res.ok) {
      throw new A2aClientError(`${agent.name} answered HTTP ${res.status}`, "remote");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new A2aClientError(`${agent.name} returned invalid JSON`, "protocol");
    }
  }
}

async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new A2aClientError(`response exceeds ${limit} bytes`, "protocol");
  }
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
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new A2aClientError(`response exceeds ${limit} bytes`, "protocol");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const protocolVersionOf = (i: Record<string, unknown>) =>
  typeof i.protocolVersion === "string" ? i.protocolVersion : "";

/** Picks a JSON-RPC interface from a 1.0 or 0.3 card and pins the endpoint to the card's origin. */
export function parseCard(body: unknown, agent: A2aRemoteAgent, cardUrl: URL): RemoteCard {
  if (!isRecord(body)) {
    throw new A2aClientError("agent card is not a JSON object", "protocol");
  }
  let rpc: string | undefined;
  let dialect: Dialect = "0.3";
  if (Array.isArray(body.supportedInterfaces)) {
    const ifaces = body.supportedInterfaces.filter(
      (i): i is Record<string, unknown> =>
        isRecord(i) && i.protocolBinding === "JSONRPC" && typeof i.url === "string",
    );
    const v1 = ifaces.find((i) => protocolVersionOf(i).startsWith("1."));
    const v03 = ifaces.find((i) => protocolVersionOf(i).startsWith("0.3"));
    if (v1) {
      rpc = v1.url as string;
      dialect = "1.0";
    } else if (v03) {
      rpc = v03.url as string;
    }
  }
  if (!rpc && typeof body.url === "string") {
    const transport =
      typeof body.preferredTransport === "string" ? body.preferredTransport : "JSONRPC";
    if (transport.toUpperCase() !== "JSONRPC") {
      throw new A2aClientError(
        `agent card prefers ${transport.slice(0, 20)}; only JSONRPC is supported`,
        "protocol",
      );
    }
    rpc = body.url;
  }
  if (agent.rpcUrl) {
    rpc = agent.rpcUrl;
  } else {
    if (!rpc) {
      throw new A2aClientError("agent card has no JSON-RPC endpoint", "protocol");
    }
    const resolved = assertSafeRemoteUrl(new URL(rpc, cardUrl).toString(), "card endpoint");
    if (resolved.origin !== cardUrl.origin) {
      throw new A2aClientError(
        "agent card points the endpoint at another origin; set rpcUrl in config to allow it",
        "insecure",
      );
    }
    rpc = resolved.toString();
  }
  assertSafeRemoteUrl(rpc, "rpcUrl");
  const skills = Array.isArray(body.skills) ? body.skills.filter(isRecord).slice(0, 50) : [];
  return {
    name: typeof body.name === "string" ? body.name.slice(0, 200) : undefined,
    description: typeof body.description === "string" ? body.description.slice(0, 2000) : undefined,
    rpcUrl: rpc,
    dialect,
    skills: skills.map((s) => ({
      id: typeof s.id === "string" ? s.id.slice(0, 100) : undefined,
      name: typeof s.name === "string" ? s.name.slice(0, 200) : undefined,
      description: typeof s.description === "string" ? s.description.slice(0, 1000) : undefined,
    })),
  };
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .filter(isRecord)
    .map((p) => {
      if (typeof p.text === "string") {
        return p.text;
      }
      if ("data" in p) {
        return JSON.stringify(p.data);
      }
      if (p.kind === "file" || "file" in p || "url" in p || "raw" in p) {
        return "[file part omitted]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Accepts 0.3 (bare Task/Message, `kind`) and 1.0 (`{ task }` / `{ message }`) results. */
export function normalizeResult(result: unknown): RemoteResult {
  if (!isRecord(result)) {
    throw new A2aClientError("remote result is not an object", "protocol");
  }
  const inner = isRecord(result.task)
    ? result.task
    : isRecord(result.message)
      ? result.message
      : result;
  const isMessage =
    isRecord(result.message) ||
    inner.kind === "message" ||
    (!("status" in inner) && "parts" in inner);
  if (isMessage) {
    return {
      kind: "message",
      contextId: safeId(inner.contextId),
      taskId: safeId(inner.taskId),
      text: partsText(inner.parts),
    };
  }
  const status = isRecord(inner.status) ? inner.status : {};
  const artifacts = Array.isArray(inner.artifacts) ? inner.artifacts.filter(isRecord) : [];
  let text = artifacts
    .map((a) => partsText(a.parts))
    .filter(Boolean)
    .join("\n\n");
  if (!text && isRecord(status.message)) {
    text = partsText(status.message.parts);
  }
  return {
    kind: "task",
    taskId: safeId(inner.id),
    contextId: safeId(inner.contextId),
    state: parseTaskState(status.state),
    text,
  };
}
