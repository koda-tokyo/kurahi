// `kurahi login` / `kurahi logout` / `kurahi whoami` — company sign-in for the command line.
//
//   kurahi login [--url <gateway>] [--no-open] [--device-name x] [--json]
//   kurahi logout [--url <gateway>] [--json]
//   kurahi whoami [--url <gateway>] [--json]
//
// Login runs the OAuth 2.0 device authorization grant (RFC 8628) against the gateway: it prints
// a short code and a link, the person signs in with the company's SSO in any browser (this
// machine or another), checks the code and approves, and the command line gets its own `kss_`
// person session. The token goes to `<KOLO_HOME>/secrets/sessions/` (0600) and is never printed;
// gateway commands then act as that person. No IdP secret is involved on this machine.
//
// Top-level verbs like `gh auth login` / `az login`: `kurahi gateway …` runs the service and
// `kurahi models auth …` signs in to model providers, so neither group fits a person sign-in.
import type { Command } from "commander";
import os from "node:os";
import { loadConfig } from "../config/config.js";
import { CLI_CLIENT_ID } from "../config/zod-schema.identity.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import {
  gatewayBaseUrl,
  readSsoSession,
  removeSsoSession,
  writeSsoSession,
} from "../gateway/sso-session-file.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

export const LOGIN_EXIT = { ok: 0, error: 1, usage: 2, unreachable: 3 } as const;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type LoginDeps = {
  runtime?: RuntimeEnv;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Open the verification link in a browser; false when it could not. */
  openUrl?: (url: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The gateway base URL when --url is not given (default: the configured gateway). */
  defaultBaseUrl?: () => string;
};

type CommonOpts = { url?: string; json?: boolean };

class LoginError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = LOGIN_EXIT.error,
  ) {
    super(message);
  }
}

function resolveBaseUrl(opts: CommonOpts, deps: LoginDeps): string {
  const raw =
    opts.url?.trim() ||
    (deps.defaultBaseUrl ?? (() => buildGatewayConnectionDetails({ config: loadConfig() }).url))();
  try {
    return gatewayBaseUrl(raw);
  } catch {
    throw new LoginError(`not a gateway URL: ${raw}`, LOGIN_EXIT.usage);
  }
}

async function request(
  deps: LoginDeps,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as Fetch);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new LoginError(
      `gateway unreachable at ${new URL(url).origin}: ${err instanceof Error ? err.message : String(err)}`,
      LOGIN_EXIT.unreachable,
    );
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(o).toString(),
});

const oauthText = (body: Record<string, unknown>) =>
  [body.error, body.error_description].filter((x) => typeof x === "string").join(": ") ||
  "unexpected response";

type SessionInfo = {
  principal: string;
  email: string | null;
  displayName: string | null;
  roles: Array<{ role: string; unit: string | null }>;
  scope: string;
  sessionId: string;
  expiresAt: string;
};

