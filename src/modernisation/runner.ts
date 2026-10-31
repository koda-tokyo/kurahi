// The local runner contract (KIMS-014): prepare → execute_baseline → execute_candidate →
// compare → report. Baseline and candidate are built from their frozen snapshots (never the live
// folders) in a scratch folder, run against the same fixtures under the same limits, and their
// outputs compared with the change spec's comparators. The verdict is computed here, from what
// ran; nothing is PASS unless both sides built, every fixture ran to completion and every
// difference is covered by an approved intended change. Signing is done by verify.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComparatorSpec, LoadedChangeSpec } from "./change-spec.js";
import type {
  BuildRecord,
  DiffFinding,
  ExecutionRecord,
  Isolation,
  OutputClass,
  SourceLanguage,
  SourceSnapshot,
  Verdict,
  VerifyPolicy,
} from "./types.js";
import { sha256Hex } from "../continuity-suite/manifest.js";
import { compareOutput } from "./compare.js";
import { type FixtureCase, loadFixtures } from "./fixtures.js";
import { RUN_ENV, runConfined } from "./sandbox.js";
import { materializeSnapshot, readSnapshotFile, verifySnapshot } from "./snapshot.js";
import {
  buildCommand,
  detectEntry,
  detectLanguage,
  programFiles,
  type ResolvedCompiler,
  resolveCompiler,
} from "./toolchain.js";

export type Side = "baseline" | "candidate";
export type Outputs = Map<string, Buffer>;
export type CapturedOutput = { side: Side; fixture: string; name: string; data: Buffer };

export type RunnerInput = {
  dataDir: string;
  baseline: SourceSnapshot;
  candidate: SourceSnapshot;
  fixturesDir: string | null;
  changeSpec: LoadedChangeSpec | null;
  policy: VerifyPolicy;
  isolation: Isolation;
  signal?: AbortSignal;
  /** Compiler binary per language (tests, or a site-specific install). */
  compilers?: Partial<Record<SourceLanguage, string>>;
  keepWork?: boolean;
};

export type RunnerResult = {
  verdict: Verdict;
  reason: string;
  language: SourceLanguage | "unknown";
  fixtures: { digest: string; cases: string[] };
  builds: BuildRecord[];
  executions: ExecutionRecord[];
  outputs: Array<{ fixture: string; output: string; class: OutputClass }>;
  findings: DiffFinding[];
  captured: CapturedOutput[];
  workDir: string | null;
};

const RESERVED = new Set(["stdout", "stderr", "exit"]);

function collectFiles(dir: string, inputs: Map<string, Buffer>, exclude: string): Outputs {
  const out: Outputs = new Map();
  const walk = (d: string, prefix: string) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile() && abs !== exclude) {
        const data = fs.readFileSync(abs);
        const input = inputs.get(rel);
        if (!input || !input.equals(data)) {
          out.set(RESERVED.has(rel) ? `file:${rel}` : rel, data);
        }
      }
    }
  };
  walk(dir, "");
  return out;
}

