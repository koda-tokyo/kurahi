import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAllowedHosts, startLegacyMcpHttp, type LegacyMcpHttp } from "./http.js";
import { demoProject } from "./test-project.js";

// Conformance for a remote-MCP toolkit import over streamable HTTP through a TLS reverse proxy:
// the importer sends initialize, notifications/initialized and tools/list, wants JSON responses,
// fails the import on any 4xx, and gives up after 30 seconds. It also sends trace-context headers.
// Requests are written from the MCP streamable-HTTP specification and the importer's documented
// limits; they are not captured traffic. See docs/integrations/ibm-watsonx-orchestrate.

const PROXY_HOST = "mcp.example.com";
const IMPORT_TIMEOUT_MS = 30_000;

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function post(
  port: number,
  token: string,
  payload: unknown,
  extra: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          host: PROXY_HOST,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          ...extra,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

describe("legacy MCP as a remote toolkit behind a reverse proxy", () => {
  let srv: LegacyMcpHttp;

  beforeAll(async () => {
    srv = await startLegacyMcpHttp({
      root: demoProject(),
      port: 0,
      token: "t".repeat(40),
      allowedHosts: [PROXY_HOST],
    });
  });
  afterAll(async () => {
    await srv.close();
  });

  it("answers initialize, initialized and tools/list in JSON, well inside the import timeout", async () => {
    const started = Date.now();
    const init = await post(srv.port, srv.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "toolkit-import", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers["content-type"]).toMatch(/application\/json/);
    const initBody = JSON.parse(init.body);
    expect(initBody.result.capabilities.tools).toBeDefined();

    const notified = await post(srv.port, srv.token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notified.status).toBeLessThan(400);

    const list = await post(srv.port, srv.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    expect(list.headers["content-type"]).toMatch(/application\/json/);
    const tools = JSON.parse(list.body).result.tools as Array<{
      name: string;
      description?: string;
      inputSchema: { type: string };
    }>;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(Date.now() - started).toBeLessThan(IMPORT_TIMEOUT_MS);
  });

  it("still requires the token through the proxy and refuses unlisted hosts", async () => {
    const payload = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    expect((await post(srv.port, "wrong-token-value-0000", payload)).status).toBe(401);
    expect((await post(srv.port, srv.token, payload, { host: "other.example.com" })).status).toBe(
      403,
    );
    expect(
      (await post(srv.port, srv.token, payload, { origin: `https://${PROXY_HOST}` })).status,
    ).toBe(200);
    expect(
      (await post(srv.port, srv.token, payload, { origin: "https://evil.example.com" })).status,
    ).toBe(403);
  });

  it("validates proxy host names", () => {
    expect(parseAllowedHosts([" MCP.Example.com:443 "])).toEqual(["mcp.example.com:443"]);
    expect(() => parseAllowedHosts(["https://mcp.example.com"])).toThrow(/host name/);
    expect(() => parseAllowedHosts(["a/b"])).toThrow(/host name/);
  });
});
