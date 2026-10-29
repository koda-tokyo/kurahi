// Data governance protocol (docs/security/data-governance.md): retention policy, the retention
// sweeper, legal holds, eDiscovery exports and data subject requests. Every method except
// governance.policy.get is person-only (operator.approvals; voice refused; an SSO person when
// enterprise identity is configured).
import { Type, type TSchema } from "@sinclair/typebox";

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

const ProjectId = Type.String({ pattern: "^p[a-z0-9]{10}$" });
const Reason = Type.String({ minLength: 2, maxLength: 2000 });
const IdList = Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 200 });

export const GOVERNANCE_DATA_CLASSES = [
  "transcripts",
  "workitems",
  "evidence",
  "audit",
  "attachments",
  "outputs",
  "memory",
  "connectorCaches",
] as const;
const DataClass = lit(GOVERNANCE_DATA_CLASSES);
const ExportClass = lit([
  "workitems",
  "evidence",
  "transcripts",
  "attachments",
  "outputs",
  "memory",
  "audit",
] as const);
const PersonalAction = lit(["block", "warn", "off"] as const);

export const GovernanceRetentionRuleSchema = Type.Object({
  /** null = indefinite. */
  keepDays: Nullable(Type.Integer({ minimum: 0, maximum: 36_500 })),
  mode: lit(["delete", "anonymize"] as const),
});

const RetentionRuleInput = strict({
  keepDays: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 36_500 }))),
  mode: Type.Optional(lit(["delete", "anonymize"] as const)),
});

export const GovernanceRetentionPolicySchema = Type.Record(
  Type.String(),
  GovernanceRetentionRuleSchema,
);

export const GovernancePersonalDataPolicySchema = Type.Object({
  myNumber: PersonalAction,
  otherIdentifiers: PersonalAction,
  redactExports: Type.Boolean(),
  redactLogs: Type.Boolean(),
});

const PersonalDataInput = strict({
  myNumber: Type.Optional(PersonalAction),
  otherIdentifiers: Type.Optional(PersonalAction),
  redactExports: Type.Optional(Type.Boolean()),
  redactLogs: Type.Optional(Type.Boolean()),
});

export const GovernanceHoldScopeSchema = strict({
  projectIds: Type.Optional(IdList),
  workItemIds: Type.Optional(IdList),
  /** Identities named in a record (requester, approver, actor, sender). */
  persons: Type.Optional(IdList),
  /** Identities that own or created a record. */
  custodians: Type.Optional(IdList),
  from: Type.Optional(Nullable(Type.String())),
  to: Type.Optional(Nullable(Type.String())),
});

export const GovernanceHoldSchema = Type.Object({
  id: Type.String(),
  matterId: Type.String(),
  reason: Type.String(),
  scope: GovernanceHoldScopeSchema,
  status: lit(["active", "released"] as const),
  createdAt: Type.String(),
  createdBy: Type.String(),
  releasedAt: Type.Optional(Type.String()),
  releasedBy: Type.Optional(Type.String()),
  releaseReason: Type.Optional(Type.String()),
});

export const GovernanceExportSchema = Type.Object({
  id: Type.String(),
  status: lit(["running", "done", "failed"] as const),
  createdAt: Type.String(),
  createdBy: Type.String(),
  reason: Type.String(),
  matterId: Nullable(Type.String()),
  scope: GovernanceHoldScopeSchema,
  classes: Type.Array(ExportClass),
  attachmentFiles: Type.Boolean(),
  redacted: Type.Boolean(),
  finishedAt: Nullable(Type.String()),
  bytes: Nullable(Type.Integer()),
  sha256: Nullable(Type.String()),
  files: Nullable(Type.Integer()),
  /** Evidence verification report of everything exported (verification.json in the archive). */
  verificationOk: Nullable(Type.Boolean()),
  error: Nullable(Type.String()),
  /** Authenticated download route once done. */
  downloadPath: Nullable(Type.String()),
});

const ClassTally = Type.Object({
  deleted: Type.Integer(),
  anonymized: Type.Integer(),
  held: Type.Integer(),
  failed: Type.Integer(),
  oldest: Nullable(Type.String()),
  newest: Nullable(Type.String()),
});

export const GovernanceDsrMatchSchema = Type.Object({
  class: DataClass,
  id: Type.String(),
  projectId: Nullable(Type.String()),
  workItemId: Nullable(Type.String()),
  occurrences: Type.Integer(),
  disposition: lit(["deletable", "held", "retained"] as const),
  holdIds: Type.Array(Type.String()),
  note: Type.Optional(Type.String()),
});

export const GovernanceDsrReportSchema = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  createdBy: Type.String(),
  reason: Type.String(),
  kind: lit(["email", "phone", "principal", "text"] as const),
  /** Keyed digest of the identifier; the identifier itself is never stored. */
  identifierDigest: Type.String(),
  projectIds: Nullable(Type.Array(Type.String())),
  matches: Type.Array(GovernanceDsrMatchSchema),
  audit: Type.Object({ rows: Type.Integer(), disposition: Type.Literal("retained") }),
  counts: Type.Object({
    deletable: Type.Integer(),
    held: Type.Integer(),
    retained: Type.Integer(),
  }),
  executed: Type.Optional(
    Type.Object({
      at: Type.String(),
      by: Type.String(),
      mode: lit(["delete", "anonymize"] as const),
      manifestId: Nullable(Type.String()),
      changed: Type.Integer(),
      skipped: Type.Integer(),
    }),
  ),
});

