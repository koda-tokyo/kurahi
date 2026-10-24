import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClientOptions } from "./gateway";
import { emptyTerminal } from "./controllers/terminal";
const clients = vi.hoisted(() => [] as { opts: GatewayBrowserClientOptions }[]);
vi.mock("./gateway", () => ({
  GatewayBrowserClient: class {
    start = vi.fn();
    stop = vi.fn();
    request = vi
      .fn()
      .mockResolvedValue({ events: [], hasMore: false, truncated: false, lastSeq: 0 });
    constructor(public opts: GatewayBrowserClientOptions) {
      clients.push(this);
    }
  },
}));
import { connectGateway, handleGatewayEvent } from "./app-gateway";
import { emptyVoice, startVoice } from "./controllers/voice";
type Host = Parameters<typeof connectGateway>[0];
function host(): Host {
  return {
    settings: { gatewayUrl: "ws://example.invalid", token: "test-token" },
    password: "",
    client: null,
    terminal: emptyTerminal(),
    connected: false,
    execApprovalQueue: [],
  } as unknown as Host;
}
function pending(h: Host) {
  h.terminal.session = { sessionId: "terminal-1" } as NonNullable<Host["terminal"]["session"]>;
  h.terminal.cursor = 7;
  h.execApprovalQueue = [
    {
      id: "approval-1",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
      request: { command: "touch demo", sessionKey: "terminal:terminal-1" },
    },
  ];
}
describe("terminal connection lifecycle", () => {
  it("preserves an already-replayed pending approval on explicit same-identity reconnect", () => {
    const h = host();
    connectGateway(h);
    pending(h);
    connectGateway(h);
    expect(h.terminal.cursor).toBe(7);
    expect(h.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-1"]);
    expect(h.terminal.synced).toBe(false);
  });
  it("does not reuse a session when the endpoint or identity changes", () => {
    const h = host();
    connectGateway(h);
    pending(h);
    h.settings = { ...h.settings, token: "different-test-token" };
    connectGateway(h);
    expect(h.terminal.session).toBeNull();
    expect(h.execApprovalQueue).toEqual([]);
  });
  it("ignores delayed close events from a replaced client", () => {
    const h = host();
    connectGateway(h);
    const old = clients.at(-1)!;
    connectGateway(h);
    h.connected = true;
    old.opts.onClose?.({ code: 1006, reason: "old socket" });
    expect(h.connected).toBe(true);
    clients.at(-1)!.opts.onClose?.({ code: 1006, reason: "current socket" });
    expect(h.connected).toBe(false);
  });
});

describe("voice connection lifecycle", () => {
  it("keeps voice events out of the debug log", () => {
    const h = host();
    h.eventLogBuffer = [];
    h.eventLog = [];
    h.tab = "debug";
    for (const event of ["voice.transcript.partial", "voice.transcript.final", "voice.audio.out"]) {
      handleGatewayEvent(h, { event, payload: { text: "Private", chunk: "AAA=" } } as Parameters<
        typeof handleGatewayEvent
      >[1]);
    }
    expect(h.eventLogBuffer).toEqual([]);
    expect(h.eventLog).toEqual([]);
  });
  it("releases capture and transcript on disconnect, never resuming it", async () => {
    const h = host();
    h.voice = emptyVoice();
    const cancel = vi.fn();
    h.voiceCapture = () => ({ start: async () => {}, stop: async () => {}, cancel });
    connectGateway(h);
    h.connected = true;
    await startVoice(h, "p1", "en");
    clients.at(-1)!.opts.onClose?.({ code: 1006, reason: "lost" });
    expect(cancel).toHaveBeenCalled();
    expect(h.voice).toEqual(emptyVoice());
    connectGateway(h);
    expect(h.voice).toEqual(emptyVoice());
  });
});
