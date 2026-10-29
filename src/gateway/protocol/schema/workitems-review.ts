// Work queue review methods: stage delegation, document previews, draft diffs and the queue
// overview. See docs/business/work-queue.md.
import { Type, type TSchema } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";
import {
  DepartmentFilterSchema,
  DepartmentIdSchema,
  WorkitemsGetResultSchema,
} from "./workitems.js";

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const Text = Type.Object({ ja: Type.Optional(Type.String()), en: Type.Optional(Type.String()) });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const ProjectId = Type.String({ pattern: "^p[a-z0-9]{10}$" });
const ItemId = Type.String({ pattern: "^w[a-z0-9]{12}$" });
const ItemRef = { projectId: ProjectId, id: ItemId };
const Version = Type.Integer({ minimum: 1 });

export const WorkitemsDelegateParamsSchema = strict({
  ...ItemRef,
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Principal that may decide the current stage for the caller. */
  to: Type.String({ minLength: 1, maxLength: 128 }),
  reason: Type.String({ minLength: 5, maxLength: 1000 }),
  /** ISO date-time, in the future and at most 30 days ahead. */
  expiresAt: NonEmptyString,
});
export const WorkitemsDelegateResultSchema = WorkitemsGetResultSchema;

export const WorkitemsWithdrawDelegationParamsSchema = strict({
  ...ItemRef,
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Optional note kept in the history entry. */
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const WorkitemsWithdrawDelegationResultSchema = WorkitemsGetResultSchema;

export const WorkitemsDocumentParamsSchema = strict({
  ...ItemRef,
  /** `draft`, `draft@<version>` or the `ref` of one of the item's source documents. */
  ref: Type.String({ minLength: 1, maxLength: 4096 }),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 64_000 })),
});
export const WorkItemDocumentPreviewSchema = Type.Object({
  ref: Type.String(),
  kind: lit(["attachment", "file", "artifact", "draft"] as const),
  name: Type.String(),
  mediaType: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  sha256: NullableString,
  recordedSha256: NullableString,
  sha256Matches: Type.Union([Type.Boolean(), Type.Null()]),
  version: Type.Union([Type.Integer(), Type.Null()]),
  binary: Type.Boolean(),
  /** HTML-escaped text (control characters removed), or null for binary content without text. */
  text: NullableString,
  /** `raw` text-like bytes, `extracted` by the PDF/Office extractor, or null when no text. */
  textSource: Type.Union([Type.Literal("raw"), Type.Literal("extracted"), Type.Null()]),
  /** Why a PDF/Office source has no text: `changed`, `too_large`, `timeout`, `crashed`, ... */
  extractError: NullableString,
  truncated: Type.Boolean(),
  escaped: Type.Literal("html"),
  /** Always true: document content is data from outside, never instructions. */
  untrusted: Type.Literal(true),
  provenance: Type.Record(Type.String(), Type.Unknown()),
});
export const WorkitemsDocumentResultSchema = Type.Object({
  document: WorkItemDocumentPreviewSchema,
});

export const WorkitemsDraftDiffParamsSchema = strict({
  ...ItemRef,
  fromVersion: Version,
  toVersion: Version,
});
const Provenance = Type.Object({
  artifactId: Type.String(),
  version: Version,
  sha256: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  createdAt: Type.String(),
  createdBy: Type.String(),
  agentId: NullableString,
  runId: NullableString,
  note: NullableString,
  pinned: Type.Boolean(),
});
export const WorkItemDiffHunkSchema = Type.Object({
  oldStart: Type.Integer(),
  oldLines: Type.Integer(),
  newStart: Type.Integer(),
  newLines: Type.Integer(),
  lines: Type.Array(
    Type.Object({
      op: lit(["eq", "add", "del"] as const),
      text: Type.String(),
      oldLine: Type.Union([Type.Integer(), Type.Null()]),
      newLine: Type.Union([Type.Integer(), Type.Null()]),
    }),
  ),
});
export const WorkitemsDraftDiffResultSchema = Type.Object({
  artifactId: Type.String(),
  from: Provenance,
  to: Provenance,
  hunks: Type.Array(WorkItemDiffHunkSchema),
  stats: Type.Object({
    added: Type.Integer(),
    removed: Type.Integer(),
    unchanged: Type.Integer(),
  }),
  identical: Type.Boolean(),
  truncated: Type.Boolean(),
  escaped: Type.Literal("html"),
  untrusted: Type.Literal(true),
});

