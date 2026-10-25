// Work queue email intake and risk flags: workitems.intakeEmail (an agent or a person turns a
// message into a work item, by reference) and workitems.clearFlag (person only). See
// docs/business/work-queue.md.
import { Type, type TSchema } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";
import {
  WorkItemFlagSchema,
  WorkItemOriginSchema,
  WorkItemPrioritySchema,
  WorkItemSchema,
  WorkItemTypeSchema,
  WorkitemsGetResultSchema,
} from "./workitems.js";

const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const ProjectId = Type.String({ pattern: "^p[a-z0-9]{10}$" });
const ItemId = Type.String({ pattern: "^w[a-z0-9]{12}$" });

export const WorkitemsIntakeEmailParamsSchema = strict({
  projectId: ProjectId,
  queue: NonEmptyString,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  type: WorkItemTypeSchema,
  priority: WorkItemPrioritySchema,
  dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Short description in the caller's own words; never the message body. */
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  /** Reference to the message; stored on the item as `source.origin`. */
  source: WorkItemOriginSchema,
  flags: Type.Optional(Type.Array(WorkItemFlagSchema, { maxItems: 4 })),
  flagReason: Type.Optional(Type.String({ maxLength: 500 })),
});
export const WorkitemsIntakeEmailResultSchema = Type.Object({
  item: WorkItemSchema,
  /** false: this message was taken in before; `item` is the existing item, unchanged. */
  created: Type.Boolean(),
});

export const WorkitemsClearFlagParamsSchema = strict({
  projectId: ProjectId,
  id: ItemId,
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  flag: WorkItemFlagSchema,
  /** Why the person is satisfied the flag no longer applies (kept on the item and audited). */
  reason: Type.String({ minLength: 10, maxLength: 2000 }),
});
export const WorkitemsClearFlagResultSchema = WorkitemsGetResultSchema;
