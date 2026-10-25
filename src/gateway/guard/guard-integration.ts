/**
 * guard-integration.ts — Wires the permission guard into the existing Gateway
 *
 *
 * This wraps the existing exec approvals system with:
 *   1. Pre-approval risk assessment (LOW/MED/HIGH) for every tool call
 *   2. Path traversal prevention for file-based tools (read/write/edit)
 *   3. Protected files check for destructive tools
 *
 * Integration point: before tools-invoke-http.ts dispatches a tool.
 * The guard returns enriched context — the existing system makes the final decision.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PermissionContext, PermissionDecision } from "./permission-modes.js";
import { guard, RiskTier, type RiskAssessment } from "./index.js";
import { securePath } from "./path-guard.js";
import { decide, buildExplainer, PermissionMode } from "./permission-modes.js";

// ── Types ────────────────────────────────────────────────────────────

export type GuardResult = {
  /** Can proceed without approval */
  autoAllowed: boolean;
  /** Should the operation be denied outright */
  blocked: boolean;
  /** Risk assessment for the operation */
  risk: RiskAssessment;
  /** Full permission decision */
  decision: PermissionDecision;
  /** User-facing explainer (for UI display) */
  explainer: string | null;
  /** Security context for logging */
  context: {
    pathCheck?: { safe: boolean; reason?: string };
    protectedFileHit?: boolean;
  };
};

// ── Configuration ────────────────────────────────────────────────────

/** Which permission mode to use when not specified */
const DEFAULT_MODE = PermissionMode.AUTO;

/** Whether new sessions are trusted by default */
const DEFAULT_TRUST = false;

// ── Tool-specific integration ────────────────────────────────────────

/**
 * Check a tool call before execution. Use this in the tools-invoke-http handler
 * before dispatching any tool.
 */
export async function guardToolCall(params: {
  toolName: string;
  args: Record<string, unknown>;
  /** Optional: paths the tool will read/write */
  paths?: string[];
  /** Optional: command for exec tool */
  command?: string;
  /** Optional: current session permission mode */
  mode?: PermissionMode;
  /** Optional: workspace roots for path validation */
  workspaceRoots?: string[];
  /** Optional: directory relative paths are resolved against (default: the process cwd). */
  baseDir?: string;
}): Promise<GuardResult> {
  const { toolName, args, paths: explicitPaths, command, mode, workspaceRoots, baseDir } = params;
  const context: GuardResult["context"] = {};

  // ── Step 1: Path validation for file tools ─────────────────────
  const resolvedPaths = (explicitPaths ?? extractPaths(toolName, args)).map((p) =>
    baseDir && !isAbsolute(p) ? resolvePath(baseDir, p) : p,
  );
  if (resolvedPaths.length > 0 && workspaceRoots && workspaceRoots.length > 0) {
    for (const p of resolvedPaths) {
      const result = await securePath(p, workspaceRoots);
      if (!result.safe) {
        const reason = result.reason ?? "path traversal detected";
        return {
          autoAllowed: false,
          blocked: true,
          risk: {
            tier: RiskTier.HIGH,
            reason,
            flags: [],
            isReadOnly: false,
            isDestructive: false,
            hasNetworkAccess: false,
          },
          decision: {
            action: "deny",
            explanation: reason,
            risk: {
              tier: RiskTier.HIGH,
              reason,
              flags: [],
              isReadOnly: false,
              isDestructive: false,
              hasNetworkAccess: false,
            },
            showExplainer: true,
          },
          explainer: reason,
          context: { pathCheck: { safe: false, reason } },
        };
      }
      context.pathCheck = { safe: true };
    }
  }

  // ── Step 2: Risk classification ────────────────────────────────
  const risk = guard.classifyRisk({ toolName, paths: resolvedPaths, command });

  // ── Step 3: Permission decision ────────────────────────────────
  const permContext: PermissionContext = {
    mode: mode ?? DEFAULT_MODE,
    sessionTrusted: DEFAULT_TRUST,
  };
  const decision = guard.decidePermission({
    toolName,
    paths: resolvedPaths,
    command,
    context: permContext,
  });

  // ── Step 4: Build explainer for medium/high risk ────────────────
  const explainer = decision.showExplainer ? guard.explain(decision) : null;

  return {
    autoAllowed: decision.action === "allow",
    blocked: decision.action === "deny",
    risk,
    decision,
    explainer,
    context,
  };
}

/**
 * Quick risk check — synchronous, for logging/metrics only.
 * Does not do path validation (requires fs access).
 */
export function assessToolRisk(toolName: string, command?: string): RiskAssessment {
  return guard.classifyRisk({ toolName, command });
}

/**
 * Validate a file path against workspace roots.
 * Use this in read/write/edit tool implementations.
 */
export async function validateToolPath(
  rawPath: string,
  workspaceRoots: string[],
): Promise<{ safe: true; resolvedPath: string } | { safe: false; reason: string }> {
  return securePath(rawPath, workspaceRoots);
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractPaths(toolName: string, args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const pathKeys = ["path", "file_path", "filePath", "from", "to", "source", "dest", "target"];

  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      paths.push(value.trim());
    }
  }

  // exec: check for path-like arguments
  if (toolName === "exec" && typeof args["command"] === "string") {
    const cmd = args["command"];
    // Extract paths that look like file arguments (not flags)
    const tokens = cmd.split(/\s+/);
    for (const token of tokens) {
      if (
        token.startsWith(".") ||
        token.startsWith("/") ||
        token.startsWith("~") ||
        /^[A-Za-z]:[\\/]/.test(token)
      ) {
        paths.push(token);
      }
    }
  }

  return paths;
}

// ── Logging integration ──────────────────────────────────────────────

/**
 * Log a guard decision for audit trail.
 * Integrates with existing Gateway logging.
 */
export function logGuardDecision(params: {
  toolName: string;
  result: GuardResult;
  sessionKey?: string;
  agentId?: string;
}): void {
  const level = params.result.blocked
    ? "WARN"
    : params.result.risk.tier === RiskTier.HIGH
      ? "WARN"
      : "DEBUG";
  const prefix = params.result.blocked
    ? "🛡️ BLOCKED"
    : params.result.autoAllowed
      ? "✅ AUTO"
      : "⚠️  REVIEW";

  // Use structured logging — integrates with Gateway's logger
  if (level === "WARN") {
    console.warn(
      `${prefix} ${params.toolName} | tier=${params.result.risk.tier} | ` +
        `session=${params.sessionKey ?? "?"} | agent=${params.agentId ?? "?"}`,
    );
  }
}
