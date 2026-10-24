// Secure defaults for new installations (OWASP ASI03, ASI04, ASI05, ASI06, ASI07, ASI08).
//
// The runtime fallbacks stay what they always were, so an existing config keeps working exactly
// as before. New installations get the secure values written into their config explicitly by
// `kurahi init`, `kurahi setup` and onboarding when they create a fresh config. A config that
// still relies on an old permissive fallback gets a warning from `kurahi doctor` and at gateway
// startup, never a silent change and never a crash.
//
//   setting                          legacy fallback (unset)   new installations
//   auth.isolation                   inherit                   explicit (+ grants[<identity>] = ["*"])
//   agents.defaults.sandbox.mode     off                       non-main (workspaceAccess rw)
//   tools.exec.unsandboxed           host                      approve
//   integrity.supplyChain.mode       warn                      enforce (skills/plugins pinned)
//   memory.provenance.mode           warn                      enforce (src/memory/provenance.ts)
//   agents.messaging.signing.mode    warn                      enforce
//   policy file (budgets, limits)    none                      starter policy, signed by a local owner key
//   console.terminal                 off                       enabled, actApprovals "always"
//
// The console terminal (src/console/terminal) is off when unset, which is the safe side. A config
// that turns it on but leaves `actApprovals` unset falls back to "policy" (the exec-approvals file
// decides) and is reported, like the other permissive fallbacks.
//
// Budgets and job limits live in the signed policy file (src/policy/starter.ts), not in the
// config: `kurahi init` installs and signs the starter policy when none exists.

import type { KoLoConfig } from "./types.js";

export type LegacyDefault = {
  /** Stable id for doctor JSON (`secure-defaults.<id>`). */
  id:
    | "auth-isolation"
    | "sandbox"
    | "exec-unsandboxed"
    | "supply-chain"
    | "memory-provenance"
    | "agent-message-signing"
    | "console-terminal-approvals";
  /** Config key that is unset. */
  key: string;
  /** Behaviour the unset key falls back to. */
  legacy: string;
  /** Value new installations get. */
  secure: string;
  /** One-line consequence and fix. */
  detail: string;
};

export type SecureDefaultsResult = { config: KoLoConfig; applied: string[] };

/**
 * Fill the secure values into keys that are not set. Never overrides a value that is present.
 * `identityAgentId` is the agent `kurahi init` creates; it is granted every credential ("*") so
 * explicit isolation does not lock the owner's own agent out of the keys it was set up with.
 */
export function applySecureDefaults(
  cfg: KoLoConfig,
  opts: { identityAgentId?: string } = {},
): SecureDefaultsResult {
  const applied: string[] = [];
  let next: KoLoConfig = { ...cfg };

  if (next.auth?.isolation === undefined) {
    const grants = { ...next.auth?.grants };
    const id = opts.identityAgentId?.trim();
    if (id && id !== "main" && grants[id] === undefined) {
      grants[id] = ["*"];
      applied.push(`auth.grants.${id}=["*"]`);
    }
    next = {
      ...next,
      auth: {
        ...next.auth,
        isolation: "explicit",
        ...(Object.keys(grants).length > 0 ? { grants } : {}),
      },
    };
    applied.push("auth.isolation=explicit");
  }

  const sandbox = next.agents?.defaults?.sandbox;
  if (sandbox?.mode === undefined) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          sandbox: {
            ...sandbox,
            mode: "non-main",
            ...(sandbox?.workspaceAccess === undefined ? { workspaceAccess: "rw" as const } : {}),
          },
        },
      },
    };
    applied.push("agents.defaults.sandbox.mode=non-main");
  }

  if (next.tools?.exec?.unsandboxed === undefined) {
    next = {
      ...next,
      tools: { ...next.tools, exec: { ...next.tools?.exec, unsandboxed: "approve" } },
    };
    applied.push("tools.exec.unsandboxed=approve");
  }

  if (next.integrity?.supplyChain?.mode === undefined) {
    next = {
      ...next,
      integrity: {
        ...next.integrity,
        supplyChain: { ...next.integrity?.supplyChain, mode: "enforce" },
      },
    };
    applied.push("integrity.supplyChain.mode=enforce");
  }
  if (next.memory?.provenance?.mode === undefined) {
    next = {
      ...next,
      memory: {
        ...next.memory,
        provenance: { ...next.memory?.provenance, mode: "enforce" },
      },
    };
    applied.push("memory.provenance.mode=enforce");
  }
  if (next.agents?.messaging?.signing?.mode === undefined) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        messaging: {
          ...next.agents?.messaging,
          signing: { ...next.agents?.messaging?.signing, mode: "enforce" },
        },
      },
    };
    applied.push("agents.messaging.signing.mode=enforce");
  }

  if (next.console?.terminal === undefined) {
    next = {
      ...next,
      console: { ...next.console, terminal: { enabled: true, actApprovals: "always" } },
    };
    applied.push("console.terminal.enabled=true");
    applied.push("console.terminal.actApprovals=always");
  }

  return { config: next, applied };
}

