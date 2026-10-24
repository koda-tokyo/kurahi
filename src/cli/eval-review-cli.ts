// `kurahi eval review <run> --task <id> …` — record a human review on a signed scorecard
// (design/workflow-evaluator.md §4.3): review and fix minutes, diff size, verdict. Re-signs the
// scorecard; the superseded version is kept under revisions/.
import type { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type CorrectionEffortStats,
  type DiffSize,
  VERDICT_ALIASES,
} from "../eval/review-effort.js";
import { parseMinutes, recordReview, ReviewError } from "../eval/review.js";
import { verifyScorecardDir } from "../eval/scorecard.js";
import { resolveEvidenceSigningKey } from "../evidence/store.js";
import { ctxOf, EVAL_EXIT, type EvalCliDeps } from "./eval-cli-shared.js";

const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
const mins = (x: number | null) => (x === null ? "–" : `${x} min`);

export function formatEffort(e: CorrectionEffortStats): string {
  return `${e.reviews} review(s) · median ${mins(e.medianMinutes)} · p90 ${mins(e.p90Minutes)} (median review ${mins(e.medianReviewMinutes)}, fix ${mins(e.medianFixMinutes)}) · accepted unchanged ${pct(e.acceptedUnchangedShare)} · edited ${pct(e.acceptedEditedShare)} · rejected ${pct(e.rejectedShare)}${e.medianEditDistance === null ? "" : ` · median diff ${e.medianEditDistance} line(s)`}`;
}

export function formatDiff(d: DiffSize): string {
  return `diff +${d.added} −${d.removed} lines (edit distance ${d.editDistance}${d.exact ? "" : ", lower bound"}, ${(d.changeRatio * 100).toFixed(1)}% changed)`;
}

/** A scorecard directory, or a run id looked up under <KOLO_HOME>/eval/scorecards/<workflow>/. */
export function resolveRunDir(
  ref: string,
  env: NodeJS.ProcessEnv,
  workflow?: string,
): { dir: string | null; ambiguous: string[] } {
  const asDir = path.resolve(ref);
  if (fs.existsSync(path.join(asDir, "manifest.json"))) {
    return { dir: asDir, ambiguous: [] };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)) {
    return { dir: null, ambiguous: [] };
  }
  const root = path.join(resolveStateDir(env), "eval", "scorecards");
  let workflows: string[] = [];
  try {
    workflows = workflow ? [workflow] : fs.readdirSync(root);
  } catch {
    workflows = [];
  }
  const hits = workflows
    .map((w) => path.join(root, w, ref))
    .filter((d) => fs.existsSync(path.join(d, "manifest.json")));
  return hits.length === 1
    ? { dir: hits[0], ambiguous: [] }
    : { dir: null, ambiguous: hits.length > 1 ? hits : [] };
}

export type EvalReviewOpts = {
  task?: string;
  attempt?: string;
  minutesReview?: string;
  minutesFix?: string;
  accepted?: string;
  diffFrom?: string;
  diffTo?: string;
  reviewer?: string;
  reason?: string;
  workflow?: string;
  json?: boolean;
};

export async function runEvalReview(run: string, opts: EvalReviewOpts = {}, deps?: EvalCliDeps) {
  const ctx = ctxOf(deps);
  const usage = (msg: string) => {
    ctx.runtime.error(msg);
    ctx.runtime.exit(EVAL_EXIT.usage);
  };
  const { dir, ambiguous } = resolveRunDir(run, ctx.env, opts.workflow);
  if (!dir) {
    usage(
      ambiguous.length
        ? `Run ${run} exists for several workflows; pass --workflow (${ambiguous.map((d) => path.basename(path.dirname(d))).join(", ")}).`
        : `No scorecard for run ${run} (give a run id or a scorecard directory).`,
    );
    return;
  }
  if (!opts.task) {
    usage("--task <id> is required");
    return;
  }
  const verdict = opts.accepted ? VERDICT_ALIASES[opts.accepted] : undefined;
  if (!verdict) {
    usage("--accepted must be as-is, edited or rejected");
    return;
  }
  try {
    const attempt = opts.attempt === undefined ? undefined : Number(opts.attempt);
    if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
      throw new ReviewError("--attempt must be a positive integer");
    }
    const { scorecard, review } = recordReview(
      dir,
      {
        task: opts.task,
        attempt,
        reviewer: opts.reviewer ?? ctx.env.USER ?? os.userInfo().username,
        minutesReview: parseMinutes(opts.minutesReview, "--minutes-review"),
        minutesFix: parseMinutes(opts.minutesFix, "--minutes-fix"),
        verdict,
        reason: opts.reason,
        diffFrom: opts.diffFrom,
        diffTo: opts.diffTo,
      },
      resolveEvidenceSigningKey(ctx.env),
      ctx.now?.() ?? new Date(),
    );
    const v = verifyScorecardDir(dir);
    if (opts.json) {
      ctx.runtime.log(
        JSON.stringify(
          {
            dir,
            review,
            correctionEffort: scorecard.correctionEffort,
            verified: v.ok,
            signer: v.manifest?.signer.keyId ?? null,
          },
          null,
          2,
        ),
      );
    } else {
      ctx.runtime.log(
        `recorded ${review.id} on ${scorecard.workflow} · run ${scorecard.runId} · task ${review.fixture}${scorecard.reliability?.k > 1 ? ` #${review.attempt}` : ""} · ${review.verdict} · ${review.minutesReview} min review + ${review.minutesFix} min fix${review.diff ? ` · ${formatDiff(review.diff)}` : ""}`,
      );
      const ce = scorecard.correctionEffort;
      const task = ce?.tasks[review.fixture];
      if (task) {
        ctx.runtime.log(`  task ${review.fixture}: ${formatEffort(task)}`);
      }
      if (ce) {
        ctx.runtime.log(`  suite: ${formatEffort(ce.suite)}`);
      }
      ctx.runtime.log(
        v.ok
          ? `  re-signed: ${dir} (signer ${v.manifest?.signer.keyId}); previous version kept in revisions/r${review.id.slice(3)}`
          : `  NOT VERIFIED after re-signing: ${v.problems.join("; ")}`,
      );
    }
    if (!v.ok) {
      ctx.runtime.exit(EVAL_EXIT.invalid);
    }
  } catch (err) {
    if (err instanceof ReviewError) {
      ctx.runtime.error(err.message);
      ctx.runtime.exit(err.kind === "invalid" ? EVAL_EXIT.invalid : EVAL_EXIT.usage);
      return;
    }
    throw err;
  }
}

export function registerEvalReview(cmd: Command) {
  cmd
    .command("review")
    .description(
      "Record a human review of one task in a run (review and fix minutes, diff size, verdict) and re-sign the scorecard",
    )
    .argument("<run>", "run id, or a scorecard directory")
    .requiredOption("--task <id>", "task (fixture) id")
    .requiredOption("--minutes-review <n>", "minutes spent reviewing the agent's output")
    .requiredOption("--minutes-fix <m>", "minutes spent correcting it (0 if accepted as-is)")
    .requiredOption("--accepted <verdict>", "as-is | edited | rejected")
    .option("--diff-from <file>", "the agent's output")
    .option("--diff-to <file>", "the accepted output")
    .option("--attempt <n>", "attempt number with --repeat runs (default 1)")
    .option("--reviewer <name>", "reviewer (default: the current user)")
    .option("--reason <code>", "reason code, e.g. for a rejection")
    .option("--workflow <id>", "workflow, when the run id is not unique")
    .option("--json", "JSON output")
    .action(async (run: string, opts: EvalReviewOpts) => {
      await runEvalReview(run, opts);
    });
}
