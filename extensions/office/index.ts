// Office documents (Kurahi). Off by default; enable for the gateway or per Project template.
//
// Three agent tools render PowerPoint, Word and Excel files from a structured JSON spec into the
// current Project folder: the model supplies the content, the renderer the layout. The files are
// plain OOXML written with jszip (no Office, no network); nothing is sent anywhere. Writes need a
// Project in 実行 Act mode and stay inside its writable folders. Audit rows carry the kind, the
// byte size and the counts, never content or file names.
//
// The autopilot engine's office.create action validates its specs with the same parsers
// (registered below) and then renders through these tools (src/autopilot/office-spec.ts).
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import { registerOfficeSpecParser } from "../../src/autopilot/office-spec.js";
import { parseDocSpec } from "../../src/office/docx.js";
import { parseDeckSpec } from "./src/pptx.js";
import { createOfficeTools, OFFICE_TOOL_NAMES } from "./src/tools.js";
import { parseWorkbookSpec } from "./src/xlsx.js";

export { createOfficeTools, OFFICE_TOOL_NAMES } from "./src/tools.js";

/** Give the autopilot engine the plugin's own spec parsers (idempotent). */
export function registerOfficeSpecParsers(): void {
  registerOfficeSpecParser("docx", parseDocSpec);
  registerOfficeSpecParser("pptx", parseDeckSpec);
  registerOfficeSpecParser("xlsx", parseWorkbookSpec);
}

export default function register(api: KoLoPluginApi) {
  registerOfficeSpecParsers();
  api.registerTool(
    (ctx) =>
      createOfficeTools({
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        audit: (input) => api.audit(input),
      }),
    { names: OFFICE_TOOL_NAMES },
  );
}
