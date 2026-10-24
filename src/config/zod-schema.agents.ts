import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

const ConsciousnessAgentEntrySchema = z
  .object({
    userId: z.string(),
    name: z.string().optional(),
    tickIntervalMs: z.number().optional(),
    perceptionSources: z.array(z.string()).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    bridgeRepo: z.string().optional(),
    quietHours: z
      .object({
        start: z.number(),
        end: z.number(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ConsciousnessSchema = z
  .object({
    enabled: z.boolean().optional(),
    garageMode: z.boolean().optional(),
    agents: z.array(ConsciousnessAgentEntrySchema).optional(),
  })
  .strict()
  .optional();

const AgentMessagingSchema = z
  .object({
    signing: z
      .object({
        mode: z.enum(["off", "warn", "enforce"]).optional(),
        maxAgeSeconds: z.number().int().min(1).max(86_400).optional(),
        maxPayloadBytes: z.number().int().min(1024).max(16_777_216).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
    consciousness: ConsciousnessSchema,
    messaging: AgentMessagingSchema,
  })
  .strict()
  .optional();

export const BindingsSchema = z
  .array(
    z
      .object({
        agentId: z.string(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
            peer: z
              .object({
                kind: z.union([z.literal("dm"), z.literal("group"), z.literal("channel")]),
                id: z.string(),
              })
              .strict()
              .optional(),
            guildId: z.string().optional(),
            teamId: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
