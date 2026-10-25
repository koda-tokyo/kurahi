// Scholar sources (Kurahi Scholars). Off by default; the Research & academic template enables it
// for its Projects (project scope: tools only).
//
// Literature search and lookup through four free, documented, keyless APIs (arXiv, OpenAlex,
// Crossref, PubMed E-utilities) and doi.org content negotiation; a citation check; open-access
// PDF intake into the Project's corpus-inbox/ through quarantine and malware scanning; and grant
// deadline reminders from the researcher's own list. Every provider's rate limit and etiquette is
// built in (src/config.ts), with one limiter per provider for the whole process. Provider text
// reaches the model inside the untrusted-content boundary; audit rows carry ids and counts only.
// The autopilot's gather may call these tools (src/autopilot/tools.ts declares them read tools).
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import { readSettings } from "./src/config.js";
import { ScholarHttp, sharedLimiters } from "./src/http.js";
import { createScholarTools, SCHOLAR_TOOL_NAMES } from "./src/tools.js";

export { createScholarTools, SCHOLAR_TOOL_NAMES } from "./src/tools.js";

export default function register(api: KoLoPluginApi) {
  const settings = readSettings(api.pluginConfig);
  const limiters = sharedLimiters();
  const http = new ScholarHttp(settings, limiters);
  api.registerTool(
    (ctx) =>
      createScholarTools({
        http,
        limiters,
        ctx: { agentId: ctx.agentId, sessionKey: ctx.sessionKey },
        audit: (input) => api.audit(input),
      }),
    { names: [...SCHOLAR_TOOL_NAMES] },
  );
}
