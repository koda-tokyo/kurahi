// SPDX-License-Identifier: MIT
// Named shapes for the autopilot (all editions): aliases of the generated method types, so they
// never drift from the spec. See docs/autopilot.md.
import type {
  AutopilotApprovalsCreateParams,
  AutopilotApprovalsListResult,
  AutopilotRoutinesListResult,
  AutopilotRunsGetResult,
  AutopilotRunsListResult,
  AutopilotStatsResult,
} from "./generated/types.js";

export type AutopilotRoutine = AutopilotRoutinesListResult["routines"][number];
export type AutopilotRoutineState = AutopilotRoutine["state"];
export type AutopilotLevel = AutopilotRoutine["level"];
export type AutopilotEdition = AutopilotRoutine["edition"];
export type AutopilotActionDef = AutopilotRoutinesListResult["catalogue"][number];
export type AutopilotActionClass = AutopilotActionDef["class"];
export type AutopilotRunSummary = AutopilotRunsListResult["runs"][number];
export type AutopilotRunStatus = AutopilotRunSummary["status"];
export type AutopilotRunCounts = AutopilotRunSummary["counts"];
export type AutopilotRunRecord = AutopilotRunsGetResult["run"];
export type AutopilotActionOutcome = AutopilotRunRecord["actions"][number];
export type AutopilotApproval = AutopilotApprovalsListResult["approvals"][number];
export type AutopilotApprovalScope = AutopilotApproval["scope"];
export type AutopilotApprovalInput = Omit<AutopilotApprovalsCreateParams, "projectId">;
export type AutopilotStats = AutopilotStatsResult;
export type AutopilotRoutineStats = AutopilotStatsResult["routines"][number];
export type AutopilotAreaStats = AutopilotStatsResult["areas"][number];

/** `error.details.code` values the autopilot methods answer with when they refuse. */
export const AUTOPILOT_REFUSALS = [
  "not_a_person",
  "project_not_found",
  "routine_not_found",
  "routines_invalid",
  "routine_disabled",
  "paused",
  "already_running",
  "agent_not_allowed",
  "archived",
  "run_not_found",
  "cron_unavailable",
  "invalid_range",
  "reason_required",
  "not_external",
  "not_in_routine",
  "invalid_scope",
  "invalid_expiry",
  "approval_not_found",
  "already_revoked",
] as const;
export type AutopilotRefusal = (typeof AUTOPILOT_REFUSALS)[number];

/** `code` on an action outcome that was not executed (authorizeAction and the runner). */
export const AUTOPILOT_DECISION_CODES = [
  "unknown_action",
  "edition_mismatch",
  "flagged",
  "never_autonomous",
  "not_in_routine",
  "invalid_args",
  "level_observe",
  "daily_limit",
  "level_too_low",
  "no_standing_approval",
  "approval_expired",
  "approval_revoked",
  "approval_daily_limit",
  "no_target",
  "recipient_out_of_scope",
  "target_out_of_scope",
  "template_out_of_scope",
  "no_executor",
  // Not a refusal: the message was already filed by this routine (intake idempotency).
  "already_handled",
  // workitem.intake executed, but the message already had an item (that item is the ref).
  "existing_item",
  // L3: executed after a person approved, the standing approval did not verify at send time.
  "person_approved",
] as const;
export type AutopilotDecisionCode = (typeof AUTOPILOT_DECISION_CODES)[number];
