// Workflow Evaluator: offline replay runs (design §4.1).
//
// For each golden fixture: run the workflow's driver against the simulated-tool layer, record the
// job's evidence (in a separate evaluation state directory, never mixed with production evidence),
// score it with the spec's deterministic checks, and write one signed scorecard for the run.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SigningKey } from "../continuity-suite/manifest.js";
import type { EvidenceEvent } from "../evidence/types.js";
import { resolveStateDir } from "../config/paths.js";
import { EvidenceRecorder } from "../evidence/recorder.js";
import {
  EVENTS_FILE,
  MANIFEST_FILE,
  readEventsFile,
  resolveEvidenceLimits,
  resolveEvidenceSigningKey,
  verifyEventChain,
} from "../evidence/store.js";
import { sha256Hex } from "../policy/attestation.js";
import { VERSION } from "../version.js";
import { type CheckResult, runCheck } from "./checks.js";
import { DRIVERS, type DriverContext } from "./drivers/csv-inspection.js";
import {
  resolveScorecardDir,
  type FixtureScore,
  type Scorecard,
  SCORECARD_KIND,
  SCORECARD_VERSION,
  reliabilityOf,
  scoreChecks,
  writeSignedScorecard,
} from "./scorecard.js";
import { type Scenario, SimulatedTools } from "./simulate.js";
import {
  type LoadedSpec,
  fixturePath,
  lintSpec,
  loadSpec,
  SpecError,
  verifyFixtureDigests,
  verifySpecSignature,
} from "./spec.js";

export type ReplayOptions = {
  specDir: string;
  env?: NodeJS.ProcessEnv;
  key?: SigningKey;
  fixtures?: string[];
  runId?: string;
  now?: () => Date;
  /** Test hook: per-fixture driver faults. */
  faults?: Record<string, DriverContext["faults"]>;
  /** Test hook: per-attempt driver faults (wins over `faults`). */
  faultsFor?: (fixtureId: string, attempt: number) => DriverContext["faults"] | undefined;
  /** Attempts per fixture (`--repeat k`); default the spec's reliability.repeat, else 1. */
  repeat?: number;
  /** Allow running an unsigned spec (authoring); the scorecard says so. Default true. */
  allowUnsigned?: boolean;
};

export type ReplayResult = { scorecard: Scorecard; dir: string };

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function readScenario(loaded: LoadedSpec, fixture: string): Scenario {
  const file = fixturePath(loaded, fixture, "scenario.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Scenario;
}

function loadOutputs(
  loaded: LoadedSpec,
  scratch: string,
  events: EvidenceEvent[],
): { outputs: Record<string, unknown>; problems: string[] } {
  const end = events.findLast((e) => e.type === "job.end");
  const declared = (end?.data.outputs ?? {}) as Record<
    string,
    { path: string; sha256: string | null }
  >;
  const outputs: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const o of loaded.spec.outputs) {
    const d = declared[o.name];
    if (!d || !d.sha256) {
      outputs[o.name] = null;
      problems.push(`output ${o.name} was not declared or not produced`);
      continue;
    }
    const buf = fs.readFileSync(path.resolve(scratch, d.path));
    if (sha256Hex(buf) !== d.sha256) {
      outputs[o.name] = null;
      problems.push(`output ${o.name} changed after the job declared it`);
      continue;
    }
    try {
      outputs[o.name] = JSON.parse(buf.toString("utf8")) as unknown;
    } catch {
      outputs[o.name] = buf.toString("utf8");
    }
  }
  return { outputs, problems };
}

