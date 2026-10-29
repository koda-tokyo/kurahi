import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "./gateway";
class Socket extends EventTarget {
  static OPEN = 1;
  static latest: Socket;
  readyState = Socket.OPEN;
  sent = "";
  constructor() {
    super();
    Socket.latest = this;
  }
  send(data: string) {
    this.sent = data;
  }
  close() {}
}
afterEach(() => vi.unstubAllGlobals());
describe("gateway terminal errors", () => {
  it("preserves structured failure details so a restarted gateway can report lost sessions", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const client = new GatewayBrowserClient({ url: "ws://example.invalid" });
    client.start();
    const result = client.request("terminal.replay", { sessionId: "lost", afterSeq: 0 });
    const id = JSON.parse(Socket.latest.sent).id;
    Socket.latest.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "res",
          id,
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Unknown session",
            details: { code: "not-found" },
          },
        }),
      }),
    );
    await expect(result).rejects.toMatchObject({
      message: "Unknown session",
      code: "INVALID_REQUEST",
      details: { code: "not-found" },
    });
    client.stop();
  });
  it("closes a retryable connect refusal with 4013, not the connect-failed 4008", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const closes: Array<[number | undefined, string | undefined]> = [];
    const client = new GatewayBrowserClient({ url: "ws://example.invalid", token: "t" });
    client.start();
    Socket.latest.close = (code?: number, reason?: string) => void closes.push([code, reason]);
    for (const [retryable, expected] of [
      [true, 4013],
      [false, 4008],
    ] as const) {
      Socket.latest.dispatchEvent(new Event("open"));
      await vi.waitFor(() => expect(Socket.latest.sent).toContain('"connect"'), { timeout: 2000 });
      const id = JSON.parse(Socket.latest.sent).id;
      Socket.latest.sent = "";
      Socket.latest.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "res",
            id,
            ok: false,
            error: { code: retryable ? "UNAVAILABLE" : "INVALID_REQUEST", message: "x", retryable },
          }),
        }),
      );
      await vi.waitFor(() => expect(closes.at(-1)?.[0]).toBe(expected));
    }
    client.stop();
  });
  it("waits out a retryable refusal's retryAfterMs before reconnecting, capped at a minute", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const timeout = vi.spyOn(window, "setTimeout");
    const client = new GatewayBrowserClient({ url: "ws://example.invalid", token: "t" });
    client.start();
    for (const [retryAfterMs, expected] of [
      [30_000, 30_000],
      [10 ** 9, 60_000],
    ] as const) {
      const socket = Socket.latest;
      let closedWith: number | undefined;
      socket.close = (code?: number) => void (closedWith = code);
      socket.dispatchEvent(new Event("open"));
      await vi.waitFor(() => expect(socket.sent).toContain('"connect"'), { timeout: 2000 });
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "res",
            id: JSON.parse(socket.sent).id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "x",
              retryable: true,
              // Wire shape from errorShape(): retryAfterMs is a top-level error field.
              retryAfterMs,
            },
          }),
        }),
      );
      await vi.waitFor(() => expect(closedWith).toBe(4013));
      timeout.mockClear();
      socket.dispatchEvent(
        Object.assign(new Event("close"), { code: 1008, reason: "rate limited" }),
      );
      expect(timeout.mock.calls.at(-1)?.[1]).toBe(expected);
      // Reconnect now so the next case starts on a fresh socket.
      (timeout.mock.calls.at(-1)![0] as () => void)();
    }
    client.stop();
    timeout.mockRestore();
  });
  it("waits out the connection limiter's 'retry in Ns' 1013 close before reconnecting", () => {
    vi.stubGlobal("WebSocket", Socket);
    const timeout = vi.spyOn(window, "setTimeout");
    const client = new GatewayBrowserClient({ url: "ws://example.invalid", token: "t" });
    client.start();
    for (const [code, reason, expected] of [
      [
        1013,
        "rate limited: over 30 new connections per minute from this address; retry in 42s",
        42_000,
      ],
      [1013, "rate limited: retry in 9999s", 60_000],
      [1013, "demo is busy", 800],
      [1006, "retry in 42s", 800],
    ] as const) {
      timeout.mockClear();
      Socket.latest.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
      expect(timeout.mock.calls.at(-1)?.[1]).toBe(expected);
      // Reset backoff the way a successful hello would, then reconnect for the next case.
      (client as unknown as { backoffMs: number }).backoffMs = 800;
      (timeout.mock.calls.at(-1)![0] as () => void)();
    }
    client.stop();
    timeout.mockRestore();
  });
});