/** The verification run. Never throws for a run-time problem: it becomes the verdict. */
export async function runVerification(input: RunnerInput): Promise<RunnerResult> {
  const res: RunnerResult = {
    verdict: "INCONCLUSIVE",
    reason: "",
    language: "unknown",
    fixtures: { digest: "", cases: [] },
    builds: [],
    executions: [],
    outputs: [],
    findings: [],
    captured: [],
    workDir: null,
  };
  const done = (verdict: Verdict, reason: string) => {
    res.verdict = verdict;
    res.reason = reason;
    return res;
  };

  // ── prepare ──────────────────────────────────────────────────────────────────────────────
  for (const snap of [input.baseline, input.candidate]) {
    const problems = verifySnapshot(input.dataDir, snap.id);
    if (problems.length > 0) {
      return done("INCONCLUSIVE", `snapshot ${snap.id} failed its integrity check: ${problems[0]}`);
    }
  }
  const fx = loadFixtures(input.fixturesDir);
  res.fixtures = { digest: fx.digest, cases: fx.cases.map((c) => c.name) };
  const langB = detectLanguage(input.baseline.files.map((f) => f.path));
  const langC = detectLanguage(input.candidate.files.map((f) => f.path));
  if (langB === "unknown" || langB !== langC) {
    return done(
      "INCONCLUSIVE",
      `language not determined or different on each side (${langB} / ${langC})`,
    );
  }
  const lang = langB;
  res.language = lang;
  const compiler = resolveCompiler(lang, { override: input.compilers?.[lang] });
  if (!compiler) {
    return done(
      "NOT_RUN_COMPILER_UNAVAILABLE",
      `no ${lang === "pli" ? "PL/I" : lang.toUpperCase()} compiler is available on this host; nothing was compiled or executed`,
    );
  }
  if (fx.cases.length === 0) {
    return done(
      "NOT_RUN_NO_FIXTURES",
      "no fixture cases: there is nothing to execute, so no behaviour was compared",
    );
  }
  if (input.signal?.aborted) {
    return done("CANCELLED", "cancelled before execution");
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-verify-"));
  res.workDir = work;
  try {
    // ── execute_baseline / execute_candidate ───────────────────────────────────────────────
    const runs: Record<Side, Outputs[][]> = { baseline: [], candidate: [] };
    for (const side of ["baseline", "candidate"] as const) {
      const snap = side === "baseline" ? input.baseline : input.candidate;
      const exe = await buildSide(input, res, work, side, snap, lang, compiler);
      if (!exe) {
        const b = res.builds[res.builds.length - 1];
        if (b?.status === "cancelled") {
          return done("CANCELLED", `cancelled while building the ${side}`);
        }
        if (b?.status === "timeout") {
          return done("TIMEOUT", `building the ${side} timed out`);
        }
        return side === "baseline"
          ? done(
              "INCONCLUSIVE",
              "the baseline does not build with this toolchain; there is no reference behaviour",
            )
          : done("FAIL", "the candidate does not build");
      }
      const attempts = side === "baseline" ? Math.max(1, input.policy.baselineRuns) : 1;
      for (const c of fx.cases) {
        const perCase: Outputs[] = [];
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const out = await executeCase(input, res, work, side, exe, c, attempt);
          const last = res.executions[res.executions.length - 1];
          if (last.status === "cancelled") {
            return done("CANCELLED", `cancelled while running ${side} fixture ${c.name}`);
          }
          if (last.status === "timeout") {
            return done(
              "TIMEOUT",
              `${side} fixture ${c.name} exceeded ${input.policy.limits.timeoutMs} ms`,
            );
          }
          if (last.status !== "ok") {
            return done("INCONCLUSIVE", `${side} fixture ${c.name}: ${last.status}`);
          }
          perCase.push(out);
        }
        runs[side].push(perCase);
        for (const [name, data] of perCase[0]) {
          res.captured.push({ side, fixture: c.name, name, data });
        }
      }
    }
    // ── compare ────────────────────────────────────────────────────────────────────────────
    return compareRuns(input, res, fx.cases, runs);
  } finally {
    if (!input.keepWork) {
      fs.rmSync(work, { recursive: true, force: true });
      res.workDir = null;
    }
  }
}

