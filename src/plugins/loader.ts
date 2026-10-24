// Plugin loader (KoLo 2.0, M7: reloadable).
//
// `loadKoLoPlugins` discovers, validates and registers every plugin into one registry. The work
// for a single candidate lives in `loadPluginCandidate` so the host (host.ts) can run it again for
// one plugin after a file change or a config change: dispose the old instance, drop the plugin's
// files from the module cache, import and register the new one. The registry object keeps its
// identity across reloads; consumers never re-fetch it.
import { createJiti } from "jiti";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { KoLoConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type {
  KoLoPluginAuditInput,
  KoLoPluginDefinition,
  KoLoPluginModule,
  KoLoPluginPaths,
  PluginDiagnostic,
  PluginLogger,
} from "./types.js";
import { koloLogDir, koloRunDir, koloSecretsDir } from "../config/kolo-home.js";
import { CONFIG_PATH, resolveStateDir } from "../config/paths.js";
import { authorizeGatewaySigusr1Restart, triggerKoLoRestart } from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands, clearPluginCommandsForPlugin } from "./commands.js";
import {
  normalizePluginsConfig,
  resolveEnableState,
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverKoLoPlugins, type PluginCandidate } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { createPluginHost, type PluginHost } from "./host.js";
import { gatePluginCandidate } from "./integrity.js";
import {
  createPluginLifecycle,
  createPluginSignalBus,
  type PluginLifecycleHandle,
  type PluginSignalBus,
} from "./lifecycle.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import {
  createPluginRegistry,
  removePluginRegistrations,
  type PluginRecord,
  type PluginRegistry,
} from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { validateJsonSchemaValue } from "./schema-validator.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: KoLoConfig;
  workspaceDir?: string;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  cache?: boolean;
  mode?: "full" | "validate";
  /** M7: write plugin.loaded / failed rows to the audit log (the gateway does; CLI reads do not). */
  audit?: boolean;
};

/** One loaded (or quarantined) plugin instance, owned by the host. */
export type PluginInstance = {
  record: PluginRecord;
  candidate: PluginCandidate;
  manifest: PluginManifestRecord;
  lifecycle: PluginLifecycleHandle;
  definition?: KoLoPluginDefinition;
  loadedAt: number;
  reloads: number;
  lastError?: string;
  /** True when the last load threw: the plugin is kept on disk and in the list, never run. */
  quarantined: boolean;
};

export type PluginLoadContext = {
  cfg: KoLoConfig;
  normalized: NormalizedPluginsConfig;
  workspaceDir?: string;
  logger: PluginLogger;
  validateOnly: boolean;
  audit: boolean;
  registry: PluginRegistry;
  createApi: ReturnType<typeof createPluginRegistry>["createApi"];
  jiti: ReturnType<typeof createJiti>;
  signals: PluginSignalBus;
  paths: KoLoPluginPaths;
  instances: Map<string, PluginInstance>;
  seenIds: Map<string, PluginRecord["origin"]>;
  memory: { slot: string | null | undefined; selectedId: string | null; matched: boolean };
};

const registryCache = new Map<string, PluginRegistry>();
const defaultLogger = () => createSubsystemLogger("plugins");

