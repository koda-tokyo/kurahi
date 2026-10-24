// `kurahi eval …` — the Workflow Evaluator (design/workflow-evaluator.md).
//
//   kurahi eval spec init|lint|verify|sign|digests <workflow>
//   kurahi eval run <workflow> [--fixture <id>...] [--require-signed] [--json]
//   kurahi eval report [<workflow>] [--run <id>] [--verify <dir>] [--json]
//   kurahi eval review <run> --task <id> --minutes-review N --minutes-fix M
//                      --accepted <as-is|edited|rejected> [--diff-from <file> --diff-to <file>]
//   kurahi eval score|gate <workflow>               not available in this release
//
// <workflow> is a spec directory, or a workflow id looked up in <KOLO_HOME>/eval/specs/<id> and
// then in the bundled examples (eval/workflows/<id>).
// Exit codes: 0 pass · 1 quality fail · 2 security gate fail · 3 spec or provenance invalid · 4 usage.
import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { resolveStateDir } from "../config/paths.js";
import { runReplay } from "../eval/run.js";
import { verifyScorecardDir, type Scorecard } from "../eval/scorecard.js";
import {
  lintSpec,
  loadSpec,
  signSpec,
  SpecError,
  updateFixtureDigests,
  verifyFixtureDigests,
  verifySpecSignature,
} from "../eval/spec.js";
import { ctxOf, EVAL_EXIT, type EvalCliDeps } from "./eval-cli-shared.js";
import { formatEffort, registerEvalReview } from "./eval-review-cli.js";

export { EVAL_EXIT, type EvalCliDeps } from "./eval-cli-shared.js";
export { resolveRunDir, runEvalReview } from "./eval-review-cli.js";

export function resolveWorkflowDir(
  ref: string,
  env: NodeJS.ProcessEnv,
  bundledRoot: string,
): string | null {
  const candidates = [
    path.resolve(ref),
    path.join(resolveStateDir(env), "eval", "specs", ref),
    path.join(bundledRoot, ref),
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, "spec.yaml"))) ?? null;
}

function needDir(ctx: ReturnType<typeof ctxOf>, ref: string): string | null {
  const dir = resolveWorkflowDir(ref, ctx.env, ctx.bundledRoot);
  if (!dir) {
    ctx.runtime.error(
      `No spec.yaml for "${ref}" (looked in ./${ref}, <KOLO_HOME>/eval/specs/${ref}, bundled examples).`,
    );
    ctx.runtime.exit(EVAL_EXIT.usage);
  }
  return dir;
}

function reportSpecError(ctx: ReturnType<typeof ctxOf>, err: unknown): void {
  if (err instanceof SpecError) {
    ctx.runtime.error(err.message);
    for (const i of err.issues) {
      ctx.runtime.error(`  - ${i}`);
    }
    ctx.runtime.exit(EVAL_EXIT.invalid);
    return;
  }
  throw err;
}

