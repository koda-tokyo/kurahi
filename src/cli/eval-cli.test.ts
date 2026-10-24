import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { copyExample, EXAMPLE_DIR, tempHome } from "../test-helpers/eval.js";
import {
  EVAL_EXIT,
  registerEvalCli,
  resolveWorkflowDir,
  runEvalGate,
  runEvalReport,
  runEvalReview,
  runEvalRun,
  runEvalSpec,
} from "./eval-cli.js";

let t: ReturnType<typeof tempHome>;
let out: string[];
let code: number | null;
let runtime: RuntimeEnv;
const bundledRoot = path.dirname(EXAMPLE_DIR.replace(/\/$/, ""));

beforeEach(() => {
  t = tempHome();
  out = [];
  code = null;
  runtime = {
    log: (...a: unknown[]) => void out.push(a.join(" ")),
    error: (...a: unknown[]) => void out.push(a.join(" ")),
    exit: (c: number) => {
      code = c;
      throw new Error(`exit ${c}`);
    },
  };
});
afterEach(() => t.cleanup());

const deps = () => ({ runtime, env: t.env, bundledRoot });
const attempt = async (fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    if (!String(err).startsWith("Error: exit")) {
      throw err;
    }
  }
  return code ?? 0;
};

describe("kurahi eval", () => {
  it("resolves a workflow from <KOLO_HOME>/eval/specs before the bundled examples", () => {
    expect(resolveWorkflowDir("csv-inspection.exceptions", t.env, bundledRoot)).toBe(
      path.join(bundledRoot, "csv-inspection.exceptions"),
    );
    const own = copyExample(t.home);
    expect(resolveWorkflowDir("csv-inspection.exceptions", t.env, bundledRoot)).toBe(own);
    expect(resolveWorkflowDir("nope", t.env, bundledRoot)).toBeNull();
  });

  it("spec sign → verify → run --require-signed → report --verify exits 0", async () => {
    copyExample(t.home);
    expect(await attempt(() => runEvalSpec("sign", "csv-inspection.exceptions", {}, deps()))).toBe(
      0,
    );
    expect(
      await attempt(() => runEvalSpec("verify", "csv-inspection.exceptions", {}, deps())),
    ).toBe(0);
    expect(
      await attempt(() => runEvalRun("csv-inspection.exceptions", { requireSigned: true }, deps())),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/summary: PASS · score 100\/85 · accepted 2\/2/);
    const root = path.join(t.home, "eval", "scorecards", "csv-inspection.exceptions");
    const runDir = path.join(root, fs.readdirSync(root)[0]);
    expect(await attempt(() => runEvalReport(undefined, { verify: runDir }, deps()))).toBe(0);
    expect(out.join("\n")).toMatch(/verified: signature and file hashes OK/);
    // Tamper → exit 3
    const f = path.join(runDir, "scorecard.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"accepted": 2', '"accepted": 3'));
    expect(await attempt(() => runEvalReport(undefined, { verify: runDir }, deps()))).toBe(
      EVAL_EXIT.invalid,
    );
  });

  it("exits 3 for an unsigned spec with --require-signed, and for lint errors", async () => {
    const dir = copyExample(t.home);
    expect(
      await attempt(() => runEvalRun("csv-inspection.exceptions", { requireSigned: true }, deps())),
    ).toBe(EVAL_EXIT.invalid);
    code = null;
    fs.writeFileSync(
      path.join(dir, "spec.yaml"),
      `${fs.readFileSync(path.join(dir, "spec.yaml"), "utf8")}\n`.replace(
        "  - id: no-duplicate-send\n    type: noDuplicateActions\n    severity: gate",
        "  - id: no-duplicate-send\n    type: noDuplicateActions\n    severity: gate\n    weight: 2",
      ),
    );
    expect(await attempt(() => runEvalSpec("lint", "csv-inspection.exceptions", {}, deps()))).toBe(
      EVAL_EXIT.invalid,
    );
  });

  it("exits 4 for unknown workflows and for score/gate in this release", async () => {
    expect(await attempt(() => runEvalRun("nope", {}, deps()))).toBe(EVAL_EXIT.usage);
    code = null;
    expect(await attempt(() => runEvalGate("csv-inspection.exceptions", {}, deps()))).toBe(
      EVAL_EXIT.usage,
    );
    expect(out.join("\n")).toMatch(/not available in this release/);
  });

  it("review records correction effort, re-signs, and report shows it next to pass^k", async () => {
    copyExample(t.home);
    const now = () => new Date("2026-10-20T05:00:00.000Z");
    expect(
      await attempt(() => runEvalRun("csv-inspection.exceptions", {}, { ...deps(), now })),
    ).toBe(0);
    const root = path.join(t.home, "eval", "scorecards", "csv-inspection.exceptions");
    const runId = fs.readdirSync(root)[0];
    const from = path.join(t.home, "agent.json");
    const to = path.join(t.home, "accepted.json");
    fs.writeFileSync(from, '{\n  "exceptions": [],\n  "note": "none"\n}\n');
    fs.writeFileSync(to, '{\n  "exceptions": [],\n  "note": "no exceptions on line 3"\n}\n');
    out = [];
    expect(
      await attempt(() =>
        runEvalReview(
          runId,
          {
            task: "line3-clean",
            minutesReview: "6",
            minutesFix: "4",
            accepted: "edited",
            diffFrom: from,
            diffTo: to,
            reviewer: "line supervisor",
          },
          { ...deps(), now },
        ),
      ),
    ).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(
      /recorded rv-1 on csv-inspection.exceptions · run .* · task line3-clean · accepted-after-edits · 6 min review \+ 4 min fix · diff \+1 −1 lines \(edit distance 2, 25.0% changed\)/,
    );
    expect(text).toMatch(
      /suite: 1 review\(s\) · median 10 min · p90 10 min \(median review 6 min, fix 4 min\) · accepted unchanged 0.0%/,
    );
    expect(text).toMatch(/re-signed: .* previous version kept in revisions\/r1/);
    out = [];
    expect(await attempt(() => runEvalReport("csv-inspection.exceptions", {}, deps()))).toBe(0);
    const report = out.join("\n");
    expect(report).toMatch(/reliability \(k=1\): pass\^k 100.0%/);
    expect(report).toMatch(/\n  correction effort: 1 review\(s\) · median 10 min/);
    expect(report).toMatch(
      /line3-clean[^\n]*\n(?:    [✓✗–][^\n]*\n)+    correction effort: 1 review/,
    );
    expect(report).toMatch(/verified: signature and file hashes OK/);
  });

  it("review exits 4 for usage errors and 3 for a scorecard that does not verify", async () => {
    copyExample(t.home);
    await attempt(() => runEvalRun("csv-inspection.exceptions", {}, deps()));
    const root = path.join(t.home, "eval", "scorecards", "csv-inspection.exceptions");
    const runId = fs.readdirSync(root)[0];
    const ok = { task: "line3-clean", minutesReview: "3", minutesFix: "0", accepted: "as-is" };
    code = null;
    expect(await attempt(() => runEvalReview("nope", ok, deps()))).toBe(EVAL_EXIT.usage);
    code = null;
    expect(await attempt(() => runEvalReview(runId, { ...ok, accepted: "maybe" }, deps()))).toBe(
      EVAL_EXIT.usage,
    );
    code = null;
    expect(await attempt(() => runEvalReview(runId, { ...ok, minutesReview: "-1" }, deps()))).toBe(
      EVAL_EXIT.usage,
    );
    code = null;
    expect(await attempt(() => runEvalReview(runId, { ...ok, task: "x" }, deps()))).toBe(
      EVAL_EXIT.usage,
    );
    code = null;
    const f = path.join(root, runId, "scorecard.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"accepted": 2', '"accepted": 3'));
    expect(await attempt(() => runEvalReview(path.join(root, runId), ok, deps()))).toBe(
      EVAL_EXIT.invalid,
    );
    expect(out.join("\n")).toMatch(/refusing to re-sign/);
  });

  it("keeps bundled examples read-only and copies them with spec init", async () => {
    expect(await attempt(() => runEvalSpec("sign", "csv-inspection.exceptions", {}, deps()))).toBe(
      EVAL_EXIT.usage,
    );
    expect(
      fs.existsSync(path.join(bundledRoot, "csv-inspection.exceptions", "spec.yaml.sig")),
    ).toBe(false);
    code = null;
    expect(await attempt(() => runEvalSpec("init", "csv-inspection.exceptions", {}, deps()))).toBe(
      0,
    );
    expect(
      fs.existsSync(path.join(t.home, "eval", "specs", "csv-inspection.exceptions", "spec.yaml")),
    ).toBe(true);
    expect(await attempt(() => runEvalSpec("sign", "csv-inspection.exceptions", {}, deps()))).toBe(
      0,
    );
  });

  it("registers spec init|lint|verify|sign|digests, run, report and the stubs", () => {
    const program = new Command();
    registerEvalCli(program);
    const evalCmd = program.commands.find((c) => c.name() === "eval")!;
    expect(evalCmd.commands.map((c) => c.name()).toSorted()).toEqual([
      "gate",
      "report",
      "review",
      "run",
      "score",
      "spec",
    ]);
    const spec = evalCmd.commands.find((c) => c.name() === "spec")!;
    expect(spec.commands.map((c) => c.name())).toEqual([
      "init",
      "lint",
      "verify",
      "sign",
      "digests",
    ]);
  });
});
