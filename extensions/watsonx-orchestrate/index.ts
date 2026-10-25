import type { KoLoPluginApi } from "../../src/plugins/types.js";
import { OrchestrateClient } from "./src/client.js";
import { orchestratePluginConfigSchema, parseOrchestrateConfig } from "./src/config.js";
import { createOrchestrateTools, TOOL_NAME } from "./src/tools.js";

/**
 * watsonx Orchestrate agent client (bundled plugin, off by default).
 *
 * One optional tool, orchestrate_agent_chat, sends a message to an Orchestrate agent the
 * administrator listed and returns the reply as untrusted content. Calling Kurahi from
 * Orchestrate (A2A, remote MCP, OpenAPI) is the a2a plugin's and the MCP server's job; see
 * docs/integrations/ibm-watsonx-orchestrate.
 */
const plugin = {
  id: "watsonx-orchestrate",
  name: "watsonx Orchestrate",
  description: "Call allowlisted watsonx Orchestrate agents from Kurahi agents",
  configSchema: orchestratePluginConfigSchema,
  register(api: KoLoPluginApi) {
    const cfg = parseOrchestrateConfig(api.pluginConfig);
    if (cfg.agents.length === 0) {
      return;
    }
    const client = new OrchestrateClient(cfg);
    api.registerTool((ctx) => createOrchestrateTools({ client, audit: api.audit, ctx }), {
      names: [TOOL_NAME],
      optional: true,
    });
    api.logger.info(
      `[watsonx-orchestrate] ${cfg.agents.length} Orchestrate agent(s) callable through ${TOOL_NAME}`,
    );
  },
};

export default plugin;
