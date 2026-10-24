import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { getCommandPath, hasHelpOrVersion } from "./argv.js";
import { emitCliBanner } from "./banner.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";
import { findRoutedCommand } from "./program/command-registry.js";
import { ensureConfigReady } from "./program/config-guard.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean;
}) {
  emitCliBanner(VERSION, { argv: params.argv });
  await ensureConfigReady({ runtime: defaultRuntime, commandPath: params.commandPath });
  if (params.loadPlugins) {
    const { preparePluginSdk } = await import("../plugins/loader.js");
    await preparePluginSdk();
    ensurePluginRegistryLoaded();
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.KOLO_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }

  const path = getCommandPath(argv, 2);
  if (!path[0]) {
    return false;
  }
  const route = findRoutedCommand(path);
  if (!route) {
    return false;
  }
  await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: route.loadPlugins });
  try {
    return await route.run(argv);
  } catch (err) {
    // One line, documented exit code, no stack unless asked (docs/CLI_STYLE.md).
    const message = err instanceof Error ? err.message : String(err);
    const verbose = argv.includes("--verbose") || isTruthyEnvValue(process.env.KOLO_DEBUG);
    process.stderr.write(`kolo ${path.join(" ")}: ${message}\n`);
    if (verbose && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    const code = (err as { exitCode?: unknown } | null)?.exitCode;
    process.exit(typeof code === "number" && code > 0 && code < 256 ? code : 1);
  }
}
