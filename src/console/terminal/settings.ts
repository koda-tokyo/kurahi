// Resolved `console.terminal` settings (src/config/types.console.ts) with their defaults.
import type { KoLoConfig } from "../../config/config.js";
import type { ConsoleTerminalActApprovals } from "../../config/types.console.js";

export type TerminalSettings = {
  enabled: boolean;
  actApprovals: ConsoleTerminalActApprovals;
  sandbox: "off" | "required";
  allowInteractive: ReadonlySet<string>;
  maxSessionsPerProject: number;
  maxSessionsPerUser: number;
  idleTimeoutMs: number;
  maxLineLength: number;
  outputBytesPerSecond: number;
  approvalTimeoutMs: number;
};

export const TERMINAL_DEFAULTS = {
  maxSessionsPerProject: 3,
  maxSessionsPerUser: 4,
  idleTimeoutMs: 30 * 60_000,
  maxLineLength: 4096,
  outputBytesPerSecond: 512 * 1024,
  approvalTimeoutMs: 120_000,
} as const;

export function resolveTerminalSettings(cfg: KoLoConfig | undefined): TerminalSettings {
  const t = cfg?.console?.terminal;
  return {
    enabled: t?.enabled === true,
    actApprovals: t?.actApprovals ?? "policy",
    sandbox: t?.sandbox ?? "off",
    allowInteractive: new Set(t?.allowInteractive ?? []),
    maxSessionsPerProject: t?.maxSessionsPerProject ?? TERMINAL_DEFAULTS.maxSessionsPerProject,
    maxSessionsPerUser: t?.maxSessionsPerUser ?? TERMINAL_DEFAULTS.maxSessionsPerUser,
    idleTimeoutMs: t?.idleTimeoutMs ?? TERMINAL_DEFAULTS.idleTimeoutMs,
    maxLineLength: t?.maxLineLength ?? TERMINAL_DEFAULTS.maxLineLength,
    outputBytesPerSecond: t?.outputBytesPerSecond ?? TERMINAL_DEFAULTS.outputBytesPerSecond,
    approvalTimeoutMs: t?.approvalTimeoutMs ?? TERMINAL_DEFAULTS.approvalTimeoutMs,
  };
}
