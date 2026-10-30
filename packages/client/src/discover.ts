// SPDX-License-Identifier: MIT
// Local gateway discovery (Node, Bun, Deno with node: compat).
//
// State root: KOLO_HOME -> KOLO_STATE_DIR -> CLAWDBOT_STATE_DIR -> ~/.kolo
// (Windows: %LOCALAPPDATA%\KoLo). Same precedence as the gateway's own resolver.
//
// Base URL:  KOLO_GATEWAY_URL
//         -> http://127.0.0.1:<port> with port from KOLO_GATEWAY_PORT
//            -> <home>/run/gateway.lock {port} (written by the running gateway's lease)
//            -> <home>/kolo.json gateway.port (or KOLO_CONFIG_PATH)
//            -> the spec default (18789)
// Token:     KOLO_GATEWAY_TOKEN -> file KOLO_GATEWAY_TOKEN_FILE -> <home>/secrets/gateway.token
//            -> KOLO_GATEWAY_PASSWORD
//            -> a paired device credential <home>/secrets/devices/<fingerprint>.json (M3a):
//               its access token when still valid; `device` describes it either way so the
//               caller can refresh an expired one.
//            -> a person session from `kurahi login` <home>/secrets/sessions/*.json for this
//               base URL, while it lasts: last, and only without a device credential, so it
//               never replaces an owner or device credential (a `kss_` session authenticates
//               WebSocket calls and sso-session routes).
// Node modules are imported lazily so the main entry stays usable in a browser.
import { DEFAULT_PORT } from "./generated/operations.js";

export type DiscoverOptions = {
  env?: Record<string, string | undefined>;
  /** Explicit state root (skips the env precedence). */
  home?: string;
};

export type DiscoveredGateway = {
  home: string;
  baseUrl: string;
  wsUrl: string;
  port: number;
  portSource: "url" | "env" | "lock" | "config" | "default";
  token?: string;
  tokenSource: "env" | "file" | "password" | "device" | "sso" | "none";
  /** Path the token was read from (never the token itself). */
  tokenFile?: string;
  /** Paired device credential for this gateway, when one exists (M3a). */
  device?: {
    file: string;
    fingerprint: string;
    scope: string;
    status: string;
    accessExpiresAt: string;
    /** Access token past its lifetime: refresh() before use. */
    expired: boolean;
  };
  /** The lease holder from run/gateway.lock, when present. */
  lock?: { pid?: number; port?: number; startedAt?: number; hostname?: string };
};

type NodeDeps = {
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  os: typeof import("node:os");
};

async function nodeDeps(): Promise<NodeDeps> {
  const [fs, path, os] = await Promise.all([
    import("node:fs"),
    import("node:path"),
    import("node:os"),
  ]);
  return { fs, path, os };
}