const resolvePluginSdkAlias = (): string | null => {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const isDistRuntime = modulePath.split(path.sep).includes("dist");
    const preferDist = process.env.VITEST || process.env.NODE_ENV === "test" || isDistRuntime;
    let cursor = path.dirname(modulePath);
    for (let i = 0; i < 6; i += 1) {
      const srcCandidate = path.join(cursor, "src", "plugin-sdk", "index.ts");
      const distCandidate = path.join(cursor, "dist", "plugin-sdk", "index.js");
      const orderedCandidates = preferDist
        ? [distCandidate, srcCandidate]
        : [srcCandidate, distCandidate];
      for (const candidate of orderedCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }
  return null;
};

let nativeSdkPreloadAttempted = false;

/** True when the plugin entry imports SDK values (type-only imports are erased by the transform). */
export function sourceImportsPluginSdkValues(source: string): boolean {
  return source
    .split("\n")
    .some((line) => line.includes("KoLo/plugin-sdk") && !/^\s*import\s+type\b/.test(line));
}

/**
 * Loads the built plugin SDK (an ES module) through Node's own loader before jiti sees it.
 *
 * jiti consults the native module cache before transpiling, so a plugin's `KoLo/plugin-sdk`
 * import then resolves to the SDK the host already has in memory instead of being re-evaluated,
 * file by file, through jiti's babel transform (the whole SDK graph: config, channels, zod, the
 * provider SDKs as CommonJS copies). That re-evaluation was most of the cost of a plugin load and
 * gave plugins private copies of host singletons. Here only the dist build (`.js`) is loaded,
 * synchronously; `preparePluginSdk()` covers the source SDK. Any failure (e.g. a graph with
 * top-level await, which `require()` of ESM refuses) leaves the jiti path as it was.
 */
function preloadPluginSdkNatively(entryFile: string): void {
  if (nativeSdkPreloadAttempted) {
    return;
  }
  try {
    if (!sourceImportsPluginSdkValues(fs.readFileSync(entryFile, "utf8"))) {
      return;
    }
  } catch {
    return;
  }
  nativeSdkPreloadAttempted = true;
  const alias = resolvePluginSdkAlias();
  if (!alias || !alias.endsWith(".js")) {
    return;
  }
  try {
    createRequire(import.meta.url)(alias);
  } catch {
    // jiti loads it as before.
  }
}

let sdkPrepared: Promise<void> | null = null;

/**
 * Async counterpart for runs from source (`.ts` SDK, e.g. `node --import tsx src/entry.ts`):
 * `require()` cannot load the source SDK (some dependencies are import-only), and jiti would
 * babel-transform its whole graph (measured ~100 s CPU with a cold cache). The SDK is imported
 * through the host's own ESM loader instead and its namespace placed in the module cache jiti
 * reads, so plugins share the host's modules. A no-op for the dist SDK, which the synchronous
 * preload above handles on demand. Callers on async paths await this before loading plugins; it
 * never throws.
 */
export function preparePluginSdk(): Promise<void> {
  if (!sdkPrepared) {
    sdkPrepared = (async () => {
      const alias = resolvePluginSdkAlias();
      if (!alias) {
        return;
      }
      if (alias.endsWith(".js")) {
        // The dist SDK loads synchronously, and only when a plugin imports it
        // (preloadPluginSdkNatively), so nothing to do ahead of time.
        return;
      }
      try {
        const ns = (await import(pathToFileURL(alias).href)) as Record<string, unknown>;
        const req = createRequire(import.meta.url);
        const keys = new Set([alias]);
        try {
          keys.add(fs.realpathSync(alias));
        } catch {
          // keep the alias spelling only
        }
        for (const key of keys) {
          if (!req.cache[key]) {
            const mod = new Module(key);
            mod.filename = key;
            mod.loaded = true;
            mod.exports = ns;
            req.cache[key] = mod;
          }
        }
      } catch {
        // jiti loads it as before.
      }
    })();
  }
  return sdkPrepared;
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: KoLoPluginDefinition;
  register?: KoLoPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as KoLoPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as KoLoPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
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
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

export function resolvePluginPaths(env: NodeJS.ProcessEnv = process.env): KoLoPluginPaths {
  const home = resolveStateDir(env);
  return {
    home,
    stateDir: home,
    logDir: koloLogDir(home),
    runDir: koloRunDir(home),
    secretsDir: koloSecretsDir(home),
    configPath: CONFIG_PATH,
  };
}

export function auditPluginEvent(
  pluginId: string,
  input: KoLoPluginAuditInput & { source?: string },
): void {
  const outcome =
    input.outcome === "ok" || input.outcome === undefined
      ? "allowed"
      : input.outcome === "failed"
        ? "failed"
        : input.outcome;
  recordAuditEvent({
    action: input.action,
    outcome,
    identity: input.identity,
    scope: input.scope,
    source: input.source ?? `plugin:${pluginId}`,
    detail: input.detail,
  });
}

function restartGatewayViaSupervisor(pluginId: string, reason: string, logger: PluginLogger) {
  logger.warn(`[plugins] ${pluginId} requested a gateway restart: ${reason}`);
  const attempt = triggerKoLoRestart();
  if (attempt.ok) {
    return { ok: true, method: attempt.method, detail: attempt.detail };
  }
  // No external supervisor answered: fall back to the in-process restart path the config
  // reloader uses (SIGUSR1 handled by the gateway runner), when one is installed.
  if (process.listenerCount("SIGUSR1") > 0) {
    authorizeGatewaySigusr1Restart();
    process.emit("SIGUSR1");
    return { ok: true, method: "sigusr1", detail: attempt.detail };
  }
  return { ok: false, method: attempt.method, detail: attempt.detail ?? "no supervisor available" };
}

/** Drops a plugin's own files from the module cache so the next import re-evaluates them. */
export function invalidatePluginModules(
  jiti: ReturnType<typeof createJiti>,
  rootDir: string,
): string[] {
  // Cache keys are the resolver's spelling of the file (realpath: long 8.3 names, canonical
  // case, native separators). Match against both the given root and its realpath, in a
  // separator- and (on Windows) case-insensitive form, or a plugin under a temp dir such as
  // C:\Users\RUNNER~1\... is never evicted and the reload keeps serving the old module.
  const prefixes = new Set<string>();
  const canon = (p: string) => {
    const slashes = p.split(path.sep).join("/");
    const normalized = process.platform === "win32" ? slashes.toLowerCase() : slashes;
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  };
  prefixes.add(canon(rootDir));
  try {
    prefixes.add(canon(fs.realpathSync.native(rootDir)));
  } catch {
    // Directory may already be gone (unlink reload); the raw prefix still applies.
  }
  const dropped: string[] = [];
  const cache = jiti.cache as Record<string, unknown>;
  for (const key of Object.keys(cache)) {
    const canonKey = canon(key);
    if (canonKey.includes("/node_modules/")) {
      continue;
    }
    if ([...prefixes].some((prefix) => canonKey.startsWith(prefix))) {
      delete cache[key];
      dropped.push(key);
    }
  }
  return dropped;
}

function finishRecord(
  ctx: PluginLoadContext,
  record: PluginRecord,
  origin: PluginRecord["origin"],
) {
  ctx.registry.plugins.push(record);
  ctx.seenIds.set(record.id, origin);
}

function failRecord(
  ctx: PluginLoadContext,
  record: PluginRecord,
  origin: PluginRecord["origin"],
  message: string,
  diagnostic: string,
) {
  ctx.logger.error(`[plugins] ${record.id} ${message}`);
  record.status = "error";
  record.error = message;
  finishRecord(ctx, record, origin);
  ctx.registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message: diagnostic,
  });
}

