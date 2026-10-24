// Workflow Evaluator: scoring and signed scorecards (design §5).
//
// <KOLO_HOME>/eval/scorecards/<workflow>/<runId>/scorecard.json
// <KOLO_HOME>/eval/scorecards/<workflow>/<runId>/manifest.json   Ed25519, offline-verifiable
//
// Gates (severity "gate") are pass/fail and never enter the weighted score. A run passes only when
// every gate passes, no critical check fails, and the weighted score meets the spec threshold.
import fs from "node:fs";
import path from "node:path";
import type { SigningKey } from "../continuity-suite/manifest.js";
import type { ManifestSigner } from "../continuity-suite/types.js";
import type { CheckResult } from "./checks.js";
import { resolveStateDir } from "../config/paths.js";
import { canonicalJson, sha256Hex, signerFromKey } from "../continuity-suite/manifest.js";
import {
  deriveDeviceIdFromPublicKey,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";
import {
  type CorrectionEffort,
  type CorrectionEffortTargets,
  correctionEffortOf,
  type HumanReview,
} from "./review-effort.js";

export const SCORECARD_KIND = "kurahi-eval-scorecard";
/**
 * v2 adds the optional `humanReview`, `correctionEffort` and `reviewTargets` fields (correction
 * effort, design §4.3). The change is additive: a v1 scorecard is a valid v2 scorecard without those
 * fields, and the manifest signing input is unchanged, so v1 scorecards still verify.
 */
export const SCORECARD_VERSION = 3 as const;
export const SUPPORTED_SCORECARD_VERSIONS: readonly number[] = [1, 2, 3];
export type ScorecardVersion = 1 | 2 | 3;
export const SCORECARD_FILE = "scorecard.json";
export const SCORECARD_MANIFEST = "manifest.json";
/** Superseded signed versions of a reviewed scorecard: revisions/r<N>/{scorecard,manifest}.json. */
export const SCORECARD_REVISIONS_DIR = "revisions";

export type FixtureScore = {
  fixture: string | null;
  /** 1-based attempt number when the run repeats each fixture (`--repeat k`). */
  attempt: number;
  jobId: string;
  evidence: { manifestSha256: string | null; signed: boolean; root: string | null };
  checks: CheckResult[];
  gates: { passed: boolean; failed: string[] };
  criticalFailed: string[];
  score: number;
  passed: boolean;
  cost: Record<string, number>;
  unmatchedToolCalls: number;
};

/**
 * Which models produced and judged this run (v3). An automated score is a joint measurement of
 * the subject and the evaluation design, so the score is only evidence together with these.
 */
export type ScorecardModels = {
  /** What produced the outputs: a provider/model, or `simulated` + the scripted driver in replay. */
  subject: { provider: string; model: string };
  /** One entry per `judge: model` check declared in the spec, whether or not it ran. */
  judges: Array<{
    checkId: string;
    model: string | null;
    rubricSha256: string | null;
    ran: boolean;
  }>;
};

export type Scorecard = {
  kind: typeof SCORECARD_KIND;
  version: ScorecardVersion;
  runId: string;
  workflow: string;
  mode: "replay" | "live" | "review";
  createdAt: string;
  runtime: { name: "Kurahi"; version: string };
  spec: { version: number; sha256: string; signature: string; signedBy: string | null };
  driver: string;
  /** Required from v3: the subject and judge models behind the score. */
  models?: ScorecardModels;
  fixtures: FixtureScore[];
  summary: {
    passed: boolean;
    gatesPassed: boolean;
    score: number;
    passThreshold: number;
    fixtures: number;
    /** Fixture runs (fixtures × k attempts). */
    attempts: number;
    /** Attempts that passed. */
    accepted: number;
  };
  metrics: {
    acceptedTaskRate: number;
    costPerAcceptedResult: Record<string, number> | null;
    reviewerMinutesPerItem: number | null;
    duplicateActions: number;
    unauthorisedActions: number;
    recoverySuccess: number | null;
  };
  /** Present on every scorecard; with k = 1 it restates the single attempt. */
  reliability: ReliabilitySection;
  /** Failure taxonomy counts over all failed checks of all attempts (design §4.5). */
  failureTags: Record<string, number>;
  provenance: string[];
  /** Correction-effort targets copied from the spec's `humanReview.targets` at run time (v2). */
  reviewTargets?: CorrectionEffortTargets;
  /** Human review records, appended by `kurahi eval review` (v2). */
  humanReview?: HumanReview[];
  /** Recomputed from `humanReview` on every review; verification recomputes and compares (v2). */
  correctionEffort?: CorrectionEffort;
};

export type FixtureReliability = {
  fixture: string;
  attempts: number;
  passes: number;
  /** Passed in at least one attempt. */
  passAtK: boolean;
  /** Passed in every attempt (headline). */
  passAllK: boolean;
  gatesHeldInAll: boolean;
  checkPassRates: Record<string, number>;
  scoreMean: number;
  scoreVariance: number;
};

export type ReliabilitySection = {
  k: number;
  /** Share of fixtures that passed in every attempt (pass^k, headline). */
  passAllK: number;
  /** Share of fixtures that passed in at least one attempt (pass@k). */
  passAtK: number;
  minPassAll: number;
  meetsThreshold: boolean;
  gatesHeldInAll: boolean;
  scoreMean: number;
  scoreVariance: number;
  fixtures: FixtureReliability[];
};

/** Reliability over attempts grouped by fixture. Population variance of the weighted score. */
export function reliabilityOf(
  attempts: FixtureScore[],
  k: number,
  minPassAll: number,
): ReliabilitySection {
  const byFixture = new Map<string, FixtureScore[]>();
  for (const a of attempts) {
    const id = a.fixture ?? "";
    byFixture.set(id, [...(byFixture.get(id) ?? []), a]);
  }
  const stats = (xs: number[]) => {
    const mean = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
    const variance = xs.length ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length : 0;
    return {
      mean: Math.round(mean * 10000) / 10000,
      variance: Math.round(variance * 10000) / 10000,
    };
  };
  const fixtures: FixtureReliability[] = [...byFixture.entries()].map(([fixture, runs]) => {
    const checkIds = [...new Set(runs.flatMap((r) => r.checks.map((c) => c.id)))];
    const checkPassRates = Object.fromEntries(
      checkIds.map((id) => {
        const scored = runs
          .map((r) => r.checks.find((c) => c.id === id))
          .filter((c) => c && c.status !== "skipped");
        const passed = scored.filter((c) => c?.status === "pass").length;
        return [id, scored.length === 0 ? 1 : Math.round((passed / scored.length) * 10000) / 10000];
      }),
    );
    const s = stats(runs.map((r) => r.score));
    const passes = runs.filter((r) => r.passed).length;
    return {
      fixture,
      attempts: runs.length,
      passes,
      passAtK: passes > 0,
      passAllK: passes === runs.length && runs.length > 0,
      gatesHeldInAll: runs.every((r) => r.gates.passed),
      checkPassRates,
      scoreMean: s.mean,
      scoreVariance: s.variance,
    };
  });
  const n = fixtures.length;
  const passAllK = n === 0 ? 0 : fixtures.filter((f) => f.passAllK).length / n;
  const passAtK = n === 0 ? 0 : fixtures.filter((f) => f.passAtK).length / n;
  const all = stats(attempts.map((a) => a.score));
  const gatesHeldInAll = attempts.every((a) => a.gates.passed);
  return {
    k,
    passAllK,
    passAtK,
    minPassAll,
    meetsThreshold: gatesHeldInAll && passAllK >= minPassAll,
    gatesHeldInAll,
    scoreMean: all.mean,
    scoreVariance: all.variance,
    fixtures,
  };
}

export type ScorecardManifest = {
  kind: typeof SCORECARD_KIND;
  version: ScorecardVersion;
  runId: string;
  workflow: string;
  createdAt: string;
  files: Record<string, { sha256: string; size: number }>;
  signer: ManifestSigner;
  signature: string;
};

/** Gates first, then the weighted quality score over non-gate, non-info, non-skipped checks. */
export function scoreChecks(
  checks: CheckResult[],
  passThreshold: number,
): Pick<FixtureScore, "gates" | "criticalFailed" | "score" | "passed"> {
  const gateFails = checks
    .filter((c) => c.severity === "gate" && c.status !== "pass")
    .map((c) => c.id);
  const criticalFailed = checks
    .filter((c) => c.severity === "critical" && c.status === "fail")
    .map((c) => c.id);
  const weighted = checks.filter(
    (c) => c.severity !== "gate" && c.severity !== "info" && c.status !== "skipped" && c.weight,
  );
  const total = weighted.reduce((a, c) => a + (c.weight ?? 0), 0);
  const got = weighted.reduce((a, c) => a + (c.status === "pass" ? (c.weight ?? 0) : 0), 0);
  const score = total === 0 ? 0 : Math.round((got / total) * 10000) / 100;
  return {
    gates: { passed: gateFails.length === 0, failed: gateFails },
    criticalFailed,
    score,
    passed: gateFails.length === 0 && criticalFailed.length === 0 && score >= passThreshold,
  };
}

function filesDigest(files: Record<string, { sha256: string; size: number }>): string {
  return sha256Hex(canonicalJson(files));
}

export function scorecardSigningInput(m: Omit<ScorecardManifest, "signer" | "signature">): string {
  return [m.kind, String(m.version), m.workflow, m.runId, m.createdAt, filesDigest(m.files)].join(
    "\n",
  );
}

export function resolveScorecardDir(
  workflow: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "eval", "scorecards", workflow, runId);
}

