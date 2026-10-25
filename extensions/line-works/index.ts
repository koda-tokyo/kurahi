// LINE WORKS business connector (Kurahi Business edition). Off by default.
//
// One bot of the customer's LINE WORKS app, authenticated as the app's service account (a JWT
// signed with the app's private key; key and client secret in the secret store). Read-only by
// default: information and members of the channels an administrator lists (LINE WORKS has no
// API to read message history). Sending a text message to a listed channel or user is a
// separate opt-in, and a person approves every message. Every call is audited with ids and counts
// only; addresses are never written to the audit log.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  type ApprovalAsk,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  registerBusinessConnector,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import { askViaGateway } from "../../src/policy/guard.js";
import { resolveSecretStore } from "../../src/secrets/store.js";
import {
  mintAccessToken,
  type ServiceAccountConfig,
  serviceAccountCredential,
} from "./src/auth.js";
import {
  API_BASE,
  CLIENT_SECRET_NAME,
  CONNECTOR_ID,
  configProblems,
  type LineWorksSettings,
  PRIVATE_KEY_NAME,
  readSettings,
  requestedScopes,
  SCOPES,
} from "./src/config.js";
import { createLineWorksTools } from "./src/tools.js";

export function createLineWorksToolsFor(
  settings: LineWorksSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  ask: ApprovalAsk = askViaGateway,
) {
  return createLineWorksTools({ runtime, ctx, ask, settings });
}

/** Health probe: the first configured channel's information, or the bot list. */
export async function probeLineWorks(
  runtime: ConnectorRuntime,
  settings: LineWorksSettings,
): Promise<void> {
  const bot = `${API_BASE}/bots/${encodeURIComponent(settings.botId ?? "")}`;
  const channel = settings.channels[0];
  await runtime.json(
    {
      // GET /bots (bot.read) when no channel is configured: https://developers.worksmobile.com/jp/docs/bot-list
      url: channel ? `${bot}/channels/${encodeURIComponent(channel)}` : `${API_BASE}/bots?count=1`,
      scopes: [SCOPES.read],
    },
    64 * 1024,
  );
}

function secret(name: string): string | undefined {
  try {
    return resolveSecretStore().get(name);
  } catch {
    return undefined;
  }
}

export default function register(api: KoLoPluginApi) {
  const settings = readSettings(api.pluginConfig);
  const problems = configProblems(settings, {
    privateKey: secret(PRIVATE_KEY_NAME),
    clientSecret: secret(CLIENT_SECRET_NAME),
  });
  const configured = problems.length === 0;
  const account: ServiceAccountConfig = {
    clientId: settings.clientId ?? "",
    serviceAccount: settings.serviceAccount ?? "",
    scopes: requestedScopes(settings),
    // Read when a token is minted, so a rotated key is picked up without a restart.
    privateKey: () => secret(PRIVATE_KEY_NAME),
    clientSecret: () => secret(CLIENT_SECRET_NAME),
  };
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client: undefined,
    credential: configured ? serviceAccountCredential(account) : undefined,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "LINE WORKS",
      cli: "lineworks",
      client: undefined,
      problems,
      flows: { loopback: false, device: false },
      redirectHost: "127.0.0.1",
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: (rt) => probeLineWorks(rt, settings),
      // `login` mints one token with the stored key: it proves the key, secret and scopes work.
      signIn: () => mintAccessToken(account, {}),
      revokeHint:
        "LINE WORKS service account tokens expire on their own; to cut access, an administrator regenerates or deletes the app's private key or client secret in the Developer Console.",
    },
    runtime,
  );
  if (!configured) {
    api.logger.info(`line-works: not configured (${problems.join("; ")}); no tools registered`);
    return;
  }
  const names = createLineWorksToolsFor(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createLineWorksToolsFor(settings, runtime, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      }),
    { names },
  );
}
