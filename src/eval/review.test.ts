import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { canonicalJson, sha256Hex, signerFromKey } from "../continuity-suite/manifest.js";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "../infra/device-identity.js";
import { copyExample, tempHome } from "../test-helpers/eval.js";
import {
  correctionEffortOf,
  diffSize,
  editDistance,
  type HumanReview,
  median,
  percentile,
  reviewerMinutesPerItem,
} from "./review-effort.js";
import { recordReview, ReviewError, type ReviewInput } from "./review.js";
import { runReplay } from "./run.js";
import {
  reliabilityOf,
  type Scorecard,
  SCORECARD_KIND,
  scorecardSigningInput,
  verifyScorecardDir,
  writeSignedScorecard,
} from "./scorecard.js";
import { loadSpec } from "./spec.js";

let t: ReturnType<typeof tempHome>;
let key: { privateKeyPem: string; publicKeyPem: string };
beforeEach(() => {
  t = tempHome();
  const id = loadOrCreateDeviceIdentity(path.join(t.home, "identity", "k.json"));
  key = { privateKeyPem: id.privateKeyPem, publicKeyPem: id.publicKeyPem };
});
afterEach(() => t.cleanup());

const NOW = new Date("2026-10-20T05:00:00.000Z");

function rv(over: Partial<HumanReview>): HumanReview {
  return {
    id: "rv-1",
    fixture: "a",
    attempt: 1,
    reviewer: "r",
    recordedAt: NOW.toISOString(),
    minutesReview: 5,
    minutesFix: 0,
    verdict: "accepted-as-is",
    diff: null,
    priorScorecardSha256: "0".repeat(64),
    ...over,
  };
}

describe("diff size", () => {
  it("counts added and removed lines with the shortest edit script", () => {
    const d = diffSize("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    expect(d).toMatchObject({
      unit: "line",
      fromLines: 4,
      toLines: 5,
      added: 2,
      removed: 1,
      editDistance: 3,
      exact: true,
    });
    expect(d.changeRatio).toBeCloseTo(3 / 9, 4);
    expect(d.fromSha256).toBe(sha256Hex("a\nb\nc\nd\n"));
  });

  it("is zero for identical text, ignores line-ending style, and handles empty files", () => {
    expect(diffSize("x\r\ny\r\n", "x\ny\n").editDistance).toBe(0);
    expect(diffSize("x\ny", "x\ny\n").editDistance).toBe(0);
    expect(diffSize("", "")).toMatchObject({ editDistance: 0, changeRatio: 0 });
    expect(diffSize("", "a\nb\n")).toMatchObject({ added: 2, removed: 0, editDistance: 2 });
    expect(diffSize("a\nb\n", "")).toMatchObject({ added: 0, removed: 2, changeRatio: 1 });
  });

  it("matches the textbook Myers example (ABCABBA → CBABAC, D = 5)", () => {
    expect(editDistance("ABCABBA".split(""), "CBABAC".split(""))).toBe(5);
    expect(editDistance("abc".split(""), "xyz".split(""))).toBe(6);
  });

  it("falls back to a lower bound when the edit script is too long", () => {
    expect(editDistance("abcdef".split(""), "uvwxyz".split(""), 3)).toBeNull();
    const many = (p: string) => Array.from({ length: 30_000 }, (_, i) => `${p}${i}`).join("\n");
    const d = diffSize(many("a"), many("b"));
    expect(d.exact).toBe(false);
    expect(d.editDistance).toBe(60_000);
  });
});

describe("correction effort aggregation", () => {
  it("median and nearest-rank p90", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([1, 2, 3], 90)).toBe(3);
  });

  it("per task and per suite, with shares and diff medians", () => {
    const reviews = [
      rv({ id: "rv-1", fixture: "a", minutesReview: 4, minutesFix: 0 }),
      rv({
        id: "rv-2",
        fixture: "a",
        minutesReview: 6,
        minutesFix: 10,
        verdict: "accepted-after-edits",
        diff: diffSize("x\n", "y\n"),
      }),
      rv({ id: "rv-3", fixture: "b", minutesReview: 3, minutesFix: 0, verdict: "rejected" }),
    ];
    const ce = correctionEffortOf(reviews, undefined);
    expect(ce.suite).toMatchObject({
      reviews: 3,
      medianMinutes: 4,
      p90Minutes: 16,
      medianReviewMinutes: 4,
      medianFixMinutes: 0,
      totalMinutes: 23,
      acceptedUnchangedShare: 0.3333,
      acceptedEditedShare: 0.3333,
      rejectedShare: 0.3333,
      medianEditDistance: 2,
    });
    expect(ce.tasks.a).toMatchObject({ reviews: 2, medianMinutes: 10, p90Minutes: 16 });
    expect(ce.tasks.b).toMatchObject({ reviews: 1, rejectedShare: 1, medianEditDistance: null });
    expect(ce.targets).toBeNull();
    expect(ce.meetsTargets).toBeNull();
    expect(reviewerMinutesPerItem(reviews)).toBe(11.5);
    expect(reviewerMinutesPerItem([])).toBeNull();
  });

  it("compares the suite against spec targets", () => {
    const reviews = [rv({ minutesReview: 5 }), rv({ id: "rv-2", minutesReview: 20 })];
    expect(correctionEffortOf(reviews, { p90Minutes: 30 }).meetsTargets).toBe(true);
    expect(correctionEffortOf(reviews, { p90Minutes: 10 }).meetsTargets).toBe(false);
    expect(correctionEffortOf(reviews, { minAcceptedUnchanged: 1 }).meetsTargets).toBe(true);
    expect(correctionEffortOf([], { p90Minutes: 10 }).meetsTargets).toBeNull();
    expect(correctionEffortOf(reviews, {}).targets).toBeNull();
  });
});

