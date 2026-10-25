// Plugin host (KoLo 2.0, M7): hot reload without a gateway restart.
//
// Owns the instances the loader produced for one registry and knows how to replace one of them:
//   stop its services → strip its registrations → dispose() + api-owned resources → drop its
//   files from the module cache → import + register again → start its services.
// The registry object (and its arrays) keep their identity, so the hook runner, HTTP router, WS
// dispatcher and tool resolver see the new instance without being rebuilt. A plugin whose load
// throws stays listed as `error` (quarantined) with the message; the gateway keeps running.
import chokidar from "chokidar";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { PluginCandidate } from "./discovery.js";
import type { PluginLoadContext, PluginInstance } from "./loader.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { PluginServicesHandle } from "./services.js";
import { resolveReleaseProfile, type ReleaseProfile } from "../packaging/release-profile.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { discoverKoLoPlugins } from "./discovery.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { removePluginRegistrations } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

export type PluginReloadReason = "manual" | "file-change" | "config-change" | "enable" | "disable";

export type PluginReloadResult = {
  id: string;
  ok: boolean;
  status: PluginRecord["status"];
  error?: string;
  reloads: number;
  durationMs: number;
};

export type PluginConfigApplyResult = {
  reloaded: string[];
  disabled: string[];
  failed: string[];
  /** Every plugin was re-evaluated (allow/deny/load paths/slots changed). */
  full: boolean;
};

export type PluginHostPluginState = {
  id: string;
  status: PluginRecord["status"];
  error?: string;
  quarantined: boolean;
  loadedAt?: number;
  reloads: number;
  lastError?: string;
  rootDir?: string;
  watched: boolean;
  services: string[];
  resources: number;
};

export type PluginHotReloadSettings = {
  enabled: boolean;
  watch: boolean;
  debounceMs: number;
};

export type PluginHost = {
  registry: PluginRegistry;
  reload: (id: string, opts?: { reason?: PluginReloadReason }) => Promise<PluginReloadResult>;
  unload: (id: string, opts?: { reason?: PluginReloadReason }) => Promise<boolean>;
  applyConfig: (nextConfig: KoLoConfig) => Promise<PluginConfigApplyResult>;
  attachServices: (services: PluginServicesHandle) => void;
  /** Start watching plugin directories; returns the stop function (also run by `dispose`). */
  watch: (opts?: { debounceMs?: number }) => () => Promise<void>;
  hasWatcher: () => boolean;
  state: () => PluginHostPluginState[];
  settings: () => PluginHotReloadSettings;
  /** Dispose every instance (gateway stop). Services must already be stopped by the caller. */
  dispose: () => Promise<void>;
};

const DEFAULT_DEBOUNCE_MS = 400;

export function resolvePluginHotReloadSettings(cfg: KoLoConfig): PluginHotReloadSettings {
  const raw = (cfg.plugins as { hotReload?: unknown } | undefined)?.hotReload;
  if (raw === false) {
    return { enabled: false, watch: false, debounceMs: DEFAULT_DEBOUNCE_MS };
  }
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabled = obj.enabled !== false;
  const watch = enabled && obj.watch !== false;
  const debounceRaw = obj.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(50, Math.floor(debounceRaw))
      : DEFAULT_DEBOUNCE_MS;
  return { enabled, watch, debounceMs };
}

/** Same key as buildCacheKey in loader.ts (the release profile is part of it). */
function buildCacheKey(
  workspaceDir: string | undefined,
  plugins: NormalizedPluginsConfig,
  profile: ReleaseProfile,
) {
  const workspaceKey = workspaceDir ? resolveUserPath(workspaceDir) : "";
  return `${workspaceKey}::${profile}::${JSON.stringify(plugins)}`;
}

function globalPolicyChanged(a: NormalizedPluginsConfig, b: NormalizedPluginsConfig): boolean {
  const pick = (n: NormalizedPluginsConfig) =>
    JSON.stringify({
      enabled: n.enabled,
      allow: n.allow,
      deny: n.deny,
      loadPaths: n.loadPaths,
      slots: n.slots,
    });
  return pick(a) !== pick(b);
}

