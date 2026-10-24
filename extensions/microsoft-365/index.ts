// Microsoft 365 business connector (Kurahi Business edition). Off by default.
//
// Outlook mail and calendar, OneDrive and SharePoint files through Microsoft Graph, signed in
// with the customer's own app registration (authorization code + PKCE on a loopback redirect,
// or device code). Read-only unless an administrator opts in to a write scope; every write then
// waits for a person's approval. Every call is audited with ids and counts only.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  type ApprovalAsk,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  graphUrl,
  registerBusinessConnector,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import { askViaGateway } from "../../src/policy/guard.js";
import { createCalendarTools } from "./src/calendar.js";
import {
  buildClient,
  CONNECTOR_ID,
  configProblems,
  type M365Settings,
  readSettings,
  SCOPES,
} from "./src/config.js";
import { createFileTools } from "./src/files.js";
import { createMailTools } from "./src/mail.js";

export function createM365Tools(
  settings: M365Settings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  ask: ApprovalAsk = askViaGateway,
) {
  const tools = [];
  if (settings.mail) {
    tools.push(
      ...createMailTools({
        runtime,
        ctx,
        ask,
        allowSend: settings.mailSend,
        approvalTimeoutMs: settings.approvalTimeoutMs,
      }),
    );
  }
  if (settings.calendar || settings.calendarWrite) {
    tools.push(
      ...createCalendarTools({
        runtime,
        ctx,
        ask,
        allowWrite: settings.calendarWrite,
        approvalTimeoutMs: settings.approvalTimeoutMs,
      }),
    );
  }
  if (settings.files || settings.sharePoint) {
    tools.push(
      ...createFileTools({
        runtime,
        ctx,
        sharePoint: settings.sharePoint,
        maxFileBytes: settings.maxFileBytes,
      }),
    );
  }
  return tools;
}

/** Health probe: the signed-in user's id (User.Read). */
export async function probeM365(runtime: ConnectorRuntime): Promise<void> {
  await runtime.json({ url: graphUrl("/me", { $select: "id" }), scopes: [SCOPES.user] }, 64 * 1024);
}

export default function register(api: KoLoPluginApi) {
  const settings = readSettings(api.pluginConfig);
  const client = buildClient(settings);
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "Microsoft 365",
      cli: "m365",
      client,
      problems: configProblems(settings),
      flows: { loopback: true, device: true },
      redirectHost: "localhost",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: probeM365,
    },
    runtime,
  );
  if (!client) {
    api.logger.info(
      `microsoft-365: not configured (${configProblems(settings).join("; ")}); no tools registered`,
    );
    return;
  }
  const names = createM365Tools(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createM365Tools(settings, runtime, { agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
    { names },
  );
}
