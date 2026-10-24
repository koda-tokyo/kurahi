import type { Command } from "commander";
import { KoloClient } from "@kodasoken/kurahi-client";
import fs from "node:fs";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { PluginRecord } from "../plugins/registry.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../plugins/install.js";
import { recordPluginInstall } from "../plugins/installs.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath, shortenHomeInString, shortenHomePath } from "../utils.js";
import { registerSupplyChainCommands } from "./supply-chain-cli.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export type PluginInfoOptions = {
  json?: boolean;
};

export type PluginUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
};

// M7: live state from a running gateway (quarantine, reload counts, running services).
type LivePluginRow = {
  id: string;
  status: "loaded" | "disabled" | "error";
  error?: string;
  quarantined: boolean;
  reloads: number;
  watched: boolean;
  runningServices: string[];
};
type LivePlugins = {
  hotReload: { enabled: boolean; watch: boolean; debounceMs: number; watching: boolean };
  plugins: LivePluginRow[];
  diagnostics: Array<{ level: "warn" | "error"; pluginId?: string; message: string }>;
};

async function fetchLivePlugins(): Promise<LivePlugins | undefined> {
  try {
    const client = await KoloClient.local({});
    return (await client.listPlugins()) as unknown as LivePlugins;
  } catch {
    return undefined;
  }
}

/** Where the self-check plugin leaves its last report (read by `kurahi plugins doctor` / `kurahi doctor`). */
export function selfCheckReportPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "self-check", "latest.json");
}

export type SelfCheckReport = {
  ranAt: string;
  ok: boolean;
  findings: Array<{ check: string; level: "info" | "warn" | "error"; message: string }>;
  checks: Record<string, "pass" | "warn" | "fail" | "skip">;
};

export function readSelfCheckReport(stateDir?: string): SelfCheckReport | null {
  try {
    const raw = fs.readFileSync(selfCheckReportPath(stateDir), "utf-8");
    const parsed = JSON.parse(raw) as SelfCheckReport;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.findings) ? parsed : null;
  } catch {
    return null;
  }
}

function liveStatusLabel(row: LivePluginRow | undefined, fallback: PluginRecord["status"]) {
  const status = row?.status ?? fallback;
  const base =
    status === "loaded"
      ? theme.success("loaded")
      : status === "disabled"
        ? theme.warn("disabled")
        : theme.error(row?.quarantined ? "quarantined" : "error");
  const extra = row && row.reloads > 0 ? theme.muted(` r${row.reloads}`) : "";
  return `${base}${extra}`;
}

function formatPluginLine(plugin: PluginRecord, verbose = false): string {
  const status =
    plugin.status === "loaded"
      ? theme.success("loaded")
      : plugin.status === "disabled"
        ? theme.warn("disabled")
        : theme.error("error");
  const name = theme.command(plugin.name || plugin.id);
  const idSuffix = plugin.name && plugin.name !== plugin.id ? theme.muted(` (${plugin.id})`) : "";
  const desc = plugin.description
    ? theme.muted(
        plugin.description.length > 60
          ? `${plugin.description.slice(0, 57)}...`
          : plugin.description,
      )
    : theme.muted("(no description)");

  if (!verbose) {
    return `${name}${idSuffix} ${status} - ${desc}`;
  }

  const parts = [
    `${name}${idSuffix} ${status}`,
    `  source: ${theme.muted(shortenHomeInString(plugin.source))}`,
    `  origin: ${plugin.origin}`,
  ];
  if (plugin.version) {
    parts.push(`  version: ${plugin.version}`);
  }
  if (plugin.providerIds.length > 0) {
    parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
  }
  if (plugin.error) {
    parts.push(theme.error(`  error: ${plugin.error}`));
  }
  return parts.join("\n");
}

function applySlotSelectionForPlugin(
  config: KoLoConfig,
  pluginId: string,
): { config: KoLoConfig; warnings: string[] } {
  const report = buildPluginStatusReport({ config });
  const plugin = report.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}

function logSlotWarnings(warnings: string[]) {
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
}

// ASI04: an installed package is not approved until it is pinned (docs/security/skill-integrity.md).
const PIN_HINT = (id: string) =>
  `Review it, then approve it with \`kurahi plugins pin ${id}\` (refused in supply-chain enforce mode until pinned).`;

