import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import {
  allowedTransitions,
  attachTestRun,
  type ChangeCase,
  createCase,
  decideApproval,
  handoffCase,
  loadCase,
  requestApproval,
  reviseCase,
  transitionCase,
} from "./case.js";
import { freezeSnapshot } from "./snapshot.js";
import { makeFakeCobc, writeProgram } from "./test-helpers.js";
import { verifyChange, type VerifyOutcome } from "./verify.js";

const isLinux = process.platform === "linux";
let tmp: string;
let data: string;
let env: NodeJS.ProcessEnv;
let cobc: string;
let clock: Date;
const ctx = () => ({ dataDir: data, env, now: () => clock });

async function verify(): Promise<VerifyOutcome> {
  return verifyChange({
    dataDir: data,
    baselineDir: path.join(tmp, "base"),
    candidateDir: path.join(tmp, "cand"),
    fixturesDir: path.join(tmp, "fixtures"),
    compilers: { cobol: cobc },
    policy: { baselineRuns: 1 },
    env,
    now: () => clock,
  });
}

function newCandidate(): string {
  const dir = path.join(tmp, "cand2");
  writeProgram(dir, "echo 3");
  const tc = {
    language: "cobol" as const,
    compiler: null,
    version: null,
    binarySha256: null,
    dialect: null,
    flags: [],
  };
  return freezeSnapshot({ root: dir, dataDir: data, toolchain: tc }).id;
}

