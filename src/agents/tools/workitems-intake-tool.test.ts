import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Any gateway connection the tool opens goes through callGateway: count them.
const gatewayCalls = vi.hoisted(() => [] as Array<{ method: string; params: unknown }>);
vi.mock("../../gateway/call.js", async (orig) => ({
  ...(await orig<typeof import("../../gateway/call.js")>()),
  callGateway: vi.fn(async (opts: { method: string; params: unknown }) => {
    gatewayCalls.push({ method: opts.method, params: opts.params });
    return { item: { id: "remote", status: "new", queue: "q" }, created: true };
  }),
}));

import { flushAudit } from "../../audit/audit-log.js";
import { clearGatewayInProcess, markGatewayInProcess } from "../../gateway/in-process.js";
import { projectSessionKey } from "../../projects/scope.js";
import { createProject } from "../../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../../projects/templates.js";
import { readWorkItem } from "../../workitems/store.js";
import { createWorkitemsIntakeTool } from "./workitems-intake-tool.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-intake-tool-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

let projectId = "";
let other = "";
const events: Array<{ event: string; payload: unknown }> = [];

const params = (messageId: string, over: Record<string, unknown> = {}) => ({
  queue: "ga-requests",
  title: "Room booking",
  type: "request",
  priority: "normal",
  summary: "Asks to book the meeting room on Friday.",
  source: { kind: "email", connector: "microsoft-365", messageId, from: "a@client.example.jp" },
  ...over,
});

async function run(tool: ReturnType<typeof createWorkitemsIntakeTool>, args: unknown) {
  const res = (await tool!.execute("t1", args as Record<string, unknown>)) as {
    details?: Record<string, unknown>;
  };
  return res.details as { created: boolean; id: string | null; status: string | null };
}

beforeAll(() => {
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-general-affairs",
  )!;
  for (const name of ["ga", "other"]) {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true });
    const id = createProject({ name, folder }, { createdBy: "device:admin", template }).id;
    if (name === "ga") {
      projectId = id;
    } else {
      other = id;
    }
  }
});

beforeEach(() => {
  gatewayCalls.length = 0;
  events.length = 0;
  clearGatewayInProcess();
});

afterAll(async () => {
  clearGatewayInProcess();
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workitems_intake_email", () => {
  it("inside the gateway: calls intake in process, opens no gateway connection", async () => {
    markGatewayInProcess({ broadcast: (event, payload) => events.push({ event, payload }) });
    const tool = createWorkitemsIntakeTool({
      agentSessionKey: projectSessionKey("main", projectId, "c1"),
    });
    // The model cannot pick another Project: the session's Project is always used.
    const first = await run(tool, { ...params("MSG-1"), projectId: other });
    expect(first.created).toBe(true);
    const item = readWorkItem(projectId, first.id!)!;
    expect(item.createdBy).toMatch(/^device:/);
    expect(item.history[0]).toMatchObject({ actorKind: "agent" });
    expect(item.source.origin).toMatchObject({ messageId: "MSG-1" });
    expect(events.map((e) => e.event)).toEqual(["workitems.changed"]);
    // Idempotent per message, like the gateway method.
    const again = await run(tool, params("MSG-1"));
    expect(again).toMatchObject({ created: false, id: first.id });
    expect(events).toHaveLength(1);
    // Same validation as workitems.intakeEmail.
    await expect(run(tool, params("MSG-2", { flags: ["urgent"] }))).rejects.toThrow(
      /invalid workitems.intakeEmail params/,
    );
    // Many calls (an autopilot run), still no connection.
    for (let i = 0; i < 12; i++) {
      await run(tool, params(`MSG-load-${i}`));
    }
    expect(gatewayCalls).toEqual([]);
  });

  it("outside the gateway (or with an explicit gateway URL): goes through the gateway", async () => {
    const key = projectSessionKey("main", projectId, "c1");
    const remote = await run(createWorkitemsIntakeTool({ agentSessionKey: key }), params("R-1"));
    expect(remote).toMatchObject({ created: true, id: "remote" });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({
      method: "workitems.intakeEmail",
      params: { projectId, source: { messageId: "R-1" } },
    });
    markGatewayInProcess({ broadcast: () => {} });
    await run(
      createWorkitemsIntakeTool({
        agentSessionKey: key,
        gateway: { gatewayUrl: "wss://gateway.example:18789" },
      }),
      params("R-2"),
    );
    expect(gatewayCalls).toHaveLength(2);
  });

  it("inside a gateway configured with gateway.mode=remote: goes through the gateway", async () => {
    markGatewayInProcess({ broadcast: () => {} });
    const key = projectSessionKey("main", projectId, "c1");
    await run(
      createWorkitemsIntakeTool({ agentSessionKey: key, remoteMode: () => true }),
      params("R-3"),
    );
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ params: { source: { messageId: "R-3" } } });
  });

  it("is offered only in project sessions", () => {
    expect(createWorkitemsIntakeTool({ agentSessionKey: "agent:main:main" })).toBeNull();
  });
});
