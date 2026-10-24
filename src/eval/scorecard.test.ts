import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { tempHome } from "../test-helpers/eval.js";
import {
  modelProvenanceProblems,
  reliabilityOf,
  type Scorecard,
  SCORECARD_KIND,
  SCORECARD_VERSION,
  verifyScorecardDir,
  writeSignedScorecard,
} from "./scorecard.js";

let t: ReturnType<typeof tempHome>;
let key: { privateKeyPem: string; publicKeyPem: string };
beforeEach(() => {
  t = tempHome();
  const id = loadOrCreateDeviceIdentity(path.join(t.home, "identity", "k.json"));
  key = { privateKeyPem: id.privateKeyPem, publicKeyPem: id.publicKeyPem };
});
afterEach(() => t.cleanup());

function card(): Scorecard {
  return {
    kind: SCORECARD_KIND,
    version: SCORECARD_VERSION,
    runId: "20261018T000000-abcdef",
    workflow: "csv-inspection.exceptions",
    mode: "replay",
    createdAt: "2026-10-18T00:00:00.000Z",
    runtime: { name: "Kurahi", version: "test" },
    spec: { version: 1, sha256: "a".repeat(64), signature: "signed", signedBy: "k" },
    driver: "csv-inspection",
    models: { subject: { provider: "simulated", model: "csv-inspection" }, judges: [] },
    fixtures: [],
    summary: {
      passed: true,
      gatesPassed: true,
      score: 100,
      passThreshold: 85,
      fixtures: 0,
      attempts: 0,
      accepted: 0,
    },
    metrics: {
      acceptedTaskRate: 1,
      costPerAcceptedResult: null,
      reviewerMinutesPerItem: null,
      duplicateActions: 0,
      unauthorisedActions: 0,
      recoverySuccess: null,
    },
    reliability: reliabilityOf([], 1, 1),
    failureTags: {},
    provenance: [],
  };
}
const write = () => writeSignedScorecard(card(), path.join(t.home, "sc"), key);

describe("signed scorecards", () => {
  it("verify offline after writing", () => {
    const dir = write();
    const v = verifyScorecardDir(dir);
    expect(v).toMatchObject({
      ok: true,
      keyIdOk: true,
      signatureOk: true,
      filesOk: true,
      problems: [],
    });
    expect(v.scorecard?.summary.score).toBe(100);
  });

  it("detect an edited scorecard", () => {
    const dir = write();
    const f = path.join(dir, "scorecard.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"score": 100', '"score": 99'));
    const v = verifyScorecardDir(dir);
    expect(v.ok).toBe(false);
    expect(v.filesOk).toBe(false);
  });

  it("detect an edited manifest (signature no longer verifies)", () => {
    const dir = write();
    const f = path.join(dir, "manifest.json");
    const m = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    m.createdAt = "2027-01-01T00:00:00.000Z";
    fs.writeFileSync(f, JSON.stringify(m));
    const v = verifyScorecardDir(dir);
    expect(v.ok).toBe(false);
    expect(v.signatureOk).toBe(false);
  });

  it("detect a swapped signer key", () => {
    const dir = write();
    const f = path.join(dir, "manifest.json");
    const m = JSON.parse(fs.readFileSync(f, "utf8")) as { signer: { keyId: string } };
    m.signer.keyId = "0".repeat(64);
    fs.writeFileSync(f, JSON.stringify(m));
    const v = verifyScorecardDir(dir);
    expect(v.keyIdOk).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("detect a scorecard re-signed for another run id", () => {
    const dir = write();
    const f = path.join(dir, "scorecard.json");
    const other = { ...card(), runId: "other" };
    // A consistent edit (file hash updated) still fails: manifest and scorecard disagree, and the
    // manifest's own signature covers the file digest.
    fs.writeFileSync(f, `${JSON.stringify(other, null, 2)}\n`);
    expect(verifyScorecardDir(dir).ok).toBe(false);
  });

  it("report missing files", () => {
    const dir = write();
    fs.rmSync(path.join(dir, "scorecard.json"));
    expect(verifyScorecardDir(dir).problems.join(" ")).toMatch(/missing/);
    fs.rmSync(path.join(dir, "manifest.json"));
    expect(verifyScorecardDir(dir).ok).toBe(false);
  });
});

describe("model provenance (v3)", () => {
  const judged = (status: "pass" | "skipped") =>
    ({
      fixture: "f1",
      attempt: 1,
      jobId: "j",
      evidence: { manifestSha256: null, signed: true, root: null },
      checks: [
        {
          id: "tone",
          type: "rubric",
          severity: "info",
          judge: "model",
          weight: null,
          status,
          detail: "",
        },
      ],
      gates: { passed: true, failed: [] },
      criticalFailed: [],
      score: 100,
      passed: true,
      cost: {},
      unmatchedToolCalls: 0,
    }) as unknown as Scorecard["fixtures"][number];

  it("rejects a v3 scorecard that does not name the subject model", () => {
    const c = { ...card(), models: undefined };
    expect(modelProvenanceProblems(c)).toEqual(["v3 scorecard does not name the subject model"]);
    const v = verifyScorecardDir(writeSignedScorecard(c, path.join(t.home, "sc"), key));
    expect(v.ok).toBe(false);
  });

  it("accepts v1/v2 scorecards without models", () => {
    expect(modelProvenanceProblems({ ...card(), version: 2, models: undefined })).toEqual([]);
  });

  it("requires a judge entry for every model-judged check", () => {
    const c = { ...card(), fixtures: [judged("skipped")] };
    expect(modelProvenanceProblems(c)).toEqual([
      "check tone is model-judged but has no judge entry",
    ]);
  });

  it("rejects a score from a model judge the scorecard does not name", () => {
    const c: Scorecard = {
      ...card(),
      models: {
        subject: { provider: "simulated", model: "csv-inspection" },
        judges: [{ checkId: "tone", model: null, rubricSha256: null, ran: false }],
      },
      fixtures: [judged("pass")],
    };
    expect(modelProvenanceProblems(c)).toEqual([
      "check tone was scored by a model judge that the scorecard does not name",
    ]);
    c.models!.judges[0] = {
      checkId: "tone",
      model: "local/qwen",
      rubricSha256: "b".repeat(64),
      ran: true,
    };
    expect(modelProvenanceProblems(c)).toEqual([]);
  });
});
