import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEventsFile, resolveEvidenceRoot, verifyEventChain } from "../evidence/store.js";
import { copyExample, tempHome } from "../test-helpers/eval.js";
import { runReplay } from "./run.js";
import { verifyScorecardDir } from "./scorecard.js";
import { signSpec, SpecError } from "./spec.js";

let t: ReturnType<typeof tempHome>;
let dir: string;
beforeEach(() => {
  t = tempHome();
  dir = copyExample(t.home);
});
afterEach(() => t.cleanup());

const FIX = "line3-2026-10-14";
const run = (extra: Partial<Parameters<typeof runReplay>[0]> = {}) =>
  runReplay({ specDir: dir, env: t.env, ...extra });
const fixtureOf = (r: ReturnType<typeof runReplay>, id = FIX) =>
  r.scorecard.fixtures.find((f) => f.fixture === id)!;
const status = (r: ReturnType<typeof runReplay>, check: string, id = FIX) =>
  fixtureOf(r, id).checks.find((c) => c.id === check)?.status;

describe("offline replay of workflow (iii)", () => {
  it("passes both golden fixtures end to end and writes a verifiable signed scorecard", () => {
    signSpec(dir, t.env);
    const r = run({ allowUnsigned: false });
    expect(r.scorecard.summary).toMatchObject({
      passed: true,
      gatesPassed: true,
      score: 100,
      fixtures: 2,
      accepted: 2,
    });
    expect(r.scorecard.spec.signature).toBe("signed");
    // v3: the score names what produced it (here the scripted replay driver).
    expect(r.scorecard.version).toBe(3);
    expect(r.scorecard.models?.subject).toEqual({
      provider: "simulated",
      model: r.scorecard.driver,
    });
    expect(fixtureOf(r).checks.find((c) => c.id === "exceptions-recall")?.items).toMatchObject({
      truePositives: 7,
    });
    expect(r.scorecard.metrics).toMatchObject({
      acceptedTaskRate: 1,
      duplicateActions: 0,
      unauthorisedActions: 0,
    });
    expect(verifyScorecardDir(r.dir).ok).toBe(true);
  });

  it("records signed, hash-chained evidence with the approval before the send and the declared output", () => {
    const r = run();
    const f = fixtureOf(r);
    expect(f.evidence.signed).toBe(true);
    const evDir = path.join(
      t.home,
      "eval",
      "runs",
      "csv-inspection.exceptions",
      r.scorecard.runId,
      FIX,
      "state",
      "evidence",
      f.jobId,
    );
    const events = readEventsFile(path.join(evDir, "events.jsonl"));
    expect(verifyEventChain(events).ok).toBe(true);
    const approval = events.find((e) => e.type === "approval");
    const sendCall = events.find((e) => e.type === "tool.call" && e.data.name === "message.send");
    expect(approval!.seq).toBeLessThan(sendCall!.seq);
    const end = events.at(-1)!;
    expect((end.data.outputs as Record<string, { sha256: string }>).report.sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("never writes evaluation evidence into the production evidence directory", () => {
    run();
    expect(fs.existsSync(resolveEvidenceRoot(t.env))).toBe(false);
  });

  it("does not send anything for a clean file", () => {
    const r = run({ fixtures: ["line3-clean"] });
    expect(r.scorecard.summary.passed).toBe(true);
  });

  it("fails recall (critical) when an exception is missed, even with a high weighted score", () => {
    const r = run({ fixtures: [FIX], faults: { [FIX]: { skipRows: ["L3-20261014-0777"] } } });
    const f = fixtureOf(r);
    expect(status(r, "exceptions-recall")).toBe("fail");
    expect(f.criticalFailed).toContain("exceptions-recall");
    expect(f.gates.passed).toBe(true);
    expect(r.scorecard.summary.passed).toBe(false);
  });

  it("fails precision when readings inside tolerance (on a limit) are flagged", () => {
    const r = run({
      fixtures: [FIX],
      faults: {
        [FIX]: {
          extraRows: [
            "L3-20261014-0012",
            "L3-20261014-0099",
            "L3-20261014-0640",
            "L3-20261014-1111",
          ],
        },
      },
    });
    expect(status(r, "exceptions-precision")).toBe("fail");
  });

  it("fails the approval gate when the report is sent without approval", () => {
    const r = run({ fixtures: [FIX], faults: { [FIX]: { sendWithoutApproval: true } } });
    expect(status(r, "approval-before-send")).toBe("fail");
    expect(r.scorecard.summary.gatesPassed).toBe(false);
    expect(r.scorecard.metrics.unauthorisedActions).toBe(1);
  });

  it("fails the duplicate gate when the report is sent twice", () => {
    const r = run({ fixtures: [FIX], faults: { [FIX]: { sendTwice: true } } });
    expect(status(r, "no-duplicate-send")).toBe("fail");
    expect(r.scorecard.metrics.duplicateActions).toBe(1);
  });

  it("fails citations when sources are dropped, and the deadline when delivery is late", () => {
    expect(
      status(run({ fixtures: [FIX], faults: { [FIX]: { dropSources: true } } }), "sources-cited"),
    ).toBe("fail");
    expect(
      status(
        run({ fixtures: [FIX], faults: { [FIX]: { delayMs: 40 * 60_000 } } }),
        "delivered-by-0600",
      ),
    ).toBe("fail");
  });

  it("refuses an unsigned spec when signatures are required, and changed fixtures always", () => {
    expect(() => run({ allowUnsigned: false })).toThrow(SpecError);
    fs.appendFileSync(path.join(dir, "fixtures", FIX, "expected.json"), " ");
    expect(() => run()).toThrow(/fixture files do not match/);
  });

  it("marks an unsigned spec in the scorecard provenance", () => {
    expect(run().scorecard.provenance).toContainEqual(expect.stringMatching(/^spec: unsigned/));
  });

  it("is deterministic: two runs give the same check results", () => {
    const a = run({ runId: "a" }).scorecard.fixtures.map((f) =>
      f.checks.map((c) => [c.id, c.status, c.value]),
    );
    const b = run({ runId: "b" }).scorecard.fixtures.map((f) =>
      f.checks.map((c) => [c.id, c.status, c.value]),
    );
    expect(a).toEqual(b);
  });
});

describe("reliability across repeated runs", () => {
  it("repeats each fixture k times, each attempt with its own signed evidence, and reports pass^k and pass@k", () => {
    const r = run({ repeat: 3 });
    expect(r.scorecard.fixtures).toHaveLength(6);
    expect(new Set(r.scorecard.fixtures.map((f) => f.jobId)).size).toBe(6);
    expect(r.scorecard.reliability).toMatchObject({
      k: 3,
      passAllK: 1,
      passAtK: 1,
      gatesHeldInAll: true,
      meetsThreshold: true,
      scoreVariance: 0,
    });
    expect(r.scorecard.summary.passed).toBe(true);
    expect(verifyScorecardDir(r.dir).scorecard?.reliability.k).toBe(3);
  });

  it("fails the run when a gate fails in any one attempt", () => {
    const r = run({
      repeat: 3,
      fixtures: [FIX],
      faultsFor: (_f, attempt) => (attempt === 2 ? { sendTwice: true } : undefined),
    });
    const rel = r.scorecard.reliability;
    expect(rel.gatesHeldInAll).toBe(false);
    expect(rel.fixtures[0]).toMatchObject({
      attempts: 3,
      passes: 2,
      passAtK: true,
      passAllK: false,
    });
    expect(rel.fixtures[0]?.checkPassRates["no-duplicate-send"]).toBeCloseTo(2 / 3, 3);
    expect(r.scorecard.summary.passed).toBe(false);
    // The second send is both a duplicate and unapproved: two gates fail.
    expect(r.scorecard.failureTags["policy-violation"]).toBe(2);
  });

  it("separates pass@k from pass^k and checks minPassAll from the spec", () => {
    const yaml = fs.readFileSync(path.join(dir, "spec.yaml"), "utf8");
    fs.writeFileSync(
      path.join(dir, "spec.yaml"),
      yaml.replace("scoring:", "reliability:\n  repeat: 4\n  minPassAll: 0.5\n\nscoring:"),
    );
    // The line 3 fixture misses an exception in attempt 4 only; the clean fixture always passes.
    const r = run({
      faultsFor: (f, a) => (f === FIX && a === 4 ? { skipRows: ["L3-20261014-0214"] } : undefined),
    });
    const rel = r.scorecard.reliability;
    expect(rel.k).toBe(4);
    expect(rel.passAtK).toBe(1);
    expect(rel.passAllK).toBe(0.5);
    expect(rel.scoreVariance).toBeGreaterThan(0);
    expect(rel.meetsThreshold).toBe(true);
    expect(r.scorecard.summary.passed).toBe(true);
    expect(r.scorecard.failureTags["wrong-context"]).toBeGreaterThan(0);
  });
});
