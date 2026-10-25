import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type { ApprovalsConfig } from "./types.approvals.js";
import type { AuthConfig } from "./types.auth.js";
import type { DiagnosticsConfig, LoggingConfig, SessionConfig, WebConfig } from "./types.base.js";
import type { BrowserConfig } from "./types.browser.js";
import type { ChannelsConfig } from "./types.channels.js";
import type { ConsoleConfig } from "./types.console.js";
import type { CronConfig } from "./types.cron.js";
import type { EvidenceConfig } from "./types.evidence.js";
import type { FactoryConfig } from "./types.factory.js";
import type { FormatConfig } from "./types.format.js";
import type {
  CanvasHostConfig,
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type { LspConfig } from "./types.lsp.js";
import type { McpConfig } from "./types.mcp.js";
import type { MemoryConfig } from "./types.memory.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ModelsConfig } from "./types.models.js";
import type { NodeHostConfig } from "./types.node-host.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { SkillsConfig } from "./types.skills.js";
import type { SnapshotsConfig } from "./types.snapshots.js";
import type { ToolsConfig } from "./types.tools.js";
import type { TuiConfig } from "./types.tui.js";
import type { VoiceConfig } from "./types.voice.js";

export type KoLoConfig = {
  meta?: {
    /** Last Kurahi version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  /**
   * Release profile. "enterprise" refuses excluded and unclassified plugins
   * (src/plugins/profile-gate.ts, docs/security/enterprise-profile.md); `KURAHI_PROFILE=enterprise`
   * has the same effect. Unset or "standard": no profile restrictions.
   */
  profile?: "standard" | "enterprise";
  auth?: AuthConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */
    channel?: "stable" | "beta" | "dev";
    /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean;
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for Kurahi UI chrome (hex). */
    seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  skills?: SkillsConfig;
  /**
   * Terminal UI (`kurahi tui`) preferences (KoLo 2.0, M9a). `theme` is one of the built-in names
   * (`dark`, `light`, `high-contrast`); `keybinds` maps an action to a key id
   * (`ctrl+p`, `alt+enter`, ...). Unknown actions are ignored.
   */
  tui?: TuiConfig;
  /**
   * Language server integration (KoLo 2.0, M9b). `servers.<lang>` describes a stdio language
   * server by command; servers whose command is not on PATH are skipped. Built-in defaults cover
   * typescript, python, go, rust and java; `enabled: false` turns the capability off.
   */
  lsp?: LspConfig;
  /** Formatters run after file-edit tools (KoLo 2.0, M10). */
  format?: FormatConfig;
  /** File snapshots before tool edits, with undo and redo (KoLo 2.0, M10). */
  snapshots?: SnapshotsConfig;
  /** Kurahi Work Console: the gateway-owned terminal broker (off unless enabled). */
  console?: ConsoleConfig;
  /** Evidence bundles: a signed, hash-chained event log per job (KoLo 2.0, M12). */
  evidence?: EvidenceConfig;
  /** The factory: boards, cards, engine runs and pull requests (KoLo 2.0, M15). */
  factory?: FactoryConfig;
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  /** Memory subsystem behavior (post-turn STM write ack, etc.). */
  memory?: MemoryConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  canvasHost?: CanvasHostConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  /** MCP servers this gateway connects to as a client (KoLo 2.0, M6). */
  mcp?: McpConfig;
  /** Push-to-talk speech adapters (Work Console). Off by default; see docs/tools/voice.md. */
  voice?: VoiceConfig;
  /**
   * Boot integrity gate (KoLo 2.0, M2b). `paths` are the constitution globs `kurahi integrity init`
   * registers (relative to KOLO_HOME or absolute). The registry itself is the source of truth.
   */
  integrity?: {
    paths?: string[];
    /**
     * Supply-chain lock (OWASP ASI04, docs/security/skill-integrity.md). Skills and plugin
     * packages are verified against `<KOLO_HOME>/integrity/supply-chain.lock.json` at load.
     * enforce: unpinned or modified ones are refused; warn (fallback when unset): loaded with a
     * warning; off: no check. New installations get enforce.
     */
    supplyChain?: {
      mode?: "off" | "warn" | "enforce";
    };
  };
  /**
   * Policy as code (KoLo 2.0, M13). The document lives in `<KOLO_HOME>/policy/policy.yaml`; only
   * the enforcement mode is configured here (KOLO_POLICY_MODE overrides it), so a document can
   * never downgrade its own gate. enforce (default): unsigned refused; audit: loaded with a
   * warning; off: inert.
   */
  policy?: {
    mode?: "enforce" | "audit" | "off";
  };
  /**
   * Inbound file security (docs/security/attachment-intake.md). Attachments a connector fetches
   * are quarantined, checked by a static policy, scanned and only then stored in the Project.
   */
  security?: {
    attachments?: {
      /** Malware scanner: auto (ClamAV, then Microsoft Defender, else none), or one of them. */
      scanner?: "auto" | "clamav" | "defender" | "none";
      /** Refuse files no scanner checked (default true). */
      requireScan?: boolean;
      /** Wall clock per scan (default 120, at most 600). */
      scanTimeoutSeconds?: number;
      /** Wall clock of the isolated text extraction (default 30, at most 300). */
      extractTimeoutSeconds?: number;
      /** V8 heap of the extraction child, MB (default 256). */
      extractMaxOldSpaceMb?: number;
    };
  };
  /**
   * KIP headless engine bridge (KoLo 2.0, M5b). Powers the `kip_engine_task` agent tool.
   * Disabled by default; when enabled, `baseUrl` must point at the engine's loopback HTTP API.
   */
  kipEngine?: {
    /** Register the kip_engine_task tool (default false). */
    enabled?: boolean;
    /** Loopback base URL of the KIP headless engine, e.g. http://127.0.0.1:18990 */
    baseUrl?: string;
    /** Path to a file holding the bearer token for the engine API. */
    tokenFile?: string;
    /** Default cap for waiting on task completion (ms). Default 300000. */
    taskTimeoutMs?: number;
  };
  /**
   * Sibling gateways/agents on this host or elsewhere. Replaces the pre-2.0
   * assumption that every sibling lives at `$HOME/.kolo/workspace-<id>`.
   */
  siblings?: SiblingConfig[];
};

export type SiblingConfig = {
  /** Agent id (e.g. "alice"). */
  id: string;
  /** Sibling's state root (its KOLO_HOME). */
  stateDir?: string;
  /** Sibling's workspace dir (inbox lives at `<workspaceDir>/inbox`). */
  workspaceDir?: string;
  /** Sibling gateway base URL (ws:// or http://). */
  url?: string;
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: KoLoConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