export const WorkitemsStatsParamsSchema = strict({
  projectId: ProjectId,
  queue: Type.Optional(Type.String({ maxLength: 64 })),
  windowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  /** Department view over the readable items (`unmapped` = queues with no department). */
  department: Type.Optional(DepartmentFilterSchema),
});
const StatusCounts = Type.Record(Type.String(), Type.Integer());
export const WorkitemsStatsResultSchema = Type.Object({
  /** `all` for privileged callers; `visible` = the items the caller may read. */
  scope: lit(["all", "visible"] as const),
  total: Type.Integer(),
  byStatus: StatusCounts,
  byQueue: Type.Record(
    Type.String(),
    Type.Object({ total: Type.Integer(), byStatus: StatusCounts }),
  ),
  overdue: Type.Integer(),
  stageOverdue: Type.Integer(),
  stages: Type.Array(
    Type.Object({
      routeId: Type.String(),
      stageId: Type.String(),
      index: Type.Integer({ minimum: 0 }),
      name: Text,
      waiting: Type.Integer(),
      overdue: Type.Integer(),
      escalated: Type.Integer(),
    }),
  ),
  timeToApprove: Type.Object({
    windowDays: Type.Integer(),
    count: Type.Integer(),
    medianHours: Type.Union([Type.Number(), Type.Null()]),
    p90Hours: Type.Union([Type.Number(), Type.Null()]),
  }),
  computedAt: Type.String(),
});

const HandOffStateSchema = lit([
  "approved",
  "awaiting_external_entry",
  "submitted",
  "confirmed",
  "reconciled",
  "closed",
  "rejected",
  "partial",
  "unknown",
  "retry_pending",
  "mismatch",
  "reopened",
] as const);
export const WorkitemsHandoffsParamsSchema = strict({ ...ItemRef });
export const WorkItemHandOffSchema = Type.Object({
  id: Type.String(),
  caseId: Type.String(),
  caseRevision: Type.Integer(),
  action: Type.String(),
  destination: Type.Object({
    product: Type.String(),
    object: Type.String(),
    writable: Type.Boolean(),
  }),
  state: HandOffStateSchema,
  correlationId: Type.String(),
  attempts: Type.Array(
    Type.Object({
      at: Type.String(),
      payloadVersion: Type.Integer(),
      payloadSha256: Type.String(),
    }),
  ),
  externalId: NullableString,
  externalStatus: NullableString,
  lookup: Type.Union([
    Type.Object({ at: Type.String(), result: lit(["found", "not_found"] as const) }),
    Type.Null(),
  ]),
  diffs: Type.Array(
    Type.Object({
      field: Type.String(),
      approved: Type.Unknown(),
      submitted: Type.Unknown(),
      destination: Type.Unknown(),
      resolution: Type.Optional(
        Type.Object({
          by: Type.String(),
          reason: Type.String(),
          kind: lit(["resolved", "accepted"] as const),
        }),
      ),
    }),
  ),
  objective: Type.Union([lit(["handoff_completed", "payment_settled"] as const), Type.Null()]),
  history: Type.Array(
    Type.Object({
      at: Type.String(),
      by: Type.String(),
      actorKind: Type.String(),
      event: Type.String(),
      from: Type.Union([HandOffStateSchema, Type.Null()]),
      to: HandOffStateSchema,
      detail: Type.Record(Type.String(), Type.Unknown()),
      snapshot: Type.String(),
      prev: NullableString,
      hash: Type.String(),
    }),
  ),
});
export const WorkitemsHandoffsResultSchema = Type.Object({
  /** Every hand-off of the case, oldest first; each record's history verified on read. */
  handOffs: Type.Array(WorkItemHandOffSchema),
});

