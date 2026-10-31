// The runner contract without a real compiler (test-helpers.ts: a stand-in `cobc`), so these run
// on any Linux CI host. Real GnuCOBOL / gfortran runs are in verify.e2e.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSigningKey } from "../continuity-suite/manifest.js";
import { signEvidenceManifest } from "../evidence/store.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import { describeIsolation } from "./sandbox.js";
import { makeFakeCobc, writeProgram } from "./test-helpers.js";
import { verifyChange, type VerifyParams } from "./verify.js";

const isLinux = process.platform === "linux";
let tmp: string;
let env: NodeJS.ProcessEnv;
let fakeCobc: string;

const program = writeProgram;

function fixture(
  name: string,
  files: Record<string, string> = {},
  golden: Record<string, string> = {},
) {
  const root = path.join(tmp, "fixtures", name);
  fs.mkdirSync(path.join(root, "files"), { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "files", k), v);
  }
  if (Object.keys(golden).length > 0) {
    fs.mkdirSync(path.join(root, "golden"), { recursive: true });
    for (const [k, v] of Object.entries(golden)) {
      fs.writeFileSync(path.join(root, "golden", k), v);
    }
  }
}

function run(extra: Partial<VerifyParams> = {}) {
  return verifyChange({
    dataDir: path.join(tmp, "data"),
    baselineDir: path.join(tmp, "base"),
    candidateDir: path.join(tmp, "cand"),
    fixturesDir: path.join(tmp, "fixtures"),
    compilers: { cobol: fakeCobc },
    policy: { baselineRuns: 2 },
    env,
    ...extra,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-runner-"));
  env = { ...process.env, KOLO_HOME: path.join(tmp, "home") };
  fakeCobc = makeFakeCobc(path.join(tmp, "bin"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!isLinux)("runner verdicts (AC-020/022)", () => {
  it("PASS when both sides produce the same outputs, with a reproducible baseline", async () => {
    program(path.join(tmp, "base"), "/bin/cat IN.DAT > OUT.DAT; echo done");
    program(path.join(tmp, "cand"), "# refactored\n/bin/cat IN.DAT > OUT.DAT; echo done");
    fixture("one", { "IN.DAT": "A\n" }, { stdout: "done\n", "OUT.DAT": "A\n" });
    const { report } = await run();
    expect(report.verdict).toBe("PASS");
    expect(report.executions.filter((e) => e.side === "baseline")).toHaveLength(2);
    expect(report.outputs.map((o) => `${o.output}:${o.class}`)).toEqual([
      "OUT.DAT:EQUIVALENT",
      "exit:EQUIVALENT",
      "stderr:EQUIVALENT",
      "stdout:EQUIVALENT",
    ]);
  });

  it("FAIL on an output difference with no change spec, and when the candidate does not build", async () => {
    program(path.join(tmp, "base"), "echo 1");
    program(path.join(tmp, "cand"), "echo 2");
    fixture("one");
    expect((await run()).report.verdict).toBe("FAIL");
    program(path.join(tmp, "cand"), "SYNTAX ERROR");
    const { report } = await run();
    expect(report.verdict).toBe("FAIL");
    expect(report.reason).toMatch(/candidate does not build/);
  });

  it("NOT_RUN_COMPILER_UNAVAILABLE when the compiler is missing, never PASS", async () => {
    program(path.join(tmp, "base"), "echo 1");
    program(path.join(tmp, "cand"), "echo 1");
    fixture("one");
    const { report, bundleDir } = await run({
      compilers: { cobol: path.join(tmp, "nope", "cobc") },
    });
    expect(report.verdict).toBe("NOT_RUN_COMPILER_UNAVAILABLE");
    expect(report.executions).toEqual([]);
    expect((await verifyEvidenceBundle(bundleDir)).ok).toBe(true);
  });

  it("NOT_RUN_COMPILER_UNAVAILABLE for PL/I", async () => {
    for (const side of ["base", "cand"]) {
      fs.mkdirSync(path.join(tmp, side), { recursive: true });
      fs.writeFileSync(path.join(tmp, side, "P.pli"), " P: PROC OPTIONS(MAIN); END P;\n");
    }
    fixture("one");
    const { report } = await run({ compilers: {} });
    expect(report.language).toBe("pli");
    expect(report.verdict).toBe("NOT_RUN_COMPILER_UNAVAILABLE");
  });

  it("NOT_RUN_NO_FIXTURES without fixture cases", async () => {
    program(path.join(tmp, "base"), "echo 1");
    program(path.join(tmp, "cand"), "echo 1");
    const { report } = await run();
    expect(report.verdict).toBe("NOT_RUN_NO_FIXTURES");
    expect(report.builds).toEqual([]);
  });

  it("TIMEOUT when an execution exceeds the limit", async () => {
    program(path.join(tmp, "base"), "/bin/sleep 10");
    program(path.join(tmp, "cand"), "/bin/sleep 10");
    fixture("one");
    const started = Date.now();
    const { report, bundleDir } = await run({
      policy: { limits: { timeoutMs: 400, maxOutputBytes: 65536, cpuSeconds: 5 } },
    });
    expect(report.verdict).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(8000);
    expect((await verifyEvidenceBundle(bundleDir)).manifest?.status).toBe("TIMEOUT");
  });

  it("CANCELLED when the run is aborted mid-execution", async () => {
    program(path.join(tmp, "base"), "/bin/sleep 10");
    program(path.join(tmp, "cand"), "/bin/sleep 10");
    fixture("one");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const { report, bundleDir } = await run({ signal: ac.signal });
    expect(report.verdict).toBe("CANCELLED");
    expect((await verifyEvidenceBundle(bundleDir)).ok).toBe(true);
  });

  it("INCONCLUSIVE when the baseline is not reproducible or misses its golden output", async () => {
    program(path.join(tmp, "base"), "/bin/cat /proc/sys/kernel/random/uuid");
    program(path.join(tmp, "cand"), "/bin/cat /proc/sys/kernel/random/uuid");
    fixture("one");
    const flaky = await run();
    expect(flaky.report.verdict).toBe("INCONCLUSIVE");
    expect(flaky.report.reason).toMatch(/not a stable reference/);
    program(path.join(tmp, "base"), "echo 1");
    program(path.join(tmp, "cand"), "echo 1");
    fixture("one", {}, { stdout: "2\n" });
    expect((await run()).report.verdict).toBe("INCONCLUSIVE");
  });

  it("INCONCLUSIVE when a declared intended change is not exercised", async () => {
    program(path.join(tmp, "base"), "echo 1");
    program(path.join(tmp, "cand"), "echo 1");
    fixture("one");
    const spec = path.join(tmp, "spec.json");
    fs.writeFileSync(
      spec,
      JSON.stringify({ id: "C1", title: "t", intended: [{ output: "stdout" }] }),
    );
    const { report } = await run({ changeSpecFile: spec });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reason).toMatch(/not exercised/);
  });

  it("runs with a fixed minimal environment, and without network when namespaces work", async () => {
    program(
      path.join(tmp, "base"),
      "/usr/bin/env | /usr/bin/sort; /bin/cat /proc/net/dev | /usr/bin/tail -n +3 | /usr/bin/cut -d: -f1",
    );
    program(
      path.join(tmp, "cand"),
      "/usr/bin/env | /usr/bin/sort; /bin/cat /proc/net/dev | /usr/bin/tail -n +3 | /usr/bin/cut -d: -f1",
    );
    fixture("one");
    const { report, bundleDir } = await run({ policy: { baselineRuns: 1 } });
    const stdout = fs.readFileSync(
      path.join(bundleDir, "outputs", "baseline", "one", "stdout"),
      "utf8",
    );
    expect(stdout).toMatch(/^LC_ALL=C\n/);
    expect(stdout).toContain("TZ=UTC\n");
    // /bin/sh itself exports PWD (and may set SHLVL); nothing is inherited from Kurahi.
    expect(stdout).not.toMatch(/HOME=|PATH=|KOLO_HOME=|USER=/);
    if (describeIsolation().network === "namespace") {
      expect(report.isolation.network).toBe("namespace");
      const ifaces = stdout.split("\n").filter((l) => l.trim() && !l.includes("="));
      expect(ifaces.map((s) => s.trim())).toEqual(["lo"]);
    }
  });
});

describe.skipIf(!isLinux)("signed evidence for every outcome (AC-024/025)", () => {
  it("verifies intact bundles and rejects tampered outputs, reports, manifests and wrong keys", async () => {
    program(path.join(tmp, "base"), "echo 1 > OUT.DAT");
    program(path.join(tmp, "cand"), "echo 2 > OUT.DAT");
    fixture("one");
    const { report, bundleDir } = await run();
    expect(report.verdict).toBe("FAIL");
    const intact = await verifyEvidenceBundle(bundleDir);
    expect(intact.ok).toBe(true);
    expect(intact.manifest?.status).toBe("FAIL");
    const keyId = intact.manifest!.signer.keyId;
    expect((await verifyEvidenceBundle(bundleDir, { trustedKeyIds: [keyId] })).ok).toBe(true);

    const copy = (name: string) => {
      const dir = path.join(tmp, name);
      fs.cpSync(bundleDir, dir, { recursive: true });
      return dir;
    };
    const out = copy("t-output");
    fs.writeFileSync(path.join(out, "outputs", "candidate", "one", "OUT.DAT"), "1\n");
    expect((await verifyEvidenceBundle(out)).ok).toBe(false);

    const rep = copy("t-report");
    const rj = path.join(rep, "report.json");
    fs.writeFileSync(
      rj,
      fs.readFileSync(rj, "utf8").replace('"verdict": "FAIL"', '"verdict": "PASS"'),
    );
    expect((await verifyEvidenceBundle(rep)).ok).toBe(false);

    const man = copy("t-manifest");
    const mj = path.join(man, "manifest.json");
    fs.writeFileSync(
      mj,
      fs.readFileSync(mj, "utf8").replace('"status": "FAIL"', '"status": "PASS"'),
    );
    const manV = await verifyEvidenceBundle(man);
    expect(manV.ok).toBe(false);
    expect(manV.problems.join(" ")).toMatch(/signature/);

    // Re-signed by another key after editing: self-consistent, but not the trusted signer.
    const wrong = copy("t-wrong-key");
    const wj = path.join(wrong, "manifest.json");
    const m = JSON.parse(fs.readFileSync(wj, "utf8"));
    const { signer: _s, signature: _g, ...unsigned } = m;
    const other = loadSigningKey(path.join(tmp, "attacker"));
    fs.writeFileSync(wj, JSON.stringify(signEvidenceManifest(unsigned, other), null, 2));
    expect((await verifyEvidenceBundle(wrong)).ok).toBe(true);
    const anchored = await verifyEvidenceBundle(wrong, { trustedKeyIds: [keyId] });
    expect(anchored.ok).toBe(false);
    expect(anchored.trustedOk).toBe(false);
  });
});