async function fetchSession(
  deps: LoginDeps,
  baseUrl: string,
  token: string,
): Promise<SessionInfo | null> {
  const r = await request(deps, `${baseUrl}/api/identity/session`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (r.status !== 200) {
    return null;
  }
  const b = r.body as {
    principal?: string;
    person?: { email?: string | null; displayName?: string | null };
    roles?: Array<{ role: string; unit: string | null }>;
    scope?: string;
    session?: { id?: string; expiresAt?: string };
  };
  return {
    principal: b.principal ?? "",
    email: b.person?.email ?? null,
    displayName: b.person?.displayName ?? null,
    roles: b.roles ?? [],
    scope: b.scope ?? "",
    sessionId: b.session?.id ?? "",
    expiresAt: b.session?.expiresAt ?? "",
  };
}

const who = (s: { displayName: string | null; email: string | null; principal: string }) =>
  s.displayName && s.email
    ? `${s.displayName} <${s.email}>`
    : (s.displayName ?? s.email ?? s.principal);

export async function runLogin(
  opts: CommonOpts & { open?: boolean; deviceName?: string },
  deps: LoginDeps = {},
): Promise<void> {
  const runtime = deps.runtime ?? defaultRuntime;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const baseUrl = resolveBaseUrl(opts, deps);
  const deviceName =
    opts.deviceName?.trim() ||
    `${(() => {
      try {
        return os.userInfo().username;
      } catch {
        return "user";
      }
    })()}@${os.hostname()}`;

  const start = await request(
    deps,
    `${baseUrl}/api/identity/oauth/device`,
    form({ client_id: CLI_CLIENT_ID, device_name: deviceName }),
  );
  const d = start.body as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (start.status !== 200 || !d.device_code || !d.user_code || !d.verification_uri) {
    throw new LoginError(
      start.status === 404
        ? "this gateway does not offer command-line sign-in (update it, or check gateway.identity)"
        : `sign-in could not start: ${oauthText(start.body)}`,
    );
  }
  // With --json the prompt goes to stderr so stdout stays one JSON document.
  const say = opts.json ? runtime.error : runtime.log;
  const link = d.verification_uri_complete ?? d.verification_uri;
  say(`To sign in, open ${theme.command(link)}`);
  say(`and check that the page shows the code ${theme.heading(d.user_code)}`);
  if (opts.open !== false) {
    const opened = await (deps.openUrl ?? defaultOpenUrl)(link).catch(() => false);
    if (opened) {
      say(theme.muted("(opened in your browser)"));
    }
  }
  say(theme.muted("Waiting for approval…"));

  let interval = Math.max(1, d.interval ?? 5) * 1000;
  const deadline = now() + Math.min(Math.max(d.expires_in ?? 600, 1), 1800) * 1000;
  // Bounded: the deadline, and a hard cap on polls whatever the clock does.
  for (let polls = 0; polls < 400 && now() < deadline; polls += 1) {
    await sleep(interval);
    const t = await request(
      deps,
      `${baseUrl}/api/identity/oauth/token`,
      form({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLI_CLIENT_ID }),
    );
    const error = typeof t.body.error === "string" ? t.body.error : null;
    if (t.status === 200 && typeof t.body.access_token === "string") {
      const token = t.body.access_token;
      const info = await fetchSession(deps, baseUrl, token);
      if (!info) {
        throw new LoginError("signed in, but the gateway did not accept the new session");
      }
      const file = writeSsoSession(
        {
          version: 1,
          gateway: baseUrl,
          token,
          sessionId: info.sessionId,
          expiresAt: info.expiresAt,
          principal: info.principal,
          email: info.email,
          displayName: info.displayName,
          createdAt: new Date(now()).toISOString(),
        },
        deps.env,
      );
      if (opts.json) {
        runtime.log(
          JSON.stringify({
            ok: true,
            gateway: baseUrl,
            principal: info.principal,
            email: info.email,
            displayName: info.displayName,
            sessionId: info.sessionId,
            expiresAt: info.expiresAt,
            file,
          }),
        );
        return;
      }
      runtime.log(`${theme.success("Signed in")} as ${who(info)} → ${baseUrl}`);
      runtime.log(`  session  ${info.sessionId} (until ${info.expiresAt})`);
      runtime.log(`  stored   ${file}`);
      return;
    }
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      const next = typeof t.body.interval === "number" ? t.body.interval * 1000 : interval + 5000;
      interval = Math.max(interval + 5000, next);
      continue;
    }
    if (error === "access_denied") {
      throw new LoginError("sign-in was denied (or the code was locked); nothing was stored");
    }
    if (error === "expired_token") {
      throw new LoginError(`the code expired; run ${formatCliCommand("kurahi login")} again`);
    }
    throw new LoginError(`sign-in failed: ${oauthText(t.body)}`);
  }
  throw new LoginError(`the code expired; run ${formatCliCommand("kurahi login")} again`);
}

async function defaultOpenUrl(url: string): Promise<boolean> {
  const mod = await import("../commands/onboard-helpers.js");
  return await mod.openUrl(url);
}