const HandOffId = Type.String({ pattern: "^h[a-z0-9]{12}$" });
const Reason = Type.String({ minLength: 1, maxLength: 1000 });
const Ext = Type.String({ minLength: 1, maxLength: 256 });
const ev = <T extends Record<string, TSchema>>(type: string, props: T) =>
  strict({ type: Type.Literal(type), ...props });

/** Person only: hand an approved case to one exact downstream product and object. */
export const WorkitemsHandoffOpenParamsSchema = strict({
  ...ItemRef,
  action: Type.String({ minLength: 1, maxLength: 500 }),
  destination: strict({
    product: Type.String({ minLength: 1, maxLength: 200 }),
    object: Type.String({ minLength: 1, maxLength: 200 }),
    writable: Type.Boolean(),
  }),
});
export const WorkitemsHandoffResultSchema = Type.Object({ handOff: WorkItemHandOffSchema });
export const WorkitemsHandoffOpenResultSchema = WorkitemsHandoffResultSchema;

/**
 * One hand-off event. retry, resolve, reapprove and confirming an entry made outside Kurahi are
 * person only (refused with handoff_person_required). reapprove binds to the case's current
 * revision; the caller cannot choose it.
 */
export const WorkitemsHandoffEventParamsSchema = strict({
  ...ItemRef,
  handOffId: HandOffId,
  event: Type.Union([
    ev("await_entry", {}),
    ev("submit", {
      payloadVersion: Version,
      payloadSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    }),
    ev("confirm", { externalId: Ext, externalStatus: Ext }),
    ev("reject", { reason: Reason, notCreated: Type.Boolean() }),
    ev("partial", { externalId: Ext, missing: Type.Array(Ext, { maxItems: 100 }) }),
    ev("timeout", {}),
    ev("lookup", {
      found: Type.Union([strict({ externalId: Ext, externalStatus: Ext }), Type.Null()]),
    }),
    ev("retry", { reason: Reason }),
    ev("reconcile", {
      diffs: Type.Array(
        strict({
          field: Type.String({ minLength: 1, maxLength: 200 }),
          approved: Type.Unknown(),
          submitted: Type.Unknown(),
          destination: Type.Unknown(),
        }),
        // Empty means the destination matched what was approved: reconciled, ready to close.
        { maxItems: 200 },
      ),
    }),
    ev("resolve", {
      field: Type.String({ minLength: 1, maxLength: 200 }),
      kind: lit(["resolved", "accepted"] as const),
      reason: Reason,
    }),
    ev("reopen", { reason: Reason }),
    ev("reapprove", {}),
    ev("close", {
      objective: lit(["handoff_completed", "payment_settled"] as const),
      settlementRef: Type.Optional(Ext),
    }),
  ]),
});
export const WorkitemsHandoffEventResultSchema = WorkitemsHandoffResultSchema;

