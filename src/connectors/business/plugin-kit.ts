// Business connectors: shared plugin wiring (CLI sign-in, revocation, health probe service).
//
//   kurahi <cli> login [--device] [--port <n>]   sign in (loopback PKCE, or device code)
//   kurahi <cli> login [--stdin]                 API-token connectors: paste the token (hidden)
//   kurahi <cli> logout                          revoke where supported, delete stored tokens
//   kurahi <cli> status                          configured / signed in / scopes (no network)
//   kurahi <cli> probe                           one live health call
//
// The gateway runs the probe at start and on an interval and reports it to the status registry
// behind `connectors.status`.
import type { Command } from "commander";
import type { KoLoPluginApi } from "../../plugins/types.js";
import type { FetchLike } from "./http.js";
import { resolveSecretStore } from "../../secrets/store.js";
import { ConnectorError, describeConnectorError, errorCodeOf } from "./errors.js";
import { loopbackSignIn } from "./loopback.js";
import {
  type OAuthClientConfig,
  pollDeviceToken,
  randomState,
  revokeToken,
  startDeviceAuthorization,
  type TokenSet,
} from "./oauth.js";
import { type ConnectorCredential, ConnectorRuntime } from "./runtime.js";
import { sanitizeScopeNames } from "./scopes.js";
import { reportConnectorStatus, runConnectorProbe } from "./status.js";

export type ConnectorFlows = { loopback: boolean; device: boolean };

export type BusinessConnectorSpec = {
  id: string;
  label: string;
  cli: string;
  client: OAuthClientConfig | undefined;
  /** Why the connector is not configured (missing tenant, client id …), for `status`. */
  problems: string[];
  flows: ConnectorFlows;
  redirectHost: "localhost" | "127.0.0.1";
  redirectPort?: number;
  probeIntervalMinutes: number;
  /** One cheap authenticated read that proves the connector works. */
  probe: (runtime: ConnectorRuntime) => Promise<void>;
  /** Called after a sign-in, before the token is stored (Entra checks the ID token here). */
  afterSignIn?: (token: TokenSet, ctx: { nonce?: string }) => Promise<void>;
  /** Send an OIDC nonce on the loopback flow (checked by `afterSignIn`). */
  useNonce?: boolean;
  /** Connector-specific subcommands under the same CLI command. */
  extraCommands?: (cmd: Command) => void;
  /**
   * Non-OAuth sign-in (API token, assertion grant): replaces the browser/device flow. It returns
   * the token set to store; `readSecret` asks for a value on a hidden prompt (or stdin).
   */
  signIn?: (input: SignInInput) => Promise<TokenSet>;
  /** What `logout` tells the administrator when the provider has no revocation endpoint. */
  revokeHint?: string;
};

export type SignInInput = {
  /** A hidden prompt, or stdin with `--stdin`; never echoed or logged. */
  readSecret: (label: string) => Promise<string>;
};

async function readSecretInput(label: string, fromStdin: boolean): Promise<string> {
  let value: string;
  if (fromStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    value = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  } else {
    if (!process.stdin.isTTY) {
      throw new ConnectorError("bad_request", "no TTY for a hidden prompt; pipe it with --stdin");
    }
    const { isCancel, password } = await import("@clack/prompts");
    const answer = await password({ message: label });
    if (isCancel(answer)) {
      throw new ConnectorError("approval_denied", "cancelled");
    }
    value = String(answer);
  }
  value = value.trim();
  if (!value) {
    throw new ConnectorError("bad_request", "empty value");
  }
  return value;
}

export function createRuntimeForPlugin(
  api: Pick<KoLoPluginApi, "audit">,
  spec: Pick<BusinessConnectorSpec, "id" | "client"> & {
    ratePerSecond?: number;
    credential?: ConnectorCredential;
  },
  deps: { fetch?: FetchLike } = {},
): ConnectorRuntime {
  return new ConnectorRuntime(
    {
      id: spec.id,
      client: spec.client,
      credential: spec.credential,
      ratePerSecond: spec.ratePerSecond,
    },
    { secrets: () => resolveSecretStore(), audit: api.audit, fetch: deps.fetch },
  );
}

async function probeOnce(runtime: ConnectorRuntime, spec: BusinessConnectorSpec) {
  return runConnectorProbe({
    id: spec.id,
    configured: runtime.configured,
    grantedScopes: runtime.configured ? runtime.grantedScopes() : undefined,
    probe: () => spec.probe(runtime),
  });
}

export function registerBusinessConnector(
  api: KoLoPluginApi,
  spec: BusinessConnectorSpec,
  runtime: ConnectorRuntime,
): void {
  // Report the configuration state at once (no probe result yet: never "Active" before a
  // real call succeeded); the first probe runs when the service starts.
  const scopes = runtime.configured ? runtime.grantedScopes() : undefined;
  reportConnectorStatus({
    id: spec.id,
    configured: runtime.configured,
    authenticated: scopes !== undefined,
    lastProbeOk: null,
    lastProbeAt: null,
    scopes: scopes ?? [],
    error: !runtime.configured ? "not_configured" : scopes ? null : "not_authenticated",
  });

  api.registerService({
    id: `${spec.id}-probe`,
    start: async () => {
      await probeOnce(runtime, spec);
      const everyMs = Math.min(Math.max(spec.probeIntervalMinutes, 5), 24 * 60) * 60_000;
      api.lifecycle.setInterval(() => {
        void probeOnce(runtime, spec);
      }, everyMs);
    },
  });

  api.registerCli(
    ({ program }) => {
      const cmd = program
        .command(spec.cli)
        .description(`${spec.label} connector (read-only by default)`);
      registerConnectorCommands(cmd, spec, runtime, api);
      spec.extraCommands?.(cmd);
    },
    { commands: [spec.cli] },
  );
}

