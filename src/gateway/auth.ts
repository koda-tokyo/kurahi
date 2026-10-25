import type { IncomingMessage } from "node:http";
import type { GatewayAuthConfig, GatewayTailscaleMode } from "../config/config.js";
import { safeEqualSecret } from "../infra/secure-compare.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { isLoopbackClientRequest, parseForwardedForNearestHop } from "./net.js";
import {
  ensureGatewayTokenFile,
  resolveGatewayTokenWithSource,
  type GatewayTokenSource,
} from "./token-file.js";
export type ResolvedGatewayAuthMode = "token" | "password";

export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  token?: string;
  /** Where the shared token came from (file > env > legacy config). */
  tokenSource?: GatewayTokenSource;
  /** Resolved token file path (null when `gateway.auth.tokenFile: false`). */
  tokenFile?: string | null;
  password?: string;
  allowTailscale: boolean;
};

export type GatewayAuthResult = {
  ok: boolean;
  method?: "token" | "password" | "tailscale" | "device-token";
  user?: string;
  reason?: string;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

function safeEqual(a: string, b: string): boolean {
  return safeEqualSecret(a, b);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  if (ip === "127.0.0.1") {
    return true;
  }
  if (ip.startsWith("127.")) {
    return true;
  }
  if (ip === "::1") {
    return true;
  }
  if (ip.startsWith("::ffff:127.")) {
    return true;
  }
  return false;
}

function getHostName(hostHeader?: string): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      return host.slice(1, end);
    }
  }
  const [name] = host.split(":");
  return name ?? "";
}

// Tailscale Serve (a loopback proxy) appends the tailnet peer it accepted as the RIGHTMOST
// X-Forwarded-For hop; anything left of it was written by the client.
function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  return parseForwardedForNearestHop(req.headers?.["x-forwarded-for"]);
}

/**
 * "From the gateway host": the socket peer is loopback, the Host is local or *.ts.net, and
 * either there are no forwarding headers or the peer is a trusted proxy and the client it
 * forwarded (X-Forwarded-For walked from the right, see resolveGatewayClientAddress) is loopback.
 * Caveat (docs/security/identity.md): a same-host reverse proxy that connects over loopback
 * without X-Forwarded-For makes proxied remote requests look local; such a proxy must send
 * X-Forwarded-For and be listed in gateway.trustedProxies.
 */
export function isLocalDirectRequest(req?: IncomingMessage, trustedProxies?: string[]): boolean {
  if (!req || !isLoopbackClientRequest(req, trustedProxies)) {
    return false;
  }
  const host = getHostName(req.headers?.host);
  const hostIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const hostIsTailscaleServe = host.endsWith(".ts.net");
  return hostIsLocal || hostIsTailscaleServe;
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

/**
 * Resolve gateway auth. Token precedence: token file → KOLO_GATEWAY_TOKEN env → legacy
 * `gateway.auth.token` (see token-file.ts). With `ensureTokenFile` (gateway startup only), a
 * token-mode gateway that has no token from any source generates its 0600 token file.
 */
export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
  ensureTokenFile?: boolean;
  /** Explicit token from a (deprecated) `--token` flag; wins over file/env/config. */
  tokenOverride?: string | null;
}): ResolvedGatewayAuth {
  const authConfig = params.authConfig ?? {};
  const env = params.env ?? process.env;
  const resolvedToken = resolveGatewayTokenWithSource({
    authConfig,
    env,
    override: params.tokenOverride,
  });
  let token = resolvedToken.token;
  let tokenSource = resolvedToken.source;
  const password =
    authConfig.password ?? env.KOLO_GATEWAY_PASSWORD ?? env.CLAWDBOT_GATEWAY_PASSWORD ?? undefined;
  const mode: ResolvedGatewayAuth["mode"] = authConfig.mode ?? (password ? "password" : "token");
  if (params.ensureTokenFile && mode === "token" && !token && resolvedToken.tokenFile) {
    token = ensureGatewayTokenFile(resolvedToken.tokenFile, env).token;
    tokenSource = "file";
  }
  const allowTailscale =
    authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password");
  return {
    mode,
    token,
    tokenSource,
    tokenFile: resolvedToken.tokenFile,
    password,
    allowTailscale,
  };
}

export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      "gateway auth mode is token, but no token was configured (create the token file <KOLO_HOME>/secrets/gateway.token, or set KOLO_GATEWAY_TOKEN)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    throw new Error("gateway auth mode is password, but no password was configured");
  }
}

export async function authorizeGatewayConnect(params: {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
}): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const localDirect = isLocalDirectRequest(req, trustedProxies);

  if (auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "token") {
    if (!auth.token) {
      return { ok: false, reason: "token_missing_config" };
    }
    if (!connectAuth?.token) {
      return { ok: false, reason: "token_missing" };
    }
    if (!safeEqual(connectAuth.token, auth.token)) {
      return { ok: false, reason: "token_mismatch" };
    }
    return { ok: true, method: "token" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return { ok: false, reason: "password_missing_config" };
    }
    if (!password) {
      return { ok: false, reason: "password_missing" };
    }
    if (!safeEqual(password, auth.password)) {
      return { ok: false, reason: "password_mismatch" };
    }
    return { ok: true, method: "password" };
  }

  return { ok: false, reason: "unauthorized" };
}
