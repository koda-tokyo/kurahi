// Microsoft 365 business connector (Kurahi Business edition). Off by default.
//
// Outlook mail and calendar, OneDrive and SharePoint files through Microsoft Graph, signed in
// with the customer's own app registration (authorization code + PKCE on a loopback redirect,
// or device code). Read-only unless an administrator opts in to a write scope; every write that
// leaves the mailbox or calendar then waits for a person's approval (drafts stay in Drafts for a
// person to send). Project files can be attached to drafts or uploaded to the OneDrive app
// folder; neither shares anything. Every call is audited with ids and counts only.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import { registerMailWatchProvider } from "../../src/autopilot/triggers/mail-source.js";
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
import { createFileTools, createFileUploadTool } from "./src/files.js";
import { M365MailWatcher, NOTIFICATIONS_PATH } from "./src/mail-watch.js";
import { createMailTools, type MailToolDeps } from "./src/mail.js";

export function createM365Tools(
  settings: M365Settings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  ask: ApprovalAsk = askViaGateway,
  opts: { attachmentIntake?: MailToolDeps["attachmentIntake"] } = {},
) {
  const tools = [];
  if (settings.mail || settings.mailDraft) {
    tools.push(
      ...createMailTools({
        runtime,
        ctx,
        ask,
        allowSend: settings.mailSend,
        allowDraft: settings.mailDraft,
        approvalTimeoutMs: settings.approvalTimeoutMs,
        attachmentIntake: opts.attachmentIntake,
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
  if (settings.filesUpload) {
    tools.push(createFileUploadTool({ runtime, ctx }));
  }
  return tools;
}

/** Health probe: the signed-in user's id (User.Read). */
export async function probeM365(runtime: ConnectorRuntime): Promise<void> {
  await runtime.json({ url: graphUrl("/me", { $select: "id" }), scopes: [SCOPES.user] }, 64 * 1024);
}

/**
 * Autopilot `m365.mail` triggers: one delta-query watcher for this sign-in, offered to the
 * trigger dispatcher; it polls only while a routine subscribes. Optional change notifications
 * when notifications.publicUrl is set.
 */
function registerMailWatcher(
  api: KoLoPluginApi,
  settings: M365Settings,
  runtime: ConnectorRuntime,
) {
  const raw = (api.pluginConfig?.notifications as { publicUrl?: unknown } | undefined)?.publicUrl;
  if (raw !== undefined && !settings.notificationsPublicUrl) {
    api.logger.warn(
      "microsoft-365: notifications.publicUrl must be an https URL without query or credentials; change notifications are off (delta polling only)",
    );
  }
  const watcher = new M365MailWatcher(runtime, {
    pollMs: settings.mailWatchPollMs,
    publicUrl: settings.notificationsPublicUrl,
    log: { warn: (msg) => api.logger.warn(msg) },
  });
  const unregister = registerMailWatchProvider(watcher.provider());
  if (settings.notificationsPublicUrl) {
    api.registerHttpRoute?.({
      path: NOTIFICATIONS_PATH,
      handler: (req, res) => watcher.httpHandler(req, res),
      methods: ["POST"],
      summary: "Microsoft Graph change notifications for autopilot mail triggers",
      description:
        "Validation handshake (validationToken echo) and notifications checked against each subscription's clientState; a notification only makes the watcher poll the folder (docs/connectors/microsoft-365.md).",
    });
  }
  api.lifecycle?.onDispose?.(() => {
    unregister();
    watcher.close();
  });
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
  if (settings.mail || settings.mailDraft) {
    registerMailWatcher(api, settings, runtime);
  }
  const names = createM365Tools(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createM365Tools(settings, runtime, { agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
    { names },
  );
}