/** A case at TEST_REVIEW with a run attached. */
async function caseUnderReview(): Promise<{ c: ChangeCase; run: VerifyOutcome }> {
  const run = await verify();
  let c = createCase(ctx(), {
    title: "synthetic change",
    createdBy: "owner",
    baseline: run.report.baseline.snapshot,
    candidate: run.report.candidate.snapshot,
    candidateDir: path.join(tmp, "cand"),
    policySha256: run.report.policySha256,
    changeSpec: run.report.changeSpec,
  });
  for (const to of [
    "ANALYSING",
    "ANALYSIS_REVIEW",
    "CHANGE_PROPOSED",
    "CHANGE_REVIEW",
    "TEST_QUEUED",
  ] as const) {
    c = transitionCase(ctx(), c.id, to, "owner");
  }
  c = attachTestRun(ctx(), c.id, "tester", run);
  return { c, run };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-case-"));
  data = path.join(tmp, "data");
  env = { ...process.env, KOLO_HOME: path.join(tmp, "home") };
  cobc = makeFakeCobc(path.join(tmp, "bin"));
  clock = new Date("2026-11-02T00:00:00Z");
  writeProgram(path.join(tmp, "base"), "echo 1");
  writeProgram(path.join(tmp, "cand"), "# refactor\necho 1");
  fs.mkdirSync(path.join(tmp, "fixtures", "one"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("change-case state machine (AC-017)", () => {
  it("follows the spec's transitions and nothing else", () => {
    expect(allowedTransitions("DRAFT")).toEqual([
      "SNAPSHOT_FROZEN",
      "BLOCKED",
      "FAILED",
      "CANCELLED",
      "RECONCILIATION_REQUIRED",
    ]);
    expect(allowedTransitions("TEST_REVIEW")).toContain("REJECTED");
    expect(allowedTransitions("APPROVED_FOR_HANDOFF")).toContain("EXPORTED");
    expect(allowedTransitions("EXPORTED")).toEqual([]);
    expect(allowedTransitions("RECONCILIATION_REQUIRED")).toEqual([
      "REVIEWED_RETRY",
      "FAILED",
      "CANCELLED",
    ]);
  });

  it.skipIf(!isLinux)(
    "rejects a disallowed transition and approval of a non-PASS run",
    async () => {
      writeProgram(path.join(tmp, "cand"), "echo 2");
      const { c } = await caseUnderReview();
      expect(c.state).toBe("TEST_REVIEW");
      expect(c.testRuns[0].verdict).toBe("FAIL");
      expect(() => transitionCase(ctx(), c.id, "EXPORTED", "owner")).toThrow(
        /not a plain transition/,
      );
      expect(() => transitionCase(ctx(), c.id, "CHANGE_PROPOSED", "owner")).toThrow(/not allowed/);
      expect(() => requestApproval(ctx(), c.id, "owner")).toThrow(
        /valid PASS test run; latest is FAIL/,
      );
      const rejected = transitionCase(ctx(), c.id, "REJECTED", "reviewer", { note: "regression" });
      expect(rejected.state).toBe("REJECTED");
      const dir = fs.readdirSync(path.join(data, "cases", c.id, "evidence"));
      expect(dir.some((d) => d.endsWith("-rejected"))).toBe(true);
    },
  );

  it.skipIf(!isLinux)("enforces segregation of duties and a stale-revision check", async () => {
    const { c } = await caseUnderReview();
    const pending = requestApproval(ctx(), c.id, "requester");
    expect(() =>
      decideApproval(ctx(), c.id, { approver: "owner", role: "approver", decision: "approved" }),
    ).toThrow(/segregation/);
    expect(() =>
      decideApproval(ctx(), c.id, {
        approver: "requester",
        role: "approver",
        decision: "approved",
      }),
    ).toThrow(/segregation/);
    expect(() =>
      decideApproval(ctx(), c.id, { approver: "eve", role: "operator", decision: "approved" }),
    ).toThrow(/approver role/);
    expect(() =>
      decideApproval(ctx(), c.id, {
        approver: "approver1",
        role: "approver",
        decision: "approved",
        expectedRevision: pending.revision - 1,
      }),
    ).toThrow(/revision/);
  });
});

describe.skipIf(!isLinux)("approval scope and handoff (AC-018/019)", () => {
  it("approves a PASS case, hands off without deploying, and signs every decision", async () => {
    const { c } = await caseUnderReview();
    requestApproval(ctx(), c.id, "requester");
    const approved = decideApproval(ctx(), c.id, {
      approver: "approver1",
      role: "approver",
      decision: "approved",
      validForMs: 86_400_000,
    });
    expect(approved.state).toBe("APPROVED_FOR_HANDOFF");
    expect(approved.approvals[0].scopeHash).toMatch(/^[0-9a-f]{64}$/);
    const h = handoffCase(ctx(), c.id, "release");
    expect(h.deployed).toBe(false);
    expect(h.case.state).toBe("EXPORTED");
    expect(JSON.parse(fs.readFileSync(h.manifest, "utf8")).deployed).toBe(false);
    const bundles = fs.readdirSync(path.join(data, "cases", c.id, "evidence"));
    expect(bundles.map((b) => b.replace(/^\d+-/, ""))).toEqual(["approved", "handoff"]);
    for (const b of bundles) {
      expect((await verifyEvidenceBundle(path.join(data, "cases", c.id, "evidence", b))).ok).toBe(
        true,
      );
    }
  });

  it("a new candidate, change spec, policy or fixture set invalidates the approval", async () => {
    for (const change of ["candidate", "changeSpec", "policySha256", "fixturesDigest"] as const) {
      const { c } = await caseUnderReview();
      requestApproval(ctx(), c.id, "requester");
      decideApproval(ctx(), c.id, {
        approver: "approver1",
        role: "approver",
        decision: "approved",
      });
      const value =
        change === "candidate"
          ? newCandidate()
          : change === "changeSpec"
            ? { id: "CHG-2", sha256: "b".repeat(64) }
            : "c".repeat(64);
      const revised = reviseCase(ctx(), c.id, "owner", { [change]: value });
      expect(revised.state).toBe("CHANGE_PROPOSED");
      expect(revised.approvals.every((a) => !a.valid)).toBe(true);
      expect(revised.testRuns.every((r) => !r.valid)).toBe(true);
      expect(() => handoffCase(ctx(), c.id, "release")).toThrow(/APPROVED_FOR_HANDOFF/);
    }
  });

  it("refuses a stale approval at handoff: expired, or the candidate source changed", async () => {
    const first = await caseUnderReview();
    requestApproval(ctx(), first.c.id, "requester");
    decideApproval(ctx(), first.c.id, {
      approver: "approver1",
      role: "approver",
      decision: "approved",
      validForMs: 60_000,
    });
    clock = new Date(clock.getTime() + 120_000);
    expect(() => handoffCase(ctx(), first.c.id, "release")).toThrow(/expired/);
    const after = loadCase(data, first.c.id);
    expect(after.state).toBe("CHANGE_PROPOSED");
    expect(after.approvals[0].valid).toBe(false);

    clock = new Date("2026-11-03T00:00:00Z");
    const second = await caseUnderReview();
    requestApproval(ctx(), second.c.id, "requester");
    decideApproval(ctx(), second.c.id, {
      approver: "approver1",
      role: "approver",
      decision: "approved",
    });
    fs.appendFileSync(path.join(tmp, "cand", "PROG.cbl"), "echo sneaky\n");
    expect(() => handoffCase(ctx(), second.c.id, "release")).toThrow(
      /candidate source changed after approval/,
    );
    expect(loadCase(data, second.c.id).approvals[0].invalidatedReason).toMatch(/PROG.cbl changed/);
  });

  it("refuses to attach a run made for other snapshots", async () => {
    const { c, run } = await caseUnderReview();
    const other = {
      ...run,
      report: {
        ...run.report,
        candidate: { ...run.report.candidate, snapshot: `snap-${"0".repeat(64)}` },
      },
    };
    expect(() => attachTestRun(ctx(), c.id, "tester", other)).toThrow(/other snapshots/);
  });
});
