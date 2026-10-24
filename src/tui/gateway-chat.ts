import { randomUUID } from "node:crypto";
import { signSiblingSendParams } from "../agents/messaging/sibling.js";
import { loadConfig, resolveGatewayPort } from "../config/config.js";
import { GatewayClient } from "../gateway/client.js";
import {
  type HelloOk,
  PROTOCOL_VERSION,
  type SessionsListParams,
  type SessionsPatchParams,
} from "../gateway/protocol/index.js";
import { resolveGatewayTokenWithSource } from "../gateway/token-file.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";

export type GatewayConnectionOptions = {
  url?: string;
  token?: string;
  password?: string;
};

export type ChatSendOptions = {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewaySessionList = {
  ts: number;
  path: string;
  count: number;
  defaults?: {
    model?: string | null;
    modelProvider?: string | null;
    contextTokens?: number | null;
  };
  sessions: Array<{
    key: string;
    sessionId?: string;
    updatedAt?: number | null;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    reasoningView?: "off" | "collapsed" | "expanded";
    sendPolicy?: string;
    model?: string;
    contextTokens?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    responseUsage?: "on" | "off" | "tokens" | "full";
    modelProvider?: string;
    label?: string;
    displayName?: string;
    provider?: string;
    groupChannel?: string;
    space?: string;
    subject?: string;
    chatType?: string;
    lastProvider?: string;
    lastTo?: string;
    lastAccountId?: string;
    derivedTitle?: string;
    lastMessagePreview?: string;
  }>;
};

export type GatewayAgentsList = {
  defaultId: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: Array<{
    id: string;
    name?: string;
  }>;
};

export type GatewayModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type GatewayJobRecord = {
  id: string;
  agent: string;
  sessionKey: string;
  kind: string;
  status: string;
  steps: number;
  toolCalls: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
  summary?: string;
};

export type SiblingMessage = {
  id: string;
  runId: string;
  from: string;
  to: string;
  text: string;
  attachments?: Array<Record<string, unknown>>;
  seq: number;
  timestamp: string;
  deliveredAt?: string;
  readAt?: string;
};

export type SiblingSendOptions = {
  to: string;
  text: string;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: string;
  }>;
  /**
   * This terminal's agent id. When set and this process can read the agent's signing key
   * (`<KOLO_HOME>/secrets/agent-keys`), the send is signed; the gateway then uses the verified
   * id as the sender instead of the client id (agents.messaging.signing.mode=enforce refuses
   * unsigned sends).
   */
  fromAgentId?: string;
};

export type SiblingHistoryOptions = {
  with: string;
  limit?: number;
  before?: string;
};

export type SiblingSubscribeOptions = {
  from?: string;
};

export type SiblingReadOptions = {
  with: string;
  upToSeq?: number;
};

// Runs started by this terminal. Other runs in the session (heartbeats, follow-ups, cron) that
// end without text are finished silently instead of printing "(no output)".
const locallySentRunIds = new Map<string, number>();
export function noteLocallySentRun(runId: string) {
  locallySentRunIds.set(runId, Date.now());
  if (locallySentRunIds.size > 200) {
    const oldest = locallySentRunIds.keys().next().value;
    if (oldest) {
      locallySentRunIds.delete(oldest);
    }
  }
}
export function wasSentLocally(runId: string) {
  return locallySentRunIds.has(runId);
}

export class GatewayChatClient {
  private client: GatewayClient;
  private readyPromise: Promise<void>;
  private resolveReady?: () => void;
  readonly connection: { url: string; token?: string; password?: string };
  hello?: HelloOk;

  onEvent?: (evt: GatewayEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onReconnectScheduled?: (delayMs: number) => void;

  constructor(opts: GatewayConnectionOptions) {
    const resolved = resolveGatewayConnection(opts);
    this.connection = resolved;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.client = new GatewayClient({
      url: resolved.url,
      token: resolved.token,
      password: resolved.password,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "kolo-tui",
      clientVersion: VERSION,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.UI,
      instanceId: randomUUID(),
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: (hello) => {
        this.hello = hello;
        this.resolveReady?.();
        this.onConnected?.();
      },
      onEvent: (evt) => {
        this.onEvent?.({
          event: evt.event,
          payload: evt.payload,
          seq: evt.seq,
        });
      },
      onClose: (_code, reason) => {
        this.onDisconnected?.(reason);
      },
      onGap: (info) => {
        this.onGap?.(info);
      },
      onReconnectScheduled: (delayMs) => {
        this.onReconnectScheduled?.(delayMs);
      },
    });
  }

  start() {
    this.client.start();
  }

  stop() {
    this.client.stop();
  }

  async waitForReady() {
    await this.readyPromise;
  }

  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = randomUUID();
    // Recorded before the request: the run's first events can arrive before the ack.
    noteLocallySentRun(runId);
    await this.client.request("chat.send", {
      sessionKey: opts.sessionKey,
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      idempotencyKey: runId,
    });
    return { runId };
  }

  async abortChat(opts: { sessionKey: string; runId: string }) {
    return await this.client.request<{ ok: boolean; aborted: boolean }>("chat.abort", {
      sessionKey: opts.sessionKey,
      runId: opts.runId,
    });
  }

