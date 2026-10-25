// SPDX-License-Identifier: MIT
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KoloApiError,
  KoloClient,
  KoloNetworkError,
  KoloWsError,
  connectWs,
  discover,
  listOperations,
  operations,
  wsMethods,
  type WebSocketLike,
} from "../src/index.js";

type Call = { url: string; init: RequestInit };

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return await respond(call);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe("KoloClient (HTTP)", () => {
  it("exposes one method per operation", () => {
    const client = new KoloClient({ fetch: async () => json(200, {}) });
    for (const op of listOperations()) {
      expect(typeof (client as unknown as Record<string, unknown>)[op.operationId]).toBe(
        "function",
      );
    }
    expect(Object.keys(operations).length).toBe(listOperations().length);
  });

  it("calls an open route, sending the token when one is held (fuller /health body)", async () => {
    const m = mockFetch(() => json(200, { status: "healthy", readiness: "gateway_ready" }));
    const client = new KoloClient({
      baseUrl: "http://127.0.0.1:1234/",
      token: "t0k",
      fetch: m.fetch,
    });
    const health = await client.getHealth();
    expect(health.status).toBe("healthy");
    expect(m.calls[0].url).toBe("http://127.0.0.1:1234/health");
    expect(m.calls[0].init.method).toBe("GET");
    expect(header(m.calls[0], "authorization")).toBe("Bearer t0k");
  });

  it("calls an open route anonymously when no credential is held", async () => {
    const m = mockFetch(() => json(200, { status: "healthy", version: "1", uptime: 1 }));
    const client = new KoloClient({ baseUrl: "http://127.0.0.1:1234/", fetch: m.fetch });
    await client.getHealth();
    expect(header(m.calls[0], "authorization")).toBeNull();
  });

  it("sends the gateway token as Bearer on gatewayToken routes", async () => {
    const m = mockFetch(() => json(200, { openapi: "3.1.0" }));
    const client = new KoloClient({ token: "t0k", fetch: m.fetch });
    await client.getOpenApiDocument();
    expect(m.calls[0].url).toBe("http://127.0.0.1:18789/doc");
    expect(header(m.calls[0], "authorization")).toBe("Bearer t0k");
  });

  it("builds path, query and header parameters and JSON bodies", async () => {
    const m = mockFetch(() => json(200, { ok: true }));
    const client = new KoloClient({ token: "t", hookToken: "h", fetch: m.fetch });
    await client.getCovenant({ userId: "a b/c" });
    expect(m.calls[0].url).toBe("http://127.0.0.1:18789/api/admin/covenants/a%20b%2Fc");
    await client.listAuditEvents({ limit: 5, action: "x" });
    expect(m.calls[1].url).toBe("http://127.0.0.1:18789/api/admin/audit?action=x&limit=5");
    await client.invokeTool({ tool: "noop" } as never, { "X-KoLo-Message-Channel": "line" });
    expect(header(m.calls[2], "x-kolo-message-channel")).toBe("line");
    expect(header(m.calls[2], "authorization")).toBe("Bearer t");
    await client.hookWake({ text: "ping" } as never);
    expect(m.calls[3].init.method).toBe("POST");
    expect(m.calls[3].init.body).toBe('{"text":"ping"}');
    expect(header(m.calls[3], "content-type")).toBe("application/json");
    expect(header(m.calls[3], "x-kolo-token")).toBe("h");
    expect(header(m.calls[3], "authorization")).toBeNull();
  });

  it("rejects unknown and missing parameters before sending", async () => {
    const m = mockFetch(() => json(200, {}));
    const client = new KoloClient({ fetch: m.fetch });
    await expect(client.send("getCovenant", {})).rejects.toThrow(
      /missing required path parameter "userId"/,
    );
    await expect(client.send("getHealth", { params: { nope: "1" } })).rejects.toThrow(
      /unknown parameter "nope"/,
    );
    await expect(client.send("getHealth", { body: {} })).rejects.toThrow(/takes no request body/);
    await expect(client.send("noSuchOperation")).rejects.toThrow(/unknown operationId/);
    expect(m.calls).toHaveLength(0);
  });

  it("throws KoloApiError with the decoded error model", async () => {
    const m = mockFetch(() =>
      json(429, { error: { message: "slow down", type: "rate_limited" } }, { "retry-after": "7" }),
    );
    const client = new KoloClient({ token: "t", fetch: m.fetch });
    const err = await client.getMetrics().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KoloApiError);
    const api = err as KoloApiError;
    expect(api.status).toBe(429);
    expect(api.body).toEqual({ error: { message: "slow down", type: "rate_limited" } });
    expect(api.retryAfterSeconds).toBe(7);
    expect(api.message).toContain("slow down");
    const res = await client.send("getMetrics");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
  });

  it("decodes text responses", async () => {
    const m = mockFetch(
      () => new Response("kolo_up 1\n", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const client = new KoloClient({ token: "t", fetch: m.fetch });
    expect(await client.getMetrics()).toBe("kolo_up 1\n");
  });

  it("maps network failures and timeouts to KoloNetworkError", async () => {
    const down = new KoloClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.getHealth()).rejects.toBeInstanceOf(KoloNetworkError);
    const slow = new KoloClient({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(slow.getHealth()).rejects.toThrow(/timed out after 20 ms/);
  });
});

class MockSocket implements WebSocketLike {
  static last: MockSocket | undefined;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(ev: never) => void>>();
  constructor(readonly url: string) {
    MockSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", undefined as never);
    });
  }
  addEventListener(type: string, listener: (ev: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, ev: unknown) {
    for (const l of this.listeners.get(type) ?? []) {
      l(ev as never);
    }
  }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    queueMicrotask(() => this.reply(frame));
  }
  reply(frame: Record<string, unknown>) {
    const res = (payload: unknown) =>
      this.serverSend({ type: "res", id: frame.id, ok: true, payload });
    if (frame.method === "connect") {
      const auth = (frame.params as { auth?: { token?: string } }).auth;
      if (auth?.token !== "good") {
        this.serverSend({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNAUTHORIZED", message: "bad token" },
        });
        return;
      }
      res({ type: "hello-ok", protocol: 3, server: { version: "test", connId: "c1" } });
    } else if (frame.method === "health") {
      this.serverSend({ type: "event", event: "tick", payload: { ts: 1 } });
      res({ ok: true });
    } else if (frame.method === "agent") {
      res({ status: "accepted" });
      queueMicrotask(() => res({ status: "ok", text: "done" }));
    } else {
      this.serverSend({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: `unknown method ${String(frame.method)}` },
      });
    }
  }
  serverSend(frame: unknown) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    queueMicrotask(() => this.fire("close", { code, reason }));
  }
}

