import type { KoLoPluginApi } from "../../src/plugins/types.js";
import { ibmDataPluginConfigSchema, parseIbmDataConfig } from "./src/config.js";
import { createIbmDataTools, DB2_TOOL, QUERY_TOOL } from "./src/tools.js";

/**
 * IBM data sources, read-only (bundled plugin, off by default).
 *
 *   watsonx_data_query  one read-only SQL statement on a watsonx.data Presto or Trino engine over
 *                       the HTTP client protocol, limited to listed catalogs and schemas.
 *   db2_service_call    an allowlisted Db2 REST service (Db2 for z/OS native REST, or the Db2 LUW
 *                       REST server), POST per service, bounded results.
 *
 * Both are optional tools, return untrusted content, and audit ids and counts only. Neither is in
 * the autopilot read-tool catalogue.
 */
const plugin = {
  id: "ibm-data",
  name: "IBM data (watsonx.data, Db2)",
  description: "Read-only watsonx.data SQL and allowlisted Db2 REST services",
  configSchema: ibmDataPluginConfigSchema,
  register(api: KoLoPluginApi) {
    const cfg = parseIbmDataConfig(api.pluginConfig);
    const names = [
      ...(cfg.watsonxData ? [QUERY_TOOL] : []),
      ...(cfg.db2?.services.length ? [DB2_TOOL] : []),
    ];
    if (names.length === 0) {
      return;
    }
    api.registerTool((ctx) => createIbmDataTools({ cfg, audit: api.audit, ctx }), {
      names,
      optional: true,
    });
    api.logger.info(`[ibm-data] tools available: ${names.join(", ")}`);
  },
};

export default plugin;