/**
 * Loads one discovered plugin into the context's registry. Returns the record pushed (every
 * outcome produces a record: loaded, disabled, or error = quarantined with the message).
 */
export function loadPluginCandidate(
  ctx: PluginLoadContext,
  candidate: PluginCandidate,
  manifestRecord: PluginManifestRecord,
  opts: { reload?: boolean; previous?: PluginInstance } = {},
): PluginRecord {
  const pluginId = manifestRecord.id;
  const existingOrigin = ctx.seenIds.get(pluginId);
  if (existingOrigin && !opts.reload) {
    const record = createPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      source: candidate.source,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: false,
      configSchema: Boolean(manifestRecord.configSchema),
    });
    record.status = "disabled";
    record.error = `overridden by ${existingOrigin} plugin`;
    ctx.registry.plugins.push(record);
    return record;
  }

  const enableState = resolveEnableState(pluginId, candidate.origin, ctx.normalized);
  const entry = ctx.normalized.entries[pluginId];
  const record = createPluginRecord({
    id: pluginId,
    name: manifestRecord.name ?? pluginId,
    description: manifestRecord.description,
    version: manifestRecord.version,
    source: candidate.source,
    origin: candidate.origin,
    workspaceDir: candidate.workspaceDir,
    enabled: enableState.enabled,
    configSchema: Boolean(manifestRecord.configSchema),
  });
  record.kind = manifestRecord.kind;
  record.configUiHints = manifestRecord.configUiHints;
  record.configJsonSchema = manifestRecord.configSchema;

  const lifecycle = createPluginLifecycle();
  const instance: PluginInstance = {
    record,
    candidate,
    manifest: manifestRecord,
    lifecycle,
    loadedAt: Date.now(),
    reloads: opts.previous ? opts.previous.reloads + 1 : 0,
    quarantined: false,
  };
  ctx.instances.set(pluginId, instance);

  const quarantine = (message: string, diagnostic: string) => {
    instance.quarantined = true;
    instance.lastError = message;
    failRecord(ctx, record, candidate.origin, message, diagnostic);
    if (ctx.audit) {
      auditPluginEvent(pluginId, {
        action: "plugin.failed",
        outcome: "failed",
        source: "plugins",
        detail: { plugin: pluginId, source: record.source, error: message, reload: !!opts.reload },
      });
    }
    return record;
  };

  if (!enableState.enabled) {
    record.status = "disabled";
    record.error = enableState.reason;
    finishRecord(ctx, record, candidate.origin);
    return record;
  }

  // ASI04: an unpinned or modified package is refused in enforce mode before any import.
  const integrity = gatePluginCandidate({ cfg: ctx.cfg, pluginId, candidate, audit: ctx.audit });
  if (!integrity.allowed) {
    const message = `supply-chain ${integrity.message ?? "refused"}`;
    return quarantine(message, message);
  }

  if (!manifestRecord.configSchema) {
    return quarantine("missing config schema", "missing config schema");
  }

  let mod: KoLoPluginModule | null = null;
  // Just before the first plugin import that needs it, so a run whose plugins never import SDK
  // values does not load the SDK at all.
  preloadPluginSdkNatively(candidate.source);
  try {
    mod = ctx.jiti(candidate.source) as KoLoPluginModule;
  } catch (err) {
    return quarantine(
      `failed to load from ${record.source}: ${String(err)}`,
      `failed to load plugin: ${String(err)}`,
    );
  }

  const resolved = resolvePluginModuleExport(mod);
  const definition = resolved.definition;
  const register = resolved.register;
  instance.definition = definition;

  if (definition?.id && definition.id !== record.id) {
    ctx.registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
    });
  }

  record.name = definition?.name ?? record.name;
  record.description = definition?.description ?? record.description;
  record.version = definition?.version ?? record.version;
  const manifestKind = record.kind as string | undefined;
  const exportKind = definition?.kind as string | undefined;
  if (manifestKind && exportKind && exportKind !== manifestKind) {
    ctx.registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: `plugin kind mismatch (manifest uses "${manifestKind}", export uses "${exportKind}")`,
    });
  }
  record.kind = definition?.kind ?? record.kind;

  if (record.kind === "memory" && ctx.memory.slot === record.id) {
    ctx.memory.matched = true;
  }

  const memoryDecision = resolveMemorySlotDecision({
    id: record.id,
    kind: record.kind,
    slot: ctx.memory.slot,
    selectedId: opts.reload && ctx.memory.selectedId === record.id ? null : ctx.memory.selectedId,
  });

  if (!memoryDecision.enabled) {
    record.enabled = false;
    record.status = "disabled";
    record.error = memoryDecision.reason;
    finishRecord(ctx, record, candidate.origin);
    return record;
  }

  if (memoryDecision.selected && record.kind === "memory") {
    ctx.memory.selectedId = record.id;
  }

  const validatedConfig = validatePluginConfig({
    schema: manifestRecord.configSchema,
    cacheKey: manifestRecord.schemaCacheKey,
    value: entry?.config,
  });

  if (!validatedConfig.ok) {
    const message = `invalid config: ${validatedConfig.errors?.join(", ")}`;
    return quarantine(message, message);
  }

  if (ctx.validateOnly) {
    finishRecord(ctx, record, candidate.origin);
    return record;
  }

  if (typeof register !== "function") {
    return quarantine(
      "plugin export missing register/activate",
      "plugin export missing register/activate",
    );
  }

  const api = ctx.createApi(record, {
    config: ctx.cfg,
    pluginConfig: validatedConfig.value,
    lifecycle: lifecycle.api,
    audit: (input) => auditPluginEvent(record.id, input),
    paths: ctx.paths,
    supervisor: {
      restartGateway: (reason) => restartGatewayViaSupervisor(record.id, reason, ctx.logger),
    },
    signals: ctx.signals.forPlugin(lifecycle.api),
    enqueueSystemEvent: (text, sessionKey) => enqueueSystemEvent(text, { sessionKey }),
  });

  try {
    const result = register(api);
    if (result && typeof result.then === "function") {
      ctx.registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "plugin register returned a promise; async registration is ignored",
      });
    }
    finishRecord(ctx, record, candidate.origin);
    if (ctx.audit) {
      auditPluginEvent(pluginId, {
        action: opts.reload ? "plugin.reloaded" : "plugin.loaded",
        source: "plugins",
        detail: {
          plugin: pluginId,
          source: record.source,
          version: record.version,
          tools: record.toolNames.length,
          services: record.services.length,
          reloads: instance.reloads,
        },
      });
    }
    return record;
  } catch (err) {
    // A throwing register may have left partial registrations behind: strip them, then
    // release whatever it grabbed through the api, so nothing of the failed instance runs.
    removePluginRegistrations(ctx.registry, record.id);
    void lifecycle.dispose();
    return quarantine(
      `failed during register from ${record.source}: ${String(err)}`,
      `plugin failed during register: ${String(err)}`,
    );
  }
}

