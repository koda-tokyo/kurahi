import { z } from "zod";
import { MemorySchema, ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, AudioSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import { HexColorSchema, ModelsConfigSchema } from "./zod-schema.core.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { McpSchema } from "./zod-schema.mcp.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { CommandsSchema, MessagesSchema, SessionSchema } from "./zod-schema.session.js";
import { VoiceSchema } from "./zod-schema.voice.js";

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const KoLoSchema = z
  .object({
    meta: z
      .object({
        lastTouchedVersion: z.string().optional(),
        lastTouchedAt: z.string().optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunVersion: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        file: z.string().optional(),
        consoleLevel: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        channel: z.union([z.literal("stable"), z.literal("beta"), z.literal("dev")]).optional(),
        checkOnStart: z.boolean().optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        cdpUrl: z.string().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        defaultProfile: z.string().optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        profiles: z
          .record(
            z
              .string()
              .regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                driver: z.union([z.literal("KoLo"), z.literal("extension")]).optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine((value) => value.cdpPort || value.cdpUrl, {
                message: "Profile must set cdpPort or cdpUrl",
              }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([z.literal("api_key"), z.literal("oauth"), z.literal("token")]),
                email: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        isolation: z.union([z.literal("inherit"), z.literal("explicit")]).optional(),
        grants: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
            billingMaxHours: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    models: ModelsConfigSchema,
    nodeHost: NodeHostSchema,
    agents: AgentsSchema,
    memory: MemorySchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: AudioSchema,
    media: z
      .object({
        preserveFilenames: z.boolean().optional(),
      })
      .strict()
      .optional(),
    messages: MessagesSchema,
    commands: CommandsSchema,
    approvals: ApprovalsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
      })
      .strict()
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    channels: ChannelsSchema,
    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
            domain: z.string().optional(),
          })
          .strict()
          .optional(),
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    canvasHost: z
      .object({
        enabled: z.boolean().optional(),
        root: z.string().optional(),
        port: z.number().int().positive().optional(),
        liveReload: z.boolean().optional(),
      })
      .strict()
      .optional(),
    talk: z
      .object({
        voiceId: z.string().optional(),
        voiceAliases: z.record(z.string(), z.string()).optional(),
        modelId: z.string().optional(),
        outputFormat: z.string().optional(),
        apiKey: z.string().optional(),
        interruptOnSpeech: z.boolean().optional(),
      })
      .strict()
      .optional(),
    siblings: z
      .array(
        z
          .object({
            id: z.string().min(1),
            stateDir: z.string().optional(),
            workspaceDir: z.string().optional(),
            url: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    integrity: z
      .object({
        /** Constitution globs (relative to KOLO_HOME or absolute; `~/`, `**`, `{a,b}`, `!exclude`). */
        paths: z.array(z.string()).optional(),
        /** Supply-chain lock for skills and plugins: off | warn (unset fallback) | enforce. */
        supplyChain: z
          .object({ mode: z.enum(["off", "warn", "enforce"]).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    policy: z
      .object({
        /** enforce (default) | audit | off; KOLO_POLICY_MODE overrides. */
        mode: z.enum(["enforce", "audit", "off"]).optional(),
      })
      .strict()
      .optional(),
    kipEngine: z
      .object({
        /** Register the kip_engine_task tool (default false). */
        enabled: z.boolean().optional(),
        /** Loopback base URL of the KIP headless engine. */
        baseUrl: z.string().optional(),
        /** Path to a file holding the bearer token for the engine API. */
        tokenFile: z.string().optional(),
        /** Default cap for waiting on task completion (ms). */
        taskTimeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
      })
      .strict()
      .optional(),
    mcp: McpSchema.optional(),
    voice: VoiceSchema.optional(),
    tui: z
      .object({
        /** A built-in theme name or a path to a JSON theme file. */
        theme: z.string().min(1).max(1024).optional(),
        /** Per action: a key id, `leader+<key>` for a chord, or a list; `leader` sets the chord key. */
        keybinds: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        diffs: z.boolean().optional(),
        reasoning: z
          .object({
            maxLines: z.number().int().min(3).max(100_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    lsp: z
      .object({
        enabled: z.boolean().optional(),
        servers: z
          .record(
            z.string().regex(/^[a-z0-9_-]+$/, "Language ids are lowercase alphanumerics"),
            z
              .object({
                command: z.string().min(1),
                args: z.array(z.string()).optional(),
                rootMarkers: z.array(z.string()).optional(),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
        maxDiagnosticsChars: z.number().int().min(200).max(100_000).optional(),
        diagnosticsTimeoutMs: z.number().int().min(100).max(60_000).optional(),
      })
      .strict()
      .optional(),
    format: z
      .object({
        enabled: z.boolean().optional(),
        onEdit: z
          .record(
            z.string().regex(/^[a-z0-9_-]+$/, "Language ids are lowercase alphanumerics"),
            z.union([z.string().min(1), z.literal(false)]),
          )
          .optional(),
        timeoutMs: z.number().int().min(100).max(120_000).optional(),
        maxOutputChars: z.number().int().min(100).max(100_000).optional(),
      })
      .strict()
      .optional(),
    console: z
      .object({
        terminal: z
          .object({
            enabled: z.boolean().optional(),
            actApprovals: z.union([z.literal("always"), z.literal("policy")]).optional(),
            sandbox: z.union([z.literal("off"), z.literal("required")]).optional(),
            allowInteractive: z
              .array(z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/, "A program name, not a path"))
              .max(64)
              .optional(),
            maxSessionsPerProject: z.number().int().min(1).max(32).optional(),
            maxSessionsPerUser: z.number().int().min(1).max(64).optional(),
            idleTimeoutMs: z.number().int().min(10_000).max(86_400_000).optional(),
            maxLineLength: z.number().int().min(64).max(65_536).optional(),
            outputBytesPerSecond: z
              .number()
              .int()
              .min(1024)
              .max(64 * 1024 * 1024)
              .optional(),
            approvalTimeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    snapshots: z
      .object({
        enabled: z.boolean().optional(),
        maxPerSession: z.number().int().min(1).max(10_000).optional(),
        maxBytesPerSession: z.number().int().min(1024).optional(),
        maxFileBytes: z.number().int().min(1024).optional(),
        required: z.union([z.boolean(), z.array(z.string())]).optional(),
      })
      .strict()
      .optional(),
    evidence: z
      .object({
        enabled: z.boolean().optional(),
        includePrompts: z.boolean().optional(),
        includeReasoning: z.boolean().optional(),
        maxEvents: z.number().int().min(10).max(1_000_000).optional(),
        maxEventBytes: z.number().int().min(256).max(1_048_576).optional(),
        maxBytesPerJob: z.number().int().min(65_536).optional(),
        retentionDays: z.number().int().min(0).max(3650).optional(),
      })
      .strict()
      .optional(),
    factory: z
      .object({
        enabled: z.boolean().optional(),
        defaultBoard: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Board ids are lowercase alphanumerics")
          .optional(),
        defaultRepo: z.string().min(1).optional(),
        github: z
          .object({
            enabled: z.boolean().optional(),
            remote: z.string().min(1).optional(),
            base: z.string().min(1).optional(),
            draft: z.boolean().optional(),
          })
          .strict()
          .optional(),
        policy: z.object({ autoMerge: z.boolean().optional() }).strict().optional(),
        maxTimelineEntries: z.number().int().min(20).max(10_000).optional(),
      })
      .strict()
      .optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
            defaultLocale: z
              .string()
              .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "BCP 47 language tag, e.g. ja or en")
              .optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z.union([z.literal("token"), z.literal("password")]).optional(),
            token: z.string().optional(),
            tokenFile: z.union([z.string(), z.literal(false)]).optional(),
            password: z.string().optional(),
            allowTailscale: z.boolean().optional(),
          })
          .strict()
          .optional(),
        pairing: z
          .object({
            accessTtlMinutes: z.number().positive().optional(),
            refreshTtlDays: z.number().positive().optional(),
            inviteTtlMinutes: z.number().positive().max(60).optional(),
            reconsentDays: z.number().positive().optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        tailscale: z
          .object({
            mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            enabled: z.boolean().optional(),
            url: z.string().optional(),
            transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    files: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxChars: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z.number().int().nonnegative().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([z.literal("auto"), z.literal("manual"), z.literal("off")])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        v3: z
          .object({
            enabled: z.boolean().optional(),
            lease: z.boolean().optional(),
            // Removed flag, still accepted so configs that set it keep loading (the CLI refuses
            // to start on legacy-flagged keys until `doctor --fix`). Nothing reads it.
            biology: z.boolean().optional(),
            scoring: z.boolean().optional(),
            health: z.boolean().optional(),
            memoryBudget: z
              .object({
                globalMaxBytes: z.number().int().positive().optional(),
                perAgentMaxBytes: z.number().int().positive().optional(),
                estimatedBytesPerRequest: z.number().int().positive().optional(),
                rejectionPolicy: z.enum(["reject-new", "oldest-first", "newest-first"]).optional(),
                expectedAgentCount: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        alerts: z
          .object({
            primaryRecipient: z.string().optional(),
            matrixTo: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: z.string().optional(),
                env: z.record(z.string(), z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        hotReload: z
          .union([
            z.boolean(),
            z
              .object({
                enabled: z.boolean().optional(),
                watch: z.boolean().optional(),
                debounceMs: z.number().int().min(50).optional(),
              })
              .strict(),
          ])
          .optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
        installs: z
          .record(
            z.string(),
            z
              .object({
                source: z.union([z.literal("npm"), z.literal("archive"), z.literal("path")]),
                spec: z.string().optional(),
                sourcePath: z.string().optional(),
                installPath: z.string().optional(),
                version: z.string().optional(),
                installedAt: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) {
      return;
    }
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) {
      return;
    }

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") {
        continue;
      }
      if (!Array.isArray(ids)) {
        continue;
      }
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId, idx],
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
          });
        }
      }
    }
  });