export async function runLogout(opts: CommonOpts, deps: LoginDeps = {}): Promise<void> {
  const runtime = deps.runtime ?? defaultRuntime;
  const baseUrl = resolveBaseUrl(opts, deps);
  const stored = readSsoSession(baseUrl, { env: deps.env, includeExpired: true });
  if (!stored) {
    runtime.log(opts.json ? JSON.stringify({ ok: true, signedOut: false }) : "Not signed in.");
    return;
  }
  let ended = false;
  try {
    const r = await request(deps, `${baseUrl}/api/identity/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${stored.token}`, accept: "application/json" },
    });
    ended = r.status === 200;
  } catch {
    ended = false;
  }
  removeSsoSession(baseUrl, deps.env);
  if (opts.json) {
    runtime.log(JSON.stringify({ ok: true, signedOut: true, sessionEnded: ended }));
    return;
  }
  runtime.log(
    ended
      ? `${theme.success("Signed out")}: session ${stored.sessionId} ended.`
      : `Signed out locally (the gateway did not confirm ending session ${stored.sessionId}; an admin can revoke it).`,
  );
}

export async function runWhoami(opts: CommonOpts, deps: LoginDeps = {}): Promise<void> {
  const runtime = deps.runtime ?? defaultRuntime;
  const baseUrl = resolveBaseUrl(opts, deps);
  const stored = readSsoSession(baseUrl, { env: deps.env, now: (deps.now ?? Date.now)() });
  if (!stored) {
    throw new LoginError(`not signed in to ${baseUrl}; run ${formatCliCommand("kurahi login")}`);
  }
  const info = await fetchSession(deps, baseUrl, stored.token);
  if (!info) {
    removeSsoSession(baseUrl, deps.env);
    throw new LoginError(
      `the session has ended (revoked, idle or expired); run ${formatCliCommand("kurahi login")}`,
    );
  }
  if (opts.json) {
    runtime.log(JSON.stringify({ ok: true, gateway: baseUrl, ...info }));
    return;
  }
  runtime.log(`${who(info)} (${info.principal}) → ${baseUrl}`);
  runtime.log(
    `  roles    ${info.roles.map((r) => (r.unit ? `${r.role}@${r.unit}` : r.role)).join(", ") || "-"}`,
  );
  runtime.log(`  scope    ${info.scope}`);
  runtime.log(`  session  ${info.sessionId} (until ${info.expiresAt})`);
}

function fail(runtime: RuntimeEnv, err: unknown, json?: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof LoginError ? err.exitCode : LOGIN_EXIT.error;
  runtime.error(json ? JSON.stringify({ ok: false, error: message }) : message);
  return runtime.exit(code);
}

const urlOption = "Gateway URL (http(s) or ws(s); default: the configured gateway)";

export function registerLoginCommand(program: Command, deps: LoginDeps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  program
    .command("login")
    .description("Sign in with your company account (SSO) for this command line")
    .option("--url <url>", urlOption)
    .option("--no-open", "Do not open the browser; just print the link")
    .option("--device-name <name>", "How this machine is shown to you when approving")
    .option("--json", "Print JSON", false)
    .action(async (opts: { url?: string; open?: boolean; deviceName?: string; json?: boolean }) => {
      try {
        await runLogin(opts, deps);
      } catch (err) {
        fail(runtime, err, opts.json);
      }
    });
}

export function registerLogoutCommand(program: Command, deps: LoginDeps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  program
    .command("logout")
    .description("End this command line's SSO session and forget it")
    .option("--url <url>", urlOption)
    .option("--json", "Print JSON", false)
    .action(async (opts: CommonOpts) => {
      try {
        await runLogout(opts, deps);
      } catch (err) {
        fail(runtime, err, opts.json);
      }
    });
}

export function registerWhoamiCommand(program: Command, deps: LoginDeps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  program
    .command("whoami")
    .description("Show the person this command line is signed in as")
    .option("--url <url>", urlOption)
    .option("--json", "Print JSON", false)
    .action(async (opts: CommonOpts) => {
      try {
        await runWhoami(opts, deps);
      } catch (err) {
        fail(runtime, err, opts.json);
      }
    });
}