export async function runEvalSpec(
  action: string,
  ref: string,
  opts: { json?: boolean } = {},
  deps?: EvalCliDeps,
) {
  const ctx = ctxOf(deps);
  if (action === "init") {
    const src = path.join(ctx.bundledRoot, ref);
    const dest = path.join(resolveStateDir(ctx.env), "eval", "specs", ref);
    if (!fs.existsSync(path.join(src, "spec.yaml"))) {
      ctx.runtime.error(`No bundled example "${ref}".`);
      ctx.runtime.exit(EVAL_EXIT.usage);
      return;
    }
    if (fs.existsSync(dest)) {
      ctx.runtime.error(`${dest} already exists.`);
      ctx.runtime.exit(EVAL_EXIT.usage);
      return;
    }
    fs.cpSync(src, dest, { recursive: true });
    ctx.runtime.log(`copied ${ref} to ${dest}; edit it, then \`kurahi eval spec sign ${ref}\``);
    return;
  }
  const dir = needDir(ctx, ref);
  if (!dir) {
    return;
  }
  const bundled = path.resolve(dir).startsWith(path.resolve(ctx.bundledRoot));
  if (bundled && (action === "sign" || action === "digests")) {
    ctx.runtime.error(
      `"${ref}" is a bundled example and stays read-only. Copy it first: kurahi eval spec init ${ref}`,
    );
    ctx.runtime.exit(EVAL_EXIT.usage);
    return;
  }
  try {
    if (action === "digests") {
      const n = updateFixtureDigests(dir);
      ctx.runtime.log(`${n} fixture digest(s) updated in ${path.join(dir, "spec.yaml")}`);
      return;
    }
    const loaded = loadSpec(dir);
    if (action === "lint") {
      const findings = lintSpec(loaded);
      const digests = verifyFixtureDigests(loaded);
      if (opts.json) {
        ctx.runtime.log(JSON.stringify({ findings, digests }, null, 2));
      } else {
        for (const f of findings) {
          ctx.runtime.log(`${f.level}: ${f.check ? `${f.check}: ` : ""}${f.message}`);
        }
        for (const d of digests) {
          ctx.runtime.log(`error: fixture ${d.fixture}/${d.file} does not match its digest`);
        }
        ctx.runtime.log(
          `${loaded.spec.workflow} v${loaded.spec.version}: ${findings.filter((f) => f.level === "error").length + digests.length} error(s)`,
        );
      }
      if (findings.some((f) => f.level === "error") || digests.length > 0) {
        ctx.runtime.exit(EVAL_EXIT.invalid);
      }
      return;
    }
    if (action === "sign") {
      const errors = lintSpec(loaded).filter((f) => f.level === "error");
      const digests = verifyFixtureDigests(loaded);
      if (errors.length > 0 || digests.length > 0) {
        throw new SpecError("refusing to sign a spec that fails lint or fixture digests", [
          ...errors.map((e) => `${e.check ?? "spec"}: ${e.message}`),
          ...digests.map((d) => `${d.fixture}/${d.file}: digest mismatch`),
        ]);
      }
      const sig = signSpec(dir, ctx.env);
      ctx.runtime.log(
        `signed ${loaded.spec.workflow} v${loaded.spec.version} (sha256 ${sig.sha256.slice(0, 12)}…) by ${sig.keyId}`,
      );
      return;
    }
    if (action === "verify") {
      const att = verifySpecSignature(loaded, ctx.env);
      const digests = verifyFixtureDigests(loaded);
      const ok = att.state === "signed" && digests.length === 0;
      if (opts.json) {
        ctx.runtime.log(JSON.stringify({ ok, signature: att, digests }, null, 2));
      } else {
        ctx.runtime.log(
          `${loaded.spec.workflow} v${loaded.spec.version}: signature ${att.state}${att.reason ? ` (${att.reason})` : ""}; fixtures ${digests.length === 0 ? "match" : `${digests.length} mismatch(es)`}`,
        );
      }
      if (!ok) {
        ctx.runtime.exit(EVAL_EXIT.invalid);
      }
      return;
    }
    ctx.runtime.error(`unknown spec action ${action} (init, lint, verify, sign, digests)`);
    ctx.runtime.exit(EVAL_EXIT.usage);
  } catch (err) {
    reportSpecError(ctx, err);
  }
}

