// Microsoft Entra ID business connector (Kurahi Business edition). Off by default.
//
// 1. Sign-in: OpenID Connect against the customer's tenant. `kurahi entra login` runs the
//    authorization code + PKCE flow with a nonce and validates the returned ID token (issuer,
//    tenant allowlist, audience, signature from the tenant's JWKS, expiry, nonce). The same
//    validator (createSsoValidator) is what gateway / desktop sign-in plugs into.
// 2. Directory read (opt-in): user lookup (User.ReadBasic.All) or users and groups
//    (Directory.Read.All). Read-only; every call audited with ids and counts only.
import type { Command } from "commander";
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  ConnectorError,
  type ConnectorRuntime,
  createRuntimeForPlugin,
  type EntraOidcValidator,
  graphUrl,
  OidcValidationError,
  registerBusinessConnector,
  type TokenSet,
  type ToolContext,
} from "../../src/connectors/business/index.js";
import {
  buildClient,
  CONNECTOR_ID,
  configProblems,
  createSsoValidator,
  type EntraSettings,
  readSettings,
  SCOPES,
} from "./src/config.js";
import { createDirectoryTools } from "./src/directory.js";

export { createSsoValidator } from "./src/config.js";

export function createEntraTools(
  settings: EntraSettings,
  runtime: ConnectorRuntime,
  ctx: ToolContext,
) {
  return createDirectoryTools({ runtime, ctx, level: settings.directory });
}

/** Probe: the tenant's signing keys are reachable, and the stored sign-in still works. */
export async function probeEntra(
  runtime: ConnectorRuntime,
  validator: EntraOidcValidator | undefined,
): Promise<void> {
  if (!validator) {
    throw new ConnectorError("not_configured", "connector is not configured");
  }
  try {
    await validator.refreshKeys();
  } catch {
    throw new ConnectorError("provider_unavailable", "tenant signing keys could not be loaded");
  }
  await runtime.json({ url: graphUrl("/me", { $select: "id" }), scopes: [SCOPES.user] }, 64 * 1024);
}

/** Validate the ID token from an interactive sign-in; refuses a sign-in that does not check out. */
export async function verifySignIn(
  validator: EntraOidcValidator | undefined,
  token: TokenSet,
  nonce: string | undefined,
) {
  if (!validator) {
    throw new ConnectorError("not_configured", "connector is not configured");
  }
  if (!token.idToken) {
    throw new ConnectorError("invalid_response", "the sign-in returned no ID token");
  }
  try {
    return await validator.validate(token.idToken, nonce ? { nonce } : {});
  } catch (err) {
    if (err instanceof OidcValidationError) {
      throw new ConnectorError("forbidden", `ID token rejected: ${err.reason}`);
    }
    throw err;
  }
}

async function readStdin(limit = 32 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > limit) {
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function verifyTokenCommand(validator: EntraOidcValidator | undefined) {
  return (cmd: Command) => {
    cmd
      .command("verify-token")
      .description(
        "Validate an ID token read from stdin (issuer, tenant, audience, signature, expiry)",
      )
      .action(async () => {
        if (!validator) {
          process.stderr.write("not_configured: set tenantId and clientId first\n");
          process.exitCode = 1;
          return;
        }
        try {
          const c = await validator.validate(await readStdin());
          const shown = {
            sub: c.sub,
            oid: c.oid,
            tid: c.tid,
            name: c.name,
            preferred_username: c.preferred_username,
            exp: c.exp,
          };
          process.stdout.write(`${JSON.stringify({ valid: true, claims: shown }, null, 2)}\n`);
        } catch (err) {
          const reason = err instanceof OidcValidationError ? err.reason : "unknown";
          process.stdout.write(`${JSON.stringify({ valid: false, reason })}\n`);
          process.exitCode = 1;
        }
      });
  };
}

export default function register(api: KoLoPluginApi) {
  const settings = readSettings(api.pluginConfig);
  const client = buildClient(settings);
  const validator = createSsoValidator(settings);
  const runtime = createRuntimeForPlugin(api, {
    id: CONNECTOR_ID,
    client,
    ratePerSecond: settings.ratePerSecond,
  });
  registerBusinessConnector(
    api,
    {
      id: CONNECTOR_ID,
      label: "Microsoft Entra ID",
      cli: "entra",
      client,
      problems: configProblems(settings),
      flows: { loopback: true, device: true },
      redirectHost: "localhost",
      redirectPort: settings.redirectPort,
      probeIntervalMinutes: settings.probeIntervalMinutes,
      probe: (rt) => probeEntra(rt, validator),
      useNonce: true,
      afterSignIn: async (token, { nonce }) => {
        const claims = await verifySignIn(validator, token, nonce);
        api.audit({
          action: "connector.entra.sso.verified",
          outcome: "ok",
          detail: { tid: claims.tid, oid: claims.oid ?? null },
        });
      },
      extraCommands: verifyTokenCommand(validator),
    },
    runtime,
  );
  if (!client || settings.directory === "off") {
    return;
  }
  const names = createEntraTools(settings, runtime, {}).map((t) => t.name);
  api.registerTool(
    (ctx) =>
      createEntraTools(settings, runtime, { agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
    { names },
  );
}