// ── methods ─────────────────────────────────────────────────────────────────────────────────

export const GovernancePolicyGetParamsSchema = strict({ projectId: Type.Optional(ProjectId) });
export const GovernancePolicyGetResultSchema = Type.Object({
  org: Type.Object({
    retention: GovernanceRetentionPolicySchema,
    personalData: GovernancePersonalDataPolicySchema,
    minimumRetentionDays: Type.Object({ audit: Type.Integer(), evidence: Type.Integer() }),
    sweep: Type.Object({ enabled: Type.Boolean(), hourUtc: Type.Integer() }),
  }),
  project: Nullable(
    Type.Object({
      projectId: Type.String(),
      retention: GovernanceRetentionPolicySchema,
      personalData: GovernancePersonalDataPolicySchema,
      updatedAt: Nullable(Type.String()),
      updatedBy: Nullable(Type.String()),
    }),
  ),
});

/** Replace a Project's override (audit retention is organisation-wide: config only). */
export const GovernancePolicySetParamsSchema = strict({
  projectId: ProjectId,
  retention: Type.Optional(Type.Record(Type.String(), RetentionRuleInput)),
  personalData: Type.Optional(PersonalDataInput),
  reason: Reason,
});
export const GovernancePolicySetResultSchema = GovernancePolicyGetResultSchema;

export const GovernanceRetentionRunParamsSchema = strict({
  /** Default true: report what would change without changing anything. */
  dryRun: Type.Optional(Type.Boolean()),
  classes: Type.Optional(Type.Array(DataClass, { minItems: 1 })),
  reason: Reason,
});
export const GovernanceRetentionRunResultSchema = Type.Object({
  at: Type.String(),
  dryRun: Type.Boolean(),
  /** Evidence bundle id of the signed deletion manifest (null on a dry run or no change). */
  manifestId: Nullable(Type.String()),
  classes: Type.Record(Type.String(), ClassTally),
  audit: Type.Object({ months: Type.Array(Type.String()), entries: Type.Integer() }),
  holds: Type.Integer(),
});

export const GovernanceHoldsCreateParamsSchema = strict({
  matterId: Type.String({ minLength: 1, maxLength: 120 }),
  reason: Reason,
  scope: GovernanceHoldScopeSchema,
});
export const GovernanceHoldsCreateResultSchema = Type.Object({ hold: GovernanceHoldSchema });

export const GovernanceHoldsListParamsSchema = strict({
  status: Type.Optional(lit(["active", "released", "all"] as const)),
});
export const GovernanceHoldsListResultSchema = Type.Object({
  holds: Type.Array(GovernanceHoldSchema),
});

export const GovernanceHoldsReleaseParamsSchema = strict({ id: Type.String(), reason: Reason });
export const GovernanceHoldsReleaseResultSchema = Type.Object({ hold: GovernanceHoldSchema });

export const GovernanceExportCreateParamsSchema = strict({
  reason: Reason,
  matterId: Type.Optional(Type.String({ maxLength: 120 })),
  scope: GovernanceHoldScopeSchema,
  /** Default: every exportable class. */
  classes: Type.Optional(Type.Array(ExportClass, { minItems: 1 })),
  /** Include attachment files, not only their metadata (default false). */
  attachmentFiles: Type.Optional(Type.Boolean()),
  /** Redact personal identifiers in items, transcripts, outputs and audit rows. */
  redact: Type.Optional(Type.Boolean()),
});
export const GovernanceExportCreateResultSchema = Type.Object({ export: GovernanceExportSchema });

export const GovernanceExportGetParamsSchema = strict({ id: Type.String() });
export const GovernanceExportGetResultSchema = Type.Object({ export: GovernanceExportSchema });

export const GovernanceExportListParamsSchema = strict({});
export const GovernanceExportListResultSchema = Type.Object({
  exports: Type.Array(GovernanceExportSchema),
});

export const GovernanceDsrFindParamsSchema = strict({
  identifier: Type.String({ minLength: 4, maxLength: 300 }),
  kind: Type.Optional(lit(["email", "phone", "principal", "text"] as const)),
  projectIds: Type.Optional(Type.Array(ProjectId, { maxItems: 200 })),
  reason: Reason,
});
export const GovernanceDsrFindResultSchema = Type.Object({ report: GovernanceDsrReportSchema });

export const GovernanceDsrExecuteParamsSchema = strict({
  reportId: Type.String(),
  /** Repeated; must match the report's digest. Never stored. */
  identifier: Type.String({ minLength: 4, maxLength: 300 }),
  mode: lit(["delete", "anonymize"] as const),
  reason: Reason,
});
export const GovernanceDsrExecuteResultSchema = Type.Object({ report: GovernanceDsrReportSchema });

export const GovernanceChangedEventSchema = Type.Object({
  kind: lit(["policy", "hold", "export", "retention", "dsr"] as const),
  id: Nullable(Type.String()),
  at: Type.String(),
});
