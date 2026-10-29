/**
 * risk-classifier.ts — Tool Risk Classification System
 *
 * Ported from Claude Code's permission architecture (spec 05).
 * Every tool action carries a risk tier. This drives the permission
 * mode decision: LOW can auto-approve, MEDIUM gets LLM explainer,
 * HIGH always requires interactive approval.
 *
 * CC Reference: spec/05_components_agents_permissions_design.md §2
 */

export enum RiskTier {
  /** Read-only, no side effects. Can auto-approve in auto mode. */
  LOW = "LOW",
  /** Read-write, but reversible or scoped. LLM explainer recommended. */
  MEDIUM = "MEDIUM",
  /** Destructive, system-modifying, or wide-scope. Always requires approval. */
  HIGH = "HIGH",
}

export interface RiskAssessment {
  tier: RiskTier;
  /** Human-readable reason for the risk level */
  reason: string;
  /** Specific danger flags (path_traversal, protected_file, network_outbound, etc.) */
  flags: RiskFlag[];
  /** Whether the operation is read-only */
  isReadOnly: boolean;
  /** Whether the operation modifies the filesystem */
  isDestructive: boolean;
  /** Whether the operation accesses the network */
  hasNetworkAccess: boolean;
}

export enum RiskFlag {
  PATH_TRAVERSAL = "PATH_TRAVERSAL",
  PROTECTED_FILE = "PROTECTED_FILE",
  SHELL_EXECUTION = "SHELL_EXECUTION",
  NETWORK_OUTBOUND = "NETWORK_OUTBOUND",
  FILE_DELETION = "FILE_DELETION",
  SYSTEM_CONFIG = "SYSTEM_CONFIG",
  PROCESS_MANAGEMENT = "PROCESS_MANAGEMENT",
  AUTH_CREDENTIAL = "AUTH_CREDENTIAL",
  LARGE_SCOPE = "LARGE_SCOPE",
}

/**
 * Classify a tool by name and operation details.
 * Mirrors CC's per-tool risk assignment pattern.
 */
export function classifyToolRisk(params: {
  toolName: string;
  operation?: string;
  paths?: string[];
  command?: string;
}): RiskAssessment {
  const { toolName, operation, paths, command } = params;
  const flags: RiskFlag[] = [];
  let isReadOnly = false;
  let isDestructive = false;
  let hasNetworkAccess = false;

  // ── Read-only tools ──────────────────────────────────────────
  const READ_ONLY_TOOLS = new Set([
    "read",
    "sessions_list",
    "sessions_history",
    "web_search",
    // Guardian: allow-listed advisory feeds and Defender alerts, read only.
    "guardian_advisories",
    "m365_security_alerts",
    "nodes",
    "image",
    "session_status",
    "agents_list",
    "cron",
    "message.read",
    "message.reactions",
    "message.list-pins",
    "message.member-info",
    "message.channel-info",
  ]);

  // ── Network tools ────────────────────────────────────────────
  const NETWORK_TOOLS = new Set([
    "web_fetch",
    "web_search",
    "guardian_advisories",
    "m365_security_alerts",
    "browser",
    "message.send",
    "message.broadcast",
    "tts",
    "whatsapp_login",
    "nodes",
    "sessions_send",
    "sessions_spawn",
  ]);

  // ── Destructive tools ────────────────────────────────────────
  const DESTRUCTIVE_TOOLS = new Set([
    "exec",
    "write",
    "edit",
    "message.delete",
    "gateway",
    "cron.add",
    "cron.remove",
    "process.kill",
  ]);

  // ── Shell execution ──────────────────────────────────────────
  if (toolName === "exec") {
    flags.push(RiskFlag.SHELL_EXECUTION);

    // Check for dangerous commands
    if (command) {
      const dangerous = [
        "rm -rf",
        "dd if=",
        "mkfs.",
        ":(){ :|:& };:",
        "> /dev/sda",
        "chmod 777",
        "wget",
        "curl",
        "eval ",
        "$(",
        "${",
        "sudo ",
        "su ",
      ];
      for (const d of dangerous) {
        if (command.includes(d)) {
          flags.push(RiskFlag.SYSTEM_CONFIG);
          flags.push(RiskFlag.PROCESS_MANAGEMENT);
          break;
        }
      }

      // Network in command
      if (/\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/.test(command)) {
        flags.push(RiskFlag.NETWORK_OUTBOUND);
        hasNetworkAccess = true;
      }
    }
  }

  // ── File operations ──────────────────────────────────────────
  if (toolName === "write" || toolName === "edit") {
    if (toolName === "edit") {
      // Edit can modify or just read
      isDestructive = !!operation && ["replace", "delete"].includes(operation);
    } else {
      isDestructive = true;
    }
  }

  if (toolName === "exec" && command) {
    if (/\brm\b/.test(command)) {
      flags.push(RiskFlag.FILE_DELETION);
      isDestructive = true;
    }
  }

  // ── Gateway/process management ───────────────────────────────
  if (toolName === "gateway" || toolName === "process") {
    flags.push(RiskFlag.PROCESS_MANAGEMENT);
    flags.push(RiskFlag.SYSTEM_CONFIG);
  }

  // ── Network detection ────────────────────────────────────────
  if (NETWORK_TOOLS.has(toolName)) {
    hasNetworkAccess = true;
    if (toolName === "message.send" || toolName === "message.broadcast") {
      flags.push(RiskFlag.NETWORK_OUTBOUND);
    }
  }

  // ── Read-only detection ──────────────────────────────────────
  isReadOnly = READ_ONLY_TOOLS.has(toolName);

  // ── Destructive detection ────────────────────────────────────
  if (DESTRUCTIVE_TOOLS.has(toolName)) {
    isDestructive = true;
  }

  // ── Risk tier assignment ─────────────────────────────────────
  let tier = RiskTier.LOW;
  let reason = `${toolName}: standard operation`;

  // HIGH: any shell execution with system config flags
  if (
    flags.includes(RiskFlag.SYSTEM_CONFIG) ||
    flags.includes(RiskFlag.PROCESS_MANAGEMENT) ||
    flags.includes(RiskFlag.AUTH_CREDENTIAL)
  ) {
    tier = RiskTier.HIGH;
    reason = `${toolName}: system-level operation — requires explicit approval`;
  }
  // HIGH: destructive + network (exfiltration risk)
  else if (isDestructive && hasNetworkAccess) {
    tier = RiskTier.HIGH;
    reason = `${toolName}: destructive operation with network access`;
  }
  // MEDIUM: destructive but local
  else if (isDestructive && !flags.includes(RiskFlag.SHELL_EXECUTION)) {
    tier = RiskTier.MEDIUM;
    reason = `${toolName}: destructive local operation — LLM explainer recommended`;
  }
  // MEDIUM: network but not destructive
  else if (hasNetworkAccess && !isReadOnly) {
    tier = RiskTier.MEDIUM;
    reason = `${toolName}: network access — verify destination`;
  }
  // MEDIUM: shell without system flags
  else if (flags.includes(RiskFlag.SHELL_EXECUTION)) {
    tier = RiskTier.MEDIUM;
    reason = `${toolName}: shell execution — review command before approving`;
  }
  // LOW: read-only
  else if (isReadOnly) {
    tier = RiskTier.LOW;
    reason = `${toolName}: read-only operation — safe to auto-approve`;
  }

  return { tier, reason, flags, isReadOnly, isDestructive, hasNetworkAccess };
}
