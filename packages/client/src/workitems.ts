// SPDX-License-Identifier: MIT
// Named shapes for the Business edition work queue (aliases of the generated method types, so
// they never drift from the spec). See docs/business/work-queue.md.
import type {
  WorkitemsClearFlagParams,
  WorkitemsConfigResult,
  WorkitemsDecideParams,
  WorkitemsDelegateParams,
  WorkitemsDocumentResult,
  WorkitemsDraftDiffResult,
  WorkitemsEvidenceResult,
  WorkitemsGetResult,
  WorkitemsIntakeEmailParams,
  WorkitemsIntakeEmailResult,
  WorkitemsListParams,
  WorkitemsListResult,
  WorkitemsStatsResult,
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

// 稟議 routes, ownership and the approver inbox.
export type WorkItemApproval = WorkItem["approvals"][number];
export type WorkItemRoute = NonNullable<WorkItem["route"]>;
export type WorkItemStage = WorkItemRoute["stages"][number];
export type WorkItemStageStatus = WorkItemStage["status"];
export type WorkItemDelegation = WorkItemStage["delegations"][number];
export type WorkItemStageSummary = NonNullable<WorkItemSummary["currentStage"]>;
export type WorkItemDelegateInput = Omit<WorkitemsDelegateParams, "projectId" | "id">;
export type WorkQueueRouteDef = WorkitemsConfigResult["routes"][number];
export type WorkQueueAccess = WorkitemsConfigResult["access"];
export type WorkQueueViewer = WorkitemsConfigResult["viewer"];

// Review: document previews, draft diffs, overview.
export type WorkItemDocumentPreview = WorkitemsDocumentResult["document"];
export type WorkItemDraftDiff = WorkitemsDraftDiffResult;
export type WorkItemDiffHunk = WorkitemsDraftDiffResult["hunks"][number];
export type WorkItemDiffLine = WorkItemDiffHunk["lines"][number];
export type WorkItemDraftProvenance = WorkitemsDraftDiffResult["from"];
export type WorkQueueStats = WorkitemsStatsResult;
export type WorkQueueStageStats = WorkitemsStatsResult["stages"][number];

// Email intake (by reference) and person-cleared risk flags.
export type WorkItemOrigin = NonNullable<WorkItem["source"]["origin"]>;
export type WorkItemFlag = NonNullable<WorkItem["flags"]>[number];
export type WorkItemFlagClearance = NonNullable<WorkItem["flagClearances"]>[number];
export type WorkItemIntakeEmailInput = Omit<WorkitemsIntakeEmailParams, "projectId">;
export type WorkItemIntakeEmailResult = WorkitemsIntakeEmailResult;
export type WorkItemClearFlagInput = Omit<WorkitemsClearFlagParams, "projectId" | "id">;

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
  "not_an_approver",
  "not_authorised",
  "fraud_flag_uncleared",
] as const;
export type WorkItemDecisionRefusal = (typeof WORK_ITEM_DECISION_REFUSALS)[number];

/** `error.details.code` values workitems.delegate answers with when it refuses. */
export const WORK_ITEM_DELEGATION_REFUSALS = [
  "not_a_person",
  "not_awaiting_review",
  "delegation_not_allowed",
  "not_an_approver",
  "already_approved",
  "invalid_delegate",
  "reason_required",
  "invalid_expiry",
] as const;
export type WorkItemDelegationRefusal = (typeof WORK_ITEM_DELEGATION_REFUSALS)[number];

/** Codes for reads and updates the caller may not make, and for document references. */
export const WORK_ITEM_ACCESS_REFUSALS = [
  "not_authorised",
  "no_draft",
  "unknown_ref",
  "outside_project",
  "document_not_found",
] as const;
export type WorkItemAccessRefusal = (typeof WORK_ITEM_ACCESS_REFUSALS)[number];

/** `error.details.code` values workitems.clearFlag answers with when it refuses. */
export const WORK_ITEM_FLAG_REFUSALS = [
  "not_a_person",
  "invalid_flag",
  "reason_required",
  "terminal",
  "flag_not_set",
  "not_authorised",
] as const;
export type WorkItemFlagRefusal = (typeof WORK_ITEM_FLAG_REFUSALS)[number];

/** `error.details.code` values workitems.intakeEmail answers with when it refuses. */
export const WORK_ITEM_INTAKE_REFUSALS = ["duplicate_source"] as const;
export type WorkItemIntakeRefusal = (typeof WORK_ITEM_INTAKE_REFUSALS)[number];
