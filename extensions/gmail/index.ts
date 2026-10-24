// Gmail business connector (Kurahi Business edition). Off by default.
//
// Reads mail through the Gmail API with the customer's own Google Cloud OAuth client
// (authorization code + PKCE on a loopback redirect; Google's device flow does not allow Gmail
// scopes). gmail.readonly by default; sending is a separate opt-in and every send waits for a
// person's approval. An optional Workspace domain restriction is enforced after sign-in.
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  type ApprovalAsk,
  ConnectorError,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  type FetchLike,
  readJson,
  registerBusinessConnector,
  requestWithRetry,
  type TokenSet,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import { askViaGateway } from "../../src/policy/guard.js";
import { resolveSecretStore } from "../../src/secrets/store.js";
import {
  buildClient,
  CLIENT_SECRET_NAME,
  CONNECTOR_ID,
  configProblems,
  GMAIL_API,
  type GmailSettings,
  readSettings,
  SCOPES,
} from "./src/config.js";
import { createGmailTools } from "./src/tools.js";

export function createGmailToolsFor(
  settings: GmailSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  ask: ApprovalAsk = askViaGateway,
) {
  return createGmailTools({
    runtime,
    ctx,
    ask,
    allowSend: settings.send,
    approvalTimeoutMs: settings.approvalTimeoutMs,
  });
}

/** Health probe: the mailbox profile (gmail.readonly). Nothing from it is kept. */
export async function probeGmail(runtime: ConnectorRuntime): Promise<void> {
  await runtime.json({ url: `${GMAIL_API}/profile`, scopes: [SCOPES.readonly] }, 64 * 1024);
}

/** Refuse a sign-in whose mailbox is outside the allowed Workspace domain. */
export async function checkAllowedDomain(
  token: TokenSet,
  allowedDomain: string | undefined,
  fetch?: FetchLike,
): Promise<void> {
  if (!allowedDomain) {
    return;
  }
  const res = await requestWithRetry(
    `${GMAIL_API}/profile`,
    { headers: { authorization: `Bearer ${token.accessToken}`, accept: "application/json" } },
    { fetch },
  );
  const profile = res.ok ? await readJson<{ emailAddress?: string }>(res, 64 * 1024) : {};
  const domain = profile.emailAddress?.split("@").pop()?.toLowerCase();
  if (domain !== allowedDomain) {
    throw new ConnectorError("forbidden", "the mailbox is outside the allowed domain");
  }
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
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "Gmail",
      cli: "gmail",
      client,
      problems: configProblems(settings, secret),
      flows: { loopback: true, device: false },
      redirectHost: "127.0.0.1",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: probeGmail,
      afterSignIn: (token) => checkAllowedDomain(token, settings.allowedDomain),
    },
    runtime,
  );
  if (!client) {
    api.logger.info(
      `gmail: not configured (${configProblems(settings, secret).join("; ")}); no tools registered`,
    );
    return;
  }
  const names = createGmailToolsFor(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createGmailToolsFor(settings, runtime, { agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
    { names },
  );
}