async function buildSide(
  input: RunnerInput,
  res: RunnerResult,
  work: string,
  side: Side,
  snap: SourceSnapshot,
  lang: SourceLanguage,
  compiler: ResolvedCompiler,
): Promise<string | null> {
  const src = path.join(work, side, "src");
  const bin = path.join(work, side, "bin");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(work, side, "tmp"), { recursive: true });
  materializeSnapshot(input.dataDir, snap, src);
  const exe = path.join(bin, "program");
  const paths = snap.files.map((f) => f.path);
  let argv: string[];
  try {
    const texts = programFiles(lang, paths).map((p) => ({
      path: p,
      text: readSnapshotFile(input.dataDir, snap, p).toString("latin1"),
    }));
    const entry = detectEntry(lang, texts, input.policy.entry);
    argv = buildCommand({
      lang,
      compiler: compiler.path,
      srcDir: src,
      paths,
      entry,
      exe,
      dialect: input.policy.dialect,
      flags: input.policy.flags,
    });
  } catch (err) {
    res.builds.push({
      side,
      status: "failed",
      command: [],
      ms: 0,
      executableSha256: null,
      diagnostics: String(err instanceof Error ? err.message : err),
    });
    return null;
  }
  const r = await runConfined({
    argv,
    cwd: src,
    env: {
      ...RUN_ENV,
      PATH: `${path.dirname(compiler.path)}:/usr/bin:/bin`,
      HOME: path.join(work, side),
      TMPDIR: path.join(work, side, "tmp"),
    },
    timeoutMs: input.policy.limits.timeoutMs,
    maxOutputBytes: input.policy.limits.maxOutputBytes,
    signal: input.signal,
  });
  const ok = r.status === "ok" && r.exitCode === 0 && fs.existsSync(exe);
  res.builds.push({
    side,
    status:
      r.status === "timeout"
        ? "timeout"
        : r.status === "cancelled"
          ? "cancelled"
          : ok
            ? "ok"
            : "failed",
    command: argv.map((a) => (a.startsWith(work) ? `$WORK${a.slice(work.length)}` : a)),
    ms: r.ms,
    executableSha256: ok ? sha256Hex(fs.readFileSync(exe)) : null,
    diagnostics: Buffer.concat([r.stdout, r.stderr])
      .toString("utf8")
      .slice(0, 4000)
      .split(work)
      .join("$WORK"),
  });
  return ok ? exe : null;
}

async function executeCase(
  input: RunnerInput,
  res: RunnerResult,
  work: string,
  side: Side,
  exe: string,
  c: FixtureCase,
  attempt: number,
): Promise<Outputs> {
  const cwd = path.join(work, side, "run", `${c.name}-${attempt}`);
  fs.mkdirSync(cwd, { recursive: true });
  for (const [name, data] of c.files) {
    fs.writeFileSync(path.join(cwd, name), data);
  }
  const lim = input.policy.limits;
  const r = await runConfined({
    argv: [exe, ...c.args],
    cwd,
    env: { ...RUN_ENV },
    stdin: c.stdin ?? undefined,
    timeoutMs: lim.timeoutMs,
    maxOutputBytes: lim.maxOutputBytes,
    signal: input.signal,
    confine: { cpuSeconds: lim.cpuSeconds, isolation: input.isolation },
  });
  const outputs: Outputs = new Map();
  outputs.set(
    "exit",
    Buffer.from(r.exitCode !== null ? `${r.exitCode}\n` : `signal ${r.signal}\n`),
  );
  outputs.set("stdout", r.stdout);
  outputs.set("stderr", r.stderr);
  let status = r.status;
  for (const [name, data] of collectFiles(cwd, c.files, exe)) {
    if (data.length >= lim.maxOutputBytes && status === "ok") {
      status = "output-capped";
    }
    outputs.set(name, data);
  }
  if (status === "ok" && r.signal === "SIGXFSZ") {
    status = "output-capped";
  }
  res.executions.push({
    side,
    fixture: c.name,
    attempt,
    status,
    exitCode: r.exitCode,
    signal: r.signal,
    ms: r.ms,
    stdoutSha256: sha256Hex(r.stdout),
    stderrSha256: sha256Hex(r.stderr),
    outputs: Object.fromEntries(
      [...outputs].map(([k, v]) => [k, { sha256: sha256Hex(v), size: v.length }]),
    ),
  });
  return outputs;
}

