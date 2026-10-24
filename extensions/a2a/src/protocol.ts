// A2A wire shapes. The plugin keeps one internal task model and speaks two dialects:
//
//   v1.0 (current, lf.a2a.v1): methods SendMessage / SendStreamingMessage / GetTask / CancelTask,
//        enums in SCREAMING_SNAKE_CASE (TASK_STATE_COMPLETED, ROLE_AGENT), parts without `kind`,
//        SendMessage result `{ task }`, stream results `{ task } | { statusUpdate } | ...`.
//   v0.3 (widely deployed):      methods message/send / message/stream / tasks/get / tasks/cancel,
//        lowercase enums, `kind` discriminators, result is the Task itself, stream events carry
//        `final`.
//
// The dialect of a call is chosen by its method name, so one endpoint serves both.

export type Dialect = "0.3" | "1.0";
export const SUPPORTED_VERSIONS = ["0.3", "1.0"] as const;

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

export type Part = { kind: "text"; text: string } | { kind: "data"; data: unknown };

export type Message = {
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  contextId?: string;
  taskId?: string;
};

export type Artifact = { artifactId: string; name?: string; parts: Part[] };

export type TaskStatus = { state: TaskState; message?: Message; timestamp: string };

export type TaskView = {
  id: string;
  contextId: string;
  status: TaskStatus;
  history: Message[];
  artifacts: Artifact[];
};

// JSON-RPC 2.0 and A2A error codes (the same numbers in 0.3 and 1.0).
export const RpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  VersionNotSupported: -32009,
} as const;

export class A2aRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "A2aRpcError";
  }
}

export type RpcId = string | number | null;

export function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function rpcError(id: RpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export type MethodKind = "send" | "stream" | "get" | "cancel" | "unsupported";

const METHODS: Record<string, { kind: MethodKind; dialect: Dialect }> = {
  "message/send": { kind: "send", dialect: "0.3" },
  "message/stream": { kind: "stream", dialect: "0.3" },
  "tasks/get": { kind: "get", dialect: "0.3" },
  "tasks/cancel": { kind: "cancel", dialect: "0.3" },
  "tasks/resubscribe": { kind: "unsupported", dialect: "0.3" },
  "tasks/pushNotificationConfig/set": { kind: "unsupported", dialect: "0.3" },
  "tasks/pushNotificationConfig/get": { kind: "unsupported", dialect: "0.3" },
  "tasks/pushNotificationConfig/list": { kind: "unsupported", dialect: "0.3" },
  "tasks/pushNotificationConfig/delete": { kind: "unsupported", dialect: "0.3" },
  "agent/getAuthenticatedExtendedCard": { kind: "unsupported", dialect: "0.3" },
  SendMessage: { kind: "send", dialect: "1.0" },
  SendStreamingMessage: { kind: "stream", dialect: "1.0" },
  GetTask: { kind: "get", dialect: "1.0" },
  CancelTask: { kind: "cancel", dialect: "1.0" },
  ListTasks: { kind: "unsupported", dialect: "1.0" },
  SubscribeToTask: { kind: "unsupported", dialect: "1.0" },
  GetExtendedAgentCard: { kind: "unsupported", dialect: "1.0" },
  CreateTaskPushNotificationConfig: { kind: "unsupported", dialect: "1.0" },
  GetTaskPushNotificationConfig: { kind: "unsupported", dialect: "1.0" },
  ListTaskPushNotificationConfigs: { kind: "unsupported", dialect: "1.0" },
  DeleteTaskPushNotificationConfig: { kind: "unsupported", dialect: "1.0" },
};

export function lookupMethod(method: string) {
  return Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
}

/** `A2A-Version` header value: empty means 0.3 (spec); anything else must be supported. */
export function checkVersionHeader(value: string | string[] | undefined): string | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  if (!raw) {
    return null;
  }
  const majorMinor = raw.split(".").slice(0, 2).join(".");
  return (SUPPORTED_VERSIONS as readonly string[]).includes(majorMinor)
    ? null
    : `A2A version ${raw.slice(0, 20)} is not supported (supported: ${SUPPORTED_VERSIONS.join(", ")})`;
}

