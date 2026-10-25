// freee 会計 business connector (Kurahi Business edition). Off by default. Read-only, always.
//
// Reads companies, deals (取引), partners, account items and receipt metadata of the companies an
// administrator lists, through the freee accounting API with the customer's own freee app
// (OAuth 2.0 authorization code on a loopback redirect; the client secret lives in the secret
// store). There is no write tool: the deals API has no draft state, so creating a deal would
// always book it (see src/tools.ts and docs/connectors/freee.md).
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  type ConnectorRuntime,
  createRuntimeForPlugin,
  registerBusinessConnector,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import { resolveSecretStore } from "../../src/secrets/store.js";
import {
  buildClient,
  CLIENT_SECRET_NAME,
  CONNECTOR_ID,
  configProblems,
  FREEE_API,
  type FreeeSettings,
  readSettings,
  SCOPES,
} from "./src/config.js";
import { createFreeeTools } from "./src/tools.js";

export function createFreeeToolsFor(
  settings: FreeeSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
) {
  return createFreeeTools({ runtime, ctx, settings });
}

/** Health probe: the signed-in user's companies list (nothing from it is kept). */
export async function probeFreee(runtime: ConnectorRuntime): Promise<void> {
  await runtime.json({ url: `${FREEE_API}/companies`, scopes: [SCOPES.read] }, 256 * 1024);
}

function readClientSecret(): string | undefined {
  try {
    return resolveSecretStore().get(CLIENT_SECRET_NAME);
  } catch {
    return undefined;
  }
}

export default function register(api: KoLoPluginApi) {
  const settings = readSettings(api.pluginConfig);
  const secret = settings.clientId ? readClientSecret() : undefined;
  const client = buildClient(settings, secret);
  const problems = configProblems(settings, secret);
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "freee",
      cli: "freee",
      client,
      problems,
      flows: { loopback: true, device: false },
      redirectHost: "localhost",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: probeFreee,
    },
    runtime,
  );
  if (!client) {
    api.logger.info(`freee: not configured (${problems.join("; ")}); no tools registered`);
    return;
  }
  const names = createFreeeToolsFor(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createFreeeToolsFor(settings, runtime, { agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
    { names },
  );
}
