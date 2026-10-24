import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NonceCache } from "./messaging/envelope.js";
import { checkInboundAgentMessage } from "./messaging/inbound.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

const { markSteeredAnnounce, sendAnnounce } = await import("./subagent-announce-delivery.js");

let home = "";
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-announce-sign-"));
  vi.stubEnv("KOLO_HOME", home);
  vi.stubEnv("KOLO_POLICY_OWNER_KEY_FILE", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("queued sub-agent announces", () => {
  it("are signed with the child session key and verify at the gateway", async () => {
    mocks.callGateway.mockResolvedValue({});
    await sendAnnounce({
      prompt: "A background task finished.\nFindings:\nall green",
      enqueuedAt: Date.now(),
      sessionKey: "agent:main:main",
      senderSessionKey: "agent:main:subagent:abc",
    });
    const params = mocks.callGateway.mock.calls[0]?.[0]?.params as Record<string, unknown>;
    expect(params.agentEnvelope).toBeDefined();
    const decision = checkInboundAgentMessage({
      cfg: { agents: { messaging: { signing: { mode: "enforce" } } } },
      request: {
        message: params.message as string,
        sessionKey: params.sessionKey as string,
        agentEnvelope: params.agentEnvelope,
      },
      replay: new NonceCache(),
      audit: () => {},
    });
    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      expect(decision.verified).toBe(true);
      expect(decision.senderAgentId).toBe("main");
    }
  });

  it("without a sender session (the overflow summary) go out unsigned", async () => {
    mocks.callGateway.mockClear();
    mocks.callGateway.mockResolvedValue({});
    await sendAnnounce({
      prompt: "2 announces dropped",
      enqueuedAt: 0,
      sessionKey: "agent:main:main",
    });
    const params = mocks.callGateway.mock.calls[0]?.[0]?.params as Record<string, unknown>;
    expect(params.agentEnvelope).toBeUndefined();
  });

  it("collect mode never merges items from different child sessions", async () => {
    const sent: AnnounceQueueItem[] = [];
    const send = async (item: AnnounceQueueItem) => {
      sent.push(item);
    };
    const settings = { mode: "collect" as const, debounceMs: 20 };
    const item = (prompt: string, sender: string): AnnounceQueueItem => ({
      prompt,
      enqueuedAt: Date.now(),
      sessionKey: "agent:main:main",
      senderSessionKey: sender,
    });
    enqueueAnnounce({ key: "k-mixed", item: item("one", "agent:main:subagent:a"), settings, send });
    enqueueAnnounce({ key: "k-mixed", item: item("two", "agent:ops:subagent:b"), settings, send });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => [s.prompt, s.senderSessionKey])).toEqual([
      ["one", "agent:main:subagent:a"],
      ["two", "agent:ops:subagent:b"],
    ]);

    const same: AnnounceQueueItem[] = [];
    const sendSame = async (i: AnnounceQueueItem) => {
      same.push(i);
    };
    enqueueAnnounce({
      key: "k-same",
      item: item("a1", "agent:main:subagent:a"),
      settings,
      send: sendSame,
    });
    enqueueAnnounce({
      key: "k-same",
      item: item("a2", "agent:main:subagent:a"),
      settings,
      send: sendSame,
    });
    await vi.waitFor(() => expect(same).toHaveLength(1));
    expect(same[0]?.senderSessionKey).toBe("agent:main:subagent:a");
    expect(same[0]?.prompt).toContain("a1");
    expect(same[0]?.prompt).toContain("a2");
  });
});

describe("steered sub-agent announces", () => {
  it("are wrapped as untrusted when the child is another agent", () => {
    const text = markSteeredAnnounce({
      text: "Findings: done",
      childSessionKey: "agent:ops:subagent:x",
      requesterSessionKey: "agent:main:main",
    });
    expect(text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(text).toContain('From: agent "ops" (session agent:ops:subagent:x)');
    expect(text).toContain("not signature-checked");
  });

  it("are left as they are for the requester's own sub-agents", () => {
    expect(
      markSteeredAnnounce({
        text: "Findings: done",
        childSessionKey: "agent:main:subagent:x",
        requesterSessionKey: "agent:main:main",
      }),
    ).toBe("Findings: done");
  });
});
