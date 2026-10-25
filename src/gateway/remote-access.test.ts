import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  applyAuthAttemptGate,
  isRemoteUpgradeAuthorized,
  rejectUnauthenticatedRemoteRequest,
} from "./http-remote-auth.js";
import { AuthAttemptLimiter } from "./rate-limiter.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const TOKEN = "fake-gateway-token-for-tests-000000";

describe("gateway bind: loopback by default, remote is opt-in", () => {
  const base = {
    port: 18861,
    auth: { mode: "token" as const, token: TOKEN, tokenFile: false as const },
  };

  it("binds loopback by default", async () => {
    const rc = await resolveGatewayRuntimeConfig({ cfg: {}, ...base });
    expect(rc.bindHost).toBe("127.0.0.1");
    expect(rc.remoteEnabled).toBe(false);
  });

  it("refuses a non-loopback bind without gateway.remote.enabled", async () => {
    await expect(
      resolveGatewayRuntimeConfig({ cfg: { gateway: { bind: "lan" } }, ...base }),
    ).rejects.toThrow(/remote access is off.*gateway\.remote\.enabled=true/);
    await expect(
      resolveGatewayRuntimeConfig({ cfg: {}, ...base, host: "0.0.0.0" }),
    ).rejects.toThrow(/refusing to bind gateway to 0\.0\.0\.0/);
  });

  it("allows a non-loopback bind once remote is enabled, still requiring auth", async () => {
    const rc = await resolveGatewayRuntimeConfig({
      cfg: { gateway: { bind: "lan", remote: { enabled: true } } },
      ...base,
    });
    expect(rc.bindHost).toBe("0.0.0.0");
    expect(rc.remoteEnabled).toBe(true);
    await expect(
      resolveGatewayRuntimeConfig({
        cfg: { gateway: { bind: "lan", remote: { enabled: true } } },
        port: 18862,
        auth: { mode: "password", tokenFile: false },
      }),
    ).rejects.toThrow(/password/);
  });

  it("refuses tailscale funnel without the remote opt-in", async () => {
    await expect(
      resolveGatewayRuntimeConfig({
        cfg: { gateway: { tailscale: { mode: "funnel" } } },
        port: 18863,
        auth: { mode: "password", password: "fake-password", tokenFile: false },
      }),
    ).rejects.toThrow(/funnel.*remote\.enabled/);
  });
});

describe("AuthAttemptLimiter (sliding window)", () => {
  it("allows 20 attempts per minute per source, then 429 with retry-after; window slides", () => {
    let now = 1_000_000;
    const limiter = new AuthAttemptLimiter(20, 60_000, () => now);
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume("203.0.113.9").allowed).toBe(true);
      now += 1000; // 20 attempts spread over 20 s
    }
    const blocked = limiter.consume("203.0.113.9");
    expect(blocked.allowed).toBe(false);
    // Oldest attempt was at 1_000_000, so it frees at 1_060_000; now = 1_020_000.
    expect(blocked.retryAfterMs).toBe(40_000);
    expect(limiter.consume("198.51.100.1").allowed).toBe(true); // other sources unaffected
    now += 40_000;
    expect(limiter.consume("203.0.113.9").allowed).toBe(true); // one slot slid free
    expect(limiter.consume("203.0.113.9").allowed).toBe(false);
  });
});

function mockReq(params: {
  ip: string;
  url: string;
  method?: string;
  host?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    url: params.url,
    method: params.method ?? "GET",
    headers: { host: params.host ?? "gateway.example.invalid", ...params.headers },
    socket: { remoteAddress: params.ip },
  } as unknown as IncomingMessage;
}

function mockRes() {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      Object.assign(res.headers, headers ?? {});
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    end(body?: string) {
      res.body = body ?? "";
      emitter.emit("finish");
    },
  });
  return res as unknown as ServerResponse & { headers: Record<string, string>; body: string };
}

