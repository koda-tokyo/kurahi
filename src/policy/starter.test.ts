import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toolDecision } from "./decisions.js";
import { parsePolicyText } from "./load.js";
import { STARTER_POLICY_YAML, starterPolicyYaml } from "./starter.js";

const home = path.join(os.tmpdir(), "kolo-starter-home");
const ws = path.join(home, "workspace");

function decide(text: string, tool: string, target: string) {
  const parsed = parsePolicyText(text);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  return toolDecision(
    parsed.policy,
    { agentId: "default", tool, args: { path: target }, workspaceDir: ws },
    os.homedir(),
  );
}

describe("starter policy for a state directory", () => {
  it("parses and keeps the generic entries", () => {
    const parsed = parsePolicyText(starterPolicyYaml(home));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.policy.data?.neverRead).toContain("~/.ssh/**");
      expect(parsed.policy.data?.neverWrite).toContain("/etc/**");
    }
  });

  it("keeps file tools away from the state directory's secrets, policy, config and audit log", () => {
    const text = starterPolicyYaml(home);
    expect(decide(text, "read", path.join(home, "secrets", "gateway.token")).effect).toBe("deny");
    expect(decide(text, "read", "../secrets/policy-owner.json").effect).toBe("deny");
    expect(decide(text, "write", path.join(home, "policy", "policy.yaml")).effect).toBe("deny");
    expect(decide(text, "edit", path.join(home, "kolo.json")).effect).toBe("deny");
    expect(decide(text, "write", path.join(home, "audit", "audit-2026-10.jsonl")).effect).toBe(
      "deny",
    );
    expect(decide(text, "read", path.join(home, "kolo.json")).effect).toBe("allow");
    expect(decide(text, "write", path.join(ws, "notes.md")).effect).toBe("allow");
  });

  it("also guards the file_path alias of the file tools", () => {
    const parsed = parsePolicyText(starterPolicyYaml(home));
    if (!parsed.ok) {
      throw new Error(parsed.errors.join("\n"));
    }
    const decision = toolDecision(
      parsed.policy,
      {
        agentId: "default",
        tool: "read",
        args: { file_path: path.join(home, "secrets", "gateway.token") },
        workspaceDir: ws,
      },
      os.homedir(),
    );
    expect(decision.effect).toBe("deny");
  });

  it("protects an owner key kept outside the state directory", () => {
    const key = path.join(os.tmpdir(), "elsewhere", "owner.json");
    const text = starterPolicyYaml(home, [key]);
    expect(decide(text, "read", key).effect).toBe("deny");
    expect(decide(text, "write", key).effect).toBe("deny");
  });

  it("matches ~/ against the operating-system user's home", () => {
    expect(
      decide(STARTER_POLICY_YAML, "read", path.join(os.homedir(), ".ssh", "id_ed25519")).effect,
    ).toBe("deny");
  });

  it("falls back to the generic policy for a path with glob characters", () => {
    expect(starterPolicyYaml("/srv/kolo[1]")).toBe(STARTER_POLICY_YAML);
    expect(starterPolicyYaml()).toBe(STARTER_POLICY_YAML);
  });
});
