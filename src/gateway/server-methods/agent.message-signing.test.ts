import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { signAgentMessageParams } from "../../agents/messaging/signing.js";
import { flushAudit } from "../../audit/index.js";
import { agentHandlers } from "./agent.js";

// The gateway `agent` method verifies signed inter-agent envelopes before a run starts.
const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(),
  // Cross-agent sends need tools.agentToAgent; the gateway re-checks it on receipt.
  loadConfigReturn: {
    tools: { agentToAgent: { enabled: true, allow: ["main", "ops"] } },
    agents: { messaging: { signing: { mode: "enforce" } } },
  } as Record<string, unknown>,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: (key: string) => ({
    cfg: mocks.loadConfigReturn,
    storePath: undefined,
    entry: { sessionId: "s-1", updatedAt: Date.now() },
    canonicalKey: key,
  }),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommand: mocks.agentCommand }));
vi.mock("../../config/config.js", () => ({ loadConfig: () => mocks.loadConfigReturn }));
vi.mock("../../agents/agent-scope.js", () => ({ listAgentIds: () => ["main", "ops"] }));
vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
  onAgentEvent: vi.fn(),
}));
vi.mock("../../sessions/send-policy.js", () => ({ resolveSendPolicy: () => "allow" }));

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

let home = "";
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-gw-a2a-"));
  vi.stubEnv("KOLO_HOME", home);
  vi.stubEnv("KOLO_POLICY_OWNER_KEY_FILE", "");
});
afterAll(async () => {
  await flushAudit();
  vi.unstubAllEnvs();
});

async function call(params: Record<string, unknown>) {
  const respond = vi.fn();
  await agentHandlers.agent({
    params: { idempotencyKey: `idem-${Math.random()}`, ...params },
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "agent" },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("gateway agent handler: inter-agent message signing", () => {
  it("rejects an unsigned agent-to-agent message in enforce mode and audits it", async () => {
    const respond = await call({ message: "forged", sessionKey: "agent:ops:main", lane: "nested" });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringMatching(/inter-agent message rejected.*unsigned/),
      }),
    );
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    await flushAudit();
    const auditDir = path.join(home, "audit");
    const lines = fs
      .readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n"));
    const entry = JSON.parse(lines.at(-1) ?? "{}");
    expect(entry).toMatchObject({
      action: "agent.message.verify",
      outcome: "denied",
      scope: "agent:ops:main",
    });
  });

  it("delivers a signed message wrapped with its verified sender", async () => {
    const message = "please summarise the incident";
    const extraSystemPrompt = "Agent-to-agent message context:";
    const signed = signAgentMessageParams({
      cfg: mocks.loadConfigReturn,
      senderSessionKey: "agent:main:main",
      recipientSessionKey: "agent:ops:main",
      message,
      extraSystemPrompt,
    });
    expect(signed.agentEnvelope).toBeDefined();
    // Keys live in the Kurahi home, the private key file is owner-only.
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(home, "secrets", "agent-keys", "main.json")).mode & 0o777).toBe(
        0o600,
      );
    }
    mocks.agentCommand.mockResolvedValue({ payloads: [], meta: {} });
    const respond = await call({
      message,
      extraSystemPrompt,
      sessionKey: "agent:ops:main",
      lane: "nested",
      ...signed,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted" }),
      undefined,
      expect.anything(),
    );
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const args = mocks.agentCommand.mock.calls[0][0];
    expect(args.message).toContain('From: agent "main" (session agent:main:main)');
    expect(args.message).toContain("Trust: signature verified");
    expect(args.extraSystemPrompt).toContain("Inter-agent message provenance");

    // The same envelope again (new idempotency key) is a replay.
    const replay = await call({
      message,
      extraSystemPrompt,
      sessionKey: "agent:ops:main",
      lane: "nested",
      ...signed,
    });
    expect(replay).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/replay/) }),
    );
  });

  it("rejects a validly signed message between agents outside tools.agentToAgent.allow", async () => {
    const message = "please summarise the incident";
    const extraSystemPrompt = "Agent-to-agent message context:";
    const signed = signAgentMessageParams({
      cfg: mocks.loadConfigReturn,
      senderSessionKey: "agent:intruder:main",
      recipientSessionKey: "agent:ops:main",
      message,
      extraSystemPrompt,
    });
    expect(signed.agentEnvelope).toBeDefined();
    const respond = await call({
      message,
      extraSystemPrompt,
      sessionKey: "agent:ops:main",
      lane: "nested",
      ...signed,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/not-allowed: agent "intruder"/) }),
    );
  });
});
