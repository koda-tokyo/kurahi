// kintone business connector (Kurahi Business edition). Off by default.
//
// Reads the kintone apps an administrator lists, with one API token per app (created in each
// app's settings with only the permissions it needs, e.g. "view records"). Only the field codes
// on each app's allow-list are requested and returned. Read-only unless an administrator opts in
// to adding comments or creating records; every write then waits for a person's approval. Every
// call is audited with ids and counts only; requests are rate limited and counted against
// kintone's per-app daily limit.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  type ApprovalAsk,
  type ConnectorCredential,
  ConnectorError,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  registerBusinessConnector,
  type SignInInput,
  type TokenSet,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import { askViaGateway } from "../../src/policy/guard.js";
import { resolveSecretStore } from "../../src/secrets/store.js";
import {
  baseUrl,
  buildOAuthClient,
  CLIENT_SECRET_NAME,
  CONNECTOR_ID,
  configProblems,
  grantedScopes,
  type KintoneSettings,
  readSettings,
  toolScopes,
} from "./src/config.js";
import { createKintoneTools, DailyBudget } from "./src/tools.js";

const API_TOKEN = /^[A-Za-z0-9]{20,64}$/;

/** The stored credential: one API token per configured app, as JSON `{ "<appId>": "<token>" }`. */
function tokenMap(token: TokenSet): Record<string, string> {
  try {
    const m = JSON.parse(token.accessToken) as unknown;
    return m && typeof m === "object" ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** API token authentication: the app's own token in X-Cybozu-API-Token, never another app's. */
export const kintoneCredential: ConnectorCredential = {
  token: async (store) => {
    const t = store.load();
    if (!t) {
      throw new ConnectorError("not_authenticated", "no stored API token");
    }
    return t;
  },
  headers: (token, req) => {
    const value = req.credentialKey ? tokenMap(token)[req.credentialKey] : undefined;
    if (!value) {
      throw new ConnectorError(
        "not_authenticated",
        "no API token for this app",
        undefined,
        "no API token is stored for this app; run kurahi kintone login",
      );
    }
    return { "x-cybozu-api-token": value };
  },
};

export function createKintoneToolsFor(
  settings: KintoneSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  ask: ApprovalAsk = askViaGateway,
  budget = new DailyBudget(settings.dailyRequestsPerApp),
) {
  return createKintoneTools({ runtime, ctx, ask, settings, budget });
}

/** Health probe: one record id from the first configured app (no field content). */
export async function probeKintone(
  runtime: ConnectorRuntime,
  settings: KintoneSettings,
): Promise<void> {
  const app = settings.apps[0];
  if (!app) {
    throw new ConnectorError("not_configured", "no apps configured");
  }
  const url = new URL(`${baseUrl(settings)}/k/v1/records.json`);
  url.searchParams.set("app", String(app.id));
  url.searchParams.set("query", "limit 1");
  url.searchParams.set("fields[0]", "$id");
  await runtime.json(
    { url: url.toString(), scopes: [toolScopes(settings).records], credentialKey: String(app.id) },
    64 * 1024,
  );
}

/** `kurahi kintone login`: one hidden prompt per configured app; stored in the secret store. */
export async function kintoneSignIn(
  settings: KintoneSettings,
  input: SignInInput,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const map: Record<string, string> = {};
  for (const app of settings.apps) {
    const value = await input.readSecret(`kintone API token for app ${app.id}`);
    if (!API_TOKEN.test(value)) {
      throw new ConnectorError("bad_request", "that does not look like a kintone API token");
    }
    map[String(app.id)] = value;
  }
  return {
    accessToken: JSON.stringify(map),
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: grantedScopes(settings),
    tokenType: "kintone-api-token",
    obtainedAt: now(),
  };
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
  const oauth = settings.auth === "oauth";
  const secret = oauth ? readClientSecret() : undefined;
  const problems = configProblems(settings, secret);
  const configured = problems.length === 0;
  const client = buildOAuthClient(settings, secret);
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client,
    credential: configured && !oauth ? kintoneCredential : undefined,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "kintone",
      cli: "kintone",
      client,
      problems,
      flows: { loopback: oauth, device: false },
      redirectHost: "localhost",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: (rt) => probeKintone(rt, settings),
      ...(oauth ? {} : { signIn: (input: SignInInput) => kintoneSignIn(settings, input) }),
      revokeHint: oauth
        ? "kintone has no token revocation endpoint: a cybozu.com administrator can delete the OAuth client or the user can revoke the app in their account settings."
        : "kintone API tokens are revoked in each app: App settings > API token > delete the token, then save and update the app.",
    },
    runtime,
  );
  if (!configured) {
    api.logger.info(`kintone: not configured (${problems.join("; ")}); no tools registered`);
    return;
  }
  const budget = new DailyBudget(settings.dailyRequestsPerApp);
  const names = createKintoneToolsFor(settings, runtime, {}, askViaGateway, budget).map(
    (t) => t.name,
  );
  api.registerTool(
    (ctx) =>
      createKintoneToolsFor(
        settings,
        runtime,
        { agentId: ctx.agentId, sessionKey: ctx.sessionKey },
        askViaGateway,
        budget,
      ),
    { names },
  );
}
