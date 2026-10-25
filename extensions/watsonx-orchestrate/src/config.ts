import { z } from "zod";

// plugins.entries.watsonx-orchestrate.config. Inert until an administrator lists at least one
// Orchestrate agent: the model can call only the agents listed here, by name.

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Orchestrate agent ids are UUIDs; accept the general id shape, never a path. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((raw) => {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  }, "must be an https URL without credentials, query or fragment");

export const OrchestrateAgentSchema = z
  .object({
    /** Name the model uses in orchestrate_agent_chat. */
    name: z.string().regex(NAME),
    /** The Orchestrate agent id (from the Orchestrate UI or `orchestrate agents list`). */
    agentId: z.string().regex(AGENT_ID),
    /** What the agent does, shown to the model. */
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const OrchestrateConfigSchema = z
  .object({
    /** Service instance URL, e.g. https://api.<region>.watson-orchestrate.cloud.ibm.com/instances/<id>. */
    instanceUrl: httpsUrl.optional(),
    /** IBM Cloud API key, or a bearer token with auth "bearer". Use a `{ "$secret": "<name>" }` ref. */
    apiKey: z.string().trim().min(1).optional(),
    /** "iam" exchanges the API key at IBM Cloud IAM; "bearer" sends the stored token as-is. */
    auth: z.enum(["iam", "bearer"]).default("iam"),
    iamUrl: httpsUrl.optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    maxResponseBytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
    maxMessageChars: z.number().int().min(1).max(200_000).default(32_000),
    agents: z.array(OrchestrateAgentSchema).max(50).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    cfg.agents.forEach((agent, i) => {
      if (names.has(agent.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", i, "name"],
          message: `duplicate agent name "${agent.name}"`,
        });
      }
      names.add(agent.name);
    });
    if (cfg.agents.length > 0 && !cfg.instanceUrl) {
      ctx.addIssue({ code: "custom", path: ["instanceUrl"], message: "instanceUrl is required" });
    }
    if (cfg.agents.length > 0 && !cfg.apiKey) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "apiKey is required (use a secret reference)",
      });
    }
  });

export type OrchestrateConfig = z.infer<typeof OrchestrateConfigSchema>;
export type OrchestrateAgent = z.infer<typeof OrchestrateAgentSchema>;

export function parseOrchestrateConfig(value: unknown): OrchestrateConfig {
  const result = OrchestrateConfigSchema.safeParse(value ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid watsonx-orchestrate config: ${issues}`);
  }
  return result.data;
}

export const orchestratePluginConfigSchema = {
  safeParse(value: unknown) {
    const result = OrchestrateConfigSchema.safeParse(value ?? {});
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
    instanceUrl: { label: "Orchestrate instance URL" },
    apiKey: { label: "API key", sensitive: true, help: "Use a secret reference." },
    agents: { label: "Orchestrate agents the model may call" },
  },
};
