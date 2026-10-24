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
});
