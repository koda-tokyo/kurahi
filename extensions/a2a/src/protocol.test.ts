import { describe, expect, it } from "vitest";
import { buildAgentCard, resolveBaseUrl } from "./agent-card.js";
import { parseA2aConfig } from "./config.js";
import {
  A2aRpcError,
  checkVersionHeader,
  lookupMethod,
  parseInboundMessage,
  parseTaskState,
  RpcError,
  sendResult,
  statusUpdateEvent,
  type TaskView,
} from "./protocol.js";

const TOKEN = "t".repeat(40);

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    server: {
      enabled: true,
      agents: [
        {
          agentId: "Main",
          slug: "helpdesk",
          name: "Helpdesk",
          description: "Answers product questions.",
          instructions: "SECRET-OPERATOR-NOTE /home/operator/private",
          skills: [{ id: "faq", name: "FAQ", description: "Product FAQ", tags: ["support"] }],
        },
      ],
      clients: [{ id: "partner", token: TOKEN, agents: ["helpdesk"] }],
      ...overrides,
    },
  };
}

describe("a2a config", () => {
  it("is off by default and needs nothing", () => {
    const cfg = parseA2aConfig(undefined);
    expect(cfg.server.enabled).toBe(false);
    expect(cfg.server.allowNonLoopback).toBe(false);
    expect(cfg.server.agents).toEqual([]);
    expect(cfg.client.agents).toEqual([]);
  });

  it("rejects short tokens, unknown slugs and shared tokens", () => {
    expect(() =>
      parseA2aConfig(baseConfig({ clients: [{ id: "a", token: "short", agents: ["helpdesk"] }] })),
    ).toThrow(/at least 32/);
    expect(() =>
      parseA2aConfig(baseConfig({ clients: [{ id: "a", token: TOKEN, agents: ["nope"] }] })),
    ).toThrow(/unknown agent slug/);
    expect(() =>
      parseA2aConfig(
        baseConfig({
          clients: [
            { id: "a", token: TOKEN, agents: ["helpdesk"] },
            { id: "b", token: TOKEN, agents: ["helpdesk"] },
          ],
        }),
      ),
    ).toThrow(/share a token/);
  });

  it("defaults the slug to the lower-cased agent id", () => {
    const cfg = parseA2aConfig(
      baseConfig({
        agents: [
          {
            agentId: "Ops",
            name: "Ops",
            description: "d",
            skills: [{ id: "s", name: "S", description: "d" }],
          },
        ],
        clients: [{ id: "a", token: TOKEN, agents: ["ops"] }],
      }),
    );
    expect(cfg.server.agents[0].slug).toBe("ops");
  });
});

