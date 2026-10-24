// Pre-exec destructive-command guard (OWASP ASI05).
//
// Every path that turns agent output into a shell command calls `enforceExecGuard` before the
// command reaches a shell, a container or a node host:
//
//   src/agents/bash-tools.exec.ts     exec tool (sandbox, gateway and node hosts, elevated too)
//   src/agents/bash-tools.process.ts  process tool write / send-keys / paste (stdin of a shell)
//   src/agents/tools/nodes-tool.ts    nodes tool `run` (system.run on a paired node)
//   src/node-host/runner.ts           system.run on the node host (any caller, defence in depth)
//
// The hardline check (src/security/hardline-guard.ts) is the unconditional floor: it runs before
// allowlists, approvals, elevated mode and the sandbox, and nothing configurable bypasses it. A
// blocked command is refused (never queued for approval) and written to the hash-chained audit
// log as `exec.guard` / denied. A command that passes is written as `exec.guard` / allowed when
// the caller asks for it (command starts; not every keystroke sent to a running process).

import { createHash } from "node:crypto";
import { recordAuditEvent } from "./audit-log.js";
import { detectHardlinePreExec, type HardlineMatch } from "./hardline-guard.js";

export const EXEC_GUARD_AUDIT_ACTION = "exec.guard";

/** Longest command text kept in an audit entry (the full text is identified by its hash). */
const AUDIT_COMMAND_CHARS = 400;

export type ExecGuardContext = {
  /** Subsystem that is about to execute (`exec`, `process.write`, `nodes.run`, `node-host`). */
  source: string;
  agentId?: string;
  sessionKey?: string;
  /** Where the command would run: sandbox | gateway | node. */
  host?: string;
  /** Record passing commands too (default true). Blocked commands are always recorded. */
  recordAllowed?: boolean;
};

export class ExecGuardBlockedError extends Error {
  readonly match: HardlineMatch;
  constructor(match: HardlineMatch) {
    super(match.message);
    this.name = "ExecGuardBlockedError";
    this.match = match;
  }
}

function auditDetail(command: string, ctx: ExecGuardContext, match?: HardlineMatch) {
  return {
    host: ctx.host,
    command:
      command.length > AUDIT_COMMAND_CHARS
        ? `${command.slice(0, AUDIT_COMMAND_CHARS)}… (${command.length} chars)`
        : command,
    commandSha256: createHash("sha256").update(command, "utf8").digest("hex"),
    ...(match ? { pattern: match.pattern, reason: match.description } : {}),
  };
}

/**
 * Check a command against the hardline floor and record the decision. Returns the match when the
 * command must be refused, null when it may proceed to the normal approval path.
 */
export function checkExecCommand(command: string, ctx: ExecGuardContext): HardlineMatch | null {
  const result = detectHardlinePreExec(command);
  if (result.blocked) {
    recordAuditEvent({
      action: EXEC_GUARD_AUDIT_ACTION,
      outcome: "denied",
      identity: ctx.agentId,
      scope: ctx.sessionKey,
      source: ctx.source,
      detail: auditDetail(command, ctx, result),
    });
    return result;
  }
  if (ctx.recordAllowed !== false) {
    recordAuditEvent({
      action: EXEC_GUARD_AUDIT_ACTION,
      outcome: "allowed",
      identity: ctx.agentId,
      scope: ctx.sessionKey,
      source: ctx.source,
      detail: auditDetail(command, ctx),
    });
  }
  return null;
}

/** Throw a model-visible refusal when the command is on the hardline blocklist. */
export function enforceExecGuard(command: string, ctx: ExecGuardContext): void {
  const match = checkExecCommand(command, ctx);
  if (match) {
    throw new ExecGuardBlockedError(match);
  }
}