export function runReplay(opts: ReplayOptions): ReplayResult {
  const env = opts.env ?? process.env;
  const clockNow = opts.now ?? (() => new Date());
  const loaded = loadSpec(opts.specDir);
  const lint = lintSpec(loaded).filter((f) => f.level === "error");
  if (lint.length > 0) {
    throw new SpecError(
      "spec does not pass lint",
      lint.map((f) => `${f.check ?? "spec"}: ${f.message}`),
    );
  }
  const digestIssues = verifyFixtureDigests(loaded);
  if (digestIssues.length > 0) {
    throw new SpecError(
      "fixture files do not match the spec",
      digestIssues.map(
        (d) =>
          `${d.fixture}/${d.file}: expected ${d.expected.slice(0, 12)}, got ${d.actual?.slice(0, 12) ?? "missing"}`,
      ),
    );
  }
  const attestation = verifySpecSignature(loaded, env);
  const provenance: string[] = [];
  if (attestation.state !== "signed") {
    if (opts.allowUnsigned === false) {
      throw new SpecError(
        `spec signature: ${attestation.state}${attestation.reason ? ` (${attestation.reason})` : ""}`,
      );
    }
    provenance.push(
      `spec: ${attestation.state}${attestation.reason ? ` (${attestation.reason})` : ""}`,
    );
  }
  const driverName = loaded.spec.driver ?? loaded.spec.jobKind;
  const driver = DRIVERS[driverName];
  if (!driver) {
    throw new SpecError(`no driver "${driverName}" for workflow ${loaded.spec.workflow}`);
  }
  const key = opts.key ?? resolveEvidenceSigningKey(env);
  const runId = opts.runId ?? newRunId(clockNow());
  const runRoot = path.join(resolveStateDir(env), "eval", "runs", loaded.spec.workflow, runId);
  const sinkTools = loaded.spec.consequential.map((c) => c.tool);
  const repeat = Math.max(1, Math.floor(opts.repeat ?? loaded.spec.reliability?.repeat ?? 1));
  const fixtureIds = opts.fixtures?.length
    ? opts.fixtures
    : loaded.spec.inputs.fixtures.map((f) => f.id);

  // Replay runs a scripted driver; a model-driven driver must report its own provider/model here.
  const subject = { provider: "simulated", model: driverName };
  const judges = loaded.spec.checks
    .filter((c) => c.judge === "model")
    .map((c) => ({
      checkId: c.id,
      model: c.model ?? null,
      rubricSha256: c.rubric ? sha256Hex(Buffer.from(c.rubric, "utf8")) : null,
      ran: false, // model judges are not run in this release (checks.ts: rubric -> skipped)
    }));

  const fixtures: FixtureScore[] = [];
  for (const fixtureId of fixtureIds) {
    if (!loaded.spec.inputs.fixtures.some((f) => f.id === fixtureId)) {
      throw new SpecError(`unknown fixture ${fixtureId}`);
    }
    const scenario = readScenario(loaded, fixtureId);
    for (let attempt = 1; attempt <= repeat; attempt++) {
      // One attempt = one job with its own evidence; with k = 1 the layout has no attempt level.
      const base =
        repeat === 1
          ? path.join(runRoot, fixtureId)
          : path.join(runRoot, fixtureId, `attempt-${attempt}`);
      const suffix = repeat === 1 ? "" : `-a${attempt}`;
      const evalHome = path.join(base, "state");
      const evalEnv = { ...env, KOLO_HOME: evalHome, KOLO_STATE_DIR: evalHome };
      const scratch = path.join(base, "workspace");
      const jobId = `eval-${runId}-${fixtureId}${suffix}`.slice(0, 128);
      const sessionKey = `eval:${loaded.spec.workflow}:${runId}:${fixtureId}${suffix}`;
      let tools: SimulatedTools | null = null;
      const recorder = new EvidenceRecorder(
        {
          id: jobId,
          agent: loaded.spec.agent,
          sessionKey,
          kind: loaded.spec.jobKind,
          startedAt: scenario.clock,
        },
        {
          env: evalEnv,
          key,
          limits: {
            ...resolveEvidenceLimits(),
            maxEventBytes: 1_048_576,
            maxBytesPerJob: 64 * 1_048_576,
          },
          now: () => tools?.now() ?? new Date(scenario.clock),
          startDigests: { policyDigest: null, inventoryDigest: null },
        },
      );
      tools = new SimulatedTools({
        recorder,
        sessionKey,
        fixtureDir: path.join(loaded.dir, "fixtures", fixtureId),
        scratchDir: scratch,
        scenario,
        sinkTools,
      });
      recorder.start({
        prompt: `${loaded.spec.workflow} on fixture ${fixtureId}`,
        provider: subject.provider,
        model: subject.model,
        workspaceDir: scratch,
      });
      const result = driver({
        tools,
        fixtureId,
        faults: opts.faultsFor?.(fixtureId, attempt) ?? opts.faults?.[fixtureId],
      });
      for (const o of result.outputs) {
        recorder.declareOutput(o.name, o.path, scratch);
      }
      const manifest = recorder.finish({
        status: "succeeded",
        steps: 1,
        toolCalls: tools.sink.length,
        endedAt: tools.now().toISOString(),
        summary: result.summary,
      });
      const events = readEventsFile(path.join(recorder.dir, EVENTS_FILE));
      const chainOk = verifyEventChain(events).ok;
      const { outputs, problems } = loadOutputs(loaded, scratch, events);
      const checks: CheckResult[] = loaded.spec.checks.map((c) =>
        runCheck(c, { loaded, fixtureId, events, outputs }),
      );
      const scored = scoreChecks(checks, loaded.spec.scoring.passThreshold);
      const end = events.findLast((e) => e.type === "job.end");
      const cost: Record<string, number> =
        (end?.data.cost as { totals?: Record<string, number> } | undefined)?.totals ?? {};
      for (const p of problems) {
        provenance.push(`${fixtureId}: ${p}`);
      }
      if (!chainOk) {
        provenance.push(`${fixtureId}: evidence chain does not verify`);
      }
      let manifestSha: string | null = null;
      try {
        manifestSha = sha256Hex(fs.readFileSync(path.join(recorder.dir, MANIFEST_FILE)));
      } catch {
        manifestSha = null;
      }
      fixtures.push({
        fixture: fixtureId,
        attempt,
        jobId,
        evidence: {
          manifestSha256: manifestSha,
          signed: Boolean(manifest),
          root: manifest?.events.root ?? null,
        },
        checks,
        ...scored,
        passed: scored.passed && chainOk && problems.length === 0,
        cost,
        unmatchedToolCalls: tools.unmatched.length,
      });
    }
  }

  const accepted = fixtures.filter((f) => f.passed).length;
  const reliability = reliabilityOf(fixtures, repeat, loaded.spec.reliability?.minPassAll ?? 1);
  const failureTags: Record<string, number> = {};
  for (const f of fixtures) {
    for (const c of f.checks) {
      for (const tag of c.failureTags ?? []) {
        failureTags[tag] = (failureTags[tag] ?? 0) + 1;
      }
    }
  }
  const costTotals: Record<string, number> = {};
  for (const f of fixtures) {
    for (const [cur, amount] of Object.entries(f.cost)) {
      costTotals[cur] = (costTotals[cur] ?? 0) + amount;
    }
  }
  const sumOf = (type: CheckResult["type"] | Array<CheckResult["type"]>) =>
    fixtures.reduce(
      (a, f) =>
        a +
        f.checks
          .filter((c) => ([] as string[]).concat(type).includes(c.type))
          .reduce((b, c) => b + (typeof c.value === "number" ? c.value : 0), 0),
      0,
    );
  const score =
    fixtures.length === 0
      ? 0
      : Math.round((fixtures.reduce((a, f) => a + f.score, 0) / fixtures.length) * 100) / 100;
  const gatesPassed = fixtures.every((f) => f.gates.passed);
  const scorecard: Scorecard = {
    kind: SCORECARD_KIND,
    version: SCORECARD_VERSION,
    runId,
    workflow: loaded.spec.workflow,
    mode: "replay",
    createdAt: clockNow().toISOString(),
    runtime: { name: "Kurahi", version: VERSION },
    spec: {
      version: loaded.spec.version,
      sha256: loaded.sha256,
      signature: attestation.state,
      signedBy: attestation.keyId ?? null,
    },
    driver: driverName,
    models: { subject, judges },
    fixtures,
    summary: {
      // Gates must hold in every attempt; pass^k must reach minPassAll (default: every fixture).
      passed:
        fixtures.length > 0 &&
        reliability.meetsThreshold &&
        provenance.every((p) => p.startsWith("spec:")),
      gatesPassed,
      score,
      passThreshold: loaded.spec.scoring.passThreshold,
      fixtures: reliability.fixtures.length,
      attempts: fixtures.length,
      accepted,
    },
    metrics: {
      acceptedTaskRate: fixtures.length === 0 ? 0 : accepted / fixtures.length,
      // null when nothing was accepted or no priced model ran (the reference driver is scripted).
      costPerAcceptedResult:
        accepted === 0 || Object.keys(costTotals).length === 0
          ? null
          : Object.fromEntries(Object.entries(costTotals).map(([k, v]) => [k, v / accepted])),
      reviewerMinutesPerItem: null,
      duplicateActions: sumOf("noDuplicateActions"),
      unauthorisedActions: sumOf(["noDeniedOrUnlisted", "approvalBeforeAction"]),
      recoverySuccess: null,
    },
    reliability,
    failureTags,
    provenance,
    ...(loaded.spec.humanReview?.targets
      ? { reviewTargets: { ...loaded.spec.humanReview.targets } }
      : {}),
  };
  const dir = writeSignedScorecard(
    scorecard,
    resolveScorecardDir(loaded.spec.workflow, runId, env),
    key,
  );
  return { scorecard, dir };
}