export function createPluginHost(params: {
  ctx: PluginLoadContext;
  cacheKey: string | null;
  registryCache: Map<string, PluginRegistry>;
  manifestOptions: { workspaceDir?: string; cache?: boolean };
}): PluginHost {
  const { ctx, registryCache } = params;
  let cacheKey = params.cacheKey;
  let services: PluginServicesHandle | null = null;
  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  const watched = new Set<string>();
  const debounces = new Map<string, NodeJS.Timeout>();
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;

  // Loader internals are imported lazily to avoid a static import cycle (loader → host → loader).
  const internals = async () => await import("./loader.js");

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const discoverOne = (
    id: string,
  ): { candidate: PluginCandidate; manifest: PluginManifestRecord } | null => {
    const discovery = discoverKoLoPlugins({
      workspaceDir: ctx.workspaceDir,
      extraPaths: ctx.normalized.loadPaths,
    });
    const manifests = loadPluginManifestRegistry({
      config: ctx.cfg,
      workspaceDir: ctx.workspaceDir,
      cache: false,
      candidates: discovery.candidates,
      diagnostics: [],
    });
    const byRoot = new Map(manifests.plugins.map((m) => [m.rootDir, m]));
    for (const candidate of discovery.candidates) {
      const manifest = byRoot.get(candidate.rootDir);
      if (manifest && manifest.id === id) {
        return { candidate, manifest };
      }
    }
    return null;
  };

  const refreshManifest = (candidate: PluginCandidate): PluginManifestRecord | null => {
    const manifests = loadPluginManifestRegistry({
      config: ctx.cfg,
      workspaceDir: ctx.workspaceDir,
      cache: false,
      candidates: [candidate],
      diagnostics: [],
    });
    return manifests.plugins.find((m) => m.rootDir === candidate.rootDir) ?? null;
  };

  const tearDown = async (id: string, reason: string): Promise<PluginInstance | undefined> => {
    const instance = ctx.instances.get(id);
    if (services) {
      await services.stopPlugin(id);
    }
    removePluginRegistrations(ctx.registry, id);
    ctx.seenIds.delete(id);
    ctx.instances.delete(id);
    if (ctx.memory.selectedId === id) {
      ctx.memory.selectedId = null;
    }
    if (instance) {
      const { disposePluginInstance } = await internals();
      await disposePluginInstance(ctx, instance, reason);
    }
    return instance;
  };

  const watchDir = (dir: string) => {
    if (!watcher || watched.has(dir)) {
      return;
    }
    watched.add(dir);
    watcher.add(dir);
  };

  const reloadNow = async (id: string, reason: PluginReloadReason): Promise<PluginReloadResult> => {
    const startedAt = Date.now();
    const previous = ctx.instances.get(id);
    let candidate = previous?.candidate;
    if (!candidate) {
      const found = discoverOne(id);
      if (!found) {
        return {
          id,
          ok: false,
          status: "error",
          error: "plugin not found (no manifest with that id in the plugin paths)",
          reloads: 0,
          durationMs: Date.now() - startedAt,
        };
      }
      candidate = found.candidate;
    }
    ctx.logger.info(`[plugins] reloading ${id} (${reason})`);
    const prior = await tearDown(id, reason);
    const { invalidatePluginModules, loadPluginCandidate } = await internals();
    invalidatePluginModules(ctx.jiti, candidate.rootDir);
    const manifest = refreshManifest(candidate);
    if (!manifest) {
      const record: PluginRecord = {
        ...(prior?.record ?? {
          id,
          name: id,
          source: candidate.source,
          origin: candidate.origin,
          workspaceDir: candidate.workspaceDir,
          enabled: false,
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          configSchema: false,
        }),
        status: "error",
        error: "manifest missing or invalid (KoLo.plugin.json)",
      };
      ctx.registry.plugins.push(record);
      ctx.registry.diagnostics.push({
        level: "error",
        pluginId: id,
        source: candidate.source,
        message: record.error ?? "manifest invalid",
      });
      return {
        id,
        ok: false,
        status: "error",
        error: record.error,
        reloads: prior?.reloads ?? 0,
        durationMs: Date.now() - startedAt,
      };
    }
    const record = loadPluginCandidate(ctx, candidate, manifest, { reload: true, previous: prior });
    const instance = ctx.instances.get(id);
    if (record.status === "loaded" && services) {
      await services.startPlugin(id);
    }
    if (record.status === "loaded" || instance?.quarantined) {
      watchDir(candidate.rootDir);
    }
    return {
      id,
      ok: record.status === "loaded",
      status: record.status,
      error: record.error,
      reloads: instance?.reloads ?? prior?.reloads ?? 0,
      durationMs: Date.now() - startedAt,
    };
  };

  const host: PluginHost = {
    registry: ctx.registry,
    reload: (id, opts) => serial(() => reloadNow(id, opts?.reason ?? "manual")),
    unload: (id, opts) =>
      serial(async () => {
        const instance = ctx.instances.get(id);
        if (!instance) {
          return false;
        }
        await tearDown(id, opts?.reason ?? "disable");
        ctx.registry.plugins.push({
          ...instance.record,
          enabled: false,
          status: "disabled",
          error: "disabled in config",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
        });
        return true;
      }),
    applyConfig: (nextConfig) =>
      serial(async () => {
        const result: PluginConfigApplyResult = {
          reloaded: [],
          disabled: [],
          failed: [],
          full: false,
        };
        const prevNormalized = ctx.normalized;
        const prevProfile = resolveReleaseProfile(ctx.cfg);
        const nextNormalized = normalizePluginsConfig(nextConfig.plugins);
        const nextProfile = resolveReleaseProfile(nextConfig);
        ctx.cfg = nextConfig;
        ctx.normalized = nextNormalized;
        ctx.memory.slot = nextNormalized.slots.memory;
        // Re-key the registry cache so a later loadKoLoPlugins(nextConfig) returns this registry.
        if (cacheKey !== null) {
          registryCache.delete(cacheKey);
          cacheKey = buildCacheKey(ctx.workspaceDir, nextNormalized, nextProfile);
          registryCache.set(cacheKey, ctx.registry);
          setActivePluginRegistry(ctx.registry, cacheKey);
        }

        const affected = new Set<string>();
        // A release-profile switch re-evaluates every plugin, like a global policy change.
        if (globalPolicyChanged(prevNormalized, nextNormalized) || prevProfile !== nextProfile) {
          result.full = true;
          for (const record of ctx.registry.plugins) {
            affected.add(record.id);
          }
          // Plugins that only exist under a new load path are discovered on reload by id; a
          // full re-discovery adds candidates the previous policy never listed.
          const discovery = discoverKoLoPlugins({
            workspaceDir: ctx.workspaceDir,
            extraPaths: nextNormalized.loadPaths,
          });
          const manifests = loadPluginManifestRegistry({
            config: nextConfig,
            workspaceDir: ctx.workspaceDir,
            cache: false,
            candidates: discovery.candidates,
            diagnostics: [],
          });
          for (const manifest of manifests.plugins) {
            affected.add(manifest.id);
          }
        } else {
          const ids = new Set([
            ...Object.keys(prevNormalized.entries),
            ...Object.keys(nextNormalized.entries),
          ]);
          for (const id of ids) {
            const before = JSON.stringify(prevNormalized.entries[id] ?? null);
            const after = JSON.stringify(nextNormalized.entries[id] ?? null);
            if (before !== after) {
              affected.add(id);
            }
          }
        }

        for (const id of affected) {
          const known = ctx.instances.has(id) || ctx.registry.plugins.some((p) => p.id === id);
          const outcome = await reloadNow(id, "config-change");
          if (outcome.status === "loaded") {
            result.reloaded.push(id);
          } else if (outcome.status === "disabled") {
            result.disabled.push(id);
          } else if (known || outcome.error !== undefined) {
            result.failed.push(id);
          }
        }
        return result;
      }),
    attachServices: (handle) => {
      services = handle;
    },
    watch: (opts) => {
      if (watcher) {
        return async () => {};
      }
      const debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
      watcher = chokidar.watch([], {
        ignoreInitial: true,
        persistent: true,
        // chokidar reports forward-slash paths on Windows too, so match either separator;
        // otherwise nothing is pruned and the watcher follows `node_modules/kolo` (the pnpm
        // workspace link back to the repo root) into the whole tree, and every write there
        // reloads the plugin (and each reload audits, which writes, which reloads …).
        ignored: (file: string) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(file),
        awaitWriteFinish: { stabilityThreshold: Math.min(debounceMs, 300), pollInterval: 50 },
      });
      const onChange = (file: string) => {
        if (disposed) {
          return;
        }
        // Longest root wins when plugin directories nest (a workspace inside a load path).
        let match: { id: string; root: string } | null = null;
        for (const [id, instance] of ctx.instances) {
          const root = instance.candidate.rootDir;
          if (file === root || file.startsWith(`${root}${path.sep}`)) {
            if (!match || root.length > match.root.length) {
              match = { id, root };
            }
          }
        }
        if (!match) {
          return;
        }
        const id = match.id;
        const pending = debounces.get(id);
        if (pending) {
          clearTimeout(pending);
        }
        debounces.set(
          id,
          setTimeout(() => {
            debounces.delete(id);
            void host.reload(id, { reason: "file-change" }).catch((err) => {
              ctx.logger.error(`[plugins] ${id} reload failed: ${String(err)}`);
            });
          }, debounceMs),
        );
      };
      watcher.on("change", onChange);
      watcher.on("add", onChange);
      watcher.on("unlink", onChange);
      watcher.on("error", (err: unknown) => {
        ctx.logger.warn(`[plugins] watcher error: ${String(err)}`);
      });
      for (const instance of ctx.instances.values()) {
        if (instance.record.status === "loaded" || instance.quarantined) {
          watchDir(instance.candidate.rootDir);
        }
      }
      const stop = async () => {
        for (const timer of debounces.values()) {
          clearTimeout(timer);
        }
        debounces.clear();
        const current = watcher;
        watcher = null;
        watched.clear();
        if (current) {
          await current.close().catch(() => undefined);
        }
      };
      return stop;
    },
    hasWatcher: () => watcher !== null,
    state: () => {
      const running = services?.running() ?? {};
      return ctx.registry.plugins.map((record) => {
        const instance = ctx.instances.get(record.id);
        const rootDir = instance?.candidate.rootDir;
        return {
          id: record.id,
          status: record.status,
          error: record.error,
          quarantined: instance?.quarantined ?? false,
          loadedAt: instance?.loadedAt,
          reloads: instance?.reloads ?? 0,
          lastError: instance?.lastError,
          rootDir,
          watched: rootDir ? watched.has(rootDir) : false,
          services: running[record.id] ?? [],
          resources: instance?.lifecycle.size() ?? 0,
        };
      });
    },
    settings: () => resolvePluginHotReloadSettings(ctx.cfg),
    dispose: () =>
      serial(async () => {
        disposed = true;
        for (const timer of debounces.values()) {
          clearTimeout(timer);
        }
        debounces.clear();
        if (watcher) {
          const current = watcher;
          watcher = null;
          await current.close().catch(() => undefined);
        }
        const { disposePluginInstance } = await internals();
        for (const [id, instance] of [...ctx.instances].reverse()) {
          removePluginRegistrations(ctx.registry, id);
          ctx.instances.delete(id);
          await disposePluginInstance(ctx, instance, "gateway-stop");
        }
        if (cacheKey !== null) {
          registryCache.delete(cacheKey);
        }
      }),
  };
  return host;
}
