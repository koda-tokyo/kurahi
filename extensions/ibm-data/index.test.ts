import { describe, expect, it, vi } from "vitest";
import type { KoLoPluginApi, KoLoPluginAuditInput } from "../../src/plugins/types.js";
import { readToolDef } from "../../src/autopilot/tools.js";
import plugin from "./index.js";
import { parseIbmDataConfig } from "./src/config.js";
import { Db2RestClient } from "./src/db2.js";
import { runReadOnlyQuery } from "./src/presto.js";
import { createIbmDataTools, DB2_TOOL, QUERY_TOOL } from "./src/tools.js";

// Recorded-shape fixtures (values fake, nothing from a live system):
//  - Presto/Trino client protocol: POST /v1/statement answers { id, nextUri, stats }; the next
//    page carries columns and data; the last page has no nextUri.
//  - Db2 for z/OS native REST: { "ResultSet Output": [...], "StatusCode": 200,
//    "StatusDescription": "Execution Successful" } (IBM sample shape).
//  - Db2 LUW REST server: /v1/auth -> { token }; /v1/services -> { jobStatus, resultSet, rowCount }.

const ENGINE = "https://lh.example.ibm.test:31234";

const cfg = (over: Record<string, unknown> = {}) =>
  parseIbmDataConfig({
    watsonxData: {
      url: ENGINE,
      password: "ibm-cloud-key",
      catalogs: [{ name: "iceberg_data", schemas: ["sales"] }],
      maxRows: 3,
      ...over,
    },
    db2: {
      connections: [
        {
          id: "zos1",
          kind: "zos",
          url: "https://db2z.example.test:4711",
          user: "RACFUSR",
          password: "pw",
        },
        {
          id: "luw1",
          kind: "luw",
          url: "https://db2rest.example.test:50050",
          user: "db2inst1",
          password: "pw2",
          database: { host: "db.example.test", name: "SAMPLE", port: 50001 },
        },
      ],
      services: [
        {
          name: "employees",
          connection: "zos1",
          collection: "SYSIBMSERVICE",
          service: "getEmployees",
          version: "V1",
          description: "Employees of a department",
          parameters: ["whichDept"],
        },
        {
          name: "orders",
          connection: "luw1",
          service: "getOrders",
          version: "1.0",
          description: "Open orders",
          parameters: ["since"],
        },
      ],
      maxRows: 2,
    },
  });

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