/**
 * Disposes one instance: `dispose()` export, then api-owned resources. Never throws.
 * Registrations are removed by the caller (so the registry is consistent even if dispose hangs).
 */
export async function disposePluginInstance(
  ctx: PluginLoadContext,
  instance: PluginInstance,
  reason: string,
): Promise<void> {
  const id = instance.record.id;
  const errors: string[] = [];
  if (typeof instance.definition?.dispose === "function" && !instance.quarantined) {
    try {
      await Promise.race([
        Promise.resolve(instance.definition.dispose()),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
      ]);
    } catch (err) {
      errors.push(`dispose: ${String(err)}`);
    }
  }
  await instance.lifecycle.dispose((what, err) => errors.push(`${what}: ${String(err)}`));
  for (const message of errors) {
    ctx.logger.warn(`[plugins] ${id} dispose problem (${message})`);
  }
  // A gateway stop disposes every plugin; the stop itself is the audited event, not each plugin.
  if (ctx.audit && reason !== "gateway-stop") {
    auditPluginEvent(id, {
      action: "plugin.disposed",
      outcome: errors.length > 0 ? "failed" : "ok",
      source: "plugins",
      detail: { plugin: id, reason, errors: errors.length > 0 ? errors : undefined },
    });
  }
}

const hosts = new WeakMap<PluginRegistry, PluginHost>();

