import { describe, expect, it, vi } from "vitest";
import type { AgentMessageSigningMode } from "../../config/types.agents.js";
import type { KoLoConfig } from "../../config/types.js";
import { checkInterAgentAccess } from "./access.js";
import { NonceCache } from "./envelope.js";
import { checkInboundAgentMessage } from "./inbound.js";
import { signAgentMessageParams } from "./signing.js";
import { tempAgentKeyLocations } from "./test-helpers.js";

const CONTEXT = "Agent-to-agent message context:\nAgent 2 (target) session: agent:ops:main.";

function deliver(params: {
  cfg: KoLoConfig;
  mode: AgentMessageSigningMode;
  sender: string;
  recipient: string;
}) {
  const loc = tempAgentKeyLocations();
  const cfg: KoLoConfig = {
    ...params.cfg,
    agents: { ...params.cfg.agents, messaging: { signing: { mode: params.mode } } },
  };
  const message = "hello";
  const audit = vi.fn();
  const decision = checkInboundAgentMessage({
    cfg,
    loc,
    audit,
    replay: new NonceCache(),
    request: {
      message,
      extraSystemPrompt: CONTEXT,
      lane: "nested",
      sessionKey: params.recipient,
      ...signAgentMessageParams({
        cfg,
        senderSessionKey: params.sender,
        recipientSessionKey: params.recipient,
        message,
        extraSystemPrompt: CONTEXT,
        loc,
      }),
    },
  });
  return { decision, audit };
}

describe("receiver-side inter-agent access check", () => {
  it("enforce: a validly signed message to an agent outside tools.agentToAgent.allow is rejected", () => {
    const cfg: KoLoConfig = { tools: { agentToAgent: { enabled: true, allow: ["main", "qa"] } } };
    const { decision, audit } = deliver({
      cfg,
      mode: "enforce",
      sender: "agent:main:main",
      recipient: "agent:ops:main",
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") {
      expect(decision.error).toContain('not-allowed: agent "main" may not message agent "ops"');
    }
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ outcome: "denied" });
  });

  it("enforce: disabled agent-to-agent messaging is rejected even with a valid signature", () => {
    const { decision } = deliver({
      cfg: {},
      mode: "enforce",
      sender: "agent:main:main",
      recipient: "agent:ops:main",
    });
    expect(decision.kind).toBe("reject");
  });

  it("warn: the same message is delivered, flagged in the audit and in the trust line", () => {
    const { decision, audit } = deliver({
      cfg: {},
      mode: "warn",
      sender: "agent:main:main",
      recipient: "agent:ops:main",
    });
    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      expect(decision.verified).toBe(true);
      expect(decision.flagged.join(" ")).toContain("not-allowed");
      expect(decision.message).toContain("Trust: signature verified; flagged (not-allowed");
    }
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ outcome: "flagged" });
  });

  it("allowed pairs and same-agent sessions pass", () => {
    const { decision } = deliver({
      cfg: { tools: { agentToAgent: { enabled: true, allow: ["main", "ops"] } } },
      mode: "enforce",
      sender: "agent:main:main",
      recipient: "agent:ops:main",
    });
    expect(decision.kind).toBe("deliver");
    const same = deliver({
      cfg: {},
      mode: "enforce",
      sender: "agent:main:main",
      recipient: "agent:main:subagent:1",
    });
    expect(same.decision.kind).toBe("deliver");
  });

  it("sub-agents across agent ids follow subagents.allowAgents in both directions", () => {
    const cfg: KoLoConfig = {
      agents: { list: [{ id: "main", subagents: { allowAgents: ["ops"] } }, { id: "ops" }] },
    };
    const base = { cfg };
    // sessions_spawn: main -> ops sub-agent session.
    expect(
      checkInterAgentAccess({
        ...base,
        senderAgentId: "main",
        senderSessionKey: "agent:main:main",
        recipientAgentId: "ops",
        recipientSessionKey: "agent:ops:subagent:abc",
      }),
    ).toBeNull();
    // Announce: ops sub-agent -> main.
    expect(
      checkInterAgentAccess({
        ...base,
        senderAgentId: "ops",
        senderSessionKey: "agent:ops:subagent:abc",
        recipientAgentId: "main",
        recipientSessionKey: "agent:main:main",
      }),
    ).toBeNull();
    // Not a sub-agent session: allowAgents does not open ordinary cross-agent sends.
    expect(
      checkInterAgentAccess({
        ...base,
        senderAgentId: "main",
        senderSessionKey: "agent:main:main",
        recipientAgentId: "ops",
        recipientSessionKey: "agent:ops:main",
      }),
    ).toContain("not-allowed");
    // The reverse spawn (ops may not spawn main) is denied.
    expect(
      checkInterAgentAccess({
        ...base,
        senderAgentId: "ops",
        senderSessionKey: "agent:ops:main",
        recipientAgentId: "main",
        recipientSessionKey: "agent:main:subagent:x",
      }),
    ).toContain("not-allowed");
  });
});
