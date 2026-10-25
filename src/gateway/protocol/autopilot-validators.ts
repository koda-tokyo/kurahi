// Compiled validators for the autopilot methods (kept apart from protocol/index.ts).
import AjvPkg, { type ValidateFunction } from "ajv";
import {
  AutopilotApprovalsCreateParamsSchema,
  AutopilotApprovalsListParamsSchema,
  AutopilotApprovalsRevokeParamsSchema,
  AutopilotPauseParamsSchema,
  AutopilotResumeParamsSchema,
  AutopilotRoutinesListParamsSchema,
  AutopilotRoutinesSyncParamsSchema,
  AutopilotRunParamsSchema,
  AutopilotRunsGetParamsSchema,
  AutopilotRunsListParamsSchema,
  AutopilotStartAllParamsSchema,
  AutopilotAutonomyProposalsParamsSchema,
  AutopilotAutonomyDeclineParamsSchema,
  AutopilotAutonomyAcceptParamsSchema,
  AutopilotBriefGetParamsSchema,
  AutopilotReportErrorParamsSchema,
  AutopilotStatsParamsSchema,
  AutopilotStopAllParamsSchema,
} from "./schema/autopilot.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

// Compiled on first use, like the work queue validators (import stays cheap).
function lazyCompile(schema: object): ValidateFunction {
  let compiled: ValidateFunction | null = null;
  const validate = ((data: unknown) =>
    (compiled ??= ajv.compile(schema))(data)) as ValidateFunction;
  Object.defineProperty(validate, "errors", {
    configurable: true,
    enumerable: true,
    get: () => compiled?.errors ?? null,
  });
  return validate;
}

export const autopilotValidators = {
  "autopilot.routines.list": lazyCompile(AutopilotRoutinesListParamsSchema),
  "autopilot.routines.sync": lazyCompile(AutopilotRoutinesSyncParamsSchema),
  "autopilot.runs.list": lazyCompile(AutopilotRunsListParamsSchema),
  "autopilot.runs.get": lazyCompile(AutopilotRunsGetParamsSchema),
  "autopilot.run": lazyCompile(AutopilotRunParamsSchema),
  "autopilot.pause": lazyCompile(AutopilotPauseParamsSchema),
  "autopilot.resume": lazyCompile(AutopilotResumeParamsSchema),
  "autopilot.approvals.create": lazyCompile(AutopilotApprovalsCreateParamsSchema),
  "autopilot.approvals.list": lazyCompile(AutopilotApprovalsListParamsSchema),
  "autopilot.approvals.revoke": lazyCompile(AutopilotApprovalsRevokeParamsSchema),
  "autopilot.stats": lazyCompile(AutopilotStatsParamsSchema),
  "autopilot.autonomy.proposals": lazyCompile(AutopilotAutonomyProposalsParamsSchema),
  "autopilot.autonomy.decline": lazyCompile(AutopilotAutonomyDeclineParamsSchema),
  "autopilot.autonomy.accept": lazyCompile(AutopilotAutonomyAcceptParamsSchema),
  "autopilot.reportError": lazyCompile(AutopilotReportErrorParamsSchema),
  "autopilot.brief.get": lazyCompile(AutopilotBriefGetParamsSchema),
  "autopilot.stopAll": lazyCompile(AutopilotStopAllParamsSchema),
  "autopilot.startAll": lazyCompile(AutopilotStartAllParamsSchema),
} as const;

export type AutopilotMethod = keyof typeof autopilotValidators;
