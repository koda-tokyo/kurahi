// Workflow Evaluator: record a human review on a signed scorecard and re-sign it (design §4.3).
//
// The scorecard must verify before it is amended: re-signing an edited scorecard would launder the
// edit. The superseded scorecard.json and manifest.json move to revisions/r<N>/ and are hashed into
// the new signed manifest, and the review records the SHA-256 of the scorecard it amended.
import fs from "node:fs";
import path from "node:path";
import type { SigningKey } from "../continuity-suite/manifest.js";
import { sha256Hex } from "../continuity-suite/manifest.js";
import {
  correctionEffortOf,
  type DiffSize,
  diffSizeOfFiles,
  type HumanReview,
  REVIEW_VERDICTS,
  type ReviewVerdict,
  reviewerMinutesPerItem,
} from "./review-effort.js";
import {
  type Scorecard,
  SCORECARD_FILE,
  SCORECARD_MANIFEST,
  SCORECARD_REVISIONS_DIR,
  SCORECARD_VERSION,
  verifyScorecardDir,
  writeSignedScorecard,
} from "./scorecard.js";

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly kind: "usage" | "invalid" = "usage",
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export type ReviewInput = {
  task: string;
  attempt?: number;
  reviewer: string;
  minutesReview: number;
  minutesFix: number;
  verdict: ReviewVerdict;
  reason?: string;
  diffFrom?: string;
  diffTo?: string;
};

export type ReviewResult = { dir: string; scorecard: Scorecard; review: HumanReview };

/** Minutes are recorded to 0.1 min; 0 ≤ m ≤ 24 h. */
export function parseMinutes(raw: string | number | undefined, flag: string): number {
  const n = typeof raw === "number" ? raw : Number((raw ?? "").trim());
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n < 0 || n > 1440) {
    throw new ReviewError(`${flag} must be a number of minutes between 0 and 1440`);
  }
  return Math.round(n * 10) / 10;
}

function validate(input: ReviewInput, diff: DiffSize | null) {
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new ReviewError(`unknown verdict ${String(input.verdict)}`);
  }
  if (!input.reviewer.trim()) {
    throw new ReviewError("a review needs a reviewer");
  }
  if ((input.diffFrom === undefined) !== (input.diffTo === undefined)) {
    throw new ReviewError("--diff-from and --diff-to go together");
  }
  if (input.verdict === "accepted-as-is") {
    if (input.minutesFix > 0) {
      throw new ReviewError("accepted as-is with fix minutes > 0: use --accepted edited");
    }
    if (diff && diff.editDistance > 0) {
      throw new ReviewError(
        `accepted as-is but the accepted output differs by ${diff.editDistance} line(s): use --accepted edited`,
      );
    }
  }
  if (input.verdict === "accepted-after-edits" && diff && diff.editDistance === 0) {
    throw new ReviewError(
      "accepted after edits but the outputs are identical: use --accepted as-is",
    );
  }
}

export function recordReview(
  dir: string,
  input: ReviewInput,
  key: SigningKey,
  now: Date = new Date(),
): ReviewResult {
  const v = verifyScorecardDir(dir);
  if (!v.ok || !v.scorecard) {
    throw new ReviewError(
      `scorecard does not verify, refusing to re-sign: ${v.problems.join("; ")}`,
      "invalid",
    );
  }
  const card = v.scorecard;
  const attempts = card.fixtures.filter((f) => f.fixture === input.task);
  if (attempts.length === 0) {
    const known = [...new Set(card.fixtures.map((f) => f.fixture))].join(", ");
    throw new ReviewError(`no task ${input.task} in run ${card.runId} (tasks: ${known})`);
  }
  const attempt = input.attempt ?? 1;
  if (!attempts.some((f) => f.attempt === attempt)) {
    throw new ReviewError(
      `task ${input.task} has attempts 1..${attempts.length} in run ${card.runId}, not ${attempt}`,
    );
  }
  let diff: DiffSize | null = null;
  if (input.diffFrom !== undefined && input.diffTo !== undefined) {
    try {
      diff = diffSizeOfFiles(input.diffFrom, input.diffTo);
    } catch (err) {
      throw new ReviewError(`cannot diff: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  validate(input, diff);

  const priorBody = fs.readFileSync(path.join(dir, SCORECARD_FILE));
  const prior = card.humanReview ?? [];
  const review: HumanReview = {
    id: `rv-${prior.length + 1}`,
    fixture: input.task,
    attempt,
    reviewer: input.reviewer.trim(),
    recordedAt: now.toISOString(),
    minutesReview: input.minutesReview,
    minutesFix: input.minutesFix,
    verdict: input.verdict,
    ...(input.reason ? { reason: input.reason } : {}),
    diff,
    priorScorecardSha256: sha256Hex(priorBody),
  };
  const humanReview = [...prior, review];
  const next: Scorecard = {
    ...card,
    // A review never upgrades past what the run recorded: a card without models stays v2.
    version: card.models ? SCORECARD_VERSION : 2,
    metrics: { ...card.metrics, reviewerMinutesPerItem: reviewerMinutesPerItem(humanReview) },
    humanReview,
    correctionEffort: correctionEffortOf(humanReview, card.reviewTargets),
  };

  // Keep the superseded signed version, and carry earlier revisions into the new manifest.
  const carried = Object.keys(v.manifest?.files ?? {}).filter((f) =>
    f.startsWith(`${SCORECARD_REVISIONS_DIR}/`),
  );
  const rev = `${SCORECARD_REVISIONS_DIR}/r${prior.length + 1}`;
  fs.mkdirSync(path.join(dir, rev), { recursive: true, mode: 0o700 });
  for (const f of [SCORECARD_FILE, SCORECARD_MANIFEST]) {
    fs.copyFileSync(path.join(dir, f), path.join(dir, rev, f));
  }
  writeSignedScorecard(next, dir, key, [
    ...carried,
    `${rev}/${SCORECARD_FILE}`,
    `${rev}/${SCORECARD_MANIFEST}`,
  ]);
  return { dir, scorecard: next, review };
}