function printScorecard(runtime: RuntimeEnv, card: Scorecard, dir: string) {
  runtime.log(
    `${card.workflow} · run ${card.runId} · ${card.mode} · spec v${card.spec.version} (${card.spec.signature})`,
  );
  for (const f of card.fixtures) {
    runtime.log(
      `  ${f.fixture}${card.reliability?.k > 1 ? ` #${f.attempt}` : ""}: ${f.passed ? "PASS" : "FAIL"} · score ${f.score} · gates ${f.gates.passed ? "ok" : `FAILED (${f.gates.failed.join(", ")})`}${f.criticalFailed.length ? ` · critical failed: ${f.criticalFailed.join(", ")}` : ""}`,
    );
    for (const c of f.checks) {
      runtime.log(
        `    ${c.status === "pass" ? "✓" : c.status === "skipped" ? "–" : "✗"} ${c.id} [${c.severity}${c.judge === "model" ? ", judge: model" : ""}] ${c.detail}`,
      );
    }
    const effort = f.fixture ? card.correctionEffort?.tasks[f.fixture] : undefined;
    if (effort && (f.attempt === 1 || !card.reliability || card.reliability.k === 1)) {
      runtime.log(`    correction effort: ${formatEffort(effort)}`);
    }
  }
  const m = card.metrics;
  runtime.log(
    `  summary: ${card.summary.passed ? "PASS" : "FAIL"} · score ${card.summary.score}/${card.summary.passThreshold} · accepted ${card.summary.accepted}/${card.summary.attempts ?? card.summary.fixtures} · duplicates ${m.duplicateActions} · unauthorised ${m.unauthorisedActions}`,
  );
  const r = card.reliability;
  const ce = card.correctionEffort;
  // Correction effort is reported next to pass^k: a pass rate alone hides what the output cost
  // a person to check and fix.
  if (r && (r.k > 1 || ce)) {
    runtime.log(
      `  reliability (k=${r.k}): pass^k ${(r.passAllK * 100).toFixed(1)}% (min ${(r.minPassAll * 100).toFixed(0)}%) · pass@k ${(r.passAtK * 100).toFixed(1)}% · gates held in all attempts: ${r.gatesHeldInAll ? "yes" : "NO"} · score mean ${r.scoreMean} variance ${r.scoreVariance}`,
    );
  }
  if (ce) {
    runtime.log(`  correction effort: ${formatEffort(ce.suite)}`);
    if (ce.targets) {
      const t = ce.targets;
      runtime.log(
        `  correction effort targets: ${[
          t.medianMinutes === undefined ? null : `median ≤ ${t.medianMinutes} min`,
          t.p90Minutes === undefined ? null : `p90 ≤ ${t.p90Minutes} min`,
          t.minAcceptedUnchanged === undefined
            ? null
            : `accepted unchanged ≥ ${(t.minAcceptedUnchanged * 100).toFixed(0)}%`,
        ]
          .filter(Boolean)
          .join(
            " · ",
          )} → ${ce.meetsTargets === null ? "no reviews" : ce.meetsTargets ? "met" : "NOT met"}`,
      );
    }
  } else if (card.reviewTargets) {
    runtime.log("  correction effort: no human reviews recorded yet");
  }
  const tags = Object.entries(card.failureTags ?? {});
  if (tags.length > 0) {
    runtime.log(`  failure tags: ${tags.map(([t, n]) => `${t} ${n}`).join(" · ")}`);
  }
  for (const p of card.provenance) {
    runtime.log(`  provenance: ${p}`);
  }
  runtime.log(`  scorecard: ${dir}`);
}

function exitFor(card: Scorecard): number {
  if (!card.summary.gatesPassed) {
    return EVAL_EXIT.gate;
  }
  return card.summary.passed ? EVAL_EXIT.pass : EVAL_EXIT.quality;
}

export async function runEvalRun(
  ref: string,
  opts: { fixture?: string[]; requireSigned?: boolean; json?: boolean; repeat?: string } = {},
  deps?: EvalCliDeps,
) {
  const ctx = ctxOf(deps);
  const dir = needDir(ctx, ref);
  if (!dir) {
    return;
  }
  try {
    const { scorecard, dir: out } = runReplay({
      specDir: dir,
      env: ctx.env,
      fixtures: opts.fixture,
      allowUnsigned: !opts.requireSigned,
      repeat: opts.repeat === undefined ? undefined : Number(opts.repeat),
      now: ctx.now,
    });
    if (opts.json) {
      ctx.runtime.log(JSON.stringify({ dir: out, scorecard }, null, 2));
    } else {
      printScorecard(ctx.runtime, scorecard, out);
    }
    const code = exitFor(scorecard);
    if (code !== EVAL_EXIT.pass) {
      ctx.runtime.exit(code);
    }
  } catch (err) {
    reportSpecError(ctx, err);
  }
}

function latestRunDir(env: NodeJS.ProcessEnv, workflow: string, run?: string): string | null {
  const root = path.join(resolveStateDir(env), "eval", "scorecards", workflow);
  if (run) {
    const d = path.join(root, run);
    return fs.existsSync(d) ? d : null;
  }
  try {
    const runs = fs.readdirSync(root).toSorted();
    return runs.length ? path.join(root, runs.at(-1)!) : null;
  } catch {
    return null;
  }
}

