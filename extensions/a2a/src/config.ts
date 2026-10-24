import { z } from "zod";

// Config for the A2A plugin (plugins.entries.a2a.config). Both halves are inert until the
// operator lists something: the server needs `server.enabled`, at least one agent and one
// client; the client tools need at least one remote agent.

const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Bearer tokens shorter than this are refused: a guessable token defeats the allowlist. */
export const MIN_TOKEN_LENGTH = 32;

const tokenSchema = z
  .string()
  .trim()
  .min(MIN_TOKEN_LENGTH, `token must be at least ${MIN_TOKEN_LENGTH} characters`);

export const A2aSkillSchema = z
  .object({
    id: z.string().regex(ID),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    examples: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  })
  .strict();

export const A2aExposedAgentSchema = z
  .object({
    /** Internal agent id (agents.list[].id). Never published. */
    agentId: z.string().trim().min(1),
    /** Public path segment: <basePath>/<slug>. Defaults to the agent id. */
    slug: z.string().regex(SLUG).optional(),
    /** Public name and description shown on the Agent Card. */
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    version: z.string().trim().min(1).max(40).default("1.0.0"),
    skills: z.array(A2aSkillSchema).min(1).max(50),
    /**
     * Let the agent use its tools for A2A requests. Off by default (model-only run). When on,
     * every tool call still goes through the policy guard and approvals like any other session.
     */
    allowTools: z.boolean().default(false),
    /** Extra operator instructions for A2A sessions of this agent. */
    instructions: z.string().max(4000).optional(),
    timeoutSeconds: z.number().int().min(5).max(3600).default(300),
  })
  .strict();

export const A2aServerClientSchema = z
  .object({
    /** Stable id for audit rows and session keys. */
    id: z.string().regex(ID),
    /** Bearer token; a `{ "$secret": "<name>" }` ref is resolved by the config loader. */
    token: tokenSchema,
    /** Slugs this client may call. */
    agents: z.array(z.string().regex(SLUG)).min(1),
  })
  .strict();

export const A2aServerSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Path prefix for the JSON-RPC endpoints. */
    basePath: z
      .string()
      .regex(/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/)
      .default("/a2a"),
    /**
     * Accept requests whose client address is not loopback. Off by default: the endpoints answer
     * only local callers (and local reverse proxies listed in gateway.trustedProxies on behalf of
     * local clients) until the operator opts in.
     */
    allowNonLoopback: z.boolean().default(false),
    /** Base URL published on the Agent Card (e.g. https://agents.example.com). */
    publicUrl: z.string().url().optional(),
    /** Slug served at /.well-known/agent-card.json. */
    defaultAgent: z.string().regex(SLUG).optional(),
    /** Serve Agent Cards without a bearer token (discovery). The JSON-RPC endpoint always requires one. */
    publicCard: z.boolean().default(true),
    streaming: z.boolean().default(true),
    maxBodyBytes: z.number().int().min(1024).max(4_194_304).default(65_536),
    maxInputChars: z.number().int().min(100).max(1_000_000).default(32_000),
    maxParts: z.number().int().min(1).max(100).default(20),
    requestsPerMinute: z.number().int().min(1).max(10_000).default(30),
    maxConcurrentTasks: z.number().int().min(1).max(100).default(4),
    maxTasks: z.number().int().min(10).max(100_000).default(500),
    taskTtlMinutes: z.number().int().min(1).max(10_080).default(60),
    provider: z
      .object({ organization: z.string().trim().min(1).max(120), url: z.string().url() })
      .strict()
      .optional(),
    agents: z.array(A2aExposedAgentSchema).default([]),
    clients: z.array(A2aServerClientSchema).default([]),
  })
  .strict();