function compareRuns(
  input: RunnerInput,
  res: RunnerResult,
  cases: FixtureCase[],
  runs: Record<Side, Outputs[][]>,
): RunnerResult {
  const spec = input.changeSpec?.spec;
  const intended = spec?.intended ?? [];
  const comparatorFor = (name: string): ComparatorSpec =>
    spec?.comparators?.[name] ?? { mode: "exact" };
  const baselineProblems: string[] = [];
  const used = new Set<number>();
  cases.forEach((c, i) => {
    const base = runs.baseline[i];
    const cand = runs.candidate[i][0];
    // The baseline must reproduce itself and its golden outputs, or nothing can be concluded.
    for (let k = 1; k < base.length; k++) {
      for (const name of new Set([...base[0].keys(), ...base[k].keys()])) {
        const a = base[0].get(name);
        const b = base[k].get(name);
        if (!a || !b || !a.equals(b)) {
          baselineProblems.push(`${c.name}/${name}`);
          res.findings.push({
            fixture: c.name,
            output: name,
            class: "INCONCLUSIVE",
            detail: `baseline is not reproducible (run 1 vs run ${k + 1})`,
          });
        }
      }
    }
    for (const [name, golden] of c.golden) {
      const got = base[0].get(name);
      if (!got || !got.equals(golden)) {
        baselineProblems.push(`${c.name}/${name}`);
        res.findings.push({
          fixture: c.name,
          output: name,
          class: "INCONCLUSIVE",
          detail: "baseline does not reproduce the golden output",
        });
      }
    }
    for (const name of [...new Set([...base[0].keys(), ...cand.keys()])].toSorted()) {
      const cmp = compareOutput({
        fixture: c.name,
        output: name,
        baseline: base[0].get(name),
        candidate: cand.get(name),
        comparator: comparatorFor(name),
        intended,
      });
      cmp.usedIntended.forEach((u) => used.add(u));
      let cls = cmp.class;
      res.findings.push(...cmp.findings);
      // An intended change with an approved expectation must produce exactly that output.
      intended.forEach((it, idx) => {
        const exp = input.changeSpec?.expected.get(`${idx}|${c.name}`);
        if (it.output === name && exp) {
          used.add(idx);
          if (!cand.get(name)?.equals(exp)) {
            cls = "REGRESSION";
            res.findings.push({
              fixture: c.name,
              output: name,
              class: "REGRESSION",
              detail: `candidate output does not match the approved expectation of ${spec?.id}`,
            });
          }
        }
      });
      res.outputs.push({ fixture: c.name, output: name, class: cls });
    }
  });
  intended.forEach((it, idx) => {
    if (!used.has(idx)) {
      res.findings.push({
        fixture: "*",
        output: it.output,
        class: "INCONCLUSIVE",
        detail: "declared intended change was not exercised by any fixture",
      });
    }
  });
  const regressions = res.outputs.filter((o) => o.class === "REGRESSION").length;
  const unexercised = res.findings.filter((f) => f.fixture === "*").length;
  if (baselineProblems.length > 0) {
    return Object.assign(res, {
      verdict: "INCONCLUSIVE" as const,
      reason: `the baseline is not a stable reference: ${baselineProblems.slice(0, 5).join(", ")}`,
    });
  }
  if (regressions > 0) {
    return Object.assign(res, {
      verdict: "FAIL" as const,
      reason: `${regressions} output(s) regressed`,
    });
  }
  if (unexercised > 0) {
    return Object.assign(res, {
      verdict: "INCONCLUSIVE" as const,
      reason: `${unexercised} declared intended change(s) not exercised by the fixtures`,
    });
  }
  const changed = res.outputs.filter((o) => o.class === "INTENDED_CHANGE").length;
  return Object.assign(res, {
    verdict: "PASS" as const,
    reason:
      changed > 0
        ? `all differences are approved intended changes (${changed} output(s)); the rest are equivalent`
        : "all outputs equivalent on every fixture",
  });
}
