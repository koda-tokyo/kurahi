// Stable codes of the console terminal protocol. The UI owns the Japanese and English copy for
// each code; the gateway never sends prose. Add codes at the end; never rename or reuse one.

/** Risk preview codes carried by `approval.requested` (with safe params such as counts). */
export const TERMINAL_RISK_CODES = [
  "deletes-files",
  "moves-files",
  "overwrites-files",
  "writes-files",
  "changes-permissions",
  "rewrites-git-history",
  "modifies-git-repository",
  "network",
  "installs-packages",
  "process-control",
  "runs-program",
  "runs-nested-command",
  "background-job",
  "prints-environment",
  "outside-allowlist",
  "read-only-path",
] as const;
export type TerminalRiskCode = (typeof TERMINAL_RISK_CODES)[number];

/** Notice codes (`type: "notice"`): refusals, limits and session state changes. */
export const TERMINAL_NOTICE_CODES = [
  "ready",
  "cwd-changed",
  "read-mode",
  "hardline-blocked",
  "path-escape",
  "unverifiable-path",
  "interactive-refused",
  "privilege-refused",
  "substitution-refused",
  "eval-refused",
  "detach-refused",
  "unsupported-builtin",
  "unparsed",
  "line-too-long",
  "paste-truncated",
  "busy",
  "approval-denied",
  "approval-timeout",
  "approval-cancelled",
  "security-deny",
  "allowlist-miss",
  "mode-changed",
  "output-rate-limited",
  "snapshot-truncated",
  "spawn-failed",
  "idle-timeout",
  "closed",
  "shutdown",
  "read-only-path",
  "read-only-violation",
] as const;
export type TerminalNoticeCode = (typeof TERMINAL_NOTICE_CODES)[number];

export const TERMINAL_EVENT_TYPES = [
  "stdout",
  "stderr",
  "exit",
  "approval.requested",
  "approval.resolved",
  "file.diff",
  "notice",
] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/** Safe parameters only: counts, program names, flags. Never paths with content, env or secrets. */
export type TerminalSafeParams = Record<string, string | number | boolean>;

export type TerminalRisk = { code: TerminalRiskCode; params?: TerminalSafeParams };
