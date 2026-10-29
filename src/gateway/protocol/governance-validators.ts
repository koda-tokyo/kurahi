// Compiled validators for the data governance methods (kept apart from protocol/index.ts).
import AjvPkg, { type ValidateFunction } from "ajv";
import {
  GovernanceDsrExecuteParamsSchema,
  GovernanceDsrFindParamsSchema,
  GovernanceExportCreateParamsSchema,
  GovernanceExportGetParamsSchema,
  GovernanceExportListParamsSchema,
  GovernanceHoldsCreateParamsSchema,
  GovernanceHoldsListParamsSchema,
  GovernanceHoldsReleaseParamsSchema,
  GovernancePolicyGetParamsSchema,
  GovernancePolicySetParamsSchema,
  GovernanceRetentionRunParamsSchema,
} from "./schema/governance.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

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

export const governanceValidators = {
  "governance.policy.get": lazyCompile(GovernancePolicyGetParamsSchema),
  "governance.policy.set": lazyCompile(GovernancePolicySetParamsSchema),
  "governance.retention.run": lazyCompile(GovernanceRetentionRunParamsSchema),
  "governance.holds.create": lazyCompile(GovernanceHoldsCreateParamsSchema),
  "governance.holds.list": lazyCompile(GovernanceHoldsListParamsSchema),
  "governance.holds.release": lazyCompile(GovernanceHoldsReleaseParamsSchema),
  "governance.export.create": lazyCompile(GovernanceExportCreateParamsSchema),
  "governance.export.get": lazyCompile(GovernanceExportGetParamsSchema),
  "governance.export.list": lazyCompile(GovernanceExportListParamsSchema),
  "governance.dsr.find": lazyCompile(GovernanceDsrFindParamsSchema),
  "governance.dsr.execute": lazyCompile(GovernanceDsrExecuteParamsSchema),
} as const;

export type GovernanceMethod = keyof typeof governanceValidators;
