import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isLocalDirectRequest } from "./auth.js";
import {
  isTrustedProxyAddress,
  resolveGatewayClientAddress,
  resolveGatewayClientIp,
} from "./net.js";
import { checkHttpRateLimit, resetRateLimiters } from "./rate-limiter.js";

function req(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe("resolveGatewayClientIp (shared resolver)", () => {
  it("ignores forwarding headers from an untrusted peer", () => {
    expect(
      resolveGatewayClientIp({
        remoteAddr: "203.0.113.9",
        forwardedFor: "127.0.0.1",
        trustedProxies: ["127.0.0.1"],
      }),
    ).toBe("203.0.113.9");
  });

  it("walks X-Forwarded-For from the right, skipping trusted proxies", () => {
    // Client wrote "127.0.0.1"; the edge proxy appended the real client, the inner proxy itself.
    expect(
      resolveGatewayClientIp({
        remoteAddr: "127.0.0.1",
        forwardedFor: "127.0.0.1, 198.51.100.7, 10.0.0.2",
        trustedProxies: ["127.0.0.1", "10.0.0.2"],
      }),
    ).toBe("198.51.100.7");
  });

  it("returns the leftmost hop when every hop is a trusted proxy", () => {
    expect(
      resolveGatewayClientAddress({
        remoteAddr: "127.0.0.1",
        forwardedFor: "127.0.0.1",
        trustedProxies: ["127.0.0.1"],
      }),
    ).toEqual({ ip: "127.0.0.1", source: "forwarded-for" });
  });

  it("normalizes ::ffff: mapped IPv4 and ports in the trust check and the result", () => {
    expect(isTrustedProxyAddress("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isTrustedProxyAddress("127.0.0.1", ["::ffff:127.0.0.1"])).toBe(true);
    expect(
      resolveGatewayClientIp({
        remoteAddr: "::ffff:127.0.0.1",
        forwardedFor: "[2001:db8::1]:443, ::ffff:10.0.0.2",
        trustedProxies: ["127.0.0.1", "10.0.0.2"],
      }),
    ).toBe("2001:db8::1");
    expect(resolveGatewayClientIp({ remoteAddr: "::ffff:192.0.2.4" })).toBe("192.0.2.4");
  });

  it("uses X-Real-IP only without X-Forwarded-For", () => {
    expect(
      resolveGatewayClientAddress({
        remoteAddr: "127.0.0.1",
        realIp: "198.51.100.8",
        trustedProxies: ["127.0.0.1"],
      }),
    ).toEqual({ ip: "198.51.100.8", source: "real-ip" });
  });
});

describe("isLocalDirectRequest behind a trusted proxy", () => {
  const trusted = ["127.0.0.1"];

  it("does not treat a spoofed leftmost X-Forwarded-For 127.0.0.1 as local", () => {
    // Remote client sent X-Forwarded-For: 127.0.0.1 + Host: localhost; the proxy appended it.
    const spoofed = req("127.0.0.1", {
      host: "localhost",
      "x-forwarded-for": "127.0.0.1, 198.51.100.7",
    });
    expect(isLocalDirectRequest(spoofed, trusted)).toBe(false);
  });

  it("does not treat a remote trusted proxy relaying 127.0.0.1 as local", () => {
    const relayed = req("10.0.0.2", { host: "localhost", "x-forwarded-for": "127.0.0.1" });
    expect(isLocalDirectRequest(relayed, ["10.0.0.2"])).toBe(false);
  });

  it("does not treat a forwarding proxy that names no client as local", () => {
    const noClient = req("127.0.0.1", { host: "localhost", "x-forwarded-host": "a.example" });
    expect(isLocalDirectRequest(noClient, trusted)).toBe(false);
  });

  it("keeps a same-host client through a trusted loopback proxy local", () => {
    const viaProxy = req("127.0.0.1", { host: "localhost", "x-forwarded-for": "127.0.0.1" });
    expect(isLocalDirectRequest(viaProxy, trusted)).toBe(true);
    expect(isLocalDirectRequest(req("::ffff:127.0.0.1", { host: "localhost" }), [])).toBe(true);
  });

  it("refuses forwarding headers from an untrusted loopback peer", () => {
    const untrusted = req("127.0.0.1", { host: "localhost", "x-forwarded-for": "127.0.0.1" });
    expect(isLocalDirectRequest(untrusted, [])).toBe(false);
  });
});

describe("HTTP rate limiter key behind a trusted proxy", () => {
  it("cannot be bypassed by rotating the leftmost X-Forwarded-For entry", () => {
    resetRateLimiters();
    const res = () => ({ writeHead: () => {}, end: () => {} });
    let allowed = 0;
    for (let i = 0; i < 150; i++) {
      const r = req("127.0.0.1", { "x-forwarded-for": `10.9.0.${i}, 198.51.100.7` });
      if (checkHttpRateLimit(r as never, res(), ["127.0.0.1"])) {
        allowed++;
      }
    }
    expect(allowed).toBe(100);
  });
});
