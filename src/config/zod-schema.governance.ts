// Data governance config (docs/security/data-governance.md). Mirrors types.governance.ts.
import { z } from "zod";

const RetentionRuleSchema = z
  .object({
    keepDays: z.number().int().min(0).max(36_500).nullable().optional(),
    mode: z.enum(["delete", "anonymize"]).optional(),
  })
  .strict();

const PersonalDataActionSchema = z.enum(["block", "warn", "off"]);

export const GovernanceSchema = z
  .object({
    retention: z
      .object({
        transcripts: RetentionRuleSchema.optional(),
        workitems: RetentionRuleSchema.optional(),
        evidence: RetentionRuleSchema.optional(),
        audit: RetentionRuleSchema.optional(),
        attachments: RetentionRuleSchema.optional(),
        outputs: RetentionRuleSchema.optional(),
        memory: RetentionRuleSchema.optional(),
        connectorCaches: RetentionRuleSchema.optional(),
      })
      .strict()
      .optional(),
    minimumRetentionDays: z
      .object({
        audit: z.number().int().min(1).max(36_500).optional(),
        evidence: z.number().int().min(1).max(36_500).optional(),
      })
      .strict()
      .optional(),
    sweep: z
      .object({
        enabled: z.boolean().optional(),
        hourUtc: z.number().int().min(0).max(23).optional(),
      })
      .strict()
      .optional(),
    personalData: z
      .object({
        myNumber: PersonalDataActionSchema.optional(),
        otherIdentifiers: PersonalDataActionSchema.optional(),
        redactExports: z.boolean().optional(),
        redactLogs: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