/** Settings a config leaves to an old permissive fallback (doctor and startup warnings). */
export function findLegacyDefaults(cfg: KoLoConfig): LegacyDefault[] {
  const out: LegacyDefault[] = [];
  const agents = cfg.agents?.list ?? [];
  if (cfg.auth?.isolation === undefined) {
    out.push({
      id: "auth-isolation",
      key: "auth.isolation",
      legacy: "inherit",
      secure: "explicit",
      detail:
        agents.length > 1
          ? `${agents.length} agents inherit the main agent's credentials. Set auth.isolation to "explicit" and list each agent's profiles in auth.grants (\`"*"\` for the owner's agent).`
          : 'Any agent added later inherits the main agent\'s credentials. Set auth.isolation to "explicit" (grant the owner\'s agent `"*"` in auth.grants).',
    });
  }
  const perAgentSandbox = agents.some((a) => a.sandbox?.mode !== undefined);
  if (cfg.agents?.defaults?.sandbox?.mode === undefined && !perAgentSandbox) {
    out.push({
      id: "sandbox",
      key: "agents.defaults.sandbox.mode",
      legacy: "off",
      secure: "non-main",
      detail:
        'No session runs in the container sandbox. Set agents.defaults.sandbox.mode to "non-main" (needs Docker and the sandbox image; without them exec is refused in sandboxed sessions).',
    });
  }
  if (cfg.tools?.exec?.unsandboxed === undefined) {
    const host = cfg.tools?.exec?.host ?? "sandbox";
    if (host === "sandbox") {
      out.push({
        id: "exec-unsandboxed",
        key: "tools.exec.unsandboxed",
        legacy: "host",
        secure: "approve",
        detail:
          'Where no sandbox is active, exec runs commands on the host with no approvals. Set tools.exec.unsandboxed to "approve" (or "deny").',
      });
    }
  }
  if (cfg.integrity?.supplyChain?.mode === undefined) {
    out.push({
      id: "supply-chain",
      key: "integrity.supplyChain.mode",
      legacy: "warn",
      secure: "enforce",
      detail:
        'Unpinned or modified skills and plugins still load (with a warning). Review them, run `kurahi skills pin --all` and `kurahi plugins pin --all`, then set integrity.supplyChain.mode to "enforce".',
    });
  }
  if (cfg.memory?.provenance?.mode === undefined) {
    out.push({
      id: "memory-provenance",
      key: "memory.provenance.mode",
      legacy: "warn",
      secure: "enforce",
      detail:
        'Memory writes made after untrusted input (web, MCP, hooks, files outside the workspace) are tagged and flagged but still land in active memory. Set memory.provenance.mode to "enforce" to hold them for review (`kurahi memory quarantine list`).',
    });
  }
  if (cfg.agents?.messaging?.signing?.mode === undefined) {
    out.push({
      id: "agent-message-signing",
      key: "agents.messaging.signing.mode",
      legacy: "warn",
      secure: "enforce",
      detail:
        'Inter-agent messages that are unsigned, forged, replayed, stale or malformed are delivered (flagged in the audit log), not rejected. Set agents.messaging.signing.mode to "enforce".',
    });
  }
  const terminal = cfg.console?.terminal;
  if (terminal?.enabled === true && terminal.actApprovals === undefined) {
    out.push({
      id: "console-terminal-approvals",
      key: "console.terminal.actApprovals",
      legacy: "policy",
      secure: "always",
      detail:
        'The console terminal is on and act-mode commands follow the exec-approvals allowlist, so allowlisted commands run without asking. Set console.terminal.actApprovals to "always" to approve every command that is not read-only.',
    });
  }
  return out;
}

/** Warning lines for a config's legacy defaults (empty when none). */
export function formatLegacyDefaultWarnings(cfg: KoLoConfig): string[] {
  return findLegacyDefaults(cfg).map(
    (d) =>
      `${d.key} is not set (legacy default ${d.legacy}; new installs use ${d.secure}). ${d.detail}`,
  );
}
