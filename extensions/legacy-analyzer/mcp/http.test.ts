import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLegacyMcpHttp, type LegacyMcpHttp } from "./http.js";
import { demoProject } from "./test-project.js";

function rawPost(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

describe("kurahi-legacy over loopback HTTP", () => {
  let srv: LegacyMcpHttp;

  beforeAll(async () => {
    srv = await startLegacyMcpHttp({ root: demoProject(), port: 0 });
  });
  afterAll(async () => {
    await srv.close();
  });

  it("serves the tools to a client holding the token", async () => {
    const client = new Client({ name: "legacy-mcp-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
      requestInit: { headers: { authorization: `Bearer ${srv.token}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("legacy_query");
    const r = (await client.callTool({
      name: "legacy_query",
      arguments: { kind: "callers", args: { name: "ORDTAX" } },
    })) as unknown as { structuredContent: { result: { calledBy: Array<{ at: string }> } } };
    expect(r.structuredContent.result.calledBy[0].at).toMatch(/^source\/cobol\/ORDCALC\.cbl:\d+$/);
    await client.close();
  });

  it("refuses a missing token, a foreign Host and a foreign Origin", async () => {
    const host = `127.0.0.1:${srv.port}`;
    const auth = `Bearer ${srv.token}`;
    const json = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    expect(await rawPost(srv.port, { ...json, host })).toBe(401);
    expect(await rawPost(srv.port, { ...json, host, authorization: "Bearer wrong" })).toBe(401);
    expect(await rawPost(srv.port, { ...json, host: "evil.example:80", authorization: auth })).toBe(
      403,
    );
    expect(
      await rawPost(srv.port, {
        ...json,
        host,
        authorization: auth,
        origin: "http://evil.example",
      }),
    ).toBe(403);
  });
});
