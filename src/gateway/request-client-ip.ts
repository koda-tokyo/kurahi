import type { IncomingMessage } from "node:http";
import { loadConfig } from "../config/config.js";
import { resolveRequestClientAddress } from "./net.js";

/**
 * Client address of a request for audit records, via the shared resolver and the current
 * `gateway.trustedProxies` (never the raw, client-controlled leftmost X-Forwarded-For entry).
 */
export function requestClientIp(req: IncomingMessage): string {
  let trustedProxies: string[] = [];
  try {
    trustedProxies = loadConfig().gateway?.trustedProxies ?? [];
  } catch {
    // unreadable config: no proxy is trusted, the socket peer is the client
  }
  return resolveRequestClientAddress(req, trustedProxies).ip ?? "unknown";
}