export function registerPluginsCli(program: Command) {
  const plugins = program
    .command("plugins")
    .description("Manage Kurahi plugins/extensions")
    .addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins")}\n`);
  registerSupplyChainCommands(plugins, "plugin");

  plugins
    .command("list")
    .description("List discovered plugins")
    .option("--json", "Print JSON")
    .option("--enabled", "Only show enabled plugins", false)
    .option("--verbose", "Show detailed entries", false)
    .action(async (opts: PluginsListOptions) => {
      const report = buildPluginStatusReport();
      // M7: when a gateway runs, its live view wins (quarantine, reloads, running services).
      const live = await fetchLivePlugins();
      const liveById = new Map((live?.plugins ?? []).map((row) => [row.id, row]));
      const effectiveStatus = (p: PluginRecord) => liveById.get(p.id)?.status ?? p.status;
      const list = opts.enabled
        ? report.plugins.filter((p) => effectiveStatus(p) === "loaded")
        : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
          live: live ? { hotReload: live.hotReload } : null,
          plugins: list.map((plugin) => {
            const row = liveById.get(plugin.id);
            return row
              ? {
                  ...plugin,
                  status: row.status,
                  error: row.error ?? plugin.error,
                  quarantined: row.quarantined,
                  reloads: row.reloads,
                  watched: row.watched,
                  runningServices: row.runningServices,
                }
              : plugin;
          }),
          diagnostics: live ? live.diagnostics : report.diagnostics,
        };
        defaultRuntime.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (list.length === 0) {
        defaultRuntime.log(theme.muted("No plugins found."));
        return;
      }

      const loaded = list.filter((p) => effectiveStatus(p) === "loaded").length;
      const liveNote = live
        ? theme.muted(
            `, live: hot reload ${live.hotReload.enabled ? "on" : "off"}${live.hotReload.watching ? ", watching" : ""}`,
          )
        : theme.muted(", no gateway: config view");
      defaultRuntime.log(
        `${theme.heading("Plugins")} ${theme.muted(`(${loaded}/${list.length} loaded`)}${liveNote}${theme.muted(")")}`,
      );

      if (!opts.verbose) {
        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        const rows = list.map((plugin) => {
          const row = liveById.get(plugin.id);
          const error = row?.error ?? (effectiveStatus(plugin) === "error" ? plugin.error : "");
          const desc = plugin.description ? theme.muted(plugin.description) : "";
          const detail = error ? theme.error(error) : desc;
          const sourceLine = detail ? `${plugin.source}\n${detail}` : plugin.source;
          return {
            Name: plugin.name || plugin.id,
            ID: plugin.name && plugin.name !== plugin.id ? plugin.id : "",
            Status: liveStatusLabel(row, plugin.status),
            Source: sourceLine,
            Version: plugin.version ?? "",
          };
        });
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Name", minWidth: 14, flex: true },
              { key: "ID", header: "ID", minWidth: 10, flex: true },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Source", header: "Source", minWidth: 26, flex: true },
              { key: "Version", header: "Version", minWidth: 8 },
            ],
            rows,
          }).trimEnd(),
        );
        return;
      }

      const lines: string[] = [];
      for (const plugin of list) {
        const row = liveById.get(plugin.id);
        lines.push(
          formatPluginLine(
            row ? { ...plugin, status: row.status, error: row.error ?? plugin.error } : plugin,
            true,
          ),
        );
        if (row) {
          lines.push(
            `  live: reloads=${row.reloads} watched=${row.watched ? "yes" : "no"}${row.quarantined ? " quarantined" : ""}${row.runningServices.length ? ` services=${row.runningServices.join(",")}` : ""}`,
          );
        }
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    });

  plugins
    .command("reload")
    .description("Reload one plugin in the running gateway (no restart)")
    .argument("<id>", "Plugin id")
    .option("--json", "Print JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = await KoloClient.local({}).catch((err: unknown) => {
        defaultRuntime.error(
          theme.error(`No running gateway found (${String((err as Error).message ?? err)}).`),
        );
        return null;
      });
      if (!client) {
        process.exitCode = 3;
        return;
      }
      try {
        const res = (await client.reloadPlugin({ id })) as unknown as {
          ok: boolean;
          plugin: {
            ok: boolean;
            status: string;
            error?: string;
            reloads: number;
            durationMs: number;
          };
        };
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } else if (res.plugin.ok) {
          defaultRuntime.log(
            `${theme.success("reloaded")} ${theme.command(id)} ${theme.muted(`(reload #${res.plugin.reloads}, ${res.plugin.durationMs} ms)`)}`,
          );
        } else {
          defaultRuntime.log(
            `${theme.error(res.plugin.status === "disabled" ? "disabled" : "quarantined")} ${theme.command(id)}${res.plugin.error ? `: ${res.plugin.error}` : ""}`,
          );
          process.exitCode = 1;
        }
      } catch (err) {
        defaultRuntime.error(
          theme.error(`reload failed: ${String((err as Error).message ?? err)}`),
        );
        process.exitCode = 1;
      }
    });

  plugins
    .command("info")
    .description("Show plugin details")
    .argument("<id>", "Plugin id")
    .option("--json", "Print JSON")
    .action((id: string, opts: PluginInfoOptions) => {
      const report = buildPluginStatusReport();
      const plugin = report.plugins.find((p) => p.id === id || p.name === id);
      if (!plugin) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        process.exit(1);
      }
      const cfg = loadConfig();
      const install = cfg.plugins?.installs?.[plugin.id];

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(plugin, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push(theme.heading(plugin.name || plugin.id));
      if (plugin.name && plugin.name !== plugin.id) {
        lines.push(theme.muted(`id: ${plugin.id}`));
      }
      if (plugin.description) {
        lines.push(plugin.description);
      }
      lines.push("");
      lines.push(`${theme.muted("Status:")} ${plugin.status}`);
      lines.push(`${theme.muted("Source:")} ${shortenHomeInString(plugin.source)}`);
      lines.push(`${theme.muted("Origin:")} ${plugin.origin}`);
      if (plugin.version) {
        lines.push(`${theme.muted("Version:")} ${plugin.version}`);
      }
      if (plugin.toolNames.length > 0) {
        lines.push(`${theme.muted("Tools:")} ${plugin.toolNames.join(", ")}`);
      }
      if (plugin.hookNames.length > 0) {
        lines.push(`${theme.muted("Hooks:")} ${plugin.hookNames.join(", ")}`);
      }
      if (plugin.gatewayMethods.length > 0) {
        lines.push(`${theme.muted("Gateway methods:")} ${plugin.gatewayMethods.join(", ")}`);
      }
      if (plugin.providerIds.length > 0) {
        lines.push(`${theme.muted("Providers:")} ${plugin.providerIds.join(", ")}`);
      }
      if (plugin.cliCommands.length > 0) {
        lines.push(`${theme.muted("CLI commands:")} ${plugin.cliCommands.join(", ")}`);
      }
      if (plugin.services.length > 0) {
        lines.push(`${theme.muted("Services:")} ${plugin.services.join(", ")}`);
      }
      if (plugin.error) {
        lines.push(`${theme.error("Error:")} ${plugin.error}`);
      }
      if (install) {
        lines.push("");
        lines.push(`${theme.muted("Install:")} ${install.source}`);
        if (install.spec) {
          lines.push(`${theme.muted("Spec:")} ${install.spec}`);
        }
        if (install.sourcePath) {
          lines.push(`${theme.muted("Source path:")} ${shortenHomePath(install.sourcePath)}`);
        }
        if (install.installPath) {
          lines.push(`${theme.muted("Install path:")} ${shortenHomePath(install.installPath)}`);
        }
        if (install.version) {
          lines.push(`${theme.muted("Recorded version:")} ${install.version}`);
        }
        if (install.installedAt) {
          lines.push(`${theme.muted("Installed at:")} ${install.installedAt}`);
        }
      }
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      let next: KoLoConfig = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(cfg.plugins?.entries as Record<string, { enabled?: boolean }> | undefined)?.[id],
              enabled: true,
            },
          },
        },
      };
      const slotResult = applySlotSelectionForPlugin(next, id);
      next = slotResult.config;
      await writeConfigFile(next);
      logSlotWarnings(slotResult.warnings);
      defaultRuntime.log(
        `Enabled plugin "${id}". A running gateway applies it in place (plugins.hotReload); ` +
          `otherwise it loads on the next start.`,
      );
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(cfg.plugins?.entries as Record<string, { enabled?: boolean }> | undefined)?.[id],
              enabled: false,
            },
          },
        },
      };
      await writeConfigFile(next);
      defaultRuntime.log(
        `Disabled plugin "${id}". A running gateway unloads it in place (plugins.hotReload); ` +
          `otherwise it stays off from the next start.`,
      );
    });

  plugins
    .command("install")
    .description("Install a plugin (path, archive, or npm spec)")
    .argument("<path-or-spec>", "Path (.ts/.js/.zip/.tgz/.tar.gz) or an npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .action(async (raw: string, opts: { link?: boolean }) => {
      const resolved = resolveUserPath(raw);
      const cfg = loadConfig();

      if (fs.existsSync(resolved)) {
        if (opts.link) {
          const existing = cfg.plugins?.load?.paths ?? [];
          const merged = Array.from(new Set([...existing, resolved]));
          const probe = await installPluginFromPath({ path: resolved, dryRun: true });
          if (!probe.ok) {
            defaultRuntime.error(probe.error);
            process.exit(1);
          }

          let next: KoLoConfig = {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              load: {
                ...cfg.plugins?.load,
                paths: merged,
              },
              entries: {
                ...cfg.plugins?.entries,
                [probe.pluginId]: {
                  ...(cfg.plugins?.entries?.[probe.pluginId] as object | undefined),
                  enabled: true,
                },
              },
            },
          };
          next = recordPluginInstall(next, {
            pluginId: probe.pluginId,
            source: "path",
            sourcePath: resolved,
            installPath: resolved,
            version: probe.version,
          });
          const slotResult = applySlotSelectionForPlugin(next, probe.pluginId);
          next = slotResult.config;
          await writeConfigFile(next);
          logSlotWarnings(slotResult.warnings);
          defaultRuntime.log(`Linked plugin path: ${shortenHomePath(resolved)}`);
          defaultRuntime.log(`Restart the gateway to load plugins.`);
          return;
        }

        const result = await installPluginFromPath({
          path: resolved,
          logger: {
            info: (msg) => defaultRuntime.log(msg),
            warn: (msg) => defaultRuntime.log(theme.warn(msg)),
          },
        });
        if (!result.ok) {
          defaultRuntime.error(result.error);
          process.exit(1);
        }

        let next: KoLoConfig = {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              [result.pluginId]: {
                ...(cfg.plugins?.entries?.[result.pluginId] as object | undefined),
                enabled: true,
              },
            },
          },
        };
        const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
        next = recordPluginInstall(next, {
          pluginId: result.pluginId,
          source,
          sourcePath: resolved,
          installPath: result.targetDir,
          version: result.version,
        });
        const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
        next = slotResult.config;
        await writeConfigFile(next);
        logSlotWarnings(slotResult.warnings);
        defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
        defaultRuntime.log(PIN_HINT(result.pluginId));
        defaultRuntime.log(`Restart the gateway to load plugins.`);
        return;
      }

      if (opts.link) {
        defaultRuntime.error("`--link` requires a local path.");
        process.exit(1);
      }

      const looksLikePath =
        raw.startsWith(".") ||
        raw.startsWith("~") ||
        path.isAbsolute(raw) ||
        raw.endsWith(".ts") ||
        raw.endsWith(".js") ||
        raw.endsWith(".mjs") ||
        raw.endsWith(".cjs") ||
        raw.endsWith(".tgz") ||
        raw.endsWith(".tar.gz") ||
        raw.endsWith(".tar") ||
        raw.endsWith(".zip");
      if (looksLikePath) {
        defaultRuntime.error(`Path not found: ${resolved}`);
        process.exit(1);
      }

      const result = await installPluginFromNpmSpec({
        spec: raw,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
      });
      if (!result.ok) {
        defaultRuntime.error(result.error);
        process.exit(1);
      }

      let next: KoLoConfig = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [result.pluginId]: {
              ...(cfg.plugins?.entries?.[result.pluginId] as object | undefined),
              enabled: true,
            },
          },
        },
      };
      next = recordPluginInstall(next, {
        pluginId: result.pluginId,
        source: "npm",
        spec: raw,
        installPath: result.targetDir,
        version: result.version,
      });
      const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
      next = slotResult.config;
      await writeConfigFile(next);
      logSlotWarnings(slotResult.warnings);
      defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
      defaultRuntime.log(PIN_HINT(result.pluginId));
      defaultRuntime.log(`Restart the gateway to load plugins.`);
    });

  plugins
    .command("update")
    .description("Update installed plugins (npm installs only)")
    .argument("[id]", "Plugin id (omit with --all)")
    .option("--all", "Update all tracked plugins", false)
    .option("--dry-run", "Show what would change without writing", false)
    .action(async (id: string | undefined, opts: PluginUpdateOptions) => {
      const cfg = loadConfig();
      const installs = cfg.plugins?.installs ?? {};
      const targets = opts.all ? Object.keys(installs) : id ? [id] : [];

      if (targets.length === 0) {
        if (opts.all) {
          defaultRuntime.log("No npm-installed plugins to update.");
          return;
        }
        defaultRuntime.error("Provide a plugin id or use --all.");
        process.exit(1);
      }

      const result = await updateNpmInstalledPlugins({
        config: cfg,
        pluginIds: targets,
        dryRun: opts.dryRun,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
      });

      for (const outcome of result.outcomes) {
        if (outcome.status === "error") {
          defaultRuntime.log(theme.error(outcome.message));
          continue;
        }
        if (outcome.status === "skipped") {
          defaultRuntime.log(theme.warn(outcome.message));
          continue;
        }
        defaultRuntime.log(outcome.message);
      }

      if (!opts.dryRun && result.changed) {
        await writeConfigFile(result.config);
        defaultRuntime.log("Restart the gateway to load plugins.");
      }
    });

  plugins
    .command("doctor")
    .description(
      "Report plugin load issues (live gateway state when one runs) and the last self-check",
    )
    .action(async () => {
      const report = buildPluginStatusReport();
      const live = await fetchLivePlugins();
      const liveById = new Map((live?.plugins ?? []).map((row) => [row.id, row]));
      const errors = report.plugins
        .map((p) => {
          const row = liveById.get(p.id);
          return row
            ? {
                ...p,
                status: row.status,
                error: row.error ?? p.error,
                quarantined: row.quarantined,
              }
            : { ...p, quarantined: false };
        })
        .filter((p) => p.status === "error");
      const diags = (live ? live.diagnostics : report.diagnostics).filter(
        (d) => d.level === "error",
      );
      const selfCheck = readSelfCheckReport();
      const selfCheckProblems = selfCheck?.findings.filter((f) => f.level !== "info") ?? [];

      if (errors.length === 0 && diags.length === 0 && selfCheckProblems.length === 0) {
        defaultRuntime.log(
          `No plugin issues detected${live ? " (live)" : ""}${selfCheck ? `; self-check ${selfCheck.ok ? "ok" : "ran"} at ${selfCheck.ranAt}` : ""}.`,
        );
        return;
      }

      const lines: string[] = [];
      if (errors.length > 0) {
        lines.push(theme.error(live ? "Plugin errors (live):" : "Plugin errors:"));
        for (const entry of errors) {
          lines.push(
            `- ${entry.id}${entry.quarantined ? " [quarantined]" : ""}: ${entry.error ?? "failed to load"} (${entry.source})`,
          );
        }
      }
      if (selfCheckProblems.length > 0 && selfCheck) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(theme.warn(`Self-check (${selfCheck.ranAt}):`));
        for (const finding of selfCheckProblems) {
          lines.push(`- [${finding.level}] ${finding.check}: ${finding.message}`);
        }
      }
      if (diags.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(theme.warn("Diagnostics:"));
        for (const diag of diags) {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          lines.push(`- ${target}${diag.message}`);
        }
      }
      const docs = formatDocsLink("/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      defaultRuntime.log(lines.join("\n"));
    });
}
