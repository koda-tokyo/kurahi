import { describe, expect, it } from "vitest";
import type { KoLoConfig } from "./types.js";
import {
  applySecureDefaults,
  findLegacyDefaults,
  formatLegacyDefaultWarnings,
} from "./secure-defaults.js";

describe("secure defaults", () => {
  it("a fresh config gets isolation, the sandbox, exec approvals and the supply-chain lock", () => {
    const { config, applied } = applySecureDefaults({}, { identityAgentId: "alice" });
    expect(config.auth).toEqual({ isolation: "explicit", grants: { alice: ["*"] } });
    expect(config.agents?.defaults?.sandbox).toEqual({ mode: "non-main", workspaceAccess: "rw" });
    expect(config.tools?.exec?.unsandboxed).toBe("approve");
    expect(config.integrity?.supplyChain?.mode).toBe("enforce");
    expect(config.memory?.provenance?.mode).toBe("enforce");
    expect(config.agents?.messaging?.signing).toEqual({ mode: "enforce" });
    expect(applied).toEqual([
      'auth.grants.alice=["*"]',
      "auth.isolation=explicit",
      "agents.defaults.sandbox.mode=non-main",
      "tools.exec.unsandboxed=approve",
      "integrity.supplyChain.mode=enforce",
      "memory.provenance.mode=enforce",
      "agents.messaging.signing.mode=enforce",
      "console.terminal.enabled=true",
      "console.terminal.actApprovals=always",
    ]);
    expect(config.console?.terminal).toEqual({ enabled: true, actApprovals: "always" });
    expect(findLegacyDefaults(config)).toEqual([]);
  });

  it("the main agent needs no grant (it owns the main credential store)", () => {
    const { config } = applySecureDefaults({}, { identityAgentId: "main" });
    expect(config.auth).toEqual({ isolation: "explicit" });
  });

  it("never overrides a value that is set", () => {
    const cfg: KoLoConfig = {
      auth: { isolation: "inherit" },
      agents: { defaults: { sandbox: { mode: "off" } }, messaging: { signing: { mode: "off" } } },
      tools: { exec: { unsandboxed: "host" } },
      integrity: { paths: ["SOUL.md"], supplyChain: { mode: "off" } },
      memory: { provenance: { mode: "warn" } },
      console: { terminal: { enabled: false } },
    };
    const { config, applied } = applySecureDefaults(cfg, { identityAgentId: "alice" });
    expect(config).toEqual(cfg);
    expect(applied).toEqual([]);
    // Explicitly chosen legacy values are a decision, not a forgotten default: no warning.
    expect(findLegacyDefaults(cfg)).toEqual([]);
  });

  it("keeps a configured sandbox workspaceAccess", () => {
    const { config } = applySecureDefaults({
      agents: { defaults: { sandbox: { workspaceAccess: "ro" } } },
    });
    expect(config.agents?.defaults?.sandbox).toEqual({ mode: "non-main", workspaceAccess: "ro" });
  });

  it("an existing config without the keys is reported, not changed", () => {
    const cfg: KoLoConfig = { agents: { list: [{ id: "main" }, { id: "ops" }] } };
    const legacy = findLegacyDefaults(cfg);
    expect(legacy.map((d) => [d.key, d.legacy, d.secure])).toEqual([
      ["auth.isolation", "inherit", "explicit"],
      ["agents.defaults.sandbox.mode", "off", "non-main"],
      ["tools.exec.unsandboxed", "host", "approve"],
      ["integrity.supplyChain.mode", "warn", "enforce"],
      ["memory.provenance.mode", "warn", "enforce"],
      ["agents.messaging.signing.mode", "warn", "enforce"],
    ]);
    expect(legacy[0].detail).toMatch(/2 agents inherit/);
    const lines = formatLegacyDefaultWarnings(cfg);
    expect(lines).toHaveLength(6);
    expect(lines[2]).toMatch(/runs commands on the host with no approvals/);
    expect(lines[3]).toMatch(/kurahi skills pin --all/);
    expect(lines[4]).toMatch(/kurahi memory quarantine list/);
    expect(lines[5]).toMatch(/agents\.messaging\.signing\.mode/);
  });

  it("keeps other integrity keys when adding the supply-chain mode", () => {
    const { config } = applySecureDefaults({ integrity: { paths: ["SOUL.md"] } });
    expect(config.integrity).toEqual({ paths: ["SOUL.md"], supplyChain: { mode: "enforce" } });
  });

  it("legacy supply-chain warning points at the pin commands", () => {
    const d = findLegacyDefaults({}).find((x) => x.id === "supply-chain");
    expect(d?.detail).toMatch(/kurahi skills pin --all/);
  });

  it("does not warn about unsandboxed exec when exec is routed to the gateway or a node", () => {
    const cfg: KoLoConfig = { tools: { exec: { host: "gateway" } } };
    expect(findLegacyDefaults(cfg).map((d) => d.id)).not.toContain("exec-unsandboxed");
  });

  it("inter-agent message signing: unset warns, keeps other messaging settings when applied", () => {
    const cfg: KoLoConfig = { agents: { messaging: { signing: { maxAgeSeconds: 60 } } } };
    expect(findLegacyDefaults(cfg).find((d) => d.id === "agent-message-signing")?.detail).toMatch(
      /delivered \(flagged in the audit log\), not rejected/,
    );
    const { config } = applySecureDefaults(cfg);
    expect(config.agents?.messaging?.signing).toEqual({ mode: "enforce", maxAgeSeconds: 60 });
    expect(findLegacyDefaults(config).map((d) => d.id)).not.toContain("agent-message-signing");
  });

  it("a per-agent sandbox counts as configured", () => {
    const cfg: KoLoConfig = { agents: { list: [{ id: "ops", sandbox: { mode: "all" } }] } };
    expect(findLegacyDefaults(cfg).map((d) => d.id)).not.toContain("sandbox");
  });

  it("console terminal: enabled without actApprovals warns; off or unset does not", () => {
    expect(
      findLegacyDefaults({ console: { terminal: { enabled: true } } }).map((d) => d.key),
    ).toContain("console.terminal.actApprovals");
    expect(
      findLegacyDefaults({ console: { terminal: { enabled: false } } }).map((d) => d.key),
    ).not.toContain("console.terminal.actApprovals");
    expect(findLegacyDefaults({}).map((d) => d.key)).not.toContain("console.terminal.actApprovals");
  });
});