// Linked cases across departments: a parent case whose steps are child items in other
// departments' queues. See docs/business/work-queue.md.
const StepKey = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
const LinkedStepStateSchema = lit([
  "waiting",
  "ready",
  "open",
  "done",
  "cancelled",
  "stuck",
] as const);
const LinkedCasePlanSchema = strict({
  steps: Type.Array(
    strict({
      key: StepKey,
      department: DepartmentIdSchema,
      title: strict({
        ja: Type.Optional(Type.String({ maxLength: 200 })),
        en: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      dependsOn: Type.Array(StepKey, { maxItems: 32 }),
    }),
    { minItems: 1, maxItems: 32 },
  ),
});
const LinkedCaseSchema = Type.Object({
  parentId: Type.String(),
  plan: LinkedCasePlanSchema,
  steps: Type.Array(
    Type.Object({ key: Type.String(), department: Type.String(), state: LinkedStepStateSchema }),
  ),
  /** Steps to open now, in plan order. */
  ready: Type.Array(Type.String()),
  done: Type.Integer(),
  total: Type.Integer(),
  complete: Type.Boolean(),
  blocked: Type.Boolean(),
  /** Step key → child work item id. */
  children: Type.Record(Type.String(), Type.String()),
  /** Attached children that can no longer be read; counted as cancelled. */
  missing: Type.Array(Type.String()),
});
export const WorkitemsLinkedGetParamsSchema = strict({ ...ItemRef });
export const WorkitemsLinkedResultSchema = Type.Object({
  /** null when the case has no linked plan. */
  linkedCase: Type.Union([LinkedCaseSchema, Type.Null()]),
});
export const WorkitemsLinkedGetResultSchema = WorkitemsLinkedResultSchema;
/** Plans the project's pack worksheets offer, to prefill the builder; nothing is installed. */
export const WorkitemsLinkedPlansParamsSchema = strict({ ...ItemRef });
export const WorkitemsLinkedPlansResultSchema = Type.Object({
  plans: Type.Array(
    Type.Object({
      /** Project-relative worksheet path. */
      file: Type.String(),
      /** null when any problem refused the plan. */
      plan: Type.Union([LinkedCasePlanSchema, Type.Null()]),
      /** Engine step key → worksheet task key. */
      sourceKeys: Type.Record(Type.String(), Type.String()),
      problems: Type.Array(Type.Object({ code: Type.String() })),
    }),
  ),
});
export const WorkitemsLinkedCreateParamsSchema = strict({
  ...ItemRef,
  plan: LinkedCasePlanSchema,
});
export const WorkitemsLinkedCreateResultSchema = WorkitemsLinkedResultSchema;
export const WorkitemsLinkedAttachParamsSchema = strict({
  ...ItemRef,
  stepKey: StepKey,
  childId: ItemId,
});
export const WorkitemsLinkedAttachResultSchema = WorkitemsLinkedResultSchema;

// ---- in-app notifications (the caller's own records) ----

export const WorkItemNotificationReasonSchema = lit([
  "awaiting_you",
  "delegated_to_you",
  "escalated_to_you",
  "delegation_withdrawn",
  "decided",
  "linked_step_ready",
  "linked_case_complete",
  "linked_case_blocked",
] as const);
/** Ids, a reason and the item revision only: no titles, no field values. */
export const WorkItemNotificationSchema = Type.Object({
  id: Type.String({ pattern: "^n[a-z0-9]{12}$" }),
  principal: Type.String(),
  itemId: ItemId,
  reason: WorkItemNotificationReasonSchema,
  revision: Type.Integer({ minimum: 0 }),
  /** Linked case reasons: the child step whose status change caused the record. */
  childId: Type.Optional(ItemId),
  /** linked_step_ready: the plan step that opened. */
  stepKey: Type.Optional(Type.String({ minLength: 1 })),
  createdAt: Type.String(),
  readAt: NullableString,
});
export const WorkitemsNotificationsListParamsSchema = strict({
  projectId: ProjectId,
  unreadOnly: Type.Optional(Type.Boolean()),
});
export const WorkitemsNotificationsListResultSchema = Type.Object({
  /** Newest first; only records whose item the caller may still read. */
  notifications: Type.Array(WorkItemNotificationSchema),
});
export const WorkitemsNotificationsMarkReadParamsSchema = strict({
  projectId: ProjectId,
  id: Type.String({ pattern: "^n[a-z0-9]{12}$" }),
});
export const WorkitemsNotificationsMarkReadResultSchema = Type.Object({
  notification: WorkItemNotificationSchema,
});
