// Procurement on a work item (相見積 → 発注): workitems.recordQuotes (an agent or a person stores
// the request lines and supplier quotes, a quote either as lines or as its sheet under quotes/,
// read server-side) and workitems.selectSupplier (person only). The comparison is always
// recomputed server-side from the stored quotes; line shapes and pricing rules are enforced there
// (src/workitems/procurement.ts), so the lines are open objects here.
import { Type, type TSchema } from "@sinclair/typebox";
import { WorkitemsGetResultSchema } from "./workitems.js";

const strict = <T extends Record<string, TSchema>>(props: T) =>
  Type.Object(props, { additionalProperties: false });
const ProjectId = Type.String({ pattern: "^p[a-z0-9]{10}$" });
const ItemId = Type.String({ pattern: "^w[a-z0-9]{12}$" });
const Revision = Type.Integer({ minimum: 0 });
const Line = Type.Object({});

export const WorkitemsRecordQuotesParamsSchema = strict({
  projectId: ProjectId,
  id: ItemId,
  expectedRevision: Type.Optional(Revision),
  request: Type.Array(Line, { minItems: 1, maxItems: 200 }),
  quotes: Type.Array(Line, { maxItems: 20 }),
});
export const WorkitemsRecordQuotesResultSchema = WorkitemsGetResultSchema;

export const WorkitemsSelectSupplierParamsSchema = strict({
  projectId: ProjectId,
  id: ItemId,
  /** The revision of the item the person looked at; required. */
  expectedRevision: Revision,
  /** Supplier as named on its quote. The selector is the caller, never a field here. */
  supplier: Type.String({ minLength: 1, maxLength: 200 }),
  /** Needed (at least 10 characters) when the choice is not among the lowest complete quotes. */
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});
export const WorkitemsSelectSupplierResultSchema = WorkitemsGetResultSchema;