describe("ws() helper", () => {
  it("performs the connect handshake and calls methods", async () => {
    const client = new KoloClient({ baseUrl: "http://127.0.0.1:4321", token: "good" });
    const sock = await client.ws({
      WebSocket: MockSocket,
      client: { id: "cli", mode: "cli", version: "1" },
    });
    const mock = MockSocket.last as MockSocket;
    expect(mock.url).toBe("ws://127.0.0.1:4321/");
    const connect = mock.sent[0] as { method: string; params: Record<string, unknown> };
    expect(connect.method).toBe("connect");
    expect(connect.params).toMatchObject({
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "cli", mode: "cli", version: "1" },
      auth: { token: "good" },
    });
    expect(sock.hello.server.connId).toBe("c1");
    const ticks: unknown[] = [];
    const all: string[] = [];
    sock.on("tick", (p) => ticks.push(p));
    sock.on("*", (_p, name) => all.push(name));
    expect(await sock.call("health")).toEqual({ ok: true });
    expect(ticks).toEqual([{ ts: 1 }]);
    expect(all).toEqual(["tick"]);
    expect(await sock.call("agent", undefined, { expectFinal: true })).toEqual({
      status: "ok",
      text: "done",
    });
    const err = await sock.call("nope.method").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KoloWsError);
    expect((err as KoloWsError).code).toBe("INVALID_REQUEST");
    await expect(sock.call("connect" as never)).rejects.toThrow(/handshake/);
    sock.close();
    expect((await sock.closed).code).toBe(1000);
    await expect(sock.call("health")).rejects.toThrow(/not open/);
  });

  it("rejects a failed handshake", async () => {
    await expect(
      connectWs({ url: "ws://x/", token: "bad", WebSocket: MockSocket }),
    ).rejects.toThrow(/UNAUTHORIZED: bad token/);
  });

  it("knows the spec's WebSocket methods", () => {
    expect(wsMethods).toContain("health");
    expect(wsMethods).toContain("sessions.list");
    expect(wsMethods as readonly string[]).not.toContain("connect");
  });
});