// ---------------------------------------------------------------------------------------------
// Inbound parsing (lenient across dialects, strict on content types).

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new A2aRpcError(
      RpcError.InvalidParams,
      `${field} must be an id of 1-128 [A-Za-z0-9._:-]`,
    );
  }
  return value;
}

export function parsePart(raw: unknown, index: number): Part {
  if (!isRecord(raw)) {
    throw new A2aRpcError(RpcError.InvalidParams, `message.parts[${index}] must be an object`);
  }
  const kind = typeof raw.kind === "string" ? raw.kind : undefined;
  if (kind === "file" || "file" in raw || "raw" in raw || "url" in raw) {
    throw new A2aRpcError(
      RpcError.ContentTypeNotSupported,
      "file parts are not supported by this agent; send text or data parts",
    );
  }
  if ((kind === undefined || kind === "text") && typeof raw.text === "string") {
    return { kind: "text", text: raw.text };
  }
  if ((kind === undefined || kind === "data") && "data" in raw) {
    return { kind: "data", data: raw.data };
  }
  throw new A2aRpcError(RpcError.InvalidParams, `message.parts[${index}] has no text or data`);
}

/** The `message` param of a send call, normalised. Only role user is accepted inbound. */
export function parseInboundMessage(
  params: unknown,
  limits: { maxParts: number },
): {
  message: Message;
  blocking: boolean;
  historyLength?: number;
} {
  if (!isRecord(params) || !isRecord(params.message)) {
    throw new A2aRpcError(RpcError.InvalidParams, "params.message is required");
  }
  const m = params.message;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  if (role !== "user" && role !== "role_user") {
    throw new A2aRpcError(RpcError.InvalidParams, "message.role must be user");
  }
  const messageId = optionalId(m.messageId, "message.messageId");
  if (!messageId) {
    throw new A2aRpcError(RpcError.InvalidParams, "message.messageId is required");
  }
  if (!Array.isArray(m.parts) || m.parts.length === 0) {
    throw new A2aRpcError(RpcError.InvalidParams, "message.parts must be a non-empty array");
  }
  if (m.parts.length > limits.maxParts) {
    throw new A2aRpcError(RpcError.InvalidParams, `message has more than ${limits.maxParts} parts`);
  }
  const parts = m.parts.map((p, i) => parsePart(p, i));
  const cfg = isRecord(params.configuration) ? params.configuration : {};
  // 0.3 `blocking: false` and 1.0 `returnImmediately: true` both ask for an early return.
  const blocking = !(cfg.blocking === false || cfg.returnImmediately === true);
  const historyLength = parseHistoryLength(cfg.historyLength);
  return {
    message: {
      messageId,
      role: "user",
      parts,
      contextId: optionalId(m.contextId, "message.contextId"),
      taskId: optionalId(m.taskId, "message.taskId"),
    },
    blocking,
    historyLength,
  };
}

export function parseHistoryLength(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new A2aRpcError(RpcError.InvalidParams, "historyLength must be a non-negative integer");
  }
  return value;
}

export function parseTaskIdParams(params: unknown): { id: string; historyLength?: number } {
  if (!isRecord(params)) {
    throw new A2aRpcError(RpcError.InvalidParams, "params must be an object");
  }
  // 1.0 GetTask may also carry the resource name form "tasks/<id>".
  const rawId = typeof params.id === "string" ? params.id : params.name;
  const id = optionalId(
    typeof rawId === "string" && rawId.startsWith("tasks/") ? rawId.slice(6) : rawId,
    "id",
  );
  if (!id) {
    throw new A2aRpcError(RpcError.InvalidParams, "params.id is required");
  }
  return { id, historyLength: parseHistoryLength(params.historyLength) };
}

