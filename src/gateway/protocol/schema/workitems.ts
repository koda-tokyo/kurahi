// Work queue (Business edition) protocol: work items per Project, agent drafts, policy checks,
// person-only decisions. See docs/business/work-queue.md.
import { Type, type TSchema } from "@sinclair/typebox";
import {
  DEPARTMENT_IDS,
  EMAIL_CONNECTORS,
  UNMAPPED_DEPARTMENT,
  WORK_ITEM_FLAGS,
} from "../../../workitems/types.js";
import { NonEmptyString } from "./primitives.js";
import {
  WorkItemApprovalSchema,
  WorkItemRouteSchema,
  WorkItemStageSummarySchema,
  WorkQueueRouteDefSchema,
  WorkQueueViewerSchema,
} from "./workitems-route.js";

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const WorkItemTypeSchema = lit([
  "request",
  "case",
  "document",
  "invoice",
  "leave",
  "expense",
  "purchase",
  "custom",
] as const);
export const WorkItemStatusSchema = lit([
  "new",
  "drafting",
  "awaiting_review",
  "approved",
  "sent_back",
  "done",
  "cancelled",
] as const);
export const WorkItemPrioritySchema = lit(["low", "normal", "high", "urgent"] as const);
/** Business department a queue maps to (a view for department workspaces, not a permission). */
export const DepartmentIdSchema = lit(DEPARTMENT_IDS);
/** List / stats filter: a department, or `unmapped` for queues with no department. */
export const DepartmentFilterSchema = Type.Union([
  DepartmentIdSchema,
  Type.Literal(UNMAPPED_DEPARTMENT),
]);
export const WorkItemDecisionSchema = lit(["approve", "send_back", "cancel"] as const);

const ProjectId = Type.String({ pattern: "^p[a-z0-9]{10}$" });
const ItemId = Type.String({ pattern: "^w[a-z0-9]{12}$" });
const Revision = Type.Integer({ minimum: 0 });
const Text = Type.Object({ ja: Type.Optional(Type.String()), en: Type.Optional(Type.String()) });
const FieldValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const Fields = Type.Record(Type.String(), FieldValue);

