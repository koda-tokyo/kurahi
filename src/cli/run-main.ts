import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { t } from "../i18n/index.js";
import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv, warnLegacyEnvAliasesOnce } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureKoLoCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import {
  installUnhandledRejectionHandler,
  isCrashKeepaliveEnabled,
} from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { VERSION } from "../version.js";
import { getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { tryRouteCli } from "./route.js";

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

const VERSION_FLAGS = new Set(["--version", "-V", "-v"]);

/** `kurahi --version` (any position, no subcommand) prints the version and nothing else. */
export function isVersionOnlyInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  return args.length > 0 && args.every((arg) => VERSION_FLAGS.has(arg));
}

export async function runCli(argv: string[] = process.argv) {
  const normalizedArgv = stripWindowsNodeExec(argv);
  if (isVersionOnlyInvocation(normalizedArgv)) {
    // Before dotenv, config, auth stores or plugins: the version must never be accompanied by
    // log lines, credential syncs or network calls.
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  loadDotEnv({ quiet: true });
  normalizeEnv();
  // Here and not in entry.ts: the entry process may respawn itself once for NODE_OPTIONS,
  // and the warning must appear once per command, not once per process in that chain.
  warnLegacyEnvAliasesOnce();
  ensureKoLoCliOnPath();

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  if (await tryRouteCli(normalizedArgv)) {
    return;
  }

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  enableConsoleCapture();

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[KoLo] Uncaught exception:", formatUncaughtError(error));
    if (isCrashKeepaliveEnabled()) {
      return; // debug-only escape hatch
    }
    process.exit(1);
  });

  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Register the primary subcommand if one exists (for lazy-loading)
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  const shouldSkipPluginRegistration = !primary && hasHelpOrVersion(parseArgv);
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { preparePluginSdk } = await import("../plugins/loader.js");
    await preparePluginSdk();
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
  }

  const { applyVerbAliases } = await import("./program/verb-aliases.js");
  applyVerbAliases(program);

  // Unknown command: usage and exit 2 (docs/CLI_STYLE.md), never a bare "unknown command" with
  // exit 1 and never the full help dump.
  if (primary && primary !== "help" && !isKnownCommand(program, primary)) {
    process.stderr.write(
      `${t("error.unknownCommand", { cmd: primary })}\n${t("error.usage")}\n${t("error.seeHelp")}\n`,
    );
    process.exit(2);
  }

  await program.parseAsync(parseArgv);
}

function stripWindowsNodeExec(argv: string[]): string[] {
  if (process.platform !== "win32") {
    return argv;
  }
  const stripControlChars = (value: string): string => {
    let out = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };
  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")
      .trim();
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");
  const execPath = normalizeCandidate(process.execPath);
  const execPathLower = execPath.toLowerCase();
  const execBase = path.basename(execPath).toLowerCase();
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    return (
      lower === execPathLower ||
      path.basename(lower) === execBase ||
      lower.endsWith("\\node.exe") ||
      lower.endsWith("/node.exe") ||
      lower.includes("node.exe") ||
      (path.basename(lower) === "node.exe" && fs.existsSync(normalized))
    );
  };
  const filtered = argv.filter((arg, index) => index === 0 || !isExecPath(arg));
  if (filtered.length < 3) {
    return filtered;
  }
  const cleaned = [...filtered];
  if (isExecPath(cleaned[1])) {
    cleaned.splice(1, 1);
  }
  if (isExecPath(cleaned[2])) {
    cleaned.splice(2, 1);
  }
  return cleaned;
}

function isKnownCommand(
  program: { commands: readonly { name(): string; aliases(): string[] }[] },
  name: string,
): boolean {
  return program.commands.some((cmd) => cmd.name() === name || cmd.aliases().includes(name));
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
