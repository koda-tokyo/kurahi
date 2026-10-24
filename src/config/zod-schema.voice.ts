// Zod schema for `voice` (Work Console push-to-talk). Off by default; see types.voice.ts.
import path from "node:path";
import { z } from "zod";

const ADAPTER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const Lang = z.union([z.literal("ja"), z.literal("en")]);

const LocalCliSchema = z
  .object({
    binary: z
      .string()
      .min(1)
      .refine((p) => path.isAbsolute(p), "`binary` must be an absolute path")
      .optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const LocalHttpSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "`url` must be http(s)")
      .optional(),
    allowNonLoopback: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(256 * 1024 * 1024)
      .optional(),
  })
  .strict();

const LimitsSchema = z
  .object({
    maxSessionMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 60_000)
      .optional(),
    maxChunkBytes: z
      .number()
      .int()
      .min(320)
      .max(1024 * 1024)
      .optional(),
    maxChunksPerSecond: z.number().int().min(1).max(1000).optional(),
    realtimeFactor: z.number().min(1).max(100).optional(),
    maxConcurrentSessions: z.number().int().min(1).max(16).optional(),
    idleTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
    maxSpeakChars: z.number().int().min(1).max(100_000).optional(),
    outChunkBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024)
      .optional(),
  })
  .strict();

export const VoiceSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: z
      .object({
        adapter: z.string().regex(ADAPTER_ID).optional(),
        localCli: LocalCliSchema.optional(),
        fake: z.object({ autoLang: Lang.optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        adapter: z.string().regex(ADAPTER_ID).optional(),
        localHttp: LocalHttpSchema.optional(),
      })
      .strict()
      .optional(),
    cloud: z.object({ allow: z.boolean().optional() }).strict().optional(),
    adapterOptions: z
      .record(z.string().regex(ADAPTER_ID), z.record(z.string(), z.unknown()))
      .optional(),
    limits: LimitsSchema.optional(),
    privacy: z
      .object({
        keepAudio: z.boolean().optional(),
        keepAudioDir: z
          .string()
          .min(1)
          .refine((p) => path.isAbsolute(p), "`keepAudioDir` must be an absolute path")
          .optional(),
      })
      .strict()
      .superRefine((p, ctx) => {
        if (p.keepAudio && !p.keepAudioDir) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["keepAudioDir"],
            message: "keepAudio needs an explicit keepAudioDir.",
          });
        }
      })
      .optional(),
  })
  .strict();