/** Text the agent sees: text parts as-is, data parts as JSON. */
export function partsToText(parts: Part[]): string {
  return parts
    .map((part) => (part.kind === "text" ? part.text : `[data]\n${JSON.stringify(part.data)}`))
    .join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Outbound serialisation.

const STATE_V1: Record<TaskState, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  rejected: "TASK_STATE_REJECTED",
};

/** Accepts either dialect's spelling (client side). */
export function parseTaskState(value: unknown): TaskState | "unknown" {
  if (typeof value !== "string") {
    return "unknown";
  }
  const lower = value.toLowerCase();
  const direct = (Object.keys(STATE_V1) as TaskState[]).find((s) => s === lower);
  if (direct) {
    return direct;
  }
  const v1 = (Object.entries(STATE_V1) as Array<[TaskState, string]>).find(([, v]) => v === value);
  return v1 ? v1[0] : "unknown";
}

function serializePart(part: Part, dialect: Dialect) {
  if (dialect === "1.0") {
    return part.kind === "text" ? { text: part.text } : { data: part.data };
  }
  return part.kind === "text"
    ? { kind: "text", text: part.text }
    : { kind: "data", data: part.data };
}

export function serializeMessage(message: Message, dialect: Dialect) {
  const parts = message.parts.map((p) => serializePart(p, dialect));
  const base = {
    messageId: message.messageId,
    ...(message.contextId ? { contextId: message.contextId } : {}),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    parts,
  };
  return dialect === "1.0"
    ? { ...base, role: message.role === "user" ? "ROLE_USER" : "ROLE_AGENT" }
    : { kind: "message", ...base, role: message.role };
}

export function serializeStatus(status: TaskStatus, dialect: Dialect) {
  return {
    state: dialect === "1.0" ? STATE_V1[status.state] : status.state,
    ...(status.message ? { message: serializeMessage(status.message, dialect) } : {}),
    timestamp: status.timestamp,
  };
}

export function serializeArtifact(artifact: Artifact, dialect: Dialect) {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name ? { name: artifact.name } : {}),
    parts: artifact.parts.map((p) => serializePart(p, dialect)),
  };
}

export function serializeTask(task: TaskView, dialect: Dialect, historyLength?: number) {
  const history =
    historyLength === undefined
      ? task.history
      : historyLength === 0
        ? []
        : task.history.slice(-historyLength);
  const body = {
    id: task.id,
    contextId: task.contextId,
    status: serializeStatus(task.status, dialect),
    artifacts: task.artifacts.map((a) => serializeArtifact(a, dialect)),
    history: history.map((m) => serializeMessage(m, dialect)),
  };
  return dialect === "1.0" ? body : { kind: "task", ...body };
}

/** Result of a send call: 1.0 wraps the task (`{ task }`), 0.3 returns it bare. */
export function sendResult(task: TaskView, dialect: Dialect, historyLength?: number) {
  const serialized = serializeTask(task, dialect, historyLength);
  return dialect === "1.0" ? { task: serialized } : serialized;
}

export function statusUpdateEvent(task: TaskView, dialect: Dialect) {
  const final = TERMINAL_STATES.has(task.status.state);
  const event = {
    taskId: task.id,
    contextId: task.contextId,
    status: serializeStatus(task.status, dialect),
  };
  return dialect === "1.0" ? { statusUpdate: event } : { kind: "status-update", ...event, final };
}

export function artifactUpdateEvent(task: TaskView, artifact: Artifact, dialect: Dialect) {
  const event = {
    taskId: task.id,
    contextId: task.contextId,
    artifact: serializeArtifact(artifact, dialect),
    append: false,
    lastChunk: true,
  };
  return dialect === "1.0" ? { artifactUpdate: event } : { kind: "artifact-update", ...event };
}

export function taskEvent(task: TaskView, dialect: Dialect) {
  const serialized = serializeTask(task, dialect);
  return dialect === "1.0" ? { task: serialized } : serialized;
}
