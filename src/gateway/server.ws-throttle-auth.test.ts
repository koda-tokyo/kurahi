import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { resetRateLimiters, WS_CONNECTIONS_PER_MINUTE } from "./rate-limiter.js";
import { connectReq, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

// Agent tools and the CLI open one gateway connection per call. A connection that completes an
// authenticated handshake gives its slot back, so they are not throttled; a connection that never
// authenticates keeps counting, even when it comes from loopback with Host: localhost (a same-host
// reverse proxy, SSH tunnel or socat forward makes remote clients look exactly like that).

installGatewayTestHooks({ scope: "suite" });

const TOKEN = "test-gateway-token-ws-throttle-0123456789";
let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let first: WebSocket;
let port: number;

beforeAll(async () => {
  const started = await startServerWithClient(TOKEN);
  server = started.server;
  first = started.ws;
  port = started.port;
});

afterAll(async () => {
  first.close();
  await server.close();
});

type Attempt = "ok" | "denied" | "throttled";

/** Open a connection and run the connect handshake with `token`. */
function attempt(token: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const done = (result: Attempt) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
      ws.close();
    };
    ws.on("error", () => {});
    // The throttle completes the upgrade and closes with 1013 before any frame.
    ws.once("close", (code) => done(code === 1013 ? "throttled" : "denied"));
    ws.once("open", () => {
      connectReq(ws, { token, ...(token === TOKEN ? {} : { device: null }) })
        .then((res) => done(res.ok ? "ok" : "denied"))
        .catch((err: unknown) => done(/closed 1013/.test(String(err)) ? "throttled" : "denied"));
    });
  });
}

describe("per-address WS connection throttle", () => {
  test("authenticated connections give their slot back", { timeout: 60_000 }, async () => {
    resetRateLimiters();
    // More sequential authenticated calls than the per-minute budget, as an agent's tools make.
    for (let i = 0; i < WS_CONNECTIONS_PER_MINUTE + 5; i++) {
      expect(await attempt(TOKEN), `connection ${i}`).toBe("ok");
    }
  });

  test(
    "unauthenticated loopback connections (Host: localhost) stay throttled",
    { timeout: 60_000 },
    async () => {
      resetRateLimiters();
      const results: Attempt[] = [];
      for (let i = 0; i < WS_CONNECTIONS_PER_MINUTE + 2; i++) {
        // A wrong token: the handshake fails and the slot stays counted.
        results.push(await attempt("wrong-token"));
      }
      expect(results.slice(0, WS_CONNECTIONS_PER_MINUTE)).toEqual(
        Array(WS_CONNECTIONS_PER_MINUTE).fill("denied"),
      );
      expect(results.slice(WS_CONNECTIONS_PER_MINUTE)).toEqual(["throttled", "throttled"]);
      // The budget is spent: even a client that would authenticate waits for the window.
      expect(await attempt(TOKEN)).toBe("throttled");
    },
  );
});
