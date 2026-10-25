import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countOperations, SECURITY_SCHEMES } from "./http-openapi.js";
import { HTTP_AUTH_KINDS } from "./http-registry.js";
import { createGatewayRouter, GATEWAY_MOUNTS, GATEWAY_ROUTES } from "./http-routes.js";
import { buildStaticGatewayOpenApi, serializeOpenApi } from "./openapi-static.js";
import { describeRuntimeHttpRoutes } from "./server-http.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
};

type Op = {
  operationId: string;
  security: Array<Record<string, string[]>>;
  responses: Record<string, unknown>;
  "x-kolo-scope": string | string[];
  "x-kolo-rate-limit": { class: string; limit: number };
};

const doc = buildStaticGatewayOpenApi(pkg.version) as {
  openapi: string;
  info: { version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Op>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    responses: Record<string, unknown>;
    schemas: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  "x-kolo-undocumented-routes": Array<{
    id: string;
    reason: string;
    "x-kolo-undocumented": boolean;
  }>;
  "x-kolo-websocket": {
    methods: Array<{ name: string; params?: { $ref: string } }>;
    events: Array<{ name: string }>;
    handshake: { params: { $ref: string } };
  };
};

const operations = () =>
  Object.entries(doc.paths).flatMap(([p, item]) =>
    Object.entries(item).map(([method, op]) => ({ path: p, method, op })),
  );

describe("OpenAPI document from the route registry", () => {
  it("is a structurally valid OpenAPI 3.1 document", () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info.version).toBe(pkg.version);
    expect(doc.servers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\{port\}$/);
    expect(countOperations(doc)).toBe(GATEWAY_ROUTES.length);
    expect(countOperations(doc)).toBeGreaterThanOrEqual(20);
    const ids = operations().map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path: p, method, op } of operations()) {
      expect(["get", "post", "put", "patch", "delete", "head", "options"]).toContain(method);
      // A success: 2xx, or 3xx for browser redirect steps (SSO sign-in).
      expect(Object.keys(op.responses).some((code) => /^[23]/.test(code))).toBe(true);
      // every template parameter is declared
      for (const [, name] of p.matchAll(/\{(\w+)\}/g)) {
        const params = (op as unknown as { parameters?: Array<{ name: string; in: string }> })
          .parameters;
        expect(params?.some((x) => x.in === "path" && x.name === name)).toBe(true);
      }
    }
  });

  it("gives every operation security unless its auth is none, and a scope name", () => {
    const schemeNames = new Set(Object.keys(doc.components.securitySchemes));
    for (const route of GATEWAY_ROUTES) {
      const op = doc.paths[route.path][route.method.toLowerCase()];
      const kinds = Array.isArray(route.auth) ? route.auth : [route.auth];
      if (kinds.includes("none")) {
        expect(op.security).toEqual([]);
        expect(op["x-kolo-scope"]).toBe("public");
        continue;
      }
      expect(op.security.length).toBe(kinds.length);
      for (const requirement of op.security) {
        for (const name of Object.keys(requirement)) {
          expect(schemeNames.has(name)).toBe(true);
        }
      }
      expect(op["x-kolo-scope"]).toBeTruthy();
    }
    for (const kind of HTTP_AUTH_KINDS.filter((k) => k !== "none")) {
      const entry = SECURITY_SCHEMES[kind];
      expect(doc.components.securitySchemes[entry.name]?.["x-kolo-scope"]).toBe(entry.scope);
    }
  });

  it("documents the error model and rate limits on every operation", () => {
    for (const name of ["Unauthorized", "Forbidden", "TooManyRequests"]) {
      expect(doc.components.responses[name]).toBeTruthy();
    }
    expect(Object.keys(doc.components.headers)).toEqual(
      expect.arrayContaining(["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"]),
    );
    for (const { op } of operations()) {
      expect(op.responses["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
      expect(op["x-kolo-rate-limit"].limit).toBeGreaterThan(0);
    }
    expect(doc.paths["/v1/chat/completions"].post["x-kolo-rate-limit"].class).toBe("llm");
    expect(doc.paths["/tools/invoke"].post.responses["401"]).toBeTruthy();
  });

  it("lists every mount with a reason and describes the WebSocket protocol", () => {
    expect(doc["x-kolo-undocumented-routes"].map((m) => m.id)).toEqual(
      GATEWAY_MOUNTS.map((m) => m.id),
    );
    for (const m of doc["x-kolo-undocumented-routes"]) {
      expect(m.reason.length).toBeGreaterThan(20);
    }
    const ws = doc["x-kolo-websocket"];
    expect(ws.handshake.params.$ref).toBe("#/components/schemas/ConnectParams");
    const send = ws.methods.find((m) => m.name === "chat.send");
    expect(send?.params?.$ref).toBe("#/components/schemas/ChatSendParams");
    expect(ws.events.some((e) => e.name === "tick")).toBe(true);
    for (const m of ws.methods) {
      const ref = m.params?.$ref;
      if (ref) {
        expect(doc.components.schemas[ref.split("/").pop() ?? ""]).toBeTruthy();
      }
    }
  });

  it("matches the committed spec (drift check)", () => {
    const committed = fs.readFileSync(
      path.join(ROOT, "openapi", "kolo-gateway.openapi.json"),
      "utf8",
    );
    expect(serializeOpenApi(doc)).toBe(committed);
  });

  it("binds strictly: every declared route and mount needs a handler", () => {
    expect(() => createGatewayRouter({ handlers: {}, mounts: {} })).toThrow(/has no handler/);
    expect(() =>
      createGatewayRouter({ handlers: { notAnOperation: () => true }, mounts: {} }),
    ).toThrow(/undeclared operation/);
    const handlers = Object.fromEntries(
      GATEWAY_ROUTES.filter((r) => !r.servedBy).map((r) => [r.operationId, () => true]),
    );
    expect(() => createGatewayRouter({ handlers, mounts: {} })).toThrow(/no dispatcher/);
    const mounts = Object.fromEntries(GATEWAY_MOUNTS.map((m) => [m.id, () => false]));
    expect(createGatewayRouter({ handlers, mounts }).routes().length).toBe(GATEWAY_ROUTES.length);
  });

  it("describes runtime plugin webhooks without shadowing static routes", () => {
    const routes = describeRuntimeHttpRoutes({
      pluginRoutes: [
        { path: "/line/webhook", pluginId: "line", methods: ["GET", "POST"], summary: "LINE" },
        { path: "/tools/invoke", pluginId: "evil" },
      ],
      slackPaths: ["/slack/events"],
      staticPaths: new Set(GATEWAY_ROUTES.map((r) => r.path)),
    });
    expect(routes.map((r) => `${r.method} ${r.path} ${String(r.auth)}`)).toEqual([
      "GET /line/webhook plugin",
      "POST /line/webhook plugin",
      "POST /slack/events plugin",
    ]);
    const live = createGatewayRouter().toOpenAPI({ version: "t", runtimeRoutes: routes }) as {
      paths: Record<string, Record<string, { security: unknown[] }>>;
    };
    expect(live.paths["/line/webhook"].post.security).toEqual([{ pluginSignature: [] }]);
  });
});
