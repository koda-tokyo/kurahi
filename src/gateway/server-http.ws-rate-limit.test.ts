import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { decideWsConnectionRateLimit, resetRateLimiters } from "./rate-limiter.js";
import { attachGatewayUpgradeHandler } from "./server-http.js";

// Dogfood finding: a CLI over the per-IP connection limit saw a bare 1006 with no reason.
// Rejected connections now get 1013 (try again later) and a reason, within a bounded budget.

let prevHome: string | undefined;
let tempDir: string;

beforeEach(async () => {
  resetRateLimiters();
  prevHome = process.env.KOLO_HOME;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kurahi-ws-rate-"));
  process.env.KOLO_HOME = tempDir;
});

afterEach(async () => {
  resetRateLimiters();
  if (prevHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = prevHome;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

const req = (ip: string) => ({ socket: { remoteAddress: ip }, headers: {} });

describe("decideWsConnectionRateLimit", () => {
  it("explains a bounded number of rejections, then stops explaining", () => {
    for (let i = 0; i < 10; i++) {
      expect(decideWsConnectionRateLimit(req("9.9.9.9")).allowed).toBe(true);
    }
    const first = decideWsConnectionRateLimit(req("9.9.9.9"));
    if (first.allowed) {
      throw new Error("expected a rejection");
    }
    expect(first.explain).toBe(true);
    expect(first.reason).toMatch(
      /^rate limited: over 10 new connections per minute from this address; retry in \d+s$/,
    );
    expect(Buffer.byteLength(first.reason)).toBeLessThanOrEqual(123);
    let explained = 1;
    for (let i = 0; i < 50; i++) {
      const d = decideWsConnectionRateLimit(req("9.9.9.9"));
      if (!d.allowed && d.explain) {
        explained++;
      }
    }
    expect(explained).toBe(20);
    // Another address has its own budget.
    expect(decideWsConnectionRateLimit(req("8.8.4.4")).allowed).toBe(true);
  });
});

describe("gateway upgrade handler", () => {
  it("closes an over-limit connection with 1013 and the reason, never handing it on", async () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    let handedOn = 0;
    wss.on("connection", (ws) => {
      handedOn++;
      ws.close(1000, "ok");
    });
    attachGatewayUpgradeHandler({ httpServer, wss, canvasHost: null });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const connect = () =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("error", () => {});
        ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
    try {
      for (let i = 0; i < 10; i++) {
        expect((await connect()).code).toBe(1000);
      }
      const over = await connect();
      expect(over.code).toBe(1013);
      expect(over.reason).toMatch(/rate limited: over 10 new connections per minute/);
      expect(handedOn).toBe(10);
    } finally {
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
