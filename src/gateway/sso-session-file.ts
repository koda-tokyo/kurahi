// Person sessions the command line signed in with (`kurahi login`, device authorization grant).
//
// One file per gateway under `<KOLO_HOME>/secrets/sessions/` (directory 0700, files 0600,
// written atomically), matched on the gateway's base URL like paired device credentials. The
// file holds the `kss_` session token; nothing prints it. Gateway RPC from the command line
// (`callGatewayFromCli`) uses a live stored session ahead of the shared token, so a signed-in
// person acts as themselves; `kurahi logout` ends the session and removes the file.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { koloSecretsDir, resolveKoloHome } from "../config/kolo-home.js";

export const SSO_SESSIONS_DIRNAME = "sessions";

export type StoredSsoSession = {
  version: 1;
  /** Gateway base URL (http/https origin) the session belongs to. */
  gateway: string;
  token: string;
  sessionId: string;
  expiresAt: string;
  principal: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
};

/** `ws://host:port/x` or `http://host:port/` → `http://host:port` (wss → https). */
export function gatewayBaseUrl(raw: string): string {
  const u = new URL(raw);
  const protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`not a gateway URL: ${u.protocol}`);
  }
  return `${protocol}//${u.host}`;
}

export function ssoSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveKoloHome({ env }), "secrets", SSO_SESSIONS_DIRNAME);
}

export function ssoSessionFilePath(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const id = createHash("sha256").update(gatewayBaseUrl(baseUrl)).digest("hex").slice(0, 16);
  return path.join(ssoSessionsDir(env), `${id}.json`);
}

/** The stored session for a gateway, unless missing, unreadable or past its end. */
export function readSsoSession(
  baseUrl: string,
  opts: { env?: NodeJS.ProcessEnv; now?: number; includeExpired?: boolean } = {},
): (StoredSsoSession & { file: string }) | undefined {
  let file: string;
  try {
    file = ssoSessionFilePath(baseUrl, opts.env);
  } catch {
    return undefined;
  }
  let parsed: Partial<StoredSsoSession>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSsoSession>;
  } catch {
    return undefined;
  }
  if (
    parsed?.version !== 1 ||
    typeof parsed.token !== "string" ||
    !parsed.token.startsWith("kss_") ||
    parsed.gateway !== gatewayBaseUrl(baseUrl)
  ) {
    return undefined;
  }
  const end = Date.parse(parsed.expiresAt ?? "");
  if (!opts.includeExpired && !(end > (opts.now ?? Date.now()))) {
    return undefined;
  }
  return { ...(parsed as StoredSsoSession), file };
}

/** Write (replace) the session file for its gateway: 0600, atomically. Returns the path. */
export function writeSsoSession(
  session: StoredSsoSession,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const file = ssoSessionFilePath(session.gateway, env);
  koloSecretsDir(resolveKoloHome({ env }));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(tmp, 0o600);
  }
  fs.renameSync(tmp, file);
  return file;
}

export function removeSsoSession(baseUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = ssoSessionFilePath(baseUrl, env);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}
