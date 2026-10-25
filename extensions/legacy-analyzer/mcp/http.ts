// Optional loopback transport for clients that speak streamable HTTP instead of stdio. Binds
// 127.0.0.1 only, requires a bearer token, checks Host and Origin (DNS rebinding), and runs the
// SDK transport in stateless mode: a fresh MCP server per request over the shared project context
// (root, index cache, audit log).
//
// Remote callers (an orchestration platform importing the tools as a remote MCP toolkit) reach it
// through a TLS reverse proxy on the same host. The proxy's public host names are listed in
// `allowedHosts`; the bind stays 127.0.0.1 and the token is still required.

import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "node:crypto";
import http from "node:http";
import { buildMcpServer, openLegacyMcp, SERVER_NAME, type LegacyMcpOptions } from "./server.js";

export const MCP_PATH = "/mcp";
const MAX_BODY = 1024 * 1024;

const HOST_NAME = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;

/** Normalise and validate proxy host names (`host` or `host:port`, no scheme or path). */
export function parseAllowedHosts(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of values ?? []) {
    const v = raw.trim().toLowerCase();
    if (!HOST_NAME.test(v)) {
      throw new Error(`Not a host name: ${raw.slice(0, 80)} (use host or host:port)`);
    }
    out.push(v);
  }
  return out;
}

export type LegacyMcpHttp = { url: string; port: number; token: string; close(): Promise<void> };

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

function deny(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function startLegacyMcpHttp(
  opts: LegacyMcpOptions & { port: number; token?: string; allowedHosts?: string[] },
): Promise<LegacyMcpHttp> {
  const ctx = openLegacyMcp(opts);
  const token = opts.token?.trim() || crypto.randomBytes(24).toString("base64url");
  if (token.length < 16) {
    throw new Error("The HTTP token must be at least 16 characters.");
  }
  const want = digest(`Bearer ${token}`);
  const proxyHosts = parseAllowedHosts(opts.allowedHosts);
  let port = 0;

  const server = http.createServer((req, res) => {
    const local = [`127.0.0.1:${port}`, `localhost:${port}`];
    const hosts = new Set([...local, ...proxyHosts]);
    const origins = new Set([
      ...local.map((h) => `http://${h}`),
      ...proxyHosts.map((h) => `https://${h}`),
    ]);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== MCP_PATH) {
      return deny(res, 404, "Not found.");
    }
    if (!hosts.has((req.headers.host ?? "").toLowerCase())) {
      return deny(res, 403, "Host not allowed.");
    }
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      return deny(res, 403, "Origin not allowed.");
    }
    const auth = req.headers.authorization ?? "";
    if (!crypto.timingSafeEqual(digest(auth), want)) {
      return deny(res, 401, "Missing or wrong bearer token.");
    }
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated stream, no session to delete.
      res.setHeader("allow", "POST");
      return deny(res, 405, "Method not allowed.");
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
      return deny(res, 413, "Request too large.");
    }
    const mcp = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        if (!res.headersSent) {
          deny(res, 500, err instanceof Error ? err.message : String(err));
        }
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  process.stderr.write(
    `${SERVER_NAME}: serving ${ctx.root.abs} on http://127.0.0.1:${port}${MCP_PATH} (audit ${ctx.state.auditFile})\n`,
  );
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