function print(line: string) {
  process.stdout.write(`${line}\n`);
}

function fail(err: unknown) {
  process.stderr.write(`${describeConnectorError(err)}\n`);
  // An administrator debugging a connector on their own terminal may ask for the raw error;
  // it is never audited or sent anywhere.
  if (process.env.KURAHI_DEBUG_CONNECTORS === "1") {
    process.stderr.write(
      `${String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 2000)}\n`,
    );
  }
  process.exitCode = 1;
}

function registerConnectorCommands(
  cmd: Command,
  spec: BusinessConnectorSpec,
  runtime: ConnectorRuntime,
  api: KoLoPluginApi,
) {
  cmd
    .command("login")
    .description("Sign in and store the tokens in the secret store")
    .option("--device", "Use the device code flow (sign in on another device)")
    .option("--port <n>", "Loopback port for the browser redirect (default: random)")
    .option("--stdin", "API-token connectors: read the token from stdin")
    .action(async (opts: { device?: boolean; port?: string; stdin?: boolean }) => {
      const useDevice = !spec.signIn && (opts.device === true || !spec.flows.loopback);
      try {
        let token: TokenSet;
        let nonce: string | undefined;
        if (spec.signIn) {
          if (!runtime.configured) {
            throw new ConnectorError("not_configured", "connector is not configured");
          }
          token = await spec.signIn({
            readSecret: (label) => readSecretInput(label, opts.stdin === true),
          });
        } else if (useDevice) {
          const client = runtime.requireClient();
          if (!spec.flows.device) {
            throw new ConnectorError("unsupported", "device code sign-in is not available");
          }
          const device = await startDeviceAuthorization(client);
          print(`To sign in, open ${device.verificationUri} and enter the code ${device.userCode}`);
          token = await pollDeviceToken(client, device);
        } else {
          const client = runtime.requireClient();
          const port = opts.port ? Number(opts.port) : spec.redirectPort;
          nonce = spec.useNonce ? randomState() : undefined;
          token = await loopbackSignIn(client, {
            nonce,
            port: Number.isInteger(port) ? port : 0,
            redirectHost: spec.redirectHost,
            openUrl: async (url) => {
              print(`Open this address to sign in:\n${url}`);
              const { openUrl } = await import("../../commands/onboard-helpers.js");
              await openUrl(url);
            },
          });
        }
        await spec.afterSignIn?.(token, { nonce });
        runtime.tokens.save(token);
        api.audit({
          action: `connector.${spec.id}.login`,
          outcome: "ok",
          detail: {
            flow: spec.signIn ? "credential" : useDevice ? "device" : "loopback",
            scopes: sanitizeScopeNames(token.scopes),
          },
        });
        print(`Signed in. Granted: ${sanitizeScopeNames(token.scopes).join(", ")}`);
      } catch (err) {
        api.audit({
          action: `connector.${spec.id}.login`,
          outcome: "failed",
          detail: { error: errorCodeOf(err) },
        });
        fail(err);
      }
    });

  cmd
    .command("logout")
    .description("Revoke the sign-in where the provider supports it and delete stored tokens")
    .action(async () => {
      const token = runtime.tokens.load();
      let revoked = false;
      if (token && spec.client) {
        try {
          revoked = await revokeToken(spec.client, token.refreshToken ?? token.accessToken);
        } catch {
          revoked = false;
        }
      }
      const removed = runtime.tokens.clear();
      api.audit({
        action: `connector.${spec.id}.logout`,
        outcome: "ok",
        detail: { revokedAtProvider: revoked, removedLocal: removed },
      });
      print(
        removed
          ? `Stored tokens deleted${revoked ? " and revoked at the provider" : ""}.`
          : "No stored sign-in.",
      );
      if (!spec.client?.endpoints.revokeUrl) {
        print(
          spec.revokeHint ??
            "This provider has no token revocation endpoint: an administrator can revoke the app's sessions in the admin console (see the connector documentation).",
        );
      }
    });

  cmd
    .command("status")
    .description("Show configuration and sign-in state (no network)")
    .action(() => {
      print(`configured: ${runtime.configured ? "yes" : "no"}`);
      for (const p of spec.problems) {
        print(`  - ${p}`);
      }
      const scopes = runtime.configured ? runtime.grantedScopes() : undefined;
      print(`signed in: ${scopes ? "yes" : "no"}`);
      if (scopes) {
        print(`scopes: ${sanitizeScopeNames(scopes).join(", ")}`);
      }
    });

  cmd
    .command("probe")
    .description("Run one live health call")
    .action(async () => {
      const entry = await probeOnce(runtime, spec);
      print(JSON.stringify(entry, null, 2));
      if (entry.lastProbeOk !== true) {
        process.exitCode = 1;
      }
    });
}
