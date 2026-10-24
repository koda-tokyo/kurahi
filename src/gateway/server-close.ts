import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { PluginHost } from "../plugins/host.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { closeFactoryRunner } from "../factory/runtime.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import { stopMcp } from "../mcp/client/manager.js";
import { stopVoice } from "../voice/runtime.js";
import { setGatewayPluginHost } from "./plugins-http.js";

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  canvasHostServer: CanvasHostServer | null;
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  /** M7: disposes every plugin instance after its services stopped. */
  pluginHost?: PluginHost | null;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  chatRunState: { clear: () => void; buffers?: Map<string, string> };
  clients: Set<{ socket: { close: (code: number, reason: string) => void } }>;
  configReloader: { stop: () => Promise<void> };
  browserControl: { stop: () => Promise<void> } | null;
  wss: WebSocketServer;
  httpServer: HttpServer;
  httpServers?: HttpServer[];
}) {
  return async (opts?: { reason?: string; restartExpectedMs?: number | null }) => {
    const reasonRaw = typeof opts?.reason === "string" ? opts.reason.trim() : "";
    const reason = reasonRaw || "gateway stopping";
    const restartExpectedMs =
      typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
        ? Math.max(0, Math.floor(opts.restartExpectedMs))
        : null;
    // M15: factory runs in progress are cancelled (engine tasks too) before the sockets close.
    try {
      await closeFactoryRunner();
    } catch {
      /* ignore */
    }
    if (params.bonjourStop) {
      try {
        await params.bonjourStop();
      } catch {
        /* ignore */
      }
    }
    if (params.tailscaleCleanup) {
      await params.tailscaleCleanup();
    }
    if (params.canvasHost) {
      try {
        await params.canvasHost.close();
      } catch {
        /* ignore */
      }
    }
    if (params.canvasHostServer) {
      try {
        await params.canvasHostServer.close();
      } catch {
        /* ignore */
      }
    }
    for (const plugin of listChannelPlugins()) {
      await params.stopChannel(plugin.id);
    }
    if (params.pluginServices) {
      await params.pluginServices.stop().catch(() => {});
    }
    if (params.pluginHost) {
      await params.pluginHost.dispose().catch(() => {});
      setGatewayPluginHost(null);
    }
    await stopGmailWatcher();
    params.cron.stop();
    await stopMcp().catch(() => {});
    await stopVoice().catch(() => {});
    params.heartbeatRunner.stop();
    for (const timer of params.nodePresenceTimers.values()) {
      clearInterval(timer);
    }
    params.nodePresenceTimers.clear();
    params.broadcast("shutdown", {
      reason,
      restartExpectedMs,
    });
    clearInterval(params.tickInterval);
    clearInterval(params.healthInterval);
    clearInterval(params.dedupeCleanup);
    if (params.agentUnsub) {
      try {
        params.agentUnsub();
      } catch {
        /* ignore */
      }
    }
    if (params.heartbeatUnsub) {
      try {
        params.heartbeatUnsub();
      } catch {
        /* ignore */
      }
    }

    // Graceful drain: wait up to 30s (KOLO_GATEWAY_DRAIN_TIMEOUT_MS) for active LLM requests
    const DRAIN_TIMEOUT_MS = resolveDrainTimeoutMs(process.env);
    const DRAIN_POLL_MS = 500;
    const drainStart = Date.now();

    // Signal drain mode — new requests will be rejected with 503
    params.broadcast("gateway:draining", { reason, timeoutMs: DRAIN_TIMEOUT_MS });

    // Poll until no active requests or timeout
    while (Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
      // Count active requests via chatRunState buffers (tracks in-flight runs)
      const activeCount = params.chatRunState.buffers?.size ?? 0;
      if (activeCount === 0) break;
      await new Promise<void>((r) => setTimeout(r, DRAIN_POLL_MS));
    }

    params.chatRunState.clear();
    for (const c of params.clients) {
      try {
        c.socket.close(1012, "service restart");
      } catch {
        /* ignore */
      }
    }
    params.clients.clear();
    await params.configReloader.stop().catch(() => {});
    if (params.browserControl) {
      await params.browserControl.stop().catch(() => {});
    }
    await new Promise<void>((resolve) => params.wss.close(() => resolve()));
    const servers =
      params.httpServers && params.httpServers.length > 0
        ? params.httpServers
        : [params.httpServer];
    for (const server of servers) {
      const httpServer = server as HttpServer & {
        closeIdleConnections?: () => void;
      };
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      }
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  };
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** The shutdown drain budget: 30 s, or KOLO_GATEWAY_DRAIN_TIMEOUT_MS (a non-negative integer). */
export function resolveDrainTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KOLO_GATEWAY_DRAIN_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_DRAIN_TIMEOUT_MS;
  }
  return Number.parseInt(raw, 10);
}
