---
summary: "Workflow Evaluator (preview): acceptance specs, offline replay with simulated tools, signed scorecards"
read_when:
  - You want to measure whether an agent's work on a workflow is acceptable
  - You need a signed, offline-verifiable record of an evaluation
title: "Workflow Evaluator"
---

# Workflow Evaluator (preview)

The Workflow Evaluator scores the work an agent does on one workflow against a signed acceptance
spec. Checks are deterministic and read the job's signed evidence and its declared outputs. Security
checks (unauthorised actions, missing approvals, duplicate consequential actions) are pass/fail
gates and are never averaged into the quality score. A model-based judge can be added only as an
informational check; it is never a gate and never the only check on an output.

What this release includes:

- **Acceptance specs** (`spec.yaml`): fixtures with SHA-256 digests, outputs, consequential actions,
  checks with severities and weights, signed with the policy owner key (`kurahi eval spec sign`).
- **Deterministic checks**: `noDeniedOrUnlisted`, `approvalBeforeAction`, `noDuplicateActions`,
  `deadline`, `valueMatch`, `setMatch` (precision, recall, F1), `coverage`, `citationsPresent`,
  `schemaValid`.
- **Offline replay** against golden fixtures, with simulated tools: reads come from the fixture,
  writes go to a scratch workspace, and consequential actions are recorded but never performed.
- **Signed scorecards**: Ed25519, verified offline with `kurahi eval report --verify <dir>`.
- **Reliability across repeated runs**: `kurahi eval run <workflow> --repeat k` runs each fixture k
  times. The scorecard reports pass^k (passed every time, the headline) and pass@k (passed at least
  once), per-check pass rates and the variance of the score. Gates must hold in all k attempts. The
  spec can set `reliability: { repeat, minPassAll }`. The bundled scripted driver is deterministic,
  so its attempts are identical; repeated runs matter for model-driven drivers.
- **Failure tags** on failed checks (`policy-violation`, `latency`, `loop`, `tool-error`,
  `planning`, `wrong-context`), counted in the scorecard.
- **Correction effort**: a pass rate alone overstates the value of an agent's work when the time a
  person spends checking and fixing it is left out. `kurahi eval review` (example below) records a
  human review of one task on a scorecard: reviewer, review and fix minutes, a line-level diff size
  between the agent's output and the accepted output (`--diff-from`, `--diff-to`), and the verdict
  (`--accepted as-is`, `edited` or `rejected`). The scorecard gains a `correctionEffort` summary per
  task and per run (median and p90 of review plus fix minutes, share accepted unchanged, edited and
  rejected), shown by `kurahi eval report` next to pass^k. A spec can set `humanReview.targets`
  (`medianMinutes`, `p90Minutes`, `minAcceptedUnchanged`). Effort is aggregated per task and per
  run, never per reviewer.
- **Re-signing after a review**: the scorecard must verify before a review is recorded; the new
  scorecard is signed again, the superseded version is kept under `revisions/r<N>/` and hashed into
  the new manifest, and each review records the SHA-256 of the scorecard it amended. Verification
  also recomputes the correction-effort summary from the review records.
- **Model provenance**: an automated score measures the model and the evaluation design together,
  so the score is only evidence with its configuration. Scorecards are now version 3: a signed
  `models` section names the subject (provider and model, or `simulated` and the scripted driver in
  replay) and every `judge: model` check (judge model, SHA-256 of the rubric, whether it ran).
  Verification rejects a version 3 scorecard that names no subject, a model-judged check without a
  judge entry, or a check scored by a judge the scorecard does not name. Version 1 and 2 scorecards
  still verify, and a review keeps a scorecard without `models` at version 2.

Not in this release: live scoring of production jobs, the review sampler, the change gate and shadow
mode (`kurahi eval score` and `gate` report that they are not available).

```bash
kurahi eval spec init csv-inspection.exceptions   # copy the bundled example to <KOLO_HOME>/eval/specs
kurahi eval spec lint csv-inspection.exceptions
kurahi eval spec sign csv-inspection.exceptions
kurahi eval run csv-inspection.exceptions --require-signed
kurahi eval report csv-inspection.exceptions --verify <scorecard dir>
kurahi eval review <run id> --task line3-clean --minutes-review 6 --minutes-fix 4 --accepted edited \
  --diff-from agent.json --diff-to accepted.json
```

Exit codes: 0 pass · 1 quality fail · 2 security gate fail · 3 spec or provenance invalid · 4 usage.

The bundled example `csv-inspection.exceptions` uses fictional data: a day's inspection CSV from a
production line (1,240 rows) with 7 out-of-tolerance readings, and a clean file.
