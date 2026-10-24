import type {
  AgentDefaultsConfig,
  AgentLimitsConfig,
  AgentReasoningConfig,
} from "./types.agent-defaults.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { MemoryConfig } from "./types.memory.js";
import type { GroupChatConfig } from "./types.messages.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  /** Per-run step limit + doom-loop thresholds (M5 agent controls). */
  limits?: AgentLimitsConfig;
  /** Permission globs: `class:pattern` rules, e.g. "write:/workspace/**", "exec:git *". */
  permissions?: string[];
  model?: AgentModelConfig;
  memorySearch?: MemorySearchConfig;
  /** Per-agent memory subsystem overrides (post-turn STM write ack). */
  memory?: MemoryConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
  /** Overrides `agents.defaults.reasoning` for this agent. */
  reasoning?: AgentReasoningConfig;
};

export type ConsciousnessAgentConfig = {
  userId: string;
  name?: string;
  tickIntervalMs?: number;
  perceptionSources?: string[];
  model?: string;
  provider?: string;
  bridgeRepo?: string;
  quietHours?: { start: number; end: number; timezone?: string };
  /** Path to heartbeat prompt file. Auto-resolved if not set. */
  heartbeatPromptPath?: string;
};

export type ConsciousnessConfig = {
  enabled?: boolean;
  garageMode?: boolean;
  agents?: ConsciousnessAgentConfig[];
};

export type AgentMessageSigningMode = "off" | "warn" | "enforce";

/** Signed inter-agent messages (OWASP ASI07). See docs/security/agent-message-signing.md. */
export type AgentMessageSigningConfig = {
  /**
   * off: no envelopes, no checks. warn: sign, verify and flag failures (audit + log) but deliver.
   * enforce: reject inter-agent messages that fail verification or payload validation.
   * Unset falls back to warn (legacy installs); new installations get enforce.
   */
  mode?: AgentMessageSigningMode;
  /** Accepted clock skew / message age in seconds (default 300). */
  maxAgeSeconds?: number;
  /** Maximum inter-agent payload size in bytes, message plus context (default 262144). */
  maxPayloadBytes?: number;
};

export type AgentMessagingConfig = {
  signing?: AgentMessageSigningConfig;
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
  /** N7 Consciousness — sentient-tier agent configuration. */
  consciousness?: ConsciousnessConfig;
  /** Inter-agent messaging security (signing, verification, payload limits). */
  messaging?: AgentMessagingConfig;
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};
