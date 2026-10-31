// End-to-end verification with the real toolchains (KIMS-017, AC-020…025, AC-028/029): the
// synthetic fixtures in test/fixtures/modernisation/ are frozen, compiled with GnuCOBOL `cobc`
// and `gfortran`, executed and compared, and every bundle is checked with the offline verifier.
// Each block is skipped, with the reason in its title, when its compiler is not installed (CI).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legacyInventory } from "../../packages/legacy-analyzer/src/index.js";
import { runEvidenceVerify } from "../cli/evidence-cli.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import {
  attachTestRun,
  createCase,
  decideApproval,
  handoffCase,
  requestApproval,
  transitionCase,
} from "./case.js";
import { verifyChange, type VerifyParams } from "./verify.js";

const FX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/modernisation",
);
const has = (bin: string) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
const HAS_COBC = has("cobc");
const HAS_GFORTRAN = has("gfortran");

let tmp: string;
let env: NodeJS.ProcessEnv;
let data: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-verify-e2e-"));
  env = { ...process.env, KOLO_HOME: path.join(tmp, "home") };
  data = path.join(tmp, "data");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (p: Partial<VerifyParams> & { baselineDir: string; candidateDir: string }) =>
  verifyChange({ dataDir: data, fixturesDir: null, env, ...p });

const cobol = (candidate: string, spec?: string) =>
  run({
    baselineDir: path.join(FX, "cobol-payroll", "baseline"),
    candidateDir: path.join(FX, "cobol-payroll", candidate),
    fixturesDir: path.join(FX, "cobol-payroll", "fixtures"),
    changeSpecFile: spec ? path.join(FX, "cobol-payroll", spec) : null,
  });

describe.skipIf(!HAS_COBC)(
  `COBOL payroll with GnuCOBOL${HAS_COBC ? "" : " (skipped: cobc not installed)"}`,
  () => {
    it("without a change spec, the threshold change is a regression (FAIL)", async () => {
      const { report } = await cobol("candidate-threshold");
      expect(report.verdict).toBe("FAIL");
      expect(report.candidate.toolchain.version).toMatch(/GnuCOBOL/);
    });

    it("with the approved change spec CHG-001 the same candidate PASSes as an intended change (AC-021)", async () => {
      const { report } = await cobol("candidate-threshold", "change-spec-chg001.json");
      expect(report.verdict).toBe("PASS");
      expect(report.counts.REGRESSION).toBe(0);
      expect(
        report.outputs
          .filter((o) => o.class === "INTENDED_CHANGE")
          .map((o) => `${o.fixture}/${o.output}`),
      ).toEqual(["week-01/PAYOUT.DAT", "week-01/PAYPK.DAT", "week-01/stdout"]);
      // The baseline reproduced every golden output twice (AC-020).
      expect(report.findings.filter((f) => f.class === "INCONCLUSIVE")).toEqual([]);
      expect(report.executions.filter((e) => e.side === "baseline")).toHaveLength(4);
      const gross = report.findings.find(
        (f) => f.output === "PAYPK.DAT" && f.record === 2 && f.field === "GROSS",
      );
      expect(gross).toMatchObject({
        class: "INTENDED_CHANGE",
        baseline: "1425.00",
        candidate: "1350.00",
      });
    });

    it("the injected regression (ROUNDED dropped) FAILs even under CHG-001", async () => {
      const { report } = await cobol("candidate-regression", "change-spec-chg001.json");
      expect(report.verdict).toBe("FAIL");
      const reg = report.findings.filter((f) => f.class === "REGRESSION");
      expect(reg).toContainEqual(
        expect.objectContaining({
          output: "PAYOUT.DAT",
          record: 1,
          field: "TAX",
          baseline: "179.56",
          candidate: "179.55",
        }),
      );
    });

    it("numeric edges: packed decimal, negative values and signed zero reproduce the golden bytes (AC-023)", async () => {
      const { report, bundleDir } = await cobol("candidate-threshold", "change-spec-chg001.json");
      const edge = report.outputs.filter((o) => o.fixture === "edge-zero");
      expect(edge.every((o) => o.class === "EQUIVALENT")).toBe(true);
      const pk = fs.readFileSync(
        path.join(bundleDir, "outputs", "baseline", "edge-zero", "PAYPK.DAT"),
      );
      // E00004: -0 adjustment on leave → gross +0 (sign nibble C), never a negative zero.
      expect(pk.subarray(6, 11).toString("hex")).toBe("000000000c");
      const week = fs.readFileSync(
        path.join(bundleDir, "outputs", "baseline", "week-01", "PAYPK.DAT"),
      );
      // E00007: gross -50.00 packed with sign nibble D.
      expect(week.subarray(5 * 16 + 6, 5 * 16 + 11).toString("hex")).toBe("000005000d");
    });

    it("a full signed change case reproduces from a clean data area (AC-028) and tamper fails (AC-025)", async () => {
      const out = await cobol("candidate-threshold", "change-spec-chg001.json");
      const ctx = { dataDir: data, env };
      let c = createCase(ctx, {
        title: "CHG-001 overtime threshold",
        createdBy: "owner",
        baseline: out.report.baseline.snapshot,
        candidate: out.report.candidate.snapshot,
        candidateDir: path.join(FX, "cobol-payroll", "candidate-threshold"),
        changeSpec: out.report.changeSpec,
        policySha256: out.report.policySha256,
        fixturesDigest: out.report.fixtures.digest,
      });
      for (const to of [
        "ANALYSING",
        "ANALYSIS_REVIEW",
        "CHANGE_PROPOSED",
        "CHANGE_REVIEW",
        "TEST_QUEUED",
      ] as const) {
        c = transitionCase(ctx, c.id, to, "owner");
      }
      attachTestRun(ctx, c.id, "tester", out);
      requestApproval(ctx, c.id, "tester");
      decideApproval(ctx, c.id, {
        approver: "approver1",
        role: "approver",
        decision: "approved",
        validForMs: 3_600_000,
      });
      const h = handoffCase(ctx, c.id, "release");
      expect(h.deployed).toBe(false);

      const keyId = (await verifyEvidenceBundle(out.bundleDir)).manifest!.signer.keyId;
      const bundles = [
        out.bundleDir,
        ...fs
          .readdirSync(path.join(data, "cases", c.id, "evidence"))
          .map((b) => path.join(data, "cases", c.id, "evidence", b)),
      ];
      const logs: string[] = [];
      const runtime = {
        log: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
        exit: () => {},
      };
      for (const b of bundles) {
        expect(
          await runEvidenceVerify(b, { trustKey: [keyId] }, { runtime: runtime as never }),
        ).toBe(0);
      }
      const tampered = path.join(tmp, "tampered");
      fs.cpSync(out.bundleDir, tampered, { recursive: true });
      const f = path.join(tampered, "outputs", "candidate", "week-01", "PAYOUT.DAT");
      fs.writeFileSync(f, fs.readFileSync(f, "latin1").replace("1350.00", "1425.00"), "latin1");
      expect(
        await runEvidenceVerify(tampered, { trustKey: [keyId] }, { runtime: runtime as never }),
      ).toBe(1);
      expect(logs.join("\n")).toMatch(/does not match its manifest digest/);
    });
  },
);