export const A2aRemoteAgentSchema = z
  .object({
    /** Name the model uses in a2a_send. */
    name: z.string().regex(SLUG),
    /** Agent Card URL. HTTPS unless the host is loopback. */
    cardUrl: z.string().url(),
    /**
     * JSON-RPC endpoint. Defaults to the one on the card, which must then share the card's
     * origin (a card cannot redirect calls to another host).
     */
    rpcUrl: z.string().url().optional(),
    token: tokenSchema.optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

export const A2aClientSchema = z
  .object({
    timeoutMs: z.number().int().min(1000).max(900_000).default(120_000),
    maxResponseBytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
    maxMessageChars: z.number().int().min(1).max(1_000_000).default(32_000),
    cardTtlSeconds: z.number().int().min(0).max(86_400).default(300),
    agents: z.array(A2aRemoteAgentSchema).default([]),
  })
  .strict();

export const A2aConfigSchema = z
  .object({
    server: A2aServerSchema.default(() => A2aServerSchema.parse({})),
    client: A2aClientSchema.default(() => A2aClientSchema.parse({})),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const slugs = new Set<string>();
    cfg.server.agents.forEach((agent, i) => {
      const slug = agent.slug ?? agent.agentId.toLowerCase();
      if (!SLUG.test(slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["server", "agents", i, "slug"],
          message: `agentId "${agent.agentId}" is not a valid slug; set slug explicitly`,
        });
      }
      if (slugs.has(slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["server", "agents", i, "slug"],
          message: `duplicate slug "${slug}"`,
        });
      }
      slugs.add(slug);
    });
    const ids = new Set<string>();
    const tokens = new Set<string>();
    cfg.server.clients.forEach((client, i) => {
      if (ids.has(client.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["server", "clients", i, "id"],
          message: `duplicate client id "${client.id}"`,
        });
      }
      ids.add(client.id);
      if (tokens.has(client.token)) {
        ctx.addIssue({
          code: "custom",
          path: ["server", "clients", i, "token"],
          message: "two clients share a token",
        });
      }
      tokens.add(client.token);
      client.agents.forEach((slug, j) => {
        if (!slugs.has(slug)) {
          ctx.addIssue({
            code: "custom",
            path: ["server", "clients", i, "agents", j],
            message: `unknown agent slug "${slug}"`,
          });
        }
      });
    });
    if (cfg.server.defaultAgent && !slugs.has(cfg.server.defaultAgent)) {
      ctx.addIssue({
        code: "custom",
        path: ["server", "defaultAgent"],
        message: `unknown agent slug "${cfg.server.defaultAgent}"`,
      });
    }
    const names = new Set<string>();
    cfg.client.agents.forEach((agent, i) => {
      if (names.has(agent.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["client", "agents", i, "name"],
          message: `duplicate remote agent name "${agent.name}"`,
        });
      }
      names.add(agent.name);
    });
  });

export type A2aConfig = z.infer<typeof A2aConfigSchema>;
export type A2aServerConfig = A2aConfig["server"];
export type A2aClientConfig = A2aConfig["client"];
export type A2aExposedAgent = z.infer<typeof A2aExposedAgentSchema> & { slug: string };
export type A2aRemoteAgent = z.infer<typeof A2aRemoteAgentSchema>;
export type A2aServerClient = z.infer<typeof A2aServerClientSchema>;

/** Parse and normalise (every exposed agent gets its slug). Throws a readable error. */
export type ParsedA2aConfig = {
  server: Omit<A2aServerConfig, "agents"> & { agents: A2aExposedAgent[] };
  client: A2aClientConfig;
};

export function parseA2aConfig(value: unknown): ParsedA2aConfig {
  const result = A2aConfigSchema.safeParse(value ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid a2a config: ${issues}`);
  }
  const cfg = result.data;
  return {
    ...cfg,
    server: {
      ...cfg.server,
      agents: cfg.server.agents.map((agent) => ({
        ...agent,
        slug: agent.slug ?? agent.agentId.toLowerCase(),
      })),
    },
  };
}

/** Plugin configSchema adapter (safeParse shape the loader and UI understand). */
export const a2aPluginConfigSchema = {
  safeParse(value: unknown) {
    const result = A2aConfigSchema.safeParse(value ?? {});
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.filter((p): p is string | number => typeof p !== "symbol"),
          message: issue.message,
        })),
      },
    };
  },
  uiHints: {
    "server.enabled": { label: "Serve A2A" },
    "server.clients": { label: "A2A clients", help: "Each client has its own bearer token." },
    "client.agents": { label: "Remote A2A agents" },
  },
};
