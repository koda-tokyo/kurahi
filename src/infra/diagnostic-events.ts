import type { KoLoConfig } from "../config/config.js";

export type DiagnosticSessionState = "idle" | "processing" | "waiting";

type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
};

export type DiagnosticUsageEvent = DiagnosticBaseEvent & {
  type: "model.usage";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};

export type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
  type: "webhook.received";
  channel: string;
  updateType?: string;
  chatId?: number | string;
};

export type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
  type: "webhook.processed";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
};

export type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
  type: "webhook.error";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
};

export type DiagnosticMessageQueuedEvent = DiagnosticBaseEvent & {
  type: "message.queued";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  source: string;
  queueDepth?: number;
};

export type DiagnosticMessageProcessedEvent = DiagnosticBaseEvent & {
  type: "message.processed";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};

export type DiagnosticSessionStateEvent = DiagnosticBaseEvent & {
  type: "session.state";
  sessionKey?: string;
  sessionId?: string;
  prevState?: DiagnosticSessionState;
  state: DiagnosticSessionState;
  reason?: string;
  queueDepth?: number;
};

export type DiagnosticSessionStuckEvent = DiagnosticBaseEvent & {
  type: "session.stuck";
  sessionKey?: string;
  sessionId?: string;
  state: DiagnosticSessionState;
  ageMs: number;
  queueDepth?: number;
};

export type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.enqueue";
  lane: string;
  queueSize: number;
};

export type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.dequeue";
  lane: string;
  queueSize: number;
  waitMs: number;
};

export type DiagnosticRunAttemptEvent = DiagnosticBaseEvent & {
  type: "run.attempt";
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
};

export type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
  type: "diagnostic.heartbeat";
  webhooks: {
    received: number;
    processed: number;
    errors: number;
  };
  active: number;
  waiting: number;
  queued: number;
};

/**
 * One finished agent run (embedded runtime), for governance export. Ids, timings, counts and
 * outcome only; `content` is present only when an administrator opted in
 * (diagnostics.otel.captureContent) and is truncated.
 */
export type DiagnosticAgentRunEvent = DiagnosticBaseEvent & {
  type: "agent.run";
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  jobId?: string;
  lane?: string;
  channel?: string;
  provider: string;
  model: string;
  startedAt: number;
  durationMs: number;
  outcome: "completed" | "error" | "aborted" | "timeout";
  errorKind?: string;
  steps?: number;
  toolCalls?: number;
  payloads?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  content?: { input?: string; output?: string };
};

/** One finished autopilot routine run, for governance export (no gathered data, no prompts). */
export type DiagnosticAutopilotRunEvent = DiagnosticBaseEvent & {
  type: "autopilot.run";
  runId: string;
  projectId: string;
  routineId: string;
  edition: string;
  area: string;
  level: string;
  trigger: string;
  status: string;
  startedAt: number;
  durationMs: number;
  reasoning: { backend: string | null; model: string | null; ms: number; retried?: boolean };
  counts: Record<string, number>;
  /** Action decisions by kind (allow, refuse, person ...), counted. */
  decisions: Record<string, number>;
  gatherCalls: number;
  workItems: number;
  watchdogTripped: boolean;
  evidenceRoot: string | null;
};

export type DiagnosticEventPayload =
  | DiagnosticUsageEvent
  | DiagnosticAgentRunEvent
  | DiagnosticAutopilotRunEvent
  | DiagnosticWebhookReceivedEvent
  | DiagnosticWebhookProcessedEvent
  | DiagnosticWebhookErrorEvent
  | DiagnosticMessageQueuedEvent
  | DiagnosticMessageProcessedEvent
  | DiagnosticSessionStateEvent
  | DiagnosticSessionStuckEvent
  | DiagnosticLaneEnqueueEvent
  | DiagnosticLaneDequeueEvent
  | DiagnosticRunAttemptEvent
  | DiagnosticHeartbeatEvent;

export type DiagnosticEventInput = DiagnosticEventPayload extends infer Event
  ? Event extends DiagnosticEventPayload
    ? Omit<Event, "seq" | "ts">
    : never
  : never;
let seq = 0;
const listeners = new Set<(evt: DiagnosticEventPayload) => void>();

export function isDiagnosticsEnabled(config?: KoLoConfig): boolean {
  return config?.diagnostics?.enabled === true;
}

export function emitDiagnosticEvent(event: DiagnosticEventInput) {
  const enriched = {
    ...event,
    seq: (seq += 1),
    ts: Date.now(),
  } satisfies DiagnosticEventPayload;
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      // Ignore listener failures.
    }
  }
}

export function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetDiagnosticEventsForTest(): void {
  seq = 0;
  listeners.clear();
}
