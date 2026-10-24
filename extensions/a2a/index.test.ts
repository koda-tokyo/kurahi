import { describe, expect, it } from "vitest";
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import plugin from "./index.js";

function fakeApi(pluginConfig: Record<string, unknown>) {
  const routes: string[] = [];
  const tools: Array<{ names?: string[]; optional?: boolean }> = [];
  const logs: string[] = [];
  const api = {
    id: "a2a",
    pluginConfig,
    config: {},
    runtime: { config: { loadConfig: () => ({}) } },
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      debug: () => {},
    },
    registerHttpRoute: (p: { path: string }) => routes.push(p.path),
    registerTool: (_t: unknown, opts: { names?: string[]; optional?: boolean }) => tools.push(opts),
    lifecycle: { onDispose: () => {} },
    audit: () => {},
  } as unknown as KoLoPluginApi;
  return { api, routes, tools, logs };
}

const TOKEN = "s".repeat(40);
const server = {
  agents: [
    {
      agentId: "main",
      slug: "helper",
      name: "Helper",
      description: "d",
      skills: [{ id: "s", name: "S", description: "d" }],
    },
  ],
  clients: [{ id: "peer", token: TOKEN, agents: ["helper"] }],
  defaultAgent: "helper",
};

describe("a2a plugin registration", () => {
  it("registers nothing with an empty config", () => {
    const h = fakeApi({});
    plugin.register(h.api);
    expect(h.routes).toEqual([]);
    expect(h.tools).toEqual([]);
  });

  it("does not serve listed agents until server.enabled", () => {
    const h = fakeApi({ server });
    plugin.register(h.api);
    expect(h.routes).toEqual([]);
  });

  it("mounts the endpoints when enabled and never logs a token", () => {
    const h = fakeApi({ server: { ...server, enabled: true } });
    plugin.register(h.api);
    expect(h.routes).toEqual([
      "/a2a/helper",
      "/a2a/helper/.well-known/agent-card.json",
      "/.well-known/agent-card.json",
    ]);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  it("registers the client tools as optional when remote agents are listed", () => {
    const h = fakeApi({
      client: { agents: [{ name: "peer", cardUrl: "https://p.example/card" }] },
    });
    plugin.register(h.api);
    expect(h.tools).toEqual([{ names: ["a2a_send", "a2a_get_task"], optional: true }]);
  });

  it("rejects an invalid config", () => {
    const h = fakeApi({
      server: { ...server, clients: [{ id: "x", token: "short", agents: ["helper"] }] },
    });
    expect(() => plugin.register(h.api)).toThrow(/invalid a2a config/);
  });
});
