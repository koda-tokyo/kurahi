// Work queue 稟議 routes on the wire: the route fixed on an item, its stages, delegations and the
// compact current-stage view used by lists and inboxes. See docs/business/work-queue.md.
import { Type } from "@sinclair/typebox";

const lit = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const Text = Type.Object({ ja: Type.Optional(Type.String()), en: Type.Optional(Type.String()) });
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const WorkItemApprovalSchema = Type.Object({
  by: Type.String(),
  at: Type.String(),
  comment: NullableString,
  stageId: Type.Optional(Type.String()),
  onBehalfOf: Type.Optional(NullableString),
  via: Type.Optional(lit(["approver", "delegation", "escalation"] as const)),
});

export const WorkItemDelegationSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  reason: Type.String(),
  at: Type.String(),
  expiresAt: Type.String(),
});

const Target = Type.Object({
  roles: Type.Array(Type.String()),
  principals: Type.Array(Type.String()),
});

export const WorkItemStageSchema = Type.Object({
  id: Type.String(),
  name: Text,
  approvers: Type.Object({
    any: Type.Boolean(),
    roles: Type.Array(Type.String()),
    principals: Type.Array(Type.String()),
    departmentField: NullableString,
    department: NullableString,
  }),
  minApprovals: Type.Integer({ minimum: 1 }),
  dueHours: Type.Union([Type.Number(), Type.Null()]),
  onReturn: lit(["requester", "previous"] as const),
  delegation: Type.Boolean(),
  escalation: Type.Union([Type.Object({ afterHours: Type.Number(), to: Target }), Type.Null()]),
  status: lit(["pending", "active", "approved"] as const),
  approvals: Type.Array(WorkItemApprovalSchema),
  delegations: Type.Array(WorkItemDelegationSchema),
  activatedAt: NullableString,
  dueAt: NullableString,
  completedAt: NullableString,
  overdueAt: NullableString,
  escalatedAt: NullableString,
});

export const WorkItemRouteSchema = Type.Object({
  id: Type.String(),
  kind: lit(["staged", "single"] as const),
  policyDigest: Type.String(),
  stages: Type.Array(WorkItemStageSchema),
  skipped: Type.Array(Type.Object({ id: Type.String(), name: Text, reason: Type.String() })),
  current: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export const WorkItemStageSummarySchema = Type.Object({
  id: Type.String(),
  name: Text,
  index: Type.Integer({ minimum: 0 }),
  count: Type.Integer({ minimum: 1 }),
  dueAt: NullableString,
  overdue: Type.Boolean(),
  escalated: Type.Boolean(),
  approvals: Type.Integer({ minimum: 0 }),
  minApprovals: Type.Integer({ minimum: 1 }),
});

/** Route definitions as workitems.config shows them (stage conditions included). */
export const WorkQueueRouteDefSchema = Type.Object({
  id: Type.String(),
  name: Text,
  queues: Type.Array(Type.String()),
  types: Type.Array(Type.String()),
  when: Type.Array(Type.Object({ field: Type.String(), op: Type.String(), value: Type.Unknown() })),
  stages: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Text,
      approvers: Type.Object({
        roles: Type.Array(Type.String()),
        principals: Type.Array(Type.String()),
        departmentField: NullableString,
      }),
      minApprovals: Type.Integer({ minimum: 1 }),
      dueHours: Type.Union([Type.Number(), Type.Null()]),
      onReturn: lit(["requester", "previous"] as const),
      delegation: Type.Boolean(),
      escalation: Type.Union([Type.Object({ afterHours: Type.Number(), to: Target }), Type.Null()]),
      when: Type.Array(
        Type.Object({ field: Type.String(), op: Type.String(), value: Type.Unknown() }),
      ),
    }),
  ),
});

/** Who the caller is to the work queue (for "My requests", the inbox and the decide buttons). */
export const WorkQueueViewerSchema = Type.Object({
  principal: Type.String(),
  privileged: Type.Boolean(),
  roles: Type.Array(Type.String()),
  departments: Type.Array(Type.String()),
  listed: Type.Boolean(),
});
