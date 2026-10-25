// SmartHR business connector (Kurahi Business edition). Off by default. Read-only, always.
//
// Lists employees (crews) and departments of one SmartHR tenant with an access token a SmartHR
// administrator issues (ideally with read-only resource permissions limited to the employee
// fields below). Employee requests always carry `fields=` with a strict allow-list of
// work-related fields, and responses are projected onto it again: My Number, bank accounts,
// insurance and pension numbers, pay, tax, addresses, phone numbers, birth dates and every other
// personal field are never requested or returned. There are no write tools.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  ConnectorError,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  registerBusinessConnector,
  type SignInInput,
  staticTokenCredential,
  type TokenSet,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import {
  apiBase,
  CONNECTOR_ID,
  configProblems,
  readSettings,
  SCOPES,
  type SmartHRSettings,
} from "./src/config.js";
import { createSmartHRTools } from "./src/tools.js";

const ACCESS_TOKEN = /^[A-Za-z0-9._-]{16,256}$/;

export function createSmartHRToolsFor(
  settings: SmartHRSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
) {
  return createSmartHRTools({ runtime, ctx, settings });
}

/** Health probe: one crew id (`fields=id`, nothing personal). */
export async function probeSmartHR(
  runtime: ConnectorRuntime,
  settings: SmartHRSettings,
): Promise<void> {
  await runtime.json(
    { url: `${apiBase(settings)}/crews?fields=id&per_page=1`, scopes: [SCOPES.read] },
    64 * 1024,
  );
}

export async function smarthrSignIn(
  input: SignInInput,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const value = await input.readSecret("SmartHR access token");
  if (!ACCESS_TOKEN.test(value)) {
    throw new ConnectorError("bad_request", "that does not look like a SmartHR access token");
  }
  return {
    accessToken: value,
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: [SCOPES.read],
    tokenType: "Bearer",
    obtainedAt: now(),
  };
}

export default function register(api: KoLoPluginApi) {
  const settings = readSettings(api.pluginConfig);
  const problems = configProblems(settings);
  const configured = problems.length === 0;
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client: undefined,
    credential: configured ? staticTokenCredential() : undefined,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "SmartHR",
      cli: "smarthr",
      client: undefined,
      problems,
      flows: { loopback: false, device: false },
      redirectHost: "127.0.0.1",
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: (rt) => probeSmartHR(rt, settings),
      signIn: (input) => smarthrSignIn(input),
      revokeHint:
        "SmartHR access tokens are revoked by a SmartHR administrator: 共通設定 > API アクセストークン > delete the token.",
    },
    runtime,
  );
  if (!configured) {
    api.logger.info(`smarthr: not configured (${problems.join("; ")}); no tools registered`);
    return;
  }
  const names = createSmartHRToolsFor(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createSmartHRToolsFor(settings, runtime, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      }),
    { names },
  );
}
