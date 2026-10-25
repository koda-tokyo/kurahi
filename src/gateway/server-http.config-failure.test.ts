import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

// L3: a config load that throws answers 503 (HTTP) or refuses the upgrade; it never becomes an
// unhandled rejection / uncaught exception that takes the gateway process down.
const state = vi.hoisted(() => ({ fail: false }));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      if (state.fail) {
        throw new Error("config unreadable");
      }
      return {};
    },
  };
});

const { attachGatewayUpgradeHandler, createGatewayHttpServer } = await import("./server-http.js");

function rawUpgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    let data = "";
    sock.on("data", (d) => {
      data += d.toString("utf8");
    });
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
  });
}

describe("config load failures", () => {
  const server = createGatewayHttpServer({
    canvasHost: null,
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "token", token: "unused-token-0000000000000000", allowTailscale: false },
  });
  const wss = new WebSocketServer({ noServer: true });
  attachGatewayUpgradeHandler({ httpServer: server, wss, canvasHost: null });
  let port = 0;
  const crashes: unknown[] = [];
  const onCrash = (err: unknown) => crashes.push(err);

  beforeAll(async () => {
    process.on("unhandledRejection", onCrash);
    process.on("uncaughtException", onCrash);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    process.off("unhandledRejection", onCrash);
    process.off("uncaughtException", onCrash);
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers 503 to HTTP and keeps serving once the config loads again", async () => {
    state.fail = true;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(503);
    state.fail = false;
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(ok.status).not.toBe(503);
    expect(crashes).toEqual([]);
  });

  it("refuses a WebSocket upgrade with 503 and closes it", async () => {
    state.fail = true;
    try {
      const reply = await rawUpgrade(port);
      expect(reply.startsWith("HTTP/1.1 503")).toBe(true);
    } finally {
      state.fail = false;
    }
    expect(crashes).toEqual([]);
  });
});
