import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KoLoConfig } from "../config/config.js";

// The exec host is configuration, never the model's choice. A model-supplied host is ignored
// (the call runs where it would have run without it), the schema stops offering parameters
// that can only be ignored or refused, and no parameter reaches a host that is not configured.
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const isWin = process.platform === "win32";
let prevHome: string | undefined;
let tempDir: string;

beforeEach(async () => {
  prevHome = process.env.HOME;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kurahi-exec-host-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  vi.resetAllMocks();
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
  await (await import("../audit/audit-log.js")).flushAudit();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.find((c) => c.type === "text")?.text ?? "";

const schemaKeys = (tool: { parameters: unknown }) =>
  Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties).toSorted();

describe("exec tool schema", () => {
  it("offers host/security/ask/node when the host is not pinned", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const keys = schemaKeys(createExecTool({ host: "sandbox" }));
    expect(keys).toEqual(expect.arrayContaining(["host", "security", "ask", "node", "command"]));
  });

  it("omits host/security/ask/node when the host is pinned", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const keys = schemaKeys(createExecTool({ host: "gateway", hostPinned: true }));
    expect(keys).toContain("command");
    for (const k of ["host", "security", "ask", "node"]) {
      expect(keys).not.toContain(k);
    }
  });

  it("keeps node (and only node) when the pinned host is node", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const keys = schemaKeys(createExecTool({ host: "node", hostPinned: true }));
    expect(keys).toContain("node");
    expect(keys).not.toContain("host");
  });
});

describe.skipIf(isWin)("model-supplied exec host", () => {
  it("is ignored: the command runs on the configured host instead of failing", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      hostPinned: true,
    });
    for (const host of ["node", "sandbox", "Node", "localhost"]) {
      const result = await tool.execute(`c-${host}`, { command: "echo pinned-ok", host });
      expect(text(result)).toContain("pinned-ok");
    }
    // Never routed to a node (node.invoke / node.list go through the gateway tool).
    expect(vi.mocked(callGatewayTool)).not.toHaveBeenCalled();
  });

  it("cannot escape a denying configuration through another host", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const { createExecTool } = await import("./bash-tools.exec.js");
    const denied = createExecTool({ host: "gateway", security: "deny", ask: "off" });
    await expect(denied.execute("d1", { command: "echo x", host: "node" })).rejects.toThrow(
      /host=gateway security=deny/,
    );
    const noSandbox = createExecTool({ host: "sandbox", unsandboxed: "deny" });
    await expect(noSandbox.execute("d2", { command: "echo x", host: "gateway" })).rejects.toThrow(
      /no sandbox is active.*unsandboxed is deny/,
    );
    expect(vi.mocked(callGatewayTool)).not.toHaveBeenCalled();
  });

  it("security and ask from the model can still only tighten", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    await expect(
      tool.execute("t1", { command: "echo x", host: "node", security: "deny" }),
    ).rejects.toThrow(/security=deny/);
  });
});

describe.skipIf(isWin)("KOLO_EXEC_ORIGIN", () => {
  it("is set by the runtime and cannot be spoofed through the model's env", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const agentTool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const spoofed = await agentTool.execute("o1", {
      command: 'echo "origin=$KOLO_EXEC_ORIGIN"',
      env: { KOLO_EXEC_ORIGIN: "cron" },
    });
    expect(text(spoofed)).toContain("origin=agent");
    const cronTool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      origin: "cron",
    });
    const cron = await cronTool.execute("o2", { command: 'echo "origin=$KOLO_EXEC_ORIGIN"' });
    expect(text(cron)).toContain("origin=cron");
  });
});

describe("resolveExecConfig", () => {
  const cfg = (globalExec: object, agentExec?: object) =>
    ({
      tools: { exec: globalExec },
      agents: { list: [{ id: "ops", ...(agentExec ? { tools: { exec: agentExec } } : {}) }] },
    }) as unknown as KoLoConfig;

  it("applies the agent's exec host and timings over the global block", async () => {
    const { resolveExecConfig } = await import("./pi-tools.js");
    const r = resolveExecConfig(
      cfg({ host: "sandbox", timeoutSec: 30 }, { host: "gateway", timeoutSec: 600 }),
      "ops",
    );
    expect(r.host).toBe("gateway");
    expect(r.timeoutSec).toBe(600);
    expect(resolveExecConfig(cfg({ host: "sandbox" }), "ops").host).toBe("sandbox");
    expect(resolveExecConfig(cfg({}, { host: "gateway" }), "other").host).toBeUndefined();
  });

  it("lets an agent tighten security and ask, never loosen them", async () => {
    const { resolveExecConfig } = await import("./pi-tools.js");
    const loosen = resolveExecConfig(
      cfg({ security: "allowlist", ask: "always" }, { security: "full", ask: "off" }),
      "ops",
    );
    expect(loosen.security).toBe("allowlist");
    expect(loosen.ask).toBe("always");
    const tighten = resolveExecConfig(
      cfg({ security: "full", ask: "off" }, { security: "allowlist", ask: "on-miss" }),
      "ops",
    );
    expect(tighten.security).toBe("allowlist");
    expect(tighten.ask).toBe("on-miss");
    const agentOnly = resolveExecConfig(cfg({}, { security: "allowlist", ask: "off" }), "ops");
    expect(agentOnly.security).toBe("allowlist");
    expect(agentOnly.ask).toBe("off");
  });
});

describe("createKoLoCodingTools exec wiring", () => {
  it("pins the host from the agent's exec block and hides the host parameter", async () => {
    const { createKoLoCodingTools } = await import("./pi-tools.js");
    const config = {
      tools: { exec: { unsandboxed: "approve" } },
      agents: {
        list: [
          {
            id: "ops",
            sandbox: { mode: "off" },
            tools: {
              allow: ["exec"],
              exec: { host: "gateway", security: "allowlist", ask: "off" },
            },
          },
        ],
      },
    } as unknown as KoLoConfig;
    const tools = createKoLoCodingTools({
      config,
      sessionKey: "agent:ops:cron:job-1",
      workspaceDir: tempDir,
    });
    const exec = tools.find((t) => t.name === "exec");
    expect(exec).toBeDefined();
    expect(schemaKeys(exec as { parameters: unknown })).not.toContain("host");
  });
});
