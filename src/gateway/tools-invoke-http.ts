import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedGatewayAuth } from "./auth.js";
import { loadConfig } from "../config/config.js";
import { isTestDefaultMemorySlotDisabled } from "../plugins/config-state.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendForbidden,
  sendUnauthorized,
} from "./http-common.js";
import { getHeader } from "./http-utils.js";
import { resolveInvocableSessionKey } from "./invocable-tools.js";
import { authorizeHttpBearer } from "./pair-auth.js";
import { invokeToolForSession } from "./tools-invoke-core.js";

const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;
const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

type ToolsInvokeBody = {
  tool?: unknown;
  action?: unknown;
  args?: unknown;
  sessionKey?: unknown;
  dryRun?: unknown;
};

function resolveSessionKeyFromBody(body: ToolsInvokeBody): string | undefined {
  if (typeof body.sessionKey === "string" && body.sessionKey.trim()) {
    return body.sessionKey.trim();
  }
  return undefined;
}

function resolveMemoryToolDisableReasons(cfg: ReturnType<typeof loadConfig>): string[] {
  if (!process.env.VITEST) {
    return [];
  }
  const reasons: string[] = [];
  const plugins = cfg.plugins;
  const slotRaw = plugins?.slots?.memory;
  const slotDisabled =
    slotRaw === null || (typeof slotRaw === "string" && slotRaw.trim().toLowerCase() === "none");
  const pluginsDisabled = plugins?.enabled === false;
  const defaultDisabled = isTestDefaultMemorySlotDisabled(cfg);

  if (pluginsDisabled) {
    reasons.push("plugins.enabled=false");
  }
  if (slotDisabled) {
    reasons.push(slotRaw === null ? "plugins.slots.memory=null" : 'plugins.slots.memory="none"');
  }
  if (!pluginsDisabled && !slotDisabled && defaultDisabled) {
    reasons.push("memory plugin disabled by test default");
  }
  return reasons;
}

export async function handleToolsInvokeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; maxBodyBytes?: number; trustedProxies?: string[] },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/tools/invoke") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const cfg = loadConfig();
  const authResult = await authorizeHttpBearer(req, {
    auth: opts.auth,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    minScope: "attach",
  });
  if (!authResult.ok) {
    if (authResult.status === 403) {
      sendForbidden(res);
    } else {
      sendUnauthorized(res);
    }
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as ToolsInvokeBody;

  const toolName = typeof body.tool === "string" ? body.tool.trim() : "";
  if (!toolName) {
    sendInvalidRequest(res, "tools.invoke requires body.tool");
    return true;
  }

  if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
    const reasons = resolveMemoryToolDisableReasons(cfg);
    if (reasons.length > 0) {
      const suffix = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
      sendJson(res, 400, {
        ok: false,
        error: {
          type: "invalid_request",
          message:
            `memory tools are disabled in tests${suffix}. ` +
            'Enable by setting plugins.slots.memory="memory-core" (and ensure plugins.enabled is not false).',
        },
      });
      return true;
    }
  }

  const action = typeof body.action === "string" ? body.action.trim() : undefined;

  const argsRaw = body.args;
  const args =
    argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};

  const sessionKey = resolveInvocableSessionKey(cfg, resolveSessionKeyFromBody(body));

  // Resolve message channel/account hints (optional headers) for policy inheritance.
  const messageChannel = normalizeMessageChannel(getHeader(req, "x-kolo-message-channel") ?? "");
  const accountId = getHeader(req, "x-kolo-account-id")?.trim() || undefined;

  const outcome = await invokeToolForSession({
    cfg,
    sessionKey,
    toolName,
    action,
    args,
    messageChannel: messageChannel ?? undefined,
    accountId,
    source: "http:/tools/invoke",
    callId: `http-${Date.now()}`,
  });
  if (outcome.ok) {
    sendJson(res, 200, { ok: true, result: outcome.result });
  } else {
    sendJson(res, outcome.status, {
      ok: false,
      error: {
        type: outcome.type,
        message: outcome.message,
        ...(outcome.details ? { details: outcome.details } : {}),
      },
    });
  }

  return true;
}
