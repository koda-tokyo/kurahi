import net from "node:net";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";

export function isLoopbackAddress(ip: string | undefined): boolean {
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

function normalizeIPv4MappedAddress(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice("::ffff:".length);
    if (net.isIP(v4) === 4) {
      return v4;
    }
  }
  return ip;
}

/** Canonical form for comparisons: trimmed, lower-case, no port/brackets, `::ffff:` v4 unmapped. */
export function normalizeIp(ip: string | undefined): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeIPv4MappedAddress(stripOptionalPort(trimmed.toLowerCase()));
}

function stripOptionalPort(ip: string): string {
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end !== -1) {
      return ip.slice(1, end);
    }
  }
  if (net.isIP(ip)) {
    return ip;
  }
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > -1 && ip.includes(".") && ip.indexOf(":") === lastColon) {
    const candidate = ip.slice(0, lastColon);
    if (net.isIP(candidate) === 4) {
      return candidate;
    }
  }
  return ip;
}

type HeaderInput = string | string[] | undefined;

/** Every X-Forwarded-For hop, normalized, left (claimed origin) to right (nearest hop). */
export function parseForwardedForChain(forwardedFor?: HeaderInput): string[] {
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** The RIGHTMOST X-Forwarded-For entry: the address the nearest proxy itself received. */
export function parseForwardedForNearestHop(forwardedFor?: HeaderInput): string | undefined {
  const chain = parseForwardedForChain(forwardedFor);
  return chain[chain.length - 1];
}

function parseRealIp(realIp?: HeaderInput): string | undefined {
  return normalizeIp(Array.isArray(realIp) ? realIp[0] : realIp);
}

export function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized || !trustedProxies || trustedProxies.length === 0) {
    return false;
  }
  return trustedProxies.some((proxy) => normalizeIp(proxy) === normalized);
}

export type GatewayClientAddress = {
  /** Resolved client address (normalized); undefined without a socket peer. */
  ip: string | undefined;
  /**
   * Where `ip` came from: the socket peer itself, a forwarding header set by a trusted proxy, or
   * the trusted proxy's own address because it forwarded no client address.
   */
  source: "socket" | "forwarded-for" | "real-ip" | "proxy";
};

type ClientAddressParams = {
  remoteAddr?: string;
  forwardedFor?: HeaderInput;
  realIp?: HeaderInput;
  trustedProxies?: string[];
};

/**
 * The one client-address resolver of the gateway (auth, "gateway host" test, rate limits, audit).
 * The socket peer is the client unless it is listed in `gateway.trustedProxies`. Then
 * X-Forwarded-For is walked from the RIGHT: hops that are trusted proxies are skipped and the
 * first untrusted entry is the client. Whatever the client itself wrote into the header sits left
 * of what our proxies appended, so it is never believed. Without X-Forwarded-For, X-Real-IP
 * (which the proxy must overwrite) is used.
 */
export function resolveGatewayClientAddress(params: ClientAddressParams): GatewayClientAddress {
  const remote = normalizeIp(params.remoteAddr);
  if (!remote) {
    return { ip: undefined, source: "socket" };
  }
  const trusted = params.trustedProxies ?? [];
  if (!isTrustedProxyAddress(remote, trusted)) {
    return { ip: remote, source: "socket" };
  }
  const chain = parseForwardedForChain(params.forwardedFor);
  if (chain.length > 0) {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!isTrustedProxyAddress(chain[i], trusted)) {
        return { ip: chain[i], source: "forwarded-for" };
      }
    }
    // Every hop is one of our proxies: the origin is the leftmost, itself a trusted proxy.
    return { ip: chain[0], source: "forwarded-for" };
  }
  const realIp = parseRealIp(params.realIp);
  if (realIp) {
    return { ip: realIp, source: "real-ip" };
  }
  return { ip: remote, source: "proxy" };
}

export function resolveGatewayClientIp(params: ClientAddressParams): string | undefined {
  return resolveGatewayClientAddress(params).ip;
}

type RequestLike = {
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
};

/** resolveGatewayClientAddress for an HTTP request or WebSocket upgrade request. */
export function resolveRequestClientAddress(
  req: RequestLike | undefined,
  trustedProxies?: string[],
): GatewayClientAddress {
  return resolveGatewayClientAddress({
    remoteAddr: req?.socket?.remoteAddress,
    forwardedFor: req?.headers?.["x-forwarded-for"],
    realIp: req?.headers?.["x-real-ip"],
    trustedProxies,
  });
}

/** True when the request carries any proxy forwarding header. */
export function hasForwardingHeaders(req: RequestLike | undefined): boolean {
  const h = req?.headers;
  return Boolean(h?.["x-forwarded-for"] || h?.["x-real-ip"] || h?.["x-forwarded-host"]);
}