describe("schema compatibility", () => {
  it("specs without humanReview still load; targets are optional and strict", () => {
    const dir = copyExample(t.home);
    expect(loadSpec(dir).spec.humanReview).toBeUndefined();
    const file = path.join(dir, "spec.yaml");
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    doc.humanReview = { targets: { medianMinutes: 10, p90Minutes: 30, minAcceptedUnchanged: 0.5 } };
    fs.writeFileSync(file, YAML.stringify(doc));
    expect(loadSpec(dir).spec.humanReview?.targets?.p90Minutes).toBe(30);
    doc.humanReview = { targets: { minAcceptedUnchanged: 2 } };
    fs.writeFileSync(file, YAML.stringify(doc));
    expect(() => loadSpec(dir)).toThrow(/invalid spec/);
    doc.humanReview = { targets: {}, extra: true };
    fs.writeFileSync(file, YAML.stringify(doc));
    expect(() => loadSpec(dir)).toThrow(/invalid spec/);
  });

  it("a v1 scorecard written before this change still verifies", () => {
    const dir = path.join(t.home, "v1");
    fs.mkdirSync(dir, { recursive: true });
    const card = {
      kind: SCORECARD_KIND,
      version: 1,
      runId: "20261018T000000-abcdef",
      workflow: "csv-inspection.exceptions",
      mode: "replay",
      createdAt: "2026-10-18T00:00:00.000Z",
      runtime: { name: "Kurahi", version: "test" },
      spec: { version: 1, sha256: "a".repeat(64), signature: "signed", signedBy: "k" },
      driver: "csv-inspection",
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
    const body = `${JSON.stringify(card, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, "scorecard.json"), body);
    const unsigned = {
      kind: SCORECARD_KIND,
      version: 1 as const,
      runId: card.runId,
      workflow: card.workflow,
      createdAt: card.createdAt,
      files: { "scorecard.json": { sha256: sha256Hex(body), size: Buffer.byteLength(body) } },
    };
    const manifest = {
      ...unsigned,
      signer: signerFromKey(key),
      signature: signDevicePayload(key.privateKeyPem, scorecardSigningInput(unsigned)),
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    expect(verifyScorecardDir(dir)).toMatchObject({ ok: true, problems: [] });
    // An unknown future version is reported, not silently accepted.
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ ...manifest, version: 9 }, null, 2),
    );
    expect(verifyScorecardDir(dir).problems.join(" ")).toMatch(/unsupported scorecard version 9/);
  });
});

describe("recording a review", () => {
  function run(targets?: Record<string, number>): { dir: string; card: Scorecard } {
    const spec = copyExample(t.home);
    if (targets) {
      const file = path.join(spec, "spec.yaml");
      fs.writeFileSync(
        file,
        `${fs.readFileSync(file, "utf8")}\nhumanReview:\n  targets: ${JSON.stringify(targets)}\n`,
      );
    }
    const r = runReplay({ specDir: spec, env: t.env, key, runId: "20261020T050000-aaaaaa" });
    return { dir: r.dir, card: r.scorecard };
  }
  const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
    task: "line3-clean",
    reviewer: "line supervisor",
    minutesReview: 6,
    minutesFix: 4,
    verdict: "accepted-after-edits",
    ...over,
  });

  it("new runs are v2, copy spec targets, and have no review fields until reviewed", () => {
    const { card } = run({ p90Minutes: 15 });
    expect(card.version).toBe(3);
    expect(card.reviewTargets).toEqual({ p90Minutes: 15 });
    expect(card.humanReview).toBeUndefined();
    expect(card.correctionEffort).toBeUndefined();
  });

  it("appends the review, re-signs, and the scorecard still verifies", () => {
    const { dir } = run({ p90Minutes: 15 });
    const before = fs.readFileSync(path.join(dir, "scorecard.json"));
    const from = path.join(t.home, "agent.json");
    const to = path.join(t.home, "accepted.json");
    fs.writeFileSync(from, '{\n  "exceptions": [],\n  "note": "none"\n}\n');
    fs.writeFileSync(to, '{\n  "exceptions": [],\n  "note": "none found on line 3"\n}\n');
    const r1 = recordReview(dir, input({ diffFrom: from, diffTo: to }), key, NOW);
    expect(r1.review).toMatchObject({
      id: "rv-1",
      fixture: "line3-clean",
      attempt: 1,
      verdict: "accepted-after-edits",
      priorScorecardSha256: sha256Hex(before),
      diff: { added: 1, removed: 1, editDistance: 2 },
    });
    let v = verifyScorecardDir(dir);
    expect(v).toMatchObject({ ok: true, problems: [] });
    expect(v.scorecard?.correctionEffort?.suite).toMatchObject({ reviews: 1, medianMinutes: 10 });
    expect(v.scorecard?.metrics.reviewerMinutesPerItem).toBe(10);
    expect(v.scorecard?.correctionEffort?.meetsTargets).toBe(true);
    expect(v.manifest?.files["revisions/r1/scorecard.json"]?.sha256).toBe(sha256Hex(before));

    const r2 = recordReview(
      dir,
      input({ task: "line3-2026-10-14", minutesReview: 12, minutesFix: 0, verdict: "rejected" }),
      key,
      NOW,
    );
    expect(r2.review.id).toBe("rv-2");
    v = verifyScorecardDir(dir);
    expect(v.ok).toBe(true);
    expect(Object.keys(v.manifest?.files ?? {}).toSorted()).toEqual([
      "revisions/r1/manifest.json",
      "revisions/r1/scorecard.json",
      "revisions/r2/manifest.json",
      "revisions/r2/scorecard.json",
      "scorecard.json",
    ]);
    expect(v.scorecard?.correctionEffort?.suite).toMatchObject({
      reviews: 2,
      medianMinutes: 11,
      p90Minutes: 12,
      acceptedUnchangedShare: 0,
      rejectedShare: 0.5,
    });
    // The original run is kept as a standalone verifiable signed scorecard; later revisions keep
    // their own signatures (their manifests list files relative to the scorecard root).
    expect(verifyScorecardDir(path.join(dir, "revisions", "r1")).ok).toBe(true);
    expect(verifyScorecardDir(path.join(dir, "revisions", "r2")).signatureOk).toBe(true);
  });

  it("a review edited after signing fails verification", () => {
    const { dir } = run();
    recordReview(dir, input(), key, NOW);
    const f = path.join(dir, "scorecard.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"minutesFix": 4', '"minutesFix": 0'));
    expect(verifyScorecardDir(dir).filesOk).toBe(false);
  });

  it("a consistently re-hashed but self-inconsistent summary is reported", () => {
    const { dir } = run();
    const { scorecard } = recordReview(dir, input(), key, NOW);
    const forged = {
      ...scorecard,
      correctionEffort: correctionEffortOf(
        [{ ...scorecard.humanReview![0], minutesFix: 0 }],
        undefined,
      ),
    };
    expect(canonicalJson(forged.correctionEffort)).not.toBe(
      canonicalJson(scorecard.correctionEffort),
    );
    // Re-signed with a valid key: signature and hashes pass, the consistency check does not.
    writeSignedScorecard(forged, dir, key);
    const v = verifyScorecardDir(dir);
    expect(v.signatureOk).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/correctionEffort does not match/);
  });

  it("refuses to re-sign a scorecard that does not verify", () => {
    const { dir } = run();
    const f = path.join(dir, "scorecard.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"accepted": 2', '"accepted": 3'));
    expect(() => recordReview(dir, input(), key, NOW)).toThrow(/does not verify/);
    expect(fs.existsSync(path.join(dir, "revisions"))).toBe(false);
  });

  it("rejects unknown tasks and attempts, and inconsistent verdicts", () => {
    const { dir } = run();
    const same = path.join(t.home, "same.json");
    fs.writeFileSync(same, "{}\n");
    const other = path.join(t.home, "other.json");
    fs.writeFileSync(other, "{ }\n");
    const cases: Array<[Partial<ReviewInput>, RegExp]> = [
      [{ task: "nope" }, /no task nope/],
      [{ attempt: 2 }, /not 2/],
      [{ verdict: "accepted-as-is" }, /fix minutes > 0/],
      [
        { verdict: "accepted-as-is", minutesFix: 0, diffFrom: same, diffTo: other },
        /differs by 2 line/,
      ],
      [{ diffFrom: same, diffTo: same }, /identical/],
      [{ diffFrom: same }, /go together/],
      [{ diffFrom: same, diffTo: path.join(t.home, "missing") }, /cannot diff/],
    ];
    for (const [over, msg] of cases) {
      expect(() => recordReview(dir, input(over), key, NOW)).toThrow(ReviewError);
      expect(() => recordReview(dir, input(over), key, NOW)).toThrow(msg);
    }
    expect(verifyScorecardDir(dir).scorecard?.humanReview).toBeUndefined();
  });
});