export async function runEvalReport(
  ref: string | undefined,
  opts: { run?: string; verify?: string; json?: boolean } = {},
  deps?: EvalCliDeps,
) {
  const ctx = ctxOf(deps);
  const dir = opts.verify
    ? path.resolve(opts.verify)
    : ref
      ? latestRunDir(ctx.env, ref, opts.run)
      : null;
  if (!dir) {
    ctx.runtime.error(
      ref
        ? `No scorecard for ${ref}${opts.run ? ` run ${opts.run}` : ""}.`
        : "Give a workflow id or --verify <scorecard dir>.",
    );
    ctx.runtime.exit(EVAL_EXIT.usage);
    return;
  }
  const v = verifyScorecardDir(dir);
  if (opts.json) {
    ctx.runtime.log(
      JSON.stringify(
        {
          dir,
          verification: {
            ok: v.ok,
            keyIdOk: v.keyIdOk,
            signatureOk: v.signatureOk,
            filesOk: v.filesOk,
            problems: v.problems,
            signer: v.manifest?.signer?.keyId ?? null,
          },
          scorecard: v.scorecard,
        },
        null,
        2,
      ),
    );
  } else {
    if (v.scorecard) {
      printScorecard(ctx.runtime, v.scorecard, dir);
    }
    ctx.runtime.log(
      v.ok
        ? `verified: signature and file hashes OK (signer ${v.manifest?.signer.keyId})`
        : `NOT VERIFIED: ${v.problems.join("; ")}`,
    );
  }
  if (!v.ok) {
    ctx.runtime.exit(EVAL_EXIT.invalid);
  }
}

function notYet(name: string) {
  return async (_ref: string, _opts: unknown, deps?: EvalCliDeps) => {
    const ctx = ctxOf(deps);
    ctx.runtime.error(
      `kurahi eval ${name} is not available in this release (planned: ${name === "gate" ? "phase 3" : "phase 2"}).`,
    );
    ctx.runtime.exit(EVAL_EXIT.usage);
  };
}
export const runEvalScore = notYet("score");
export const runEvalGate = notYet("gate");

/** A scorecard directory, or a run id looked up under <KOLO_HOME>/eval/scorecards/<workflow>/. */

export function registerEvalCli(program: Command) {
  const cmd = program
    .command("eval")
    .description("Workflow Evaluator: acceptance specs, offline replay and signed scorecards")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  kurahi eval spec init csv-inspection.exceptions   # copy the bundled example to <KOLO_HOME>",
        "  kurahi eval spec lint csv-inspection.exceptions",
        "  kurahi eval run csv-inspection.exceptions",
        "  kurahi eval report csv-inspection.exceptions --verify <scorecard dir>",
        "  kurahi eval review <run> --task line3-clean --minutes-review 6 --minutes-fix 4 --accepted edited \\",
        "      --diff-from agent.json --diff-to accepted.json",
        "",
        "Exit codes: 0 pass · 1 quality fail · 2 security gate fail · 3 spec/provenance invalid · 4 usage",
      ].join("\n"),
    );
  const spec = cmd
    .command("spec")
    .description(
      "Copy a bundled example, lint, sign, verify or update digests of an acceptance spec",
    );
  for (const action of ["init", "lint", "verify", "sign", "digests"]) {
    spec
      .command(action)
      .argument("<workflow>", "workflow id or spec directory")
      .option("--json", "JSON output")
      .action(async (ref: string, opts) => {
        await runEvalSpec(action, ref, opts);
      });
  }
  cmd
    .command("run")
    .description(
      "Replay a workflow against its golden fixtures with simulated tools; writes a signed scorecard",
    )
    .argument("<workflow>", "workflow id or spec directory")
    .option("--fixture <id...>", "only these fixtures")
    .option("--require-signed", "refuse an unsigned or untrusted spec")
    .option("--repeat <k>", "attempts per fixture; reports pass^k (all) and pass@k (any)")
    .option("--json", "JSON output")
    .action(async (ref: string, opts) => {
      await runEvalRun(ref, opts);
    });
  cmd
    .command("report")
    .description("Show a scorecard and verify its signature offline")
    .argument("[workflow]", "workflow id (latest run unless --run)")
    .option("--run <id>", "a specific run id")
    .option("--verify <dir>", "verify this scorecard directory")
    .option("--json", "JSON output")
    .action(async (ref: string | undefined, opts) => {
      await runEvalReport(ref, opts);
    });
  registerEvalReview(cmd);
  for (const [name, fn] of [
    ["score", runEvalScore],
    ["gate", runEvalGate],
  ] as const) {
    cmd
      .command(name)
      .description("Not available in this release")
      .argument("<workflow>")
      .action(async (ref: string, opts) => {
        await fn(ref, opts);
      });
  }
}