describe.skipIf(!HAS_GFORTRAN)(
  `FORTRAN loan with gfortran${HAS_GFORTRAN ? "" : " (skipped: gfortran not installed)"}`,
  () => {
    const fortran = (candidate: string) =>
      run({
        baselineDir: path.join(FX, "fortran-loan", "baseline"),
        candidateDir: path.join(FX, "fortran-loan", candidate),
        fixturesDir: path.join(FX, "fortran-loan", "fixtures"),
      });

    it("a refactor with identical arithmetic PASSes", async () => {
      const { report } = await fortran("candidate-equivalent");
      expect(report.verdict).toBe("PASS");
      expect(report.language).toBe("fortran");
    });

    it("single-precision regression FAILs on the fixture that exposes it, and only there", async () => {
      const { report } = await fortran("candidate-regression");
      expect(report.verdict).toBe("FAIL");
      expect(report.outputs.filter((o) => o.class === "REGRESSION")).toEqual([
        { fixture: "loan-b", output: "stdout", class: "REGRESSION" },
      ]);
    });
  },
);

describe("PL/I (AC-029)", () => {
  it("analysis runs; execution is NOT_RUN_COMPILER_UNAVAILABLE, never PASS, with signed evidence", async () => {
    const inv = legacyInventory(path.join(FX, "pli-payroll", "baseline"), "pli", undefined, {
      stateDir: path.join(tmp, "state"),
    }) as { procedures: Array<{ name: string; main: boolean }> };
    expect(inv.procedures).toContainEqual(expect.objectContaining({ name: "PAYPLI", main: true }));
    const { report, bundleDir } = await run({
      baselineDir: path.join(FX, "pli-payroll", "baseline"),
      candidateDir: path.join(FX, "pli-payroll", "candidate"),
      fixturesDir: path.join(FX, "pli-payroll", "fixtures"),
    });
    expect(report.verdict).toBe("NOT_RUN_COMPILER_UNAVAILABLE");
    expect(report.executions).toEqual([]);
    const v = await verifyEvidenceBundle(bundleDir);
    expect(v.ok).toBe(true);
    expect(v.manifest?.status).toBe("NOT_RUN_COMPILER_UNAVAILABLE");
  });
});
