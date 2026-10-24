import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { A2aServerClient } from "./config.js";
import { isLoopbackAddress, resolveGatewayClientIp } from "../../../src/gateway/net.js";

// Transport-level guards for the A2A endpoints: network gate, bearer auth, rate limits and a
// bounded body reader. Token values never leave this module: they are hashed once at startup and
// compared in constant time; nothing here logs or returns them.

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export type ClientAuthenticator = (req: IncomingMessage) => A2aServerClient | null;

export function createClientAuthenticator(clients: A2aServerClient[]): ClientAuthenticator {
  const entries = clients.map((client) => ({ client, hash: digest(client.token) }));
  return (req) => {
    const header = req.headers.authorization;
    if (typeof header !== "string") {
      return null;
    }
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) {
      return null;
    }
    const presented = digest(match[1]);
    let found: A2aServerClient | null = null;
    // Compare against every entry so timing does not reveal which (if any) matched.
    for (const entry of entries) {
      if (timingSafeEqual(entry.hash, presented) && !found) {
        found = entry.client;
      }
    }
    return found;
  };
}

/** Client address as the gateway sees it (X-Forwarded-For only from gateway.trustedProxies). */
export function clientAddress(req: IncomingMessage, trustedProxies: string[] | undefined) {
  const forwarded = req.headers["x-forwarded-for"];
  const realIp = req.headers["x-real-ip"];
  return resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress,
    forwardedFor: Array.isArray(forwarded) ? forwarded[0] : forwarded,
    realIp: Array.isArray(realIp) ? realIp[0] : realIp,
    trustedProxies,
  });
}

export function isAllowedAddress(ip: string | undefined, allowNonLoopback: boolean): boolean {
  return allowNonLoopback || isLoopbackAddress(ip);
}

/** Fixed-window counter per key. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait, or 0 when the hit is allowed. */
  hit(key: string): number {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) {
        this.sweep(now);
      }
    }
    w.count += 1;
    if (w.count > this.limit) {
      return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
    }
    return 0;
  }

  /** Seconds to wait when the key is over its limit now, without counting a hit. */
  blockedFor(key: string): number {
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs || w.count < this.limit) {
      return 0;
    }
    return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
  }

  private sweep(now: number) {
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new BodyTooLargeError(limit);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > limit) {
      req.destroy();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
}
