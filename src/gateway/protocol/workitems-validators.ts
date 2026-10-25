// Compiled validators for the work queue methods (kept apart from protocol/index.ts).
import AjvPkg, { type ValidateFunction } from "ajv";
import {
  WorkitemsClearFlagParamsSchema,
  WorkitemsIntakeEmailParamsSchema,
} from "./schema/workitems-intake.js";
import {
  WorkitemsDelegateParamsSchema,
  WorkitemsDocumentParamsSchema,
  WorkitemsDraftDiffParamsSchema,
  WorkitemsStatsParamsSchema,
} from "./schema/workitems-review.js";
import {
  WorkitemsAssignAgentParamsSchema,
  WorkitemsConfigParamsSchema,
  WorkitemsCreateParamsSchema,
  WorkitemsDecideParamsSchema,
  WorkitemsEvidenceParamsSchema,
  WorkitemsGetParamsSchema,
  WorkitemsListParamsSchema,
  WorkitemsUpdateParamsSchema,
} from "./schema/workitems.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

// Validators compile on first use: compiling all of them at import cost ~0.2-0.3 s of CPU in
// every process that imports the protocol (each CLI command, each gateway start), most of which
// use a handful. The wrapper is a drop-in ValidateFunction: callers invoke it and read `.errors`.
function lazyCompile<T = unknown>(schema: object): ValidateFunction<T> {
  let compiled: ValidateFunction<T> | null = null;
  const get = (): ValidateFunction<T> => (compiled ??= ajv.compile<T>(schema));
  const validate = ((data: unknown) => get()(data)) as ValidateFunction<T>;
  for (const key of ["errors", "schema", "schemaEnv", "source", "evaluated"] as const) {
    Object.defineProperty(validate, key, {
      configurable: true,
      enumerable: true,
      get: () => (key === "errors" ? (compiled?.errors ?? null) : get()[key]),
      set: (value: unknown) => {
        (get() as unknown as Record<string, unknown>)[key] = value;
      },
    });
  }
  return validate;
}

export const workitemsValidators = {
  "workitems.list": lazyCompile(WorkitemsListParamsSchema),
  "workitems.get": lazyCompile(WorkitemsGetParamsSchema),
  "workitems.create": lazyCompile(WorkitemsCreateParamsSchema),
  "workitems.update": lazyCompile(WorkitemsUpdateParamsSchema),
  "workitems.assignAgent": lazyCompile(WorkitemsAssignAgentParamsSchema),
  "workitems.decide": lazyCompile(WorkitemsDecideParamsSchema),
  "workitems.config": lazyCompile(WorkitemsConfigParamsSchema),
  "workitems.evidence": lazyCompile(WorkitemsEvidenceParamsSchema),
  "workitems.delegate": lazyCompile(WorkitemsDelegateParamsSchema),
  "workitems.document": lazyCompile(WorkitemsDocumentParamsSchema),
  "workitems.draftDiff": lazyCompile(WorkitemsDraftDiffParamsSchema),
  "workitems.stats": lazyCompile(WorkitemsStatsParamsSchema),
  "workitems.intakeEmail": lazyCompile(WorkitemsIntakeEmailParamsSchema),
  "workitems.clearFlag": lazyCompile(WorkitemsClearFlagParamsSchema),
} as const;

export type WorkitemsMethod = keyof typeof workitemsValidators;
