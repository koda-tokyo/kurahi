import { Type, type TSchema } from "@sinclair/typebox";
import {
  CHANGES_LIMIT,
  legacyBaselineAdvance,
  legacyChanges,
} from "../../packages/legacy-analyzer/src/index.js";
import { failure, result, str } from "./results.js";

// Change detection tools of the plugin: legacy_changes compares the fact index with the stored
// baseline (output/.legacy-index/baseline/ of the project, never the sources); the autopilot's
// legacy.baseline_advance action (and a person resetting it) moves the baseline forward with
// legacy_baseline_advance. Both read the sources only; their writes are the analyser cache.

type Deps = {
  root: (params: Record<string, unknown>) => string;
  pathParam: TSchema;
  env: { stateDir: string; now?: () => Date };
};

const DIGEST_RE = /^[a-f0-9]{16}$/;

export function changesTools({ root, pathParam, env }: Deps) {
  return [
    {
      name: "legacy_changes",
      label: "Legacy changes",
      description:
        "What changed in the legacy sources since the stored baseline: COBOL programs, copybooks, JCL jobs, SQL DDL " +
        "tables, columns and stored routines added, removed or changed (content hash; paragraphs, columns or steps " +
        "listed), and CALL / PERFORM / EXEC SQL / JCL step edges added or removed, each with path:line evidence " +
        "(removed entries cite the baseline). Changed programs carry their impact: callers, job steps and tables. " +
        "Counts are complete; the lists are bounded by limit, in a fixed order. First run: the baseline is created " +
        "and nothing is reported as a change. Read-only on the sources; the baseline lives in the analyser cache " +
        "folder and moves forward only with legacy_baseline_advance.",
      parameters: Type.Object({
        path: pathParam,
        since: Type.Optional(
          Type.String({ description: 'What to compare with: "baseline" (the only option).' }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: `Entries per list (default ${CHANGES_LIMIT.default}, at most ${CHANGES_LIMIT.max}).`,
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const since = str(params.since) || "baseline";
          if (since !== "baseline") {
            throw new Error('since must be "baseline".');
          }
          const limit = typeof params.limit === "number" ? params.limit : undefined;
          const out = legacyChanges(root(params), { limit }, env);
          // The path as given, so a follow-up action (design doc, baseline advance) names it.
          const res = result({ path: str(params.path), ...out });
          // Nothing to review (first run, or no change): a gate step ends the run as no_input.
          const noInput = out.status !== "changed";
          return {
            ...res,
            details: {
              ...res.details,
              status: out.status,
              snapshot: out.current.digest,
              noInput,
              ...(noInput
                ? {
                    noInputReason:
                      out.status === "baseline_created"
                        ? "baseline created; nothing to compare yet"
                        : "no change since the baseline",
                  }
                : {}),
            },
          };
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "legacy_baseline_advance",
      label: "Advance the legacy baseline",
      description:
        "Move the change-detection baseline forward to the snapshot the last legacy_changes compared (pass its " +
        "current.digest as snapshot to make sure it is that one), so the next comparison starts from there. " +
        "rebuild: true sets the baseline from the current sources instead (a person resetting it). Writes only the " +
        "analyser cache folder.",
      parameters: Type.Object({
        path: pathParam,
        snapshot: Type.Optional(
          Type.String({ description: "current.digest reported by legacy_changes (16 hex)." }),
        ),
        rebuild: Type.Optional(
          Type.Boolean({ description: "Baseline from the current sources (reset)." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const snapshot = str(params.snapshot) || undefined;
          if (snapshot && !DIGEST_RE.test(snapshot)) {
            throw new Error("snapshot must be the 16-hex digest legacy_changes reported.");
          }
          return result(
            legacyBaselineAdvance(
              root(params),
              { snapshot, rebuild: params.rebuild === true },
              env,
            ),
          );
        } catch (err) {
          return failure(err);
        }
      },
    },
  ];
}
