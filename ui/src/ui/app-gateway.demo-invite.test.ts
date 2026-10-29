import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClientOptions } from "./gateway";
const clients = vi.hoisted(
  () => [] as { opts: GatewayBrowserClientOptions; stop: ReturnType<typeof vi.fn> }[],
);
vi.mock("./gateway", () => ({
  GatewayBrowserClient: class {
    start = vi.fn();
    stop = vi.fn();
    request = vi.fn().mockResolvedValue({});
    constructor(public opts: GatewayBrowserClientOptions) {
      clients.push(this);
    }
  },
}));
import { connectGateway } from "./app-gateway";
import { emptyBusiness } from "./controllers/business";
import { emptyTerminal } from "./controllers/terminal";
import {
  INVITE_BUSY_NOTICE,
  INVITE_ENDED_NOTICE,
  SIGN_IN_RATE_LIMITED_NOTICE,
} from "./demo-invite-link";
type Host = Parameters<typeof connectGateway>[0];
const CODE = "kdi_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz";
function host(token: string) {
  return {
    settings: { gatewayUrl: "ws://example.invalid", token },
    password: "",
    client: null,
    terminal: emptyTerminal(),
    connected: false,
    execApprovalQueue: [],
    business: emptyBusiness(),
    tab: "chat",
    eventLogBuffer: [],
    lastError: null,
  } as unknown as Host;
}
describe("demo invite refused by the gateway", () => {
  it("shows the invite notice and stops retrying", () => {
    const h = host(CODE);
    connectGateway(h);
    const client = clients.at(-1)!;
    client.opts.onClose?.({ code: 4008, reason: "connect failed" });
    expect(h.lastError).toBe(INVITE_ENDED_NOTICE);
    expect(client.stop).toHaveBeenCalled();
  });
  it("also covers the gateway's policy close", () => {
    const h = host(CODE);
    connectGateway(h);
    clients.at(-1)!.opts.onClose?.({
      code: 1008,
      reason: "unauthorized: demo invite revoked (ask for a new invite link)",
    });
    expect(h.lastError).toBe(INVITE_ENDED_NOTICE);
  });
  it("tells a visitor to wait and keeps retrying when the invites file is busy", () => {
    const h = host(CODE);
    connectGateway(h);
    const client = clients.at(-1)!;
    client.opts.onClose?.({ code: 1013, reason: "unavailable: demo invites are busy; try again" });
    expect(h.lastError).toBe(INVITE_BUSY_NOTICE);
    expect(client.stop).not.toHaveBeenCalled();
  });
  it("still says busy when the browser's own retryable connect close lands first", () => {
    const h = host(CODE);
    connectGateway(h);
    const client = clients.at(-1)!;
    client.opts.onClose?.({ code: 4013, reason: "connect unavailable" });
    expect(h.lastError).toBe(INVITE_BUSY_NOTICE);
    expect(client.stop).not.toHaveBeenCalled();
  });
  it("treats the gateway's sign-in rate limit as a wait, not an ended invite", () => {
    const h = host(CODE);
    connectGateway(h);
    const client = clients.at(-1)!;
    client.opts.onClose?.({ code: 1008, reason: "rate limited" });
    expect(h.lastError).toBe(SIGN_IN_RATE_LIMITED_NOTICE);
    expect(client.stop).not.toHaveBeenCalled();
  });
  it("treats the connection limiter's refusal as a rate limit, not a busy demo", () => {
    const reason =
      "rate limited: over 30 new connections per minute from this address; retry in 42s";
    const visitor = host(CODE);
    connectGateway(visitor);
    const visitorClient = clients.at(-1)!;
    visitorClient.opts.onClose?.({ code: 1013, reason });
    expect(visitor.lastError).toBe(SIGN_IN_RATE_LIMITED_NOTICE);
    expect(visitorClient.stop).not.toHaveBeenCalled();

    const owner = host("owner-token");
    connectGateway(owner);
    clients.at(-1)!.opts.onClose?.({ code: 1013, reason });
    expect(owner.lastError).toBe(SIGN_IN_RATE_LIMITED_NOTICE);
  });
  it("does not sign an SSO user out when the gateway rate-limits the sign-in", () => {
    window.sessionStorage.setItem("kolo-sso-session-v1", "sso-session-token");
    try {
      const h = host("");
      connectGateway(h);
      const client = clients.at(-1)!;
      client.opts.onClose?.({ code: 1008, reason: "rate limited" });
      expect(h.lastError).toBe(SIGN_IN_RATE_LIMITED_NOTICE);
      expect(client.stop).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem("kolo-sso-session-v1")).toBe("sso-session-token");
    } finally {
      window.sessionStorage.removeItem("kolo-sso-session-v1");
    }
  });
  it("keeps the usual error and retry for other tokens and for network drops", () => {
    const owner = host("owner-token");
    connectGateway(owner);
    const ownerClient = clients.at(-1)!;
    ownerClient.opts.onClose?.({ code: 4008, reason: "connect failed" });
    expect(owner.lastError).toBe("disconnected (4008): connect failed");
    expect(ownerClient.stop).not.toHaveBeenCalled();

    const visitor = host(CODE);
    connectGateway(visitor);
    const visitorClient = clients.at(-1)!;
    visitorClient.opts.onClose?.({ code: 1006, reason: "" });
    expect(visitor.lastError).toBe("disconnected (1006): no reason");
    expect(visitorClient.stop).not.toHaveBeenCalled();
  });
});
