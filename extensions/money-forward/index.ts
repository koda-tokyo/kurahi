// マネーフォワード クラウド business connector (Kurahi Business edition). Off by default.
// Read-only, always: billings, quotes and partners of クラウド請求書 through its public API v3, with the
// customer's own app on the Money Forward Cloud developer portal (OAuth 2.0 authorization code
// on a loopback redirect; the client secret lives in the secret store). Only the read scope
// (mfc/invoice/data.read) is requested. Other Money Forward products are not covered (see
// docs/connectors/money-forward.md for which have public APIs).
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
  INVOICE_API,
  readSettings,
  SCOPES,
} from "./src/config.js";
import { createMoneyForwardTools } from "./src/tools.js";

export function createMoneyForwardToolsFor(runtime: ConnectorRuntime, ctx: ToolContext) {
  return createMoneyForwardTools({ runtime, ctx });
}

/** Health probe: the office (事業者) record, nothing from it is kept. */
export async function probeMoneyForward(runtime: ConnectorRuntime): Promise<void> {
  await runtime.json({ url: `${INVOICE_API}/office`, scopes: [SCOPES.invoiceRead] }, 64 * 1024);
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
      label: "マネーフォワード クラウド",
      cli: "moneyforward",
      client,
      problems,
      flows: { loopback: true, device: false },
      redirectHost: "localhost",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: probeMoneyForward,
    },
    runtime,
  );
  if (!client) {
    api.logger.info(`money-forward: not configured (${problems.join("; ")}); no tools registered`);
    return;
  }
  const names = createMoneyForwardToolsFor(runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createMoneyForwardToolsFor(runtime, { agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
    { names },
  );
}
