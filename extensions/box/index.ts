// Box business connector (Kurahi Business edition). Off by default.
//
// Search and file metadata through the Box API with the customer's own Box app (OAuth 2.0
// authorization code on a loopback redirect; the client secret lives in the secret store).
// Fetching a file brings it into the Project through the core attachment intake (quarantine,
// policy, malware scan); the model never receives the bytes. Uploading Project files is a
// separate opt-in limited to ONE configured folder, and a person approves every upload. Every
// call is audited with ids and counts only.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  type ApprovalAsk,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  RateLimiter,
  registerBusinessConnector,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import { askViaGateway } from "../../src/policy/guard.js";
import { resolveSecretStore } from "../../src/secrets/store.js";
import {
  BOX_API,
  type BoxSettings,
  buildClient,
  CLIENT_SECRET_NAME,
  CONNECTOR_ID,
  configProblems,
  readSettings,
  SCOPES,
} from "./src/config.js";
import { type BoxToolDeps, createBoxTools } from "./src/tools.js";

/** Box: 60 searches per minute per user; we keep a margin. */
export function createSearchLimiter(): RateLimiter {
  return new RateLimiter(50, 60_000);
}

export function createBoxToolsFor(
  settings: BoxSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  ask: ApprovalAsk = askViaGateway,
  opts: Partial<Pick<BoxToolDeps, "searchLimiter" | "intake">> = {},
) {
  return createBoxTools({
    runtime,
    ctx,
    ask,
    settings,
    searchLimiter: opts.searchLimiter ?? createSearchLimiter(),
    intake: opts.intake,
  });
}

/** Health probe: the signed-in user's id (GET /users/me, fields=id). */
export async function probeBox(runtime: ConnectorRuntime): Promise<void> {
  await runtime.json({ url: `${BOX_API}/users/me?fields=id`, scopes: [SCOPES.read] }, 64 * 1024);
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
      label: "Box",
      cli: "box",
      client,
      problems,
      flows: { loopback: true, device: false },
      redirectHost: "localhost",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: probeBox,
    },
    runtime,
  );
  if (!client) {
    api.logger.info(`box: not configured (${problems.join("; ")}); no tools registered`);
    return;
  }
  const searchLimiter = createSearchLimiter();
  const names = createBoxToolsFor(settings, runtime, {}, askViaGateway, { searchLimiter }).map(
    (t) => t.name,
  );
  api.registerTool(
    (ctx) =>
      createBoxToolsFor(
        settings,
        runtime,
        { agentId: ctx.agentId, sessionKey: ctx.sessionKey },
        askViaGateway,
        { searchLimiter },
      ),
    { names },
  );
}