function fakeFetch(route: (c: Call) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(c);
    return route(c);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

function prestoRoute(pages: unknown[]) {
  let i = 0;
  return (c: Call) =>
    c.method === "DELETE" ? new Response(null, { status: 204 }) : json(pages[i++]);
}

const page1 = {
  id: "20261025_000000_00001_abcde",
  nextUri: `${ENGINE}/v1/statement/q1/1`,
  stats: { state: "QUEUED" },
};
const page2 = {
  id: "20261025_000000_00001_abcde",
  nextUri: `${ENGINE}/v1/statement/q1/2`,
  columns: [
    { name: "id", type: "integer" },
    { name: "region", type: "varchar" },
  ],
  data: [
    [1, "JP"],
    [2, "JP"],
  ],
  stats: { state: "RUNNING" },
};
const page3 = {
  id: "20261025_000000_00001_abcde",
  data: [[3, "JP"]],
  stats: { state: "FINISHED" },
};

describe("watsonx.data read-only query (Presto client protocol)", () => {
  it("posts the statement with Presto headers and Basic auth, follows nextUri to the end", async () => {
    const f = fakeFetch(prestoRoute([page1, page2, page3]));
    const r = await runReadOnlyQuery(
      cfg().watsonxData!,
      { sql: "SELECT id, region FROM orders" },
      f.fetch,
    );
    expect(r).toMatchObject({
      columns: [
        { name: "id", type: "integer" },
        { name: "region", type: "varchar" },
      ],
      rows: [
        [1, "JP"],
        [2, "JP"],
        [3, "JP"],
      ],
      truncated: false,
      queryId: "20261025_000000_00001_abcde",
    });
    const post = f.calls[0];
    expect(post).toMatchObject({
      method: "POST",
      url: `${ENGINE}/v1/statement`,
      body: "SELECT id, region FROM orders",
    });
    expect(post.headers).toMatchObject({
      "X-Presto-User": "ibmlhapikey",
      "X-Presto-Catalog": "iceberg_data",
      "X-Presto-Schema": "sales",
      Authorization: `Basic ${Buffer.from("ibmlhapikey:ibm-cloud-key").toString("base64")}`,
    });
    expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("stops at the row limit and cancels the query", async () => {
    const f = fakeFetch(prestoRoute([page1, page2, page3]));
    const r = await runReadOnlyQuery(
      cfg().watsonxData!,
      { sql: "SELECT * FROM orders", maxRows: 2 },
      f.fetch,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", url: `${ENGINE}/v1/statement/q1/2` });
  });

  it("uses Trino headers for the trino dialect", async () => {
    const f = fakeFetch(prestoRoute([page3]));
    await runReadOnlyQuery(
      cfg({ dialect: "trino" }).watsonxData!,
      { sql: "SELECT 1 FROM orders" },
      f.fetch,
    );
    expect(f.calls[0].headers["X-Trino-User"]).toBe("ibmlhapikey");
  });

  it("refuses writes and unlisted catalogs before any request, and foreign nextUri hosts", async () => {
    const f = fakeFetch(prestoRoute([page3]));
    const w = cfg().watsonxData!;
    await expect(runReadOnlyQuery(w, { sql: "DROP TABLE orders" }, f.fetch)).rejects.toMatchObject({
      reason: "refused",
    });
    await expect(
      runReadOnlyQuery(w, { sql: "SELECT 1", catalog: "system" }, f.fetch),
    ).rejects.toMatchObject({
      reason: "refused",
    });
    expect(f.calls).toHaveLength(0);
    const evil = fakeFetch(
      prestoRoute([{ id: "q", nextUri: "https://evil.example.com/v1/statement/q/1" }]),
    );
    await expect(runReadOnlyQuery(w, { sql: "SELECT 1 FROM orders" }, evil.fetch)).rejects.toThrow(
      /another host/,
    );
    expect(evil.calls).toHaveLength(1);
  });

  it("reports engine errors", async () => {
    const f = fakeFetch(
      prestoRoute([
        {
          id: "q",
          error: {
            errorName: "TABLE_NOT_FOUND",
            message: "Table iceberg_data.sales.nope does not exist",
          },
        },
      ]),
    );
    await expect(
      runReadOnlyQuery(cfg().watsonxData!, { sql: "SELECT * FROM nope" }, f.fetch),
    ).rejects.toMatchObject({
      reason: "remote",
      message: expect.stringMatching(/TABLE_NOT_FOUND/),
    });
  });
});

describe("Db2 REST services", () => {
  it("z/OS: POST /services/<collection>/<service>/<version> with Basic auth, rows bounded", async () => {
    const f = fakeFetch(() =>
      json({
        "ResultSet Output": [
          { EMPNO: "000010", LASTNAME: "HAAS" },
          { EMPNO: "000020", LASTNAME: "THOMPSON" },
          { EMPNO: "000030", LASTNAME: "KWAN" },
        ],
        StatusCode: 200,
        StatusDescription: "Execution Successful",
      }),
    );
    const client = new Db2RestClient(cfg().db2!, f.fetch);
    const r = await client.call("employees", { whichDept: "A00" });
    expect(f.calls[0]).toMatchObject({
      method: "POST",
      url: "https://db2z.example.test:4711/services/SYSIBMSERVICE/getEmployees/V1",
      body: '{"whichDept":"A00"}',
    });
    expect(f.calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from("RACFUSR:pw").toString("base64")}`,
    );
    expect(r).toMatchObject({ truncated: true, status: "Execution Successful" });
    expect(r.rows).toHaveLength(2);
  });

  it("LUW: authenticates once, then runs the service synchronously; re-auths after a 401", async () => {
    let serviceCalls = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/v1/auth")) {
        return json({ token: `tok-${c.body?.length}` });
      }
      serviceCalls += 1;
      if (serviceCalls === 2) {
        return json({ message: "expired" }, 401);
      }
      return json({
        jobStatus: 4,
        jobStatusDescription: "Job is complete",
        resultSet: [{ ORDER_ID: 1 }],
        rowCount: 1,
      });
    });
    const client = new Db2RestClient(cfg().db2!, f.fetch);
    const first = await client.call("orders", { since: "2026-10-01" });
    expect(first.rows).toEqual([{ ORDER_ID: 1 }]);
    const auth = JSON.parse(f.calls[0].body ?? "{}");
    expect(auth).toMatchObject({
      dbParms: {
        dbHost: "db.example.test",
        dbName: "SAMPLE",
        dbPort: 50001,
        isSSLConnection: true,
        username: "db2inst1",
      },
    });
    expect(f.calls[1]).toMatchObject({
      url: "https://db2rest.example.test:50050/v1/services/getOrders/1.0",
    });
    expect(JSON.parse(f.calls[1].body ?? "{}")).toEqual({
      parameters: { since: "2026-10-01" },
      sync: true,
    });
    expect(f.calls[1].headers.authorization).toMatch(/^tok-/);
    await client.call("orders", {});
    expect(f.calls.map((c) => c.url.replace(/^https:\/\/[^/]+/, ""))).toEqual([
      "/v1/auth",
      "/v1/services/getOrders/1.0",
      "/v1/services/getOrders/1.0",
      "/v1/auth",
      "/v1/services/getOrders/1.0",
    ]);
  });

  it("refuses unknown services, unlisted parameters and non-scalar values", async () => {
    const f = fakeFetch(() => json({}));
    const client = new Db2RestClient(cfg().db2!, f.fetch);
    await expect(client.call("payroll", {})).rejects.toMatchObject({ reason: "config" });
    await expect(client.call("employees", { other: 1 })).rejects.toMatchObject({
      reason: "refused",
    });
    await expect(client.call("employees", { whichDept: { $ne: 1 } })).rejects.toMatchObject({
      reason: "refused",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("validates the config", () => {
    expect(() =>
      parseIbmDataConfig({
        db2: {
          connections: [
            { id: "z", kind: "zos", url: "https://x.example.test", user: "u", password: "p" },
          ],
          services: [{ name: "s", connection: "z", service: "svc", description: "d" }],
        },
      }),
    ).toThrow(/collection/);
    expect(() =>
      parseIbmDataConfig({
        watsonxData: { url: "http://x.example.test", password: "p", catalogs: [] },
      }),
    ).toThrow();
  });
});

describe("ibm-data tools and plugin", () => {
  it("wraps rows as untrusted and audits a SQL hash, never the SQL or rows", async () => {
    const audits: KoLoPluginAuditInput[] = [];
    const f = fakeFetch(prestoRoute([page2, page3]));
    const tools = createIbmDataTools({
      cfg: cfg(),
      audit: (a) => audits.push(a),
      ctx: { agentId: "main" } as never,
      fetchFn: f.fetch,
    })!;
    const query = tools.find((t) => t.name === QUERY_TOOL)!;
    const out = (await query.execute("t", {
      sql: "SELECT id, region FROM orders WHERE region = 'JP'",
    })) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0].text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(audits[0]).toMatchObject({
      action: "ibm_data.watsonx_query",
      outcome: "ok",
      detail: { rows: 3 },
    });
    expect(JSON.stringify(audits)).not.toMatch(/region|JP/);
    const refused = (await query.execute("t", { sql: "DELETE FROM orders" })) as {
      details: { reason: string };
    };
    expect(refused.details.reason).toBe("refused");
    expect(audits[1]).toMatchObject({ outcome: "denied" });
    expect(tools.map((t) => t.name)).toEqual([QUERY_TOOL, DB2_TOOL]);
  });

  it("registers optional tools only for configured halves; none are autopilot read tools", () => {
    const registered: Array<{ names?: string[]; optional?: boolean }> = [];
    const api = (pluginConfig: unknown) =>
      ({
        pluginConfig,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        registerTool: (_t: unknown, o: { names?: string[]; optional?: boolean }) =>
          registered.push(o),
        audit: () => {},
      }) as unknown as KoLoPluginApi;
    plugin.register(api({}));
    expect(registered).toEqual([]);
    plugin.register(api({ db2: cfg().db2 }));
    expect(registered).toEqual([{ names: [DB2_TOOL], optional: true }]);
    expect(readToolDef(QUERY_TOOL)).toBeNull();
    expect(readToolDef(DB2_TOOL)).toBeNull();
  });
});