/** The host that owns a registry produced by `loadKoLoPlugins` (M7 reload surface). */
export function getPluginHost(registry: PluginRegistry): PluginHost | null {
  return hosts.get(registry) ?? null;
}

export function loadKoLoPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const cfg = options.config ?? {};
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      setActivePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading
  clearPluginCommands();

  const runtime = createPluginRuntime();
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverKoLoPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);

  const pluginSdkAlias = resolvePluginSdkAlias();
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(pluginSdkAlias
      ? {
          alias: { "KoLo/plugin-sdk": pluginSdkAlias },
        }
      : {}),
  });

  const ctx: PluginLoadContext = {
    cfg,
    normalized,
    workspaceDir: options.workspaceDir,
    logger,
    validateOnly,
    audit: options.audit === true,
    registry,
    createApi,
    jiti,
    signals: createPluginSignalBus(),
    paths: resolvePluginPaths(),
    instances: new Map(),
    seenIds: new Map(),
    memory: { slot: normalized.slots.memory, selectedId: null, matched: false },
  };

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );

  for (const candidate of discovery.candidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    loadPluginCandidate(ctx, candidate, manifestRecord);
  }

  if (typeof ctx.memory.slot === "string" && !ctx.memory.matched) {
    registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${ctx.memory.slot}`,
    });
  }

  if (cacheEnabled) {
    registryCache.set(cacheKey, registry);
  }
  hosts.set(
    registry,
    createPluginHost({
      ctx,
      cacheKey: cacheEnabled ? cacheKey : null,
      registryCache,
      manifestOptions: { workspaceDir: options.workspaceDir, cache: options.cache },
    }),
  );
  setActivePluginRegistry(registry, cacheKey);
  initializeGlobalHookRunner(registry);
  return registry;
}

// ── Project-scoped plugins (Kurahi v0.3) ─────────────────────────────────────────────────

const scopedRegistryCache = new Map<string, PluginRegistry>();

export type ScopedPluginLoadOptions = {
  config?: KoLoConfig;
  workspaceDir?: string;
  /** Plugin ids a project template enables for that project only. */
  pluginIds: string[];
  logger?: PluginLogger;
};

/**
 * Load plugins for one project scope, without enabling them for the gateway. Only bundled
 * plugins whose manifest says `projectScope: true` qualify, and only when the config does not
 * block them (`plugins.enabled: false`, `plugins.deny`, an allowlist without them, or
 * `plugins.entries.<id>.enabled: false`). A plugin already enabled globally is skipped: its tools
 * come from the gateway registry.
 *
 * The registry is private: it is never activated, so nothing but tools leaves it. A plugin that
 * registers anything else (hooks, channels, providers, services, commands, HTTP or gateway
 * handlers) is refused for scoped use and its tools are dropped.
 */
export function loadScopedKoLoPlugins(options: ScopedPluginLoadOptions): PluginRegistry {
  const cfg = options.config ?? {};
  const logger = options.logger ?? defaultLogger();
  const base = normalizePluginsConfig(cfg.plugins);
  const wanted = [...new Set(options.pluginIds.map((id) => id.trim()).filter(Boolean))].toSorted();
  const cacheKey = `${buildCacheKey({ workspaceDir: options.workspaceDir, plugins: base })}::scoped:${wanted.join(",")}`;
  const cached = scopedRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const runtime = createPluginRuntime();
  const { registry, createApi } = createPluginRegistry({ logger, runtime });
  const discovery = discoverKoLoPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: base.loadPaths,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  // Enabled for this registry only; the global config is untouched.
  const entries = { ...base.entries };
  const loadable: Array<{ candidate: PluginCandidate; manifest: PluginManifestRecord }> = [];
  for (const id of wanted) {
    const manifest = manifestRegistry.plugins.find((p) => p.id === id);
    const candidate = manifest
      ? discovery.candidates.find((c) => c.rootDir === manifest.rootDir)
      : undefined;
    const refuse = (message: string) => {
      registry.diagnostics.push({ level: "warn", pluginId: id, message });
      logger.warn(`[plugins] ${id}: not enabled for the project (${message})`);
    };
    if (!manifest || !candidate) {
      refuse("plugin not found");
      continue;
    }
    if (candidate.origin !== "bundled" || manifest.projectScope !== true) {
      refuse("only bundled plugins with projectScope: true can be enabled per project");
      continue;
    }
    if (resolveEnableState(id, candidate.origin, base).enabled) {
      continue; // already enabled for the gateway
    }
    const entry = base.entries[id];
    if (!base.enabled || base.deny.includes(id) || entry?.enabled === false) {
      refuse("disabled in config");
      continue;
    }
    if (base.allow.length > 0 && !base.allow.includes(id)) {
      refuse("not in plugins.allow");
      continue;
    }
    entries[id] = { ...entry, enabled: true };
    loadable.push({ candidate, manifest });
  }

  const pluginSdkAlias = resolvePluginSdkAlias();
  const ctx: PluginLoadContext = {
    cfg,
    normalized: { ...base, entries },
    workspaceDir: options.workspaceDir,
    logger,
    validateOnly: false,
    audit: false,
    registry,
    createApi,
    jiti: createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      ...(pluginSdkAlias ? { alias: { "KoLo/plugin-sdk": pluginSdkAlias } } : {}),
    }),
    signals: createPluginSignalBus(),
    paths: resolvePluginPaths(),
    instances: new Map(),
    seenIds: new Map(),
    memory: { slot: null, selectedId: null, matched: false },
  };
  for (const { candidate, manifest } of loadable) {
    loadPluginCandidate(ctx, candidate, manifest);
  }

  // Tool-only: anything else a plugin registered would be inert here, which is wrong for it.
  const nonTool = new Set<string>();
  const mark = (list: Array<{ pluginId?: string }>) => {
    for (const r of list) {
      // No owner recorded: refuse every scoped plugin rather than guess.
      for (const id of r.pluginId ? [r.pluginId] : loadable.map((l) => l.manifest.id)) {
        nonTool.add(id);
      }
    }
  };
  mark(registry.hooks);
  mark(registry.typedHooks);
  mark(registry.channels);
  mark(registry.providers);
  mark(registry.httpHandlers);
  mark(registry.httpRoutes);
  mark(registry.cliRegistrars);
  mark(registry.services);
  mark(registry.commands);
  if (Object.keys(registry.gatewayHandlers).length > 0) {
    for (const { manifest } of loadable) {
      nonTool.add(manifest.id);
    }
  }
  for (const id of nonTool) {
    clearPluginCommandsForPlugin(id);
    registry.tools = registry.tools.filter((t) => t.pluginId !== id);
    registry.diagnostics.push({
      level: "error",
      pluginId: id,
      message: "registers more than tools; it cannot be enabled per project",
    });
    logger.error(`[plugins] ${id}: registers more than tools; not enabled for the project`);
  }

  scopedRegistryCache.set(cacheKey, registry);
  return registry;
}
