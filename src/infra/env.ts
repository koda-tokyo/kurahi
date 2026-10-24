import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";

const log = createSubsystemLogger("env");
const loggedEnv = new Set<string>();

type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};

function formatEnvValue(value: string, redact?: boolean): string {
  if (redact) {
    return "<redacted>";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${singleLine.slice(0, 160)}…`;
}

export function logAcceptedEnvOption(option: AcceptedEnvOption): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  if (loggedEnv.has(option.key)) {
    return;
  }
  const rawValue = option.value ?? process.env[option.key];
  if (!rawValue || !rawValue.trim()) {
    return;
  }
  loggedEnv.add(option.key);
  log.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}

export function normalizeZaiEnv(): void {
  if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
    process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
  }
}

export function isTruthyEnvValue(value?: string): boolean {
  return parseBooleanValue(value) === true;
}

const LEGACY_ENV_PREFIXES = ["CLAWDBOT_", "MOLTBOT_", "OPENCLAW_"];
let legacyEnvWarned = false;

/**
 * Pre-rename environment variables are still honoured (see src/config/paths.ts,
 * kolo-home.ts, token-file.ts), but they are deprecated and will be removed in KoLo 2.1.
 * One line on stderr per process, listing the names, never the values.
 */
export function warnLegacyEnvAliasesOnce(env: NodeJS.ProcessEnv = process.env): void {
  if (legacyEnvWarned) {
    return;
  }
  legacyEnvWarned = true;
  const names = Object.keys(env)
    .filter((k) => LEGACY_ENV_PREFIXES.some((p) => k.startsWith(p)) && env[k]?.trim())
    .toSorted();
  if (names.length === 0) {
    return;
  }
  process.stderr.write(
    `kolo: deprecated environment variables ${names.join(", ")}: use the KOLO_* names; the aliases will be removed in a later release.\n`,
  );
}

export function normalizeEnv(): void {
  normalizeZaiEnv();
}
