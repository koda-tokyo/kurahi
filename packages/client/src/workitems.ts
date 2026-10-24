// SPDX-License-Identifier: MIT
// Named shapes for the Business edition work queue (aliases of the generated method types, so
// they never drift from the spec). See docs/business/work-queue.md.
import type {
  WorkitemsConfigResult,
  WorkitemsDecideParams,
  WorkitemsEvidenceResult,
  WorkitemsGetResult,
  WorkitemsListParams,
  WorkitemsListResult,
} from "./generated/types.js";

export type WorkItem = WorkitemsGetResult["item"];
export type WorkItemSummary = WorkitemsListResult["items"][number];
export type WorkItemStatus = WorkItem["status"];
export type WorkItemType = WorkItem["type"];
export type WorkItemPriority = WorkItem["priority"];
export type WorkItemCheck = WorkItem["checks"][number];
export type WorkItemHistoryEntry = WorkItem["history"][number];
export type WorkItemDraft = NonNullable<WorkItem["draft"]>;
export type WorkItemSourceDocument = WorkItem["source"]["documents"][number];
export type WorkItemDecision = WorkitemsDecideParams["decision"];
export type WorkItemFilter = Omit<WorkitemsListParams, "projectId" | "cursor" | "limit">;
export type WorkQueueDef = WorkitemsConfigResult["queues"][number];
export type WorkQueueRule = WorkitemsConfigResult["rules"][number];
export type WorkItemEvidenceBundle = WorkitemsEvidenceResult["bundles"][number];

/** `error.details.code` values workitems.decide answers with when it refuses. */
export const WORK_ITEM_DECISION_REFUSALS = [
  "not_a_person",
  "terminal",
  "comment_required",
  "not_awaiting_review",
  "draft_changed",
  "already_approved",
  "separation_of_duties",
  "checks_failed",
] as const;
export type WorkItemDecisionRefusal = (typeof WORK_ITEM_DECISION_REFUSALS)[number];