describe("auth-bearing HTTP endpoints", () => {
  it("rate limits /api/auth/* logins at 20/min with 429 + Retry-After", () => {
    const limiter = new AuthAttemptLimiter();
    for (let i = 0; i < 20; i += 1) {
      const res = mockRes();
      const req = mockReq({ ip: "203.0.113.7", url: "/api/auth/redeem", method: "POST" });
      expect(applyAuthAttemptGate(req, res, { limiter })).toBe(false);
    }
    const res = mockRes();
    const req = mockReq({ ip: "203.0.113.7", url: "/api/auth/redeem", method: "POST" });
    expect(applyAuthAttemptGate(req, res, { limiter })).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("counts failed token checks (401/403), not successful ones", () => {
    const limiter = new AuthAttemptLimiter(3, 60_000);
    const ip = "198.51.100.20";
    for (let i = 0; i < 10; i += 1) {
      const res = mockRes();
      applyAuthAttemptGate(mockReq({ ip, url: "/tools/invoke", method: "POST" }), res, { limiter });
      res.statusCode = 200;
      res.end();
    }
    expect(limiter.check(ip).allowed).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      const res = mockRes();
      applyAuthAttemptGate(mockReq({ ip, url: "/tools/invoke", method: "POST" }), res, { limiter });
      res.statusCode = 401;
      res.end();
    }
    const res = mockRes();
    expect(
      applyAuthAttemptGate(mockReq({ ip, url: "/tools/invoke", method: "POST" }), res, { limiter }),
    ).toBe(true);
    expect(res.statusCode).toBe(429);
  });

  it("does not limit local direct requests or plain public routes", () => {
    const limiter = new AuthAttemptLimiter(1, 60_000);
    for (let i = 0; i < 5; i += 1) {
      const local = mockReq({
        ip: "127.0.0.1",
        url: "/api/auth/redeem",
        method: "POST",
        host: "127.0.0.1",
      });
      expect(applyAuthAttemptGate(local, mockRes(), { limiter })).toBe(false);
      const pub = mockReq({ ip: "203.0.113.1", url: "/index.html" });
      expect(applyAuthAttemptGate(pub, mockRes(), { limiter })).toBe(false);
    }
  });
});

describe("routes that used to be open", () => {
  const auth: ResolvedGatewayAuth = { mode: "token", token: TOKEN, allowTailscale: false };

  it("canvas/A2UI/avatars require gateway auth for non-local clients", async () => {
    for (const url of ["/__KOLO__/canvas/index.html", "/__KOLO__/a2ui/app.js", "/avatar/main"]) {
      const res = mockRes();
      expect(
        await rejectUnauthenticatedRemoteRequest(mockReq({ ip: "203.0.113.5", url }), res, {
          auth,
        }),
      ).toBe(true);
      expect(res.statusCode).toBe(401);
      const ok = mockReq({ ip: "203.0.113.5", url, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(await rejectUnauthenticatedRemoteRequest(ok, mockRes(), { auth })).toBe(false);
      const local = mockReq({ ip: "127.0.0.1", url, host: "localhost" });
      expect(await rejectUnauthenticatedRemoteRequest(local, mockRes(), { auth })).toBe(false);
    }
  });

  it("with ssoRequired the gateway token no longer opens them from another host; an SSO session does", async () => {
    const url = "/__KOLO__/canvas/index.html";
    const withToken = (headers: Record<string, string> = {}) =>
      mockReq({
        ip: "203.0.113.5",
        url,
        headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      });
    const res = mockRes();
    expect(
      await rejectUnauthenticatedRemoteRequest(withToken({ "x-kolo-break-glass": "x" }), res, {
        auth,
        ssoRequired: true,
      }),
    ).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(
      await rejectUnauthenticatedRemoteRequest(withToken(), mockRes(), {
        auth,
        ssoRequired: true,
        ssoSession: () => true,
      }),
    ).toBe(false);
    const upgrade = await isRemoteUpgradeAuthorized(withToken(), auth, [], { ssoRequired: true });
    expect(upgrade).toBe(false);
    expect(await isRemoteUpgradeAuthorized(withToken(), auth, [])).toBe(true);
  });

  it("health stays open", async () => {
    for (const url of ["/health", "/api/health"]) {
      const res = mockRes();
      expect(
        await rejectUnauthenticatedRemoteRequest(mockReq({ ip: "203.0.113.5", url }), res, {
          auth,
        }),
      ).toBe(false);
    }
  });
});