describe("agent card", () => {
  const cfg = parseA2aConfig(
    baseConfig({ provider: { organization: "Example", url: "https://example.com" } }),
  );
  const agent = cfg.server.agents[0];

  it("builds a v0.3 card from operator config only", () => {
    const card = buildAgentCard({
      server: cfg.server,
      agent,
      baseUrl: "https://a.example",
      dialect: "0.3",
    });
    expect(card).toMatchObject({
      protocolVersion: "0.3.0",
      name: "Helpdesk",
      url: "https://a.example/a2a/helpdesk",
      preferredTransport: "JSONRPC",
      capabilities: { streaming: true, pushNotifications: false },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
      skills: [{ id: "faq", name: "FAQ", tags: ["support"] }],
    });
  });

  it("builds a v1.0 card with supportedInterfaces and securityRequirements", () => {
    const card = buildAgentCard({
      server: cfg.server,
      agent,
      baseUrl: "https://a.example",
      dialect: "1.0",
    });
    expect(card).toMatchObject({
      supportedInterfaces: [
        {
          url: "https://a.example/a2a/helpdesk",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
        { protocolVersion: "0.3" },
      ],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      capabilities: { extendedAgentCard: false },
    });
    expect(card).not.toHaveProperty("url");
  });

  it("never publishes the agent id, instructions, tool or model settings", () => {
    for (const dialect of ["0.3", "1.0"] as const) {
      const json = JSON.stringify(
        buildAgentCard({ server: cfg.server, agent, baseUrl: "https://a.example", dialect }),
      );
      expect(json).not.toContain("Main");
      expect(json).not.toContain("SECRET-OPERATOR-NOTE");
      expect(json).not.toContain("/home/");
      expect(json).not.toContain("allowTools");
      expect(json).not.toContain("timeoutSeconds");
    }
  });

  it("uses publicUrl, else only a loopback Host header", () => {
    expect(resolveBaseUrl({ publicUrl: "https://x.example/" }, "evil.example", 1)).toBe(
      "https://x.example",
    );
    expect(resolveBaseUrl({}, "127.0.0.1:18789", 1)).toBe("http://127.0.0.1:18789");
    expect(resolveBaseUrl({}, "evil.example", 18789)).toBe("http://127.0.0.1:18789");
  });
});

describe("protocol", () => {
  it("maps both dialects' method names", () => {
    expect(lookupMethod("message/send")).toEqual({ kind: "send", dialect: "0.3" });
    expect(lookupMethod("SendMessage")).toEqual({ kind: "send", dialect: "1.0" });
    expect(lookupMethod("CancelTask")).toEqual({ kind: "cancel", dialect: "1.0" });
    expect(lookupMethod("toString")).toBeUndefined();
  });

  it("checks the A2A-Version header", () => {
    expect(checkVersionHeader(undefined)).toBeNull();
    expect(checkVersionHeader("0.3")).toBeNull();
    expect(checkVersionHeader("1.0")).toBeNull();
    expect(checkVersionHeader("2.1")).toMatch(/not supported/);
  });

  it("rejects file parts with ContentTypeNotSupported", () => {
    const params = {
      message: { messageId: "m1", role: "user", parts: [{ kind: "file", file: { uri: "x" } }] },
    };
    try {
      parseInboundMessage(params, { maxParts: 5 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(A2aRpcError);
      expect((err as A2aRpcError).code).toBe(RpcError.ContentTypeNotSupported);
    }
  });

  it("accepts v1 and v0.3 message shapes and reads blocking flags", () => {
    const v1 = parseInboundMessage(
      {
        message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] },
        configuration: { returnImmediately: true },
      },
      { maxParts: 5 },
    );
    expect(v1.message.parts).toEqual([{ kind: "text", text: "hi" }]);
    expect(v1.blocking).toBe(false);
    const v03 = parseInboundMessage(
      {
        message: {
          kind: "message",
          messageId: "m",
          role: "user",
          parts: [{ kind: "data", data: { a: 1 } }],
        },
      },
      { maxParts: 5 },
    );
    expect(v03.blocking).toBe(true);
    expect(() =>
      parseInboundMessage(
        { message: { messageId: "m", role: "agent", parts: [{ text: "x" }] } },
        { maxParts: 5 },
      ),
    ).toThrow(/role must be user/);
  });

  it("serialises tasks per dialect", () => {
    const task: TaskView = {
      id: "t1",
      contextId: "c1",
      status: { state: "completed", timestamp: "2026-01-01T00:00:00.000Z" },
      history: [],
      artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "ok" }] }],
    };
    expect(sendResult(task, "0.3")).toMatchObject({
      kind: "task",
      status: { state: "completed" },
      artifacts: [{ parts: [{ kind: "text", text: "ok" }] }],
    });
    expect(sendResult(task, "1.0")).toMatchObject({
      task: { status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ parts: [{ text: "ok" }] }] },
    });
    expect(statusUpdateEvent(task, "0.3")).toMatchObject({ kind: "status-update", final: true });
    expect(statusUpdateEvent(task, "1.0")).toHaveProperty("statusUpdate.taskId", "t1");
    expect(parseTaskState("TASK_STATE_WORKING")).toBe("working");
    expect(parseTaskState("input-required")).toBe("input-required");
  });
});
