// modernise_verify / `kurahi legacy verify` (KIMS-014/015): freeze baseline and candidate folders
// as immutable snapshots, run the runner contract over the fixtures, and seal the report and the
// captured outputs as signed evidence — for every outcome, including failures, timeouts,
// cancellations and runs that could not start. Reads the source folders; writes only under the
// data folder (snapshots/, runs/<runId>/).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OutputClass, SourceLanguage, VerificationReport, VerifyPolicy } from "./types.js";
import { canonicalJson, sha256Hex } from "../continuity-suite/manifest.js";
import { type LoadedChangeSpec, loadChangeSpec } from "./change-spec.js";
import { EVIDENCE_LIMITATIONS, writeVerificationEvidence } from "./evidence.js";
import { runVerification } from "./runner.js";
import { describeIsolation } from "./sandbox.js";
import { freezeSnapshot } from "./snapshot.js";
import { detectLanguage, resolveCompiler, toolchainIdentity } from "./toolchain.js";

export const DEFAULT_POLICY: VerifyPolicy = {
  limits: { timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024, cpuSeconds: 30 },
  dialect: null,
  flags: [],
  entry: null,
  baselineRuns: 2,
};

export function policySha256(policy: VerifyPolicy): string {
  return sha256Hex(canonicalJson(policy));
}

export function newRunId(now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `vr-${ts}-${crypto.randomBytes(4).toString("hex")}`;
}

export function runsDir(dataDir: string): string {
  return path.join(dataDir, "runs");
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "output") {
        walk(path.join(d, e.name), `${prefix}${e.name}/`);
      } else if (e.isFile()) {
        out.push(`${prefix}${e.name}`);
      }
    }
  };
  walk(root, "");
  return out;
}

export type VerifyParams = {
  dataDir: string;
  baselineDir: string;
  candidateDir: string;
  fixturesDir: string | null;
  changeSpecFile?: string | null;
  policy?: Partial<VerifyPolicy>;
  compilers?: Partial<Record<SourceLanguage, string>>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** false: do not use the network namespace even when available (tests of the fallback). */
  allowNetns?: boolean;
};

export type VerifyOutcome = { report: VerificationReport; bundleDir: string };

export async function verifyChange(params: VerifyParams): Promise<VerifyOutcome> {
  const now = params.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const policy: VerifyPolicy = {
    ...DEFAULT_POLICY,
    ...params.policy,
    limits: { ...DEFAULT_POLICY.limits, ...params.policy?.limits },
    flags: [...(params.policy?.flags ?? DEFAULT_POLICY.flags)],
  };
  const changeSpec: LoadedChangeSpec | null = params.changeSpecFile
    ? loadChangeSpec(params.changeSpecFile)
    : null;
  // The toolchain is part of each snapshot's identity: same source + other compiler = new id.
  const freeze = (dir: string) => {
    const lang = detectLanguage(listFiles(dir));
    const compiler =
      lang === "unknown" ? null : resolveCompiler(lang, { override: params.compilers?.[lang] });
    return freezeSnapshot({
      root: dir,
      dataDir: params.dataDir,
      toolchain: toolchainIdentity(lang, compiler, policy),
      now,
    });
  };
  const baseline = freeze(params.baselineDir);
  const candidate = freeze(params.candidateDir);
  const isolation = describeIsolation({ allowNetns: params.allowNetns });
  const run = await runVerification({
    dataDir: params.dataDir,
    baseline,
    candidate,
    fixturesDir: params.fixturesDir,
    changeSpec,
    policy,
    isolation,
    signal: params.signal,
    compilers: params.compilers,
  });
  const counts: Record<OutputClass, number> = {
    EQUIVALENT: 0,
    INTENDED_CHANGE: 0,
    REGRESSION: 0,
    INCONCLUSIVE: 0,
  };
  for (const o of run.outputs) {
    counts[o.class]++;
  }
  const limitations = [...EVIDENCE_LIMITATIONS, `Isolation: ${isolation.level}.`];
  if (run.verdict === "NOT_RUN_COMPILER_UNAVAILABLE") {
    limitations.push(
      "No compiler for this language is available: only the snapshots were recorded; no behaviour was verified.",
    );
  }
  const runId = newRunId(now());
  const report: VerificationReport = {
    schema: "kurahi.verification-report/1",
    runId,
    verdict: run.verdict,
    reason: run.reason,
    language: run.language,
    startedAt,
    endedAt: now().toISOString(),
    baseline: { snapshot: baseline.id, toolchain: baseline.toolchain },
    candidate: { snapshot: candidate.id, toolchain: candidate.toolchain },
    fixtures: run.fixtures,
    changeSpec: changeSpec ? { id: changeSpec.spec.id, sha256: changeSpec.sha256 } : null,
    policy,
    policySha256: policySha256(policy),
    isolation,
    builds: run.builds,
    executions: run.executions,
    outputs: run.outputs,
    findings: run.findings,
    counts,
    limitations,
  };
  const bundleDir = path.join(runsDir(params.dataDir), runId);
  writeVerificationEvidence(
    bundleDir,
    report,
    {
      captured: run.captured,
      baselineManifest: baseline,
      candidateManifest: candidate,
      changeSpecRaw: changeSpec?.raw ?? null,
    },
    { env: params.env },
  );
  return { report, bundleDir };
}

/** Verdict line plus the first findings, for tools and the CLI. */
export function summarizeReport(r: VerificationReport, bundleDir: string): string[] {
  const lines = [
    `verdict      ${r.verdict}`,
    `reason       ${r.reason}`,
    `run          ${r.runId}`,
    `language     ${r.language} (${r.candidate.toolchain.version ?? "no compiler"})`,
    `baseline     ${r.baseline.snapshot.slice(0, 21)}`,
    `candidate    ${r.candidate.snapshot.slice(0, 21)}`,
    `fixtures     ${r.fixtures.cases.length} (${r.fixtures.cases.join(", ") || "none"})`,
    `change spec  ${r.changeSpec ? r.changeSpec.id : "none"}`,
    `outputs      ${Object.entries(r.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `isolation    ${r.isolation.level}`,
    `evidence     ${bundleDir}`,
  ];
  const rank = { REGRESSION: 0, INCONCLUSIVE: 1, INTENDED_CHANGE: 2, EQUIVALENT: 3 } as const;
  const shown = r.findings
    .filter((x) => x.class !== "EQUIVALENT")
    .toSorted((a, b) => rank[a.class] - rank[b.class])
    .slice(0, 10);
  for (const f of shown) {
    lines.push(
      `  ${f.class} ${f.fixture}/${f.output}${f.record ? ` #${f.record}` : ""}${f.field ? ` ${f.field}` : ""}: ${f.detail}${f.baseline !== undefined ? ` [${f.baseline} -> ${f.candidate}]` : ""}`,
    );
  }
  return lines;
}