  async loadHistory(opts: { sessionKey: string; limit?: number }) {
    return await this.client.request("chat.history", {
      sessionKey: opts.sessionKey,
      limit: opts.limit,
    });
  }

  async listSessions(opts?: SessionsListParams) {
    return await this.client.request<GatewaySessionList>("sessions.list", {
      limit: opts?.limit,
      activeMinutes: opts?.activeMinutes,
      includeGlobal: opts?.includeGlobal,
      includeUnknown: opts?.includeUnknown,
      includeDerivedTitles: opts?.includeDerivedTitles,
      includeLastMessage: opts?.includeLastMessage,
      agentId: opts?.agentId,
    });
  }

  async listAgents() {
    return await this.client.request<GatewayAgentsList>("agents.list", {});
  }

  /** M13: kill switch and budget pauses, for the TUI banner. */
  async policyStatus() {
    return await this.client.request<{
      status: {
        kill: { fleet: { by: string } | null; agents: Record<string, { by: string }> };
        paused: Record<string, { rule: string }>;
        fleetPaused: { rule: string } | null;
      };
    }>("policy.status", {});
  }

  async patchSession(opts: SessionsPatchParams) {
    return await this.client.request("sessions.patch", opts);
  }

  async resetSession(key: string) {
    return await this.client.request("sessions.reset", { key });
  }

  async getStatus() {
    return await this.client.request("status");
  }

  async listJobs(opts?: {
    agent?: string;
    status?: string;
    limit?: number;
  }): Promise<GatewayJobRecord[]> {
    const res = await this.client.request<{ jobs?: GatewayJobRecord[] }>("jobs.list", {
      agent: opts?.agent,
      status: opts?.status,
      limit: opts?.limit,
    });
    return Array.isArray(res?.jobs) ? res.jobs : [];
  }

  async cancelJob(id: string): Promise<{ ok: boolean; job?: GatewayJobRecord; reason?: string }> {
    return await this.client.request<{ ok: boolean; job?: GatewayJobRecord; reason?: string }>(
      "jobs.cancel",
      { id },
    );
  }

  async listModels(): Promise<GatewayModelChoice[]> {
    const res = await this.client.request<{ models?: GatewayModelChoice[] }>("models.list");
    return Array.isArray(res?.models) ? res.models : [];
  }

  // ── Sibling Chat Methods ──────────────────────────────────────────────────

  async sendSiblingMessage(
    opts: SiblingSendOptions,
  ): Promise<{ ok: boolean; runId: string; seq?: number }> {
    const runId = randomUUID();
    const text = opts.text.trim();
    let cfg: ReturnType<typeof loadConfig> | undefined;
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
    const signed = opts.fromAgentId
      ? signSiblingSendParams({
          cfg,
          fromAgentId: opts.fromAgentId,
          to: opts.to,
          text,
          attachments: opts.attachments,
        })
      : {};
    const res = await this.client.request<{ ok: boolean; runId: string; seq?: number }>(
      "sibling.send",
      {
        to: opts.to,
        text,
        attachments: opts.attachments,
        idempotencyKey: runId,
        ...signed,
      },
    );
    return res;
  }

  async subscribeSiblingMessages(
    opts: SiblingSubscribeOptions,
  ): Promise<{ ok: boolean; subscribed: boolean }> {
    const res = await this.client.request<{ ok: boolean; subscribed: boolean }>(
      "sibling.subscribe",
      {
        from: opts.from,
      },
    );
    return res;
  }

  async getSiblingHistory(opts: SiblingHistoryOptions): Promise<{
    messages: SiblingMessage[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const res = await this.client.request<{
      messages: SiblingMessage[];
      hasMore: boolean;
      nextCursor?: string;
    }>("sibling.history", {
      with: opts.with,
      limit: opts.limit,
      before: opts.before,
    });
    return res;
  }

  async markSiblingRead(opts: SiblingReadOptions): Promise<{ ok: boolean; markedRead: number }> {
    const res = await this.client.request<{ ok: boolean; markedRead: number }>("sibling.read", {
      with: opts.with,
      upToSeq: opts.upToSeq,
    });
    return res;
  }
}

export function resolveGatewayConnection(opts: GatewayConnectionOptions) {
  const config = loadConfig();
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;

  const localPort = resolveGatewayPort(config);
  const url =
    (typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined) ||
    (typeof remote?.url === "string" && remote.url.trim().length > 0
      ? remote.url.trim()
      : undefined) ||
    `ws://127.0.0.1:${localPort}`;

  const token =
    (typeof opts.token === "string" && opts.token.trim().length > 0
      ? opts.token.trim()
      : undefined) ||
    (isRemoteMode
      ? typeof remote?.token === "string" && remote.token.trim().length > 0
        ? remote.token.trim()
        : undefined
      : resolveGatewayTokenWithSource({ authConfig: config.gateway?.auth, env: process.env })
          .token);

  const password =
    (typeof opts.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined) ||
    process.env.KOLO_GATEWAY_PASSWORD?.trim() ||
    (typeof remote?.password === "string" && remote.password.trim().length > 0
      ? remote.password.trim()
      : undefined);

  return { url, token, password };
}