export const WorkItemAssigneeSchema = Type.Union([
  Type.Object({ kind: lit(["agent", "person"] as const), id: NonEmptyString }),
  Type.Null(),
]);
const PersonAssignee = Type.Union([
  Type.Object(
    { kind: Type.Literal("person"), id: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

export const WorkItemSourceDocumentSchema = Type.Object({
  kind: lit(["attachment", "file", "artifact"] as const),
  ref: NonEmptyString,
  name: Type.String(),
  sha256: Type.Optional(Type.String()),
});
const SourceDocumentInput = Type.Object(
  {
    kind: lit(["attachment", "file", "artifact"] as const),
    ref: NonEmptyString,
    name: Type.Optional(Type.String()),
    sha256: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Risk flag on an item; `suspected_fraud` blocks approval until a person clears it. */
export const WorkItemFlagSchema = lit(WORK_ITEM_FLAGS);
export const EmailConnectorSchema = lit(EMAIL_CONNECTORS);

/**
 * Where the item came from: a reference to a message in the connected mailbox (the body stays
 * there). Input bounds; the server validates again (address format, ISO date, id alphabet).
 */
export const WorkItemOriginSchema = Type.Object(
  {
    kind: Type.Literal("email"),
    connector: EmailConnectorSchema,
    messageId: Type.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9!._=+,:/-]+$" }),
    receivedAt: Type.Optional(Type.String({ minLength: 10, maxLength: 40 })),
    /** Sender address only (no display name). */
    from: Type.Optional(Type.String({ minLength: 3, maxLength: 254 })),
    subject: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false },
);

export const WorkItemFlagClearanceSchema = Type.Object({
  flag: WorkItemFlagSchema,
  by: Type.String(),
  at: Type.String(),
  reason: Type.String(),
});

export const WorkItemDraftSchema = Type.Object({
  artifactId: NonEmptyString,
  version: Type.Integer({ minimum: 1 }),
  sha256: Type.String(),
  agentId: Type.Union([Type.String(), Type.Null()]),
  runId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

export const WorkItemCheckSchema = Type.Object({
  policyId: NonEmptyString,
  label: Text,
  result: lit(["pass", "fail", "warn"] as const),
  blocking: Type.Boolean(),
  evidence: Type.Record(Type.String(), Type.Unknown()),
  checkedAt: Type.String(),
  draftVersion: Type.Union([Type.Integer(), Type.Null()]),
  policyDigest: Type.String(),
});

const Approval = WorkItemApprovalSchema;
const Override = Type.Union([
  Type.Object({
    by: Type.String(),
    at: Type.String(),
    reason: Type.String(),
    policyIds: Type.Array(Type.String()),
  }),
  Type.Null(),
]);

export const WorkItemHistoryEntrySchema = Type.Object({
  at: Type.String(),
  by: Type.String(),
  actorKind: lit(["person", "agent", "system"] as const),
  action: Type.String(),
  from: Type.Optional(WorkItemStatusSchema),
  to: Type.Optional(WorkItemStatusSchema),
  comment: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  detail: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  evidence: Type.Optional(
    Type.Union([Type.Object({ bundle: Type.String(), root: Type.String() }), Type.Null()]),
  ),
});

const common = {
  id: ItemId,
  projectId: ProjectId,
  queue: Type.String(),
  type: WorkItemTypeSchema,
  title: Type.String(),
  status: WorkItemStatusSchema,
  assignee: WorkItemAssigneeSchema,
  priority: WorkItemPrioritySchema,
  dueAt: Type.Union([Type.String(), Type.Null()]),
  slaHours: Type.Union([Type.Number(), Type.Null()]),
  draft: Type.Union([WorkItemDraftSchema, Type.Null()]),
  checks: Type.Array(WorkItemCheckSchema),
  requiredApprovals: Type.Integer({ minimum: 1 }),
  approvals: Type.Array(Approval),
  override: Override,
  runIds: Type.Array(Type.String()),
  lastError: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  createdBy: Type.String(),
  requestedBy: Type.String(),
  route: Type.Union([WorkItemRouteSchema, Type.Null()]),
  /** Intake summary in the agent's own words (never the email body). */
  summary: Type.Optional(Type.String()),
  /** Active risk flags; absent = none. */
  flags: Type.Optional(Type.Array(WorkItemFlagSchema)),
  flagReason: Type.Optional(Type.String()),
  /** Flags a person cleared (who, when, why), oldest first. */
  flagClearances: Type.Optional(Type.Array(WorkItemFlagClearanceSchema)),
  updatedAt: Type.String(),
  revision: Revision,
};

export const WorkItemSchema = Type.Object({
  ...common,
  source: Type.Object({
    documents: Type.Array(WorkItemSourceDocumentSchema),
    fields: Fields,
    /** Set on items taken in from an email (workitems.intakeEmail). */
    origin: Type.Optional(WorkItemOriginSchema),
  }),
  history: Type.Array(WorkItemHistoryEntrySchema),
});

export const WorkItemSummarySchema = Type.Object({
  ...common,
  source: Type.Object({
    documents: Type.Integer(),
    fields: Type.Array(Type.String()),
    origin: Type.Optional(WorkItemOriginSchema),
  }),
  overdue: Type.Boolean(),
  currentStage: Type.Union([WorkItemStageSummarySchema, Type.Null()]),
});

const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const oneOrMany = <T extends TSchema>(s: T) => Type.Union([s, Type.Array(s)]);

export const WorkitemsListParamsSchema = strict({
  projectId: ProjectId,
  queue: Type.Optional(Type.String()),
  status: Type.Optional(oneOrMany(WorkItemStatusSchema)),
  type: Type.Optional(oneOrMany(WorkItemTypeSchema)),
  priority: Type.Optional(oneOrMany(WorkItemPrioritySchema)),
  assigneeKind: Type.Optional(lit(["agent", "person", "none"] as const)),
  assigneeId: Type.Optional(Type.String()),
  overdue: Type.Optional(Type.Boolean()),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  /** Only items the caller requested (enforced server-side, also for operators). */
  mine: Type.Optional(Type.Boolean()),
  /** Only items whose current stage the caller may approve now (incl. delegations). */
  awaitingMe: Type.Optional(Type.Boolean()),
  /** Only items awaiting review in this route stage id. */
  stage: Type.Optional(Type.String({ maxLength: 64 })),
  /**
   * Department view: items whose queue maps to this department (`unmapped` = no department).
   * Applied after visibility filtering; a view filter, never a permission.
   */
  department: Type.Optional(DepartmentFilterSchema),
  /** true: only items with an active flag; false: only items without. After visibility. */
  flagged: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const WorkitemsListResultSchema = Type.Object({
  items: Type.Array(WorkItemSummarySchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  total: Type.Integer(),
  counts: Type.Record(Type.String(), Type.Integer()),
});

const ItemRef = { projectId: ProjectId, id: ItemId };
export const WorkitemsGetParamsSchema = strict(ItemRef);
export const WorkitemsGetResultSchema = Type.Object({ item: WorkItemSchema });

export const WorkitemsCreateParamsSchema = strict({
  projectId: ProjectId,
  queue: NonEmptyString,
  type: Type.Optional(WorkItemTypeSchema),
  title: NonEmptyString,
  source: Type.Optional(
    strict({
      documents: Type.Optional(Type.Array(SourceDocumentInput, { maxItems: 32 })),
      fields: Type.Optional(Fields),
    }),
  ),
  priority: Type.Optional(WorkItemPrioritySchema),
  dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  slaHours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  assignee: Type.Optional(PersonAssignee),
});
export const WorkitemsCreateResultSchema = WorkitemsGetResultSchema;

export const WorkitemsUpdateParamsSchema = strict({
  ...ItemRef,
  expectedRevision: Type.Optional(Revision),
  patch: strict({
    title: Type.Optional(NonEmptyString),
    queue: Type.Optional(NonEmptyString),
    type: Type.Optional(WorkItemTypeSchema),
    priority: Type.Optional(WorkItemPrioritySchema),
    dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    assignee: Type.Optional(PersonAssignee),
    source: Type.Optional(
      strict({
        documents: Type.Optional(Type.Array(SourceDocumentInput, { maxItems: 32 })),
        fields: Type.Optional(Fields),
      }),
    ),
    draft: Type.Optional(
      strict({ artifactId: NonEmptyString, version: Type.Optional(Type.Integer({ minimum: 1 })) }),
    ),
    status: Type.Optional(lit(["awaiting_review", "done"] as const)),
  }),
});
export const WorkitemsUpdateResultSchema = WorkitemsGetResultSchema;

export const WorkitemsAssignAgentParamsSchema = strict({
  ...ItemRef,
  expectedRevision: Type.Optional(Revision),
  agentId: Type.Optional(NonEmptyString),
  instructions: Type.Optional(Type.String({ maxLength: 4000 })),
});
export const WorkitemsAssignAgentResultSchema = Type.Object({
  item: WorkItemSchema,
  runId: Type.String(),
});

export const WorkitemsDecideParamsSchema = strict({
  ...ItemRef,
  expectedRevision: Type.Optional(Revision),
  decision: WorkItemDecisionSchema,
  comment: Type.Optional(Type.String({ maxLength: 2000 })),
  override: Type.Optional(strict({ reason: Type.String({ minLength: 10, maxLength: 2000 }) })),
});
export const WorkitemsDecideResultSchema = WorkitemsGetResultSchema;

export const WorkitemsConfigParamsSchema = strict({ projectId: ProjectId });
export const WorkitemsConfigResultSchema = Type.Object({
  queues: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Text,
      types: Type.Array(WorkItemTypeSchema),
      slaHours: Type.Union([Type.Number(), Type.Null()]),
      defaultAgent: Type.Union([Type.String(), Type.Null()]),
      /** Absent = the queue is not mapped to a department. */
      department: Type.Optional(DepartmentIdSchema),
    }),
  ),
  /** Stable department catalogue (ids only; the UI owns the labels). */
  departments: Type.Array(DepartmentIdSchema),
  rules: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.String(),
      label: Text,
      severity: lit(["fail", "warn"] as const),
      blocking: Type.Boolean(),
      types: Type.Array(WorkItemTypeSchema),
      queues: Type.Array(Type.String()),
    }),
  ),
  timezone: Type.String(),
  separationOfDuties: Type.Boolean(),
  routes: Type.Array(WorkQueueRouteDefSchema),
  access: Type.Object({
    fallback: lit(["none", "any_approver"] as const),
    configured: Type.Boolean(),
    /** Roles named in the policy. Member principals are listed only for privileged callers. */
    roles: Type.Array(Type.String()),
    members: Type.Union([
      Type.Array(
        Type.Object({
          principal: Type.String(),
          name: Type.Union([Type.String(), Type.Null()]),
          roles: Type.Array(Type.String()),
          departments: Type.Array(Type.String()),
          /** Where the autopilot morning brief draft is addressed (optional). */
          email: Type.Optional(Type.String()),
        }),
      ),
      Type.Null(),
    ]),
  }),
  viewer: WorkQueueViewerSchema,
  source: Type.Object({ kind: Type.String(), path: Type.Union([Type.String(), Type.Null()]) }),
  digest: Type.String(),
  error: Type.Union([Type.String(), Type.Null()]),
});

export const WorkitemsEvidenceParamsSchema = strict(ItemRef);
export const WorkitemsEvidenceResultSchema = Type.Object({
  bundles: Type.Array(
    Type.Object({
      bundle: Type.String(),
      ok: Type.Boolean(),
      status: Type.Union([Type.String(), Type.Null()]),
      root: Type.Union([Type.String(), Type.Null()]),
      signer: Type.Union([Type.String(), Type.Null()]),
      problems: Type.Array(Type.String()),
    }),
  ),
  chainOk: Type.Boolean(),
});

/** Sent on every change. Carries no titles or field values: clients refetch with workitems.get. */
export const WorkitemsChangedEventSchema = Type.Object({
  projectId: ProjectId,
  id: ItemId,
  queue: Type.String(),
  action: Type.String(),
  status: WorkItemStatusSchema,
  revision: Revision,
  updatedAt: Type.String(),
});