function writeAtomic(file: string, body: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function fileEntry(dir: string, name: string): { sha256: string; size: number } {
  const buf = fs.readFileSync(path.join(dir, name));
  return { sha256: sha256Hex(buf), size: buf.length };
}

/**
 * Write scorecard.json and its signed manifest. Returns the directory. `extraFiles` (paths relative
 * to `dir`, e.g. superseded revisions) are hashed into the same signed manifest.
 */
export function writeSignedScorecard(
  card: Scorecard,
  dir: string,
  key: SigningKey,
  extraFiles: string[] = [],
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(card, null, 2)}\n`;
  writeAtomic(path.join(dir, SCORECARD_FILE), body);
  const files: Record<string, { sha256: string; size: number }> = {
    [SCORECARD_FILE]: { sha256: sha256Hex(body), size: Buffer.byteLength(body) },
  };
  for (const name of extraFiles) {
    files[name] = fileEntry(dir, name);
  }
  const unsigned: Omit<ScorecardManifest, "signer" | "signature"> = {
    kind: SCORECARD_KIND,
    version: SCORECARD_VERSION,
    runId: card.runId,
    workflow: card.workflow,
    createdAt: card.createdAt,
    files,
  };
  const manifest: ScorecardManifest = {
    ...unsigned,
    signer: signerFromKey(key),
    signature: signDevicePayload(key.privateKeyPem, scorecardSigningInput(unsigned)),
  };
  writeAtomic(path.join(dir, SCORECARD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

export type ScorecardVerification = {
  ok: boolean;
  keyIdOk: boolean;
  signatureOk: boolean;
  filesOk: boolean;
  problems: string[];
  manifest: ScorecardManifest | null;
  scorecard: Scorecard | null;
};

/** Offline verification: file hashes, signer key id, Ed25519 signature, manifest/scorecard match. */
export function verifyScorecardDir(dir: string): ScorecardVerification {
  const problems: string[] = [];
  let manifest: ScorecardManifest | null = null;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(dir, SCORECARD_MANIFEST), "utf8"),
    ) as ScorecardManifest;
  } catch {
    return {
      ok: false,
      keyIdOk: false,
      signatureOk: false,
      filesOk: false,
      problems: ["manifest.json missing or not JSON"],
      manifest: null,
      scorecard: null,
    };
  }
  let filesOk = true;
  for (const [name, entry] of Object.entries(manifest.files ?? {})) {
    try {
      const buf = fs.readFileSync(path.join(dir, name));
      if (sha256Hex(buf) !== entry.sha256 || buf.length !== entry.size) {
        filesOk = false;
        problems.push(`${name}: content does not match the manifest`);
      }
    } catch {
      filesOk = false;
      problems.push(`${name}: missing`);
    }
  }
  if (!manifest.files?.[SCORECARD_FILE]) {
    filesOk = false;
    problems.push(`${SCORECARD_FILE} is not listed in the manifest`);
  }
  if (!SUPPORTED_SCORECARD_VERSIONS.includes(manifest.version)) {
    problems.push(`unsupported scorecard version ${String(manifest.version)}`);
  }
  for (const name of Object.keys(manifest.files ?? {})) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
      filesOk = false;
      problems.push(`${name}: path escapes the scorecard directory`);
    }
  }
  const signer = manifest.signer;
  const keyIdOk =
    signer?.alg === "ed25519" && deriveDeviceIdFromPublicKey(signer.publicKey) === signer.keyId;
  if (!keyIdOk) {
    problems.push("signer keyId does not match its public key");
  }
  let signatureOk = false;
  if (keyIdOk) {
    const { signer: _s, signature, ...unsigned } = manifest;
    try {
      signatureOk = verifyDeviceSignature(
        signer.publicKey,
        scorecardSigningInput(unsigned),
        signature,
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      problems.push("signature does not verify");
    }
  }
  let scorecard: Scorecard | null = null;
  try {
    scorecard = JSON.parse(fs.readFileSync(path.join(dir, SCORECARD_FILE), "utf8")) as Scorecard;
    if (scorecard.runId !== manifest.runId || scorecard.workflow !== manifest.workflow) {
      problems.push("scorecard run id or workflow differs from the manifest");
    }
    problems.push(...reviewConsistencyProblems(scorecard));
    problems.push(...modelProvenanceProblems(scorecard));
  } catch {
    problems.push("scorecard.json is not JSON");
  }
  const ok = filesOk && keyIdOk && signatureOk && problems.length === 0;
  return { ok, keyIdOk, signatureOk, filesOk, problems, manifest, scorecard };
}

/**
 * A signed scorecard must also be self-consistent: every review points at an attempt in the card,
 * and the stored correction-effort summary equals the one recomputed from the review records.
 */
/** v3: the score must say which models produced and judged it; v1/v2 cards predate the field. */
export function modelProvenanceProblems(card: Scorecard): string[] {
  if (card.version < 3) {
    return [];
  }
  const m = card.models;
  if (!m?.subject?.provider || !m.subject.model) {
    return ["v3 scorecard does not name the subject model"];
  }
  const problems: string[] = [];
  const judged = new Map(m.judges.map((j) => [j.checkId, j]));
  for (const f of card.fixtures) {
    for (const c of f.checks) {
      if (c.judge !== "model") {
        continue;
      }
      const j = judged.get(c.id);
      if (!j) {
        problems.push(`check ${c.id} is model-judged but has no judge entry`);
      } else if (c.status !== "skipped" && (!j.ran || !j.model)) {
        problems.push(`check ${c.id} was scored by a model judge that the scorecard does not name`);
      }
    }
  }
  return [...new Set(problems)];
}

export function reviewConsistencyProblems(card: Scorecard): string[] {
  const reviews = card.humanReview;
  if (reviews === undefined) {
    return card.correctionEffort === undefined
      ? []
      : ["correctionEffort present without humanReview records"];
  }
  const problems: string[] = [];
  for (const r of reviews) {
    if (!card.fixtures.some((f) => f.fixture === r.fixture && f.attempt === r.attempt)) {
      problems.push(`review ${r.id}: no attempt ${r.attempt} of task ${r.fixture} in this run`);
    }
  }
  const expected = correctionEffortOf(reviews, card.reviewTargets);
  if (canonicalJson(expected) !== canonicalJson(card.correctionEffort ?? null)) {
    problems.push("correctionEffort does not match the review records");
  }
  return problems;
}
