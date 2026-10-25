// Work queue review methods: stage delegation, document previews, draft diffs and the queue
// overview. See docs/business/work-queue.md.
import { Type, type TSchema } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";
import { DepartmentFilterSchema, WorkitemsGetResultSchema } from "./workitems.js";

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
  /** HTML-escaped text (control characters removed), or null for binary content. */
  text: NullableString,
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
