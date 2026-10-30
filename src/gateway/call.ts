import { randomUUID } from "node:crypto";
import type { KoLoConfig } from "../config/config.js";
import {
  loadConfig,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { formatLoopbackUrlHost, resolveClientLoopbackHost } from "./net.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { gatewayBaseUrl, readSsoSession } from "./sso-session-file.js";
import { resolveGatewayTokenWithSource } from "./token-file.js";

export type CallGatewayOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: KoLoConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  /**
   * Overrides the config path shown in connection error details.
   * Does not affect config loading; callers still control auth via opts.token/password/env/config.
   */
  configPath?: string;
  /**
   * Command line only: authenticate as the person signed in with `kurahi login` for this
   * gateway (a live stored session) ahead of the shared token. Never set by in-process callers.
   */
  useSignIn?: boolean;
};

export type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

export function buildGatewayConnectionDetails(
  options: { config?: KoLoConfig; url?: string; configPath?: string } = {},
): GatewayConnectionDetails {
  const config = options.config ?? loadConfig();
  const configPath =
    options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort = resolveGatewayPort(config);
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const bindMode = config.gateway?.bind ?? "loopback";
  const preferTailnet = bindMode === "tailnet" && !!tailnetIPv4;
  const scheme = tlsEnabled ? "wss" : "ws";
  // Clients dial IPv4 loopback explicitly (the gateway listens on 127.0.0.1 and, when available,
  // ::1). Hosts with a broken IPv4 loopback opt in to IPv6 via KOLO_GATEWAY_LOOPBACK_HOST=::1;
  // no platform sniffing here.
  const loopbackHost = formatLoopbackUrlHost(resolveClientLoopbackHost(process.env));
  const localUrl =
    preferTailnet && tailnetIPv4
      ? `${scheme}://${tailnetIPv4}:${localPort}`
      : `${scheme}://${loopbackHost}:${localPort}`;
  const urlOverride =
    typeof options.url === "string" && options.url.trim().length > 0
      ? options.url.trim()
      : undefined;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
  const url = urlOverride || remoteUrl || localUrl;
  const urlSource = urlOverride
    ? "cli --url"
    : remoteUrl
      ? "config gateway.remote.url"
      : remoteMisconfigured
        ? "missing gateway.remote.url (fallback local)"
        : preferTailnet && tailnetIPv4
          ? `local tailnet ${tailnetIPv4}`
          : "local loopback";
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;
  const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
  const message = [
    `Gateway target: ${url}`,
    `Source: ${urlSource}`,
    `Config: ${configPath}`,
    bindDetail,
    remoteFallbackNote,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    urlSource,
    bindDetail,
    remoteFallbackNote,
    message,
  };
}

export type GatewaySessionOptions = Omit<CallGatewayOptions, "method" | "params" | "expectFinal">;

export type GatewaySession = {
  /** The connection target, for messages (never the token). */
  connectionDetails: GatewayConnectionDetails;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

/**
 * Open one authenticated gateway connection, run `fn` against it and close it (M3b). The
 * timeout bounds the whole exchange. `callGateway` is the one-request special case.
 */
export async function withGatewaySession<T>(
  opts: GatewaySessionOptions,
  fn: (session: GatewaySession) => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const config = opts.config ?? loadConfig();
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const urlOverride =
    typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  if (isRemoteMode && !urlOverride && !remoteUrl) {
    const configPath =
      opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
    throw new Error(
      [
        "gateway remote mode misconfigured: gateway.remote.url missing",
        `Config: ${configPath}`,
        "Fix: set gateway.remote.url, or set gateway.mode=local.",
      ].join("\n"),
    );
  }
  const authPassword = config.gateway?.auth?.password;
  const connectionDetails = buildGatewayConnectionDetails({
    config,
    url: urlOverride,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const url = connectionDetails.url;
  const useLocalTls =
    config.gateway?.tls?.enabled === true && !urlOverride && !remoteUrl && url.startsWith("wss://");
  const tlsRuntime = useLocalTls ? await loadGatewayTlsRuntime(config.gateway?.tls) : undefined;
  const remoteTlsFingerprint =
    isRemoteMode && !urlOverride && remoteUrl && typeof remote?.tlsFingerprint === "string"
      ? remote.tlsFingerprint.trim()
      : undefined;
  const overrideTlsFingerprint =
    typeof opts.tlsFingerprint === "string" ? opts.tlsFingerprint.trim() : undefined;
  const tlsFingerprint =
    overrideTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined);
  const signedIn = () => {
    if (!opts.useSignIn) {
      return undefined;
    }
    try {
      return readSsoSession(gatewayBaseUrl(url))?.token;
    } catch {
      return undefined;
    }
  };
  const token =
    (typeof opts.token === "string" && opts.token.trim().length > 0
      ? opts.token.trim()
      : undefined) ||
    signedIn() ||
    (isRemoteMode
      ? typeof remote?.token === "string" && remote.token.trim().length > 0
        ? remote.token.trim()
        : undefined
      : resolveGatewayTokenWithSource({ authConfig: config.gateway?.auth, env: process.env })
          .token);
  const password =
    (typeof opts.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined) ||
    process.env.KOLO_GATEWAY_PASSWORD?.trim() ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode
      ? typeof remote?.password === "string" && remote.password.trim().length > 0
        ? remote.password.trim()
        : undefined
      : typeof authPassword === "string" && authPassword.trim().length > 0
        ? authPassword.trim()
        : undefined);

  const formatCloseError = (code: number, reason: string) => {
    const reasonText = reason?.trim() || "no close reason";
    const hint =
      code === 1006
        ? "abnormal closure (no close frame)"
        : code === 1000
          ? "normal closure"
          : code === 1013
            ? "try again later"
            : "";
    const suffix = hint ? ` ${hint}` : "";
    return `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
  };
  const formatTimeoutError = () =>
    `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let ignoreClose = false;
    const stop = (err?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(value as T);
      }
    };

    const client = new GatewayClient({
      url,
      token,
      password,
      tlsFingerprint,
      instanceId: opts.instanceId ?? randomUUID(),
      clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: opts.clientDisplayName,
      clientVersion: opts.clientVersion ?? "dev",
      platform: opts.platform,
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      deviceIdentity: loadOrCreateDeviceIdentity(),
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      onHelloOk: async () => {
        try {
          const result = await fn({
            connectionDetails,
            request: (method, params, reqOpts) =>
              client.request(method, params, { expectFinal: reqOpts?.expectFinal }),
          });
          ignoreClose = true;
          stop(undefined, result);
          client.stop();
        } catch (err) {
          ignoreClose = true;
          client.stop();
          stop(err as Error);
        }
      },
      onClose: (code, reason) => {
        if (settled || ignoreClose) {
          return;
        }
        ignoreClose = true;
        client.stop();
        stop(new Error(formatCloseError(code, reason)));
      },
    });

    const timer = setTimeout(() => {
      ignoreClose = true;
      client.stop();
      stop(new Error(formatTimeoutError()));
    }, timeoutMs);

    client.start();
  });
}

export async function callGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  return await withGatewaySession<T>(opts, ({ request }) =>
    request<T>(opts.method, opts.params, { expectFinal: opts.expectFinal }),
  );
}

/** True when the error means no gateway answered (refused, timed out, closed before hello). */
export function isGatewayUnreachableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket error|gateway closed \(1006|gateway timeout after|not connected|closed before hello-ok|no hello-ok within/i.test(
    message,
  );
}

export function randomIdempotencyKey() {
  return randomUUID();
}
