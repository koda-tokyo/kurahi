import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { readSsoSession, ssoSessionFilePath } from "../gateway/sso-session-file.js";
import { resolveIdentitySettings } from "../identity/config.js";
import {
  authorizeSsoSession,
  createSsoHttpHandlers,
  setHttpPersonForTest,
} from "../identity/http.js";
import { createNativeSignInHandlers } from "../identity/native-http.js";
import { IdentityService } from "../identity/service.js";
import { SessionStore } from "../identity/sessions.js";
import { IdentityStore } from "../identity/store.js";
import { LOGIN_EXIT, runLogin, runLogout, runWhoami } from "./login-cli.js";

const BASE = "https://gateway.example.test";
const homes: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const runtime: RuntimeEnv = {
    log: (...a: unknown[]) => void out.push(a.join(" ")),
    error: (...a: unknown[]) => void err.push(a.join(" ")),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
  return { out, err, runtime };
}

/** A gateway behind fetch: the real identity handlers, no network. */
function stubGateway() {
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: BASE,
      providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" }],
      defaultRole: "member",
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
    },
  );
  const native = createNativeSignInHandlers({ service: () => svc, attemptKey: () => null });
  const sso = createSsoHttpHandlers({ service: () => svc, attemptKey: () => null });
  const browser = svc.signIn({
    providerId: "corp",
    protocol: "oidc",
    issuer: "https://idp.example.test",
    subject: "sub-1",
    email: "alice@example.com",
    emailVerified: true,
    displayName: "Alice",
    givenName: null,
    familyName: null,
    groups: [],
    idTokenHint: null,
    auth: { at: new Date().toISOString(), methods: ["pwd"], context: null },
  });
  if (!browser.ok) {
    throw new Error("sign-in failed");
  }
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? "GET"} ${u.pathname}`);
    const req = Readable.from([Buffer.from(String(init.body ?? ""))]) as unknown as IncomingMessage;
    req.headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    req.method = init.method ?? "GET";
    let status = 0;
    let body = "";
    const res = {
      setHeader: () => {},
      set statusCode(v: number) {
        status = v;
      },
      get statusCode() {
        return status;
      },
      end: (b?: string) => {
        body = b ?? "";
      },
    } as unknown as ServerResponse;
    const person = (operationId: string) =>
      authorizeSsoSession(req, { operationId, minScope: "observe" }, svc) === true;
    switch (u.pathname) {
      case "/api/identity/oauth/device":
        await native.deviceAuthorization(req, res);
        break;
      case "/api/identity/oauth/token":
        await native.token(req, res);
        break;
      case "/api/identity/session":
        if (person("getIdentitySession")) {
          sso.getIdentitySession(req, res);
        } else {
          status = 401;
        }
        break;
      case "/api/identity/logout":
        if (person("logoutIdentity")) {
          await sso.logoutIdentity(req, res);
        } else {
          status = 401;
        }
        break;
      default:
        status = 404;
    }
    return new Response(body || "{}", { status });
  };
  /** The person approves in the browser. */
  const approve = async (userCode: string, ok = true) => {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ user_code: userCode, approve: ok })),
    ]) as unknown as IncomingMessage;
    req.headers = { "content-type": "application/json" };
    setHttpPersonForTest(req, browser.principal);
    await native.decideDeviceCode(req, { setHeader: () => {}, end: () => {} } as never);
  };
  return { svc, fetch, approve, calls };
}

function tempEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-login-"));
  homes.push(home);
  return { KOLO_HOME: home } as NodeJS.ProcessEnv;
}

describe("kurahi login / whoami / logout", () => {
  it("signs in with the device flow, stores the session 0600 and never prints the token", async () => {
    const gw = stubGateway();
    const env = tempEnv();
    const io = capture();
    let code = "";
    const runtime: RuntimeEnv = {
      ...io.runtime,
      log: (...a: unknown[]) => {
        const line = a.join(" ");
        code ||= /user_code=([A-Z-]{9})/.exec(line)?.[1] ?? "";
        io.out.push(line);
      },
    };
    let sleeps = 0;
    await runLogin(
      { url: BASE, open: false, deviceName: "alice@build-01" },
      {
        runtime,
        fetch: gw.fetch,
        env,
        // The first poll is still pending; the person approves before the second.
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) {
            await gw.approve(code);
          }
        },
      },
    );
    expect(gw.calls.filter((c) => c === "POST /api/identity/oauth/token")).toHaveLength(2);
    const printed = io.out.join("\n");
    expect(printed).toContain(`${BASE}/api/identity/device?user_code=${code}`);
    expect(printed).toContain("Signed in");
    expect(printed).toContain("Alice <alice@example.com>");
    expect(printed).not.toContain("kss_");
    const stored = readSsoSession(BASE, { env });
    expect(stored?.token).toMatch(/^kss_/);
    // POSIX modes only; on Windows the file sits in the user's profile, protected by its ACL.
    if (process.platform !== "win32") {
      expect(fs.statSync(ssoSessionFilePath(BASE, env)).mode & 0o777).toBe(0o600);
    }
    const session = gw.svc.sessions.get(stored?.sessionId ?? "");
    expect(session?.client?.label).toBe("CLI: Kurahi CLI (alice@build-01)");

    const w = capture();
    await runWhoami({ url: BASE }, { runtime: w.runtime, fetch: gw.fetch, env });
    expect(w.out.join("\n")).toContain("Alice <alice@example.com>");
    expect(w.out.join("\n")).not.toContain("kss_");

    const o = capture();
    await runLogout({ url: BASE }, { runtime: o.runtime, fetch: gw.fetch, env });
    expect(o.out.join("\n")).toContain("Signed out");
    expect(session?.revokedReason).toBe("logout");
    expect(readSsoSession(BASE, { env })).toBeUndefined();
    await expect(
      runWhoami({ url: BASE }, { runtime: capture().runtime, fetch: gw.fetch, env }),
    ).rejects.toThrow(/not signed in/);
  });

  it("forgets a session the gateway ended", async () => {
    const gw = stubGateway();
    const env = tempEnv();
    let code = "";
    const io = capture();
    const runtime: RuntimeEnv = {
      ...io.runtime,
      log: (...a: unknown[]) => {
        const line = a.join(" ");
        code ||= /user_code=([A-Z-]{9})/.exec(line)?.[1] ?? "";
      },
    };
    await runLogin(
      { url: BASE, open: false },
      { runtime, fetch: gw.fetch, env, sleep: async () => void (await gw.approve(code)) },
    );
    const stored = readSsoSession(BASE, { env });
    gw.svc.sessions.revoke(stored?.sessionId ?? "", "admin");
    await expect(
      runWhoami({ url: BASE }, { runtime: capture().runtime, fetch: gw.fetch, env }),
    ).rejects.toThrow(/session has ended/);
    expect(readSsoSession(BASE, { env, includeExpired: true })).toBeUndefined();
  });

  it("reports a denial and stores nothing", async () => {
    const gw = stubGateway();
    const env = tempEnv();
    const io = capture();
    let code = "";
    const runtime: RuntimeEnv = {
      ...io.runtime,
      log: (...a: unknown[]) => {
        const line = a.join(" ");
        code ||= /user_code=([A-Z-]{9})/.exec(line)?.[1] ?? "";
        io.out.push(line);
      },
    };
    await expect(
      runLogin(
        { url: BASE, open: false },
        { runtime, fetch: gw.fetch, env, sleep: async () => void (await gw.approve(code, false)) },
      ),
    ).rejects.toThrow(/denied/);
    expect(readSsoSession(BASE, { env })).toBeUndefined();
  });

  it("says when the gateway is unreachable", async () => {
    const env = tempEnv();
    const err = await runLogin(
      { url: "ws://127.0.0.1:1", open: false },
      {
        runtime: capture().runtime,
        env,
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    ).catch((e: unknown) => e as { exitCode?: number; message: string });
    expect(err?.exitCode).toBe(LOGIN_EXIT.unreachable);
    expect(err?.message).toContain("http://127.0.0.1:1");
  });
});