describe("discover()", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  const makeHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-client-home-"));
    dirs.push(home);
    fs.mkdirSync(path.join(home, "run"));
    fs.mkdirSync(path.join(home, "secrets"));
    return home;
  };

  it("reads the port from the lease and the token from the token file", async () => {
    const home = makeHome();
    fs.writeFileSync(
      path.join(home, "run", "gateway.lock"),
      JSON.stringify({ pid: 42, port: 18877, startedAt: 1, hostname: "h" }),
    );
    fs.writeFileSync(path.join(home, "secrets", "gateway.token"), "file-token\n");
    const found = await discover({ env: { KOLO_HOME: home } });
    expect(found).toMatchObject({
      home,
      baseUrl: "http://127.0.0.1:18877",
      wsUrl: "ws://127.0.0.1:18877/",
      port: 18877,
      portSource: "lock",
      token: "file-token",
      tokenSource: "file",
      lock: { pid: 42, port: 18877 },
    });
    const viaStateDir = await discover({ env: { KOLO_STATE_DIR: home } });
    expect(viaStateDir.port).toBe(18877);
  });

  it("lets env override port and token, and falls back to config then the default", async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, "run", "gateway.lock"), JSON.stringify({ port: 18877 }));
    fs.writeFileSync(path.join(home, "secrets", "gateway.token"), "file-token");
    const env = await discover({
      env: { KOLO_HOME: home, KOLO_GATEWAY_PORT: "18866", KOLO_GATEWAY_TOKEN: "env-token" },
    });
    expect(env).toMatchObject({
      port: 18866,
      portSource: "env",
      token: "env-token",
      tokenSource: "env",
    });
    const alt = path.join(home, "alt.token");
    fs.writeFileSync(alt, "alt-token");
    expect((await discover({ env: { KOLO_HOME: home, KOLO_GATEWAY_TOKEN_FILE: alt } })).token).toBe(
      "alt-token",
    );
    const url = await discover({
      env: { KOLO_HOME: home, KOLO_GATEWAY_URL: "https://gw.example:8443/x" },
    });
    expect(url).toMatchObject({
      baseUrl: "https://gw.example:8443",
      wsUrl: "wss://gw.example:8443/",
      portSource: "url",
    });

    const bare = makeHome();
    fs.writeFileSync(path.join(bare, "kolo.json"), JSON.stringify({ gateway: { port: 18855 } }));
    expect(await discover({ env: { KOLO_HOME: bare } })).toMatchObject({
      port: 18855,
      portSource: "config",
      tokenSource: "none",
    });
    const empty = makeHome();
    expect(await discover({ env: { KOLO_HOME: empty } })).toMatchObject({
      port: 18789,
      portSource: "default",
    });
  });

  it("KoloClient.local() uses the discovered gateway", async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, "run", "gateway.lock"), JSON.stringify({ port: 18871 }));
    fs.writeFileSync(path.join(home, "secrets", "gateway.token"), "tok");
    const m = mockFetch(() => json(200, {}));
    const client = await KoloClient.local({
      fetch: m.fetch,
      discover: { env: { KOLO_HOME: home } },
    });
    expect(client.discovered.portSource).toBe("lock");
    await client.getOpenApiDocument();
    expect(m.calls[0].url).toBe("http://127.0.0.1:18871/doc");
    expect(header(m.calls[0], "authorization")).toBe("Bearer tok");
    // No break-glass header unless KOLO_BREAK_GLASS states a reason.
    expect(header(m.calls[0], "x-kolo-break-glass")).toBeNull();
  });

  it("KoloClient.local() sends KOLO_BREAK_GLASS with the owner token (percent-encoded)", async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, "run", "gateway.lock"), JSON.stringify({ port: 18872 }));
    fs.writeFileSync(path.join(home, "secrets", "gateway.token"), "tok");
    const m = mockFetch(() => json(200, {}));
    const client = await KoloClient.local({
      fetch: m.fetch,
      discover: { env: { KOLO_HOME: home, KOLO_BREAK_GLASS: "IdP 障害 #42" } },
    });
    await client.getOpenApiDocument();
    expect(header(m.calls[0], "x-kolo-break-glass")).toBe(encodeURIComponent("IdP 障害 #42"));
  });
});