/**
 * "From the gateway host" by address: the socket peer is loopback, and either the request has
 * no forwarding headers, or the peer is a trusted proxy and the client it resolved (walking
 * X-Forwarded-For from the right through trusted proxies only) is loopback too.
 */
export function isLoopbackClientRequest(
  req: RequestLike | undefined,
  trustedProxies?: string[],
): boolean {
  if (!req || !isLoopbackAddress(normalizeIp(req.socket?.remoteAddress))) {
    return false;
  }
  if (!hasForwardingHeaders(req)) {
    return true;
  }
  const resolved = resolveRequestClientAddress(req, trustedProxies);
  return (
    (resolved.source === "forwarded-for" || resolved.source === "real-ip") &&
    isLoopbackAddress(resolved.ip)
  );
}

export function isLocalGatewayAddress(ip: string | undefined): boolean {
  if (isLoopbackAddress(ip)) {
    return true;
  }
  if (!ip) {
    return false;
  }
  const normalized = normalizeIPv4MappedAddress(ip.trim().toLowerCase());
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  if (tailnetIPv4 && normalized === tailnetIPv4.toLowerCase()) {
    return true;
  }
  const tailnetIPv6 = pickPrimaryTailnetIPv6();
  if (tailnetIPv6 && ip.trim().toLowerCase() === tailnetIPv6.toLowerCase()) {
    return true;
  }
  return false;
}

/**
 * Resolves gateway bind host with fallback strategy.
 *
 * Modes:
 * - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
 * - lan: always 0.0.0.0 (no fallback)
 * - tailnet: Tailnet IPv4 if available, else loopback
 * - auto: Loopback if available, else 0.0.0.0
 * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable
 *
 * @returns The bind address to use (never null)
 */
export async function resolveGatewayBindHost(
  bind: import("../config/config.js").GatewayBindMode | undefined,
  customHost?: string,
): Promise<string> {
  const mode = bind ?? "loopback";

  if (mode === "loopback") {
    // 127.0.0.1 rarely fails, but handle gracefully
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0"; // extreme fallback
  }

  if (mode === "tailnet") {
    const tailnetIP = pickPrimaryTailnetIPv4();
    if (tailnetIP && (await canBindToHost(tailnetIP))) {
      return tailnetIP;
    }
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0";
  }

  if (mode === "lan") {
    return "0.0.0.0";
  }

  if (mode === "custom") {
    const host = customHost?.trim();
    if (!host) {
      return "0.0.0.0";
    } // invalid config → fall back to all

    if (isValidIPv4(host) && (await canBindToHost(host))) {
      return host;
    }
    // Custom IP failed → fall back to LAN
    return "0.0.0.0";
  }

  if (mode === "auto") {
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0";
  }

  return "0.0.0.0";
}

/**
 * Test if we can bind to a specific host address.
 * Creates a temporary server, attempts to bind, then closes it.
 *
 * @param host - The host address to test
 * @returns True if we can successfully bind to this address
 */
export async function canBindToHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = net.createServer();
    testServer.once("error", () => {
      resolve(false);
    });
    testServer.once("listening", () => {
      testServer.close();
      resolve(true);
    });
    // Use port 0 to let OS pick an available port for testing
    testServer.listen(0, host);
  });
}

export async function resolveGatewayListenHosts(
  bindHost: string,
  opts?: { canBindToHost?: (host: string) => Promise<boolean> },
): Promise<string[]> {
  if (bindHost !== "127.0.0.1") {
    return [bindHost];
  }
  const canBind = opts?.canBindToHost ?? canBindToHost;
  if (await canBind("::1")) {
    return [bindHost, "::1"];
  }
  return [bindHost];
}

/**
 * Validate if a string is a valid IPv4 address.
 *
 * @param host - The string to validate
 * @returns True if valid IPv4 format
 */
function isValidIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    const n = parseInt(part, 10);
    return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
  });
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host);
}

/**
 * Loopback address CLI/TUI clients dial for a local gateway. Defaults to IPv4 127.0.0.1;
 * `KOLO_GATEWAY_LOOPBACK_HOST` may select `::1` (or `127.0.0.1`) explicitly. Anything else is
 * ignored so a typo can never point a client off-host.
 */
export function resolveClientLoopbackHost(
  env: NodeJS.ProcessEnv = process.env,
): "127.0.0.1" | "::1" {
  const raw = env.KOLO_GATEWAY_LOOPBACK_HOST?.trim().replace(/^\[|\]$/g, "");
  return raw === "::1" ? "::1" : "127.0.0.1";
}

/** Bracket IPv6 literals for use in a URL authority. */
export function formatLoopbackUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
