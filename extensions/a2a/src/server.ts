import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { A2aExposedAgent, A2aServerClient, ParsedA2aConfig } from "./config.js";
import { buildAgentCard, CARD_PATH, cardPath, resolveBaseUrl, rpcPath } from "./agent-card.js";
import {
  BodyTooLargeError,
  clientAddress,
  createClientAuthenticator,
  isAllowedAddress,
  RateLimiter,
  readBody,
  sendJson,
} from "./http-guard.js";
import {
  A2aRpcError,
  artifactUpdateEvent,
  checkVersionHeader,
  type Dialect,
  lookupMethod,
  parseInboundMessage,
  parseTaskIdParams,
  partsToText,
  RpcError,
  rpcError,
  type RpcId,
  rpcResult,
  sendResult,
  serializeTask,
  statusUpdateEvent,
  taskEvent,
  TERMINAL_STATES,
} from "./protocol.js";
import { type AuditFn, executeTask, type RunAgent } from "./task-runner.js";
import { type TaskRecord, TaskStore } from "./task-store.js";

export type A2aServerRoute = {
  path: string;
  methods: string[];
  summary: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

export type A2aServerOptions = {
  config: ParsedA2aConfig["server"];
  runAgent: RunAgent;
  audit: AuditFn;
  logger: { warn: (m: string) => void; info: (m: string) => void };
  /** gateway.trustedProxies, read per request so a config reload applies. */
  trustedProxies: () => string[] | undefined;
  fallbackPort: number;
  now?: () => number;
};

const AUTH_FAILURES_PER_MINUTE = 10;

export function createA2aServer(opts: A2aServerOptions) {
  const { config, runAgent, audit, logger } = opts;
  const now = opts.now ?? Date.now;
  const store = new TaskStore({
    maxTasks: config.maxTasks,
    ttlMs: config.taskTtlMinutes * 60_000,
    now,
  });
  const authenticate = createClientAuthenticator(config.clients);
  const clientLimiter = new RateLimiter(config.requestsPerMinute, 60_000, now);
  const cardLimiter = new RateLimiter(Math.max(60, config.requestsPerMinute), 60_000, now);
  const authFailures = new RateLimiter(AUTH_FAILURES_PER_MINUTE, 60_000, now);
  const pending = new Set<Promise<void>>();

  const gate = (req: IncomingMessage, res: ServerResponse): string | null => {
    const ip = clientAddress(req, opts.trustedProxies()) ?? "unknown";
    if (!isAllowedAddress(ip, config.allowNonLoopback)) {
      sendJson(res, 403, { error: "forbidden" });
      return null;
    }
    return ip;
  };

  /** Bearer auth with a per-address failure limit. Writes the response on failure. */
  const requireClient = (req: IncomingMessage, res: ServerResponse, ip: string, slug: string) => {
    const blocked = authFailures.blockedFor(ip);
    if (blocked > 0) {
      sendJson(res, 429, { error: "too many failed attempts" }, { "Retry-After": String(blocked) });
      return null;
    }
    const client = authenticate(req);
    if (!client) {
      authFailures.hit(ip);
      audit({
        action: "a2a.server.auth_failed",
        outcome: "denied",
        detail: {
          agent: slug,
          ip,
          hasAuthorization: typeof req.headers.authorization === "string",
        },
      });
      sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="a2a"' });
      return null;
    }
    if (!client.agents.includes(slug)) {
      audit({
        action: "a2a.server.forbidden",
        outcome: "denied",
        identity: `a2a:${client.id}`,
        detail: { agent: slug, ip },
      });
      sendJson(res, 403, { error: "forbidden" });
      return null;
    }
    return client;
  };

  const cardHandler =
    (agent: A2aExposedAgent) => async (req: IncomingMessage, res: ServerResponse) => {
      const ip = gate(req, res);
      if (!ip) {
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
        return;
      }
      const retry = cardLimiter.hit(`card:${ip}`);
      if (retry > 0) {
        sendJson(res, 429, { error: "rate limited" }, { "Retry-After": String(retry) });
        return;
      }
      if (!config.publicCard && !requireClient(req, res, ip, agent.slug)) {
        return;
      }
      const versionError = checkVersionHeader(req.headers["a2a-version"]);
      if (versionError) {
        sendJson(res, 400, { error: versionError });
        return;
      }
      const version = String(req.headers["a2a-version"] ?? "").trim();
      const dialect: Dialect = version.startsWith("1.") ? "1.0" : "0.3";
      const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
      const card = buildAgentCard({
        server: config,
        agent,
        baseUrl: resolveBaseUrl(config, host, opts.fallbackPort),
        dialect,
      });
      sendJson(res, 200, card, { "Cache-Control": "public, max-age=300" });
    };

  const rpcHandler =
    (agent: A2aExposedAgent) => async (req: IncomingMessage, res: ServerResponse) => {
      const ip = gate(req, res);
      if (!ip) {
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      const client = requireClient(req, res, ip, agent.slug);
      if (!client) {
        return;
      }
      const retry = clientLimiter.hit(client.id);
      if (retry > 0) {
        audit({
          action: "a2a.server.rate_limited",
          outcome: "denied",
          identity: `a2a:${client.id}`,
          detail: { agent: agent.slug },
        });
        sendJson(res, 429, { error: "rate limited" }, { "Retry-After": String(retry) });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req, config.maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJson(res, 413, rpcError(null, RpcError.InvalidRequest, err.message));
          return;
        }
        throw err;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 200, rpcError(null, RpcError.ParseError, "invalid JSON"));
        return;
      }
      const envelope = parseEnvelope(body);
      if ("error" in envelope) {
        sendJson(res, 200, rpcError(envelope.id, RpcError.InvalidRequest, envelope.error));
        return;
      }
      const { id, method, params } = envelope;
      try {
        const versionError = checkVersionHeader(req.headers["a2a-version"]);
        if (versionError) {
          throw new A2aRpcError(RpcError.VersionNotSupported, versionError);
        }
        const entry = lookupMethod(method);
        if (!entry) {
          throw new A2aRpcError(
            RpcError.MethodNotFound,
            `method not found: ${method.slice(0, 80)}`,
          );
        }
        const { kind, dialect } = entry;
        if (kind === "unsupported") {
          const push = /push/i.test(method);
          throw new A2aRpcError(
            push ? RpcError.PushNotificationNotSupported : RpcError.UnsupportedOperation,
            `${method} is not supported by this agent`,
          );
        }
        if (kind === "get" || kind === "cancel") {
          const { id: taskId, historyLength } = parseTaskIdParams(params);
          const task = store.get(client.id, taskId);
          if (!task) {
            throw new A2aRpcError(RpcError.TaskNotFound, "task not found");
          }
          if (kind === "cancel") {
            cancelTask(task, client);
          }
          sendJson(res, 200, rpcResult(id, serializeTask(task, dialect, historyLength)));
          return;
        }
        if (kind === "stream" && !config.streaming) {
          throw new A2aRpcError(RpcError.UnsupportedOperation, "streaming is disabled");
        }
        const started = startTask(params, agent, client, method);
        if ("busy" in started) {
          sendJson(res, 503, rpcError(id, RpcError.Internal, "server busy, retry later"), {
            "Retry-After": "5",
          });
          return;
        }
        const { task, run, blocking, historyLength } = started;
        if (kind === "stream") {
          streamTask(res, id, task, dialect);
          return;
        }
        if (blocking) {
          await run;
        }
        sendJson(res, 200, rpcResult(id, sendResult(task, dialect, historyLength)));
      } catch (err) {
        if (err instanceof A2aRpcError) {
          sendJson(res, 200, rpcError(id, err.code, err.message, err.data));
          return;
        }
        logger.warn(`a2a rpc failed: ${String(err).slice(0, 300)}`);
        sendJson(res, 200, rpcError(id, RpcError.Internal, "internal error"));
      }
    };

  function startTask(
    params: unknown,
    agent: A2aExposedAgent,
    client: A2aServerClient,
    method: string,
  ) {
    const { message, blocking, historyLength } = parseInboundMessage(params, {
      maxParts: config.maxParts,
    });
    const text = partsToText(message.parts);
    if (!text.trim()) {
      throw new A2aRpcError(RpcError.InvalidParams, "message has no text");
    }
    if (text.length > config.maxInputChars) {
      throw new A2aRpcError(
        RpcError.InvalidParams,
        `message exceeds ${config.maxInputChars} characters`,
      );
    }
    let contextId = message.contextId;
    if (message.taskId) {
      const existing = store.get(client.id, message.taskId);
      if (!existing) {
        throw new A2aRpcError(RpcError.TaskNotFound, "task not found");
      }
      if (contextId && contextId !== existing.contextId) {
        throw new A2aRpcError(RpcError.InvalidParams, "contextId does not match the task");
      }
      throw new A2aRpcError(
        RpcError.UnsupportedOperation,
        TERMINAL_STATES.has(existing.status.state)
          ? "task is in a terminal state; send a new message with the same contextId instead"
          : "task is still running; wait for it or cancel it",
      );
    }
    contextId ??= randomUUID();
    if (store.activeInContext(client.id, contextId)) {
      throw new A2aRpcError(
        RpcError.UnsupportedOperation,
        "another task is running in this context; wait for it or cancel it",
      );
    }
    if (store.runningCount() >= config.maxConcurrentTasks) {
      return { busy: true as const };
    }
    const task = store.create({ clientId: client.id, slug: agent.slug, contextId, message });
    if (!task) {
      return { busy: true as const };
    }
    audit({
      action: "a2a.task.submitted",
      outcome: "ok",
      identity: `a2a:${client.id}`,
      detail: {
        client: client.id,
        agent: agent.slug,
        taskId: task.id,
        contextId,
        method,
        inputChars: text.length,
      },
    });
    const run = executeTask({
      task,
      store,
      agent,
      client,
      text,
      runAgent,
      audit,
      warn: logger.warn,
    }).catch((err) => {
      logger.warn(`a2a task ${task.id} crashed: ${String(err).slice(0, 300)}`);
      store.setState(task, "failed");
    });
    pending.add(run);
    void run.finally(() => pending.delete(run));
    return { task, run, blocking, historyLength };
  }

  function cancelTask(task: TaskRecord, client: A2aServerClient) {
    if (TERMINAL_STATES.has(task.status.state)) {
      throw new A2aRpcError(RpcError.TaskNotCancelable, `task is ${task.status.state}`);
    }
    store.setState(task, "canceled");
    task.abort.abort("canceled by client");
    audit({
      action: "a2a.task.canceled",
      outcome: "ok",
      identity: `a2a:${client.id}`,
      detail: { client: client.id, agent: task.slug, taskId: task.id, contextId: task.contextId },
    });
  }

  function streamTask(res: ServerResponse, id: RpcId, task: TaskRecord, dialect: Dialect) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Connection", "keep-alive");
    const write = (event: unknown) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(rpcResult(id, event))}\n\n`);
      }
    };
    write(taskEvent(task, dialect));
    if (TERMINAL_STATES.has(task.status.state)) {
      res.end();
      return;
    }
    // Disconnecting does not cancel the task; the client can still poll it with tasks/get.
    const unsubscribe = store.subscribe(task, (current, change, artifact) => {
      if (change === "artifact" && artifact) {
        write(artifactUpdateEvent(current, artifact, dialect));
        return;
      }
      write(statusUpdateEvent(current, dialect));
      if (TERMINAL_STATES.has(current.status.state)) {
        unsubscribe();
        res.end();
      }
    });
    res.on("close", unsubscribe);
  }

  const routes: A2aServerRoute[] = [];
  for (const agent of config.agents) {
    routes.push({
      path: rpcPath(config, agent.slug),
      methods: ["POST"],
      summary: `A2A JSON-RPC endpoint (${agent.name})`,
      handler: rpcHandler(agent),
    });
    routes.push({
      path: cardPath(config, agent.slug),
      methods: ["GET"],
      summary: `A2A Agent Card (${agent.name})`,
      handler: cardHandler(agent),
    });
  }
  const defaultAgent = config.agents.find((a) => a.slug === config.defaultAgent);
  if (defaultAgent) {
    routes.push({
      path: CARD_PATH,
      methods: ["GET"],
      summary: `A2A Agent Card (default: ${defaultAgent.name})`,
      handler: cardHandler(defaultAgent),
    });
  }

  return {
    routes,
    store,
    /** Resolves when every task started so far has settled (tests, shutdown). */
    async idle() {
      await Promise.allSettled(pending);
    },
    dispose() {
      store.abortAll("a2a plugin stopped");
    },
  };
}

function parseEnvelope(
  body: unknown,
): { id: RpcId; method: string; params: unknown } | { id: RpcId; error: string } {
  if (Array.isArray(body)) {
    return { id: null, error: "batch requests are not supported" };
  }
  if (!body || typeof body !== "object") {
    return { id: null, error: "request must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const id =
    typeof b.id === "string" || typeof b.id === "number" ? b.id : b.id === null ? null : undefined;
  if (id === undefined) {
    return { id: null, error: "id is required (notifications are not supported)" };
  }
  if (b.jsonrpc !== "2.0") {
    return { id, error: 'jsonrpc must be "2.0"' };
  }
  if (typeof b.method !== "string" || !b.method) {
    return { id, error: "method must be a string" };
  }
  return { id, method: b.method, params: b.params };
}