function trimmed(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function expandHome(p: string, deps: NodeDeps): string {
  return deps.path.resolve(p.replace(/^~(?=$|[\\/])/, deps.os.homedir()));
}

export function resolveHomeFromEnv(
  env: Record<string, string | undefined>,
  deps: NodeDeps,
): string {
  const override =
    trimmed(env.KOLO_HOME) ?? trimmed(env.KOLO_STATE_DIR) ?? trimmed(env.CLAWDBOT_STATE_DIR);
  if (override) {
    return expandHome(override, deps);
  }
  if (process.platform === "win32") {
    const base = trimmed(env.LOCALAPPDATA) ?? deps.path.join(deps.os.homedir(), "AppData", "Local");
    return deps.path.join(base, "KoLo");
  }
  return deps.path.join(deps.os.homedir(), ".kolo");
}

function readJson(file: string, deps: NodeDeps): unknown {
  try {
    return JSON.parse(deps.fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readTokenFile(file: string, deps: NodeDeps): string | undefined {
  try {
    return trimmed(deps.fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function validPort(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : Number.NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

/** Find the local gateway: base URL, WebSocket URL and token. Never prints or logs the token. */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredGateway> {
  const deps = await nodeDeps();
  const env = options.env ?? process.env;
  const home = options.home ? expandHome(options.home, deps) : resolveHomeFromEnv(env, deps);

  const lockRaw = readJson(deps.path.join(home, "run", "gateway.lock"), deps) as
    | { pid?: unknown; port?: unknown; startedAt?: unknown; hostname?: unknown }
    | undefined;
  const lock =
    lockRaw && typeof lockRaw === "object"
      ? {
          pid: typeof lockRaw.pid === "number" ? lockRaw.pid : undefined,
          port: validPort(lockRaw.port),
          startedAt: typeof lockRaw.startedAt === "number" ? lockRaw.startedAt : undefined,
          hostname: typeof lockRaw.hostname === "string" ? lockRaw.hostname : undefined,
        }
      : undefined;

  let baseUrl: string;
  let port: number;
  let portSource: DiscoveredGateway["portSource"];
  const urlOverride = trimmed(env.KOLO_GATEWAY_URL);
  if (urlOverride) {
    const u = new URL(urlOverride);
    baseUrl = `${u.protocol}//${u.host}`;
    port = validPort(u.port) ?? (u.protocol === "https:" ? 443 : 80);
    portSource = "url";
  } else {
    const envPort = validPort(env.KOLO_GATEWAY_PORT);
    const configPath = trimmed(env.KOLO_CONFIG_PATH) ?? deps.path.join(home, "kolo.json");
    const config =
      envPort || lock?.port
        ? undefined
        : (readJson(configPath, deps) as { gateway?: { port?: unknown } });
    const configPort = validPort(config?.gateway?.port);
    if (envPort) {
      [port, portSource] = [envPort, "env"];
    } else if (lock?.port) {
      [port, portSource] = [lock.port, "lock"];
    } else if (configPort) {
      [port, portSource] = [configPort, "config"];
    } else {
      [port, portSource] = [DEFAULT_PORT, "default"];
    }
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const ws = new URL(baseUrl);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  ws.pathname = "/";

  let token = trimmed(env.KOLO_GATEWAY_TOKEN);
  let tokenSource: DiscoveredGateway["tokenSource"] = token ? "env" : "none";
  let tokenFile: string | undefined;
  if (!token) {
    const file = trimmed(env.KOLO_GATEWAY_TOKEN_FILE);
    tokenFile = file ? expandHome(file, deps) : deps.path.join(home, "secrets", "gateway.token");
    token = readTokenFile(tokenFile, deps);
    tokenSource = token ? "file" : "none";
    if (!token) {
      tokenFile = undefined;
    }
  }
  if (!token) {
    token = trimmed(env.KOLO_GATEWAY_PASSWORD);
    tokenSource = token ? "password" : "none";
  }
  const device = findDeviceCredential(home, baseUrl, deps);
  if (!token && device && !device.expired && device.accessToken) {
    token = device.accessToken;
    tokenSource = "device";
    tokenFile = device.file;
  }

  if (!token && !device) {
    const sso = findSsoSession(home, baseUrl, deps);
    if (sso) {
      token = sso.token;
      tokenSource = "sso";
      tokenFile = sso.file;
    }
  }

  return {
    home,
    baseUrl,
    wsUrl: ws.toString(),
    port,
    portSource,
    token,
    tokenSource,
    tokenFile,
    lock,
    ...(device
      ? {
          device: {
            file: device.file,
            fingerprint: device.fingerprint,
            scope: device.scope,
            status: device.status,
            accessExpiresAt: device.accessExpiresAt,
            expired: device.expired,
          },
        }
      : {}),
  };
}

type FoundDevice = {
  file: string;
  fingerprint: string;
  scope: string;
  status: string;
  accessToken: string;
  accessExpiresAt: string;
  expired: boolean;
  updatedAt: string;
};

/** A live `kurahi login` session for this gateway (matched on base URL). */
function findSsoSession(
  home: string,
  baseUrl: string,
  deps: NodeDeps,
): { file: string; token: string } | undefined {
  const dir = deps.path.join(home, "secrets", "sessions");
  let names: string[];
  try {
    names = deps.fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  const wanted = baseUrl.replace(/\/+$/, "");
  for (const name of names) {
    const file = deps.path.join(dir, name);
    const raw = readJson(file, deps) as Record<string, unknown> | undefined;
    if (
      raw?.version === 1 &&
      raw.gateway === wanted &&
      typeof raw.token === "string" &&
      raw.token.startsWith("kss_") &&
      Date.parse(typeof raw.expiresAt === "string" ? raw.expiresAt : "") > Date.now()
    ) {
      return { file, token: raw.token };
    }
  }
  return undefined;
}

/** Newest device credential file issued by this gateway (matched on base URL). */
function findDeviceCredential(
  home: string,
  baseUrl: string,
  deps: NodeDeps,
): FoundDevice | undefined {
  const dir = deps.path.join(home, "secrets", "devices");
  let names: string[];
  try {
    names = deps.fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  const wanted = baseUrl.replace(/\/+$/, "");
  let best: FoundDevice | undefined;
  for (const name of names) {
    const file = deps.path.join(dir, name);
    const raw = readJson(file, deps) as Record<string, unknown> | undefined;
    if (!raw || raw.version !== 1 || typeof raw.fingerprint !== "string") {
      continue;
    }
    if (typeof raw.gateway === "string" && raw.gateway.replace(/\/+$/, "") !== wanted) {
      continue;
    }
    const accessExpiresAt = typeof raw.accessExpiresAt === "string" ? raw.accessExpiresAt : "";
    const exp = Date.parse(accessExpiresAt);
    const found: FoundDevice = {
      file,
      fingerprint: raw.fingerprint,
      scope: typeof raw.scope === "string" ? raw.scope : "",
      status: typeof raw.status === "string" ? raw.status : "",
      accessToken: typeof raw.accessToken === "string" ? raw.accessToken : "",
      accessExpiresAt,
      expired: !Number.isFinite(exp) || exp - 15_000 <= Date.now(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
    if (!best || found.updatedAt > best.updatedAt) {
      best = found;
    }
  }
  return best;
}
