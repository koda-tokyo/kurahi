import type { KoLoPluginApi } from "../../src/plugins/types.js";
import type { RunAgent } from "./src/task-runner.js";
import { createA2aClientTools } from "./src/client-tools.js";
import { A2aClient } from "./src/client.js";
import { a2aPluginConfigSchema, parseA2aConfig } from "./src/config.js";
import { createA2aServer } from "./src/server.js";

/**
 * Agent2Agent (A2A) protocol (bundled plugin, off by default).
 *
 *   server   exposes the agents listed in `server.agents` as A2A agents on the gateway HTTP
 *            server: Agent Cards plus a JSON-RPC endpoint (v1.0 and v0.3 method names). Off until
 *            `server.enabled`; loopback callers only unless `server.allowNonLoopback`; every call
 *            needs a per-client bearer token, and each client reaches only the agents it lists.
 *   client   `a2a_send` / `a2a_get_task` (optional tools) call the remote agents listed in
 *            `client.agents` by name.
 */

const DEFAULT_GATEWAY_PORT = 18789;

const a2aPlugin = {
  id: "a2a",
  name: "A2A",
  description: "Agent2Agent protocol: expose agents as A2A servers and call remote A2A agents",
  configSchema: a2aPluginConfigSchema,
  register(api: KoLoPluginApi) {
    const cfg = parseA2aConfig(api.pluginConfig);
    const log = {
      info: (m: string) => api.logger.info(`[a2a] ${m}`),
      warn: (m: string) => api.logger.warn(`[a2a] ${m}`),
    };

    if (cfg.server.enabled) {
      const server = cfg.server;
      if (server.agents.length === 0 || server.clients.length === 0) {
        log.warn("server.enabled is set but no agents or no clients are listed; nothing is served");
      } else {
        // The agent runtime is loaded on the first task, not at plugin load.
        let runner: Promise<RunAgent> | null = null;
        const runAgent: RunAgent = async (params) => {
          runner ??= import("./src/agent-runner.js").then((m) =>
            m.createEmbeddedRunAgent(() => api.runtime.config.loadConfig()),
          );
          return (await runner)(params);
        };
        const a2a = createA2aServer({
          config: server,
          runAgent,
          audit: api.audit,
          logger: log,
          trustedProxies: () => api.runtime.config.loadConfig().gateway?.trustedProxies,
          fallbackPort: api.config.gateway?.port ?? DEFAULT_GATEWAY_PORT,
        });
        for (const route of a2a.routes) {
          api.registerHttpRoute({
            path: route.path,
            handler: route.handler,
            methods: route.methods,
            summary: route.summary,
            description: "A2A plugin endpoint; bearer token per client (see docs/plugins/a2a.md).",
          });
        }
        api.lifecycle.onDispose(() => a2a.dispose());
        if (server.allowNonLoopback) {
          log.warn(
            "server.allowNonLoopback is on: non-loopback callers are accepted (tokens still required)",
          );
        }
        log.info(
          `serving ${server.agents.length} agent(s) under ${server.basePath} for ${server.clients.length} client(s)`,
        );
      }
    }

    if (cfg.client.agents.length > 0) {
      const client = new A2aClient(cfg.client);
      api.registerTool((ctx) => createA2aClientTools({ client, audit: api.audit, ctx }), {
        names: ["a2a_send", "a2a_get_task"],
        optional: true,
      });
    }
  },
};

export default a2aPlugin;
