// Kurahi Work Console settings. `console.terminal` is the gateway-owned terminal broker
// (src/console/terminal, docs/security/terminal-broker.md).

/**
 * How act-mode (実行) commands are approved:
 * - "always": every command line that is not classified read-only waits for an operator
 *   approval, whatever the exec-approvals allowlist says (new installs).
 * - "policy": the exec-approvals file decides (security / ask / allowlist of the default agent);
 *   lines with a risk preview (deletes files, network, history rewrite, …) still always ask.
 */
export type ConsoleTerminalActApprovals = "always" | "policy";

export type ConsoleTerminalConfig = {
  /** Master switch. Unset = off: the terminal methods refuse every request. */
  enabled?: boolean;
  /** Act-mode approval rule (unset = "policy"; new installs get "always"). */
  actApprovals?: ConsoleTerminalActApprovals;
  /**
   * Run every session in the container sandbox ("required") or on the gateway host ("off",
   * default). A project whose terminal profile is client-isolated always requires it. When the
   * sandbox is required and cannot start, the session is refused; it never falls back to host.
   */
  sandbox?: "off" | "required";
  /** Programs that may run interactively (editors, REPLs). Default none: they are refused. */
  allowInteractive?: string[];
  /** Open sessions per project (default 3). */
  maxSessionsPerProject?: number;
  /** Open sessions per operator identity (default 4). */
  maxSessionsPerUser?: number;
  /** A session with no input or output for this long is closed (default 30 minutes). */
  idleTimeoutMs?: number;
  /** Longest command line accepted at the prompt, in characters (default 4096). */
  maxLineLength?: number;
  /** Output rate limit per session in bytes per second; excess output is dropped (default 512 KiB). */
  outputBytesPerSecond?: number;
  /** How long an approval request waits before it counts as denied (default 120 s). */
  approvalTimeoutMs?: number;
};

export type ConsoleConfig = {
  terminal?: ConsoleTerminalConfig;
};
