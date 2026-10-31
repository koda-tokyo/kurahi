---
summary: "Modernisation verification in Kurahi Industrial: immutable source snapshots, a local runner that compiles and executes baseline and candidate on the same fixtures (GnuCOBOL, gfortran), deterministic comparators, explicit non-success verdicts, change cases with scope-hashed approvals, and signed evidence for every outcome"
read_when:
  - Checking that a COBOL or FORTRAN change behaves as intended before handoff
  - Explaining what a verification verdict proves and what it does not
  - Verifying a verification evidence bundle offline
title: "Modernisation verification"
---

# Modernisation verification

日本語: [モダナイゼーションの検証](/ja/industrial/verification)

A modernisation change is only as good as the evidence that it does what was intended and nothing
else. Kurahi Industrial checks this by execution: the original program (baseline) and the changed
program (candidate) are compiled from frozen snapshots, run on the same inputs, and their outputs
compared by deterministic rules. No language model takes part in the verdict.

Status as of 1 November 2026: R1 subset (KIMS-010, 013, 014, 015, 017), on the branch for the next
Industrial release.

## What it proves, and what it does not

| A verdict shows                                                                                             | It does not show                                                                  |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Which source snapshots (SHA-256 of every file), compiler, flags, fixtures, comparators and limits were used | That the candidate is correct for inputs the fixtures do not exercise             |
| What each side printed, wrote and returned on those fixtures, and how the outputs differ                    | That the business rules were fully recovered, or that an explanation is true      |
| That every difference is covered by the approved change spec (PASS), or which ones are not (FAIL)           | Behaviour on the production platform (z/OS, EBCDIC, CICS, Db2, VSAM, JCL restart) |
| That the record was not altered since it was signed (`kurahi evidence verify`)                              | Performance, concurrency or behaviour under production-shaped load                |

Signed evidence is a tamper-evident record of what ran. It is not a proof of semantic correctness
beyond the tested fixtures. The FORTRAN fixture shows why: the injected single-precision regression
changes the payment on one loan and not on another, so a fixture set without the second loan would
have reported PASS.

## Supported languages and toolchains

| Language | Toolchain                         | Execution                                                                                                                          |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| COBOL    | GnuCOBOL `cobc -x` (tested 3.1.2) | Yes. Dialect (`-std=`) and flags are recorded and part of the snapshot and policy identity. Copybook folders are passed with `-I`. |
| FORTRAN  | `gfortran` (tested 13.3)          | Yes. All sources in one invocation, the `program` unit first.                                                                      |
| PL/I     | none available                    | No. Analysis works (`modernise_inventory kind pli`); execution reports `NOT_RUN_COMPILER_UNAVAILABLE`.                             |

GnuCOBOL is not IBM Enterprise COBOL: dialect options narrow the gap but do not close it (EBCDIC,
`COMP` byte order, compiler-specific truncation). A PASS on GnuCOBOL is evidence about GnuCOBOL.

## How a run works

The runner contract is `prepare → execute_baseline → execute_candidate → compare → report`:

1. **Snapshot.** Both folders are frozen into the Project's data area, content-addressed:
   every file with its SHA-256, size, observed encoding (`ascii`, `utf-8`, `unknown-8bit`,
   `binary`) and line endings (`lf`, `crlf`, `cr`, `mixed`), plus the toolchain identity (compiler
   path, version line, binary SHA-256, dialect, flags). The snapshot id is the SHA-256 of that
   manifest, so the same content gives the same id and any change gives a new one. Objects are
   written once and never overwritten. Symbolic links are not followed; `output/` and hidden
   folders are not part of the scope.
2. **Prepare.** Both snapshots are re-hashed; the language and compiler are resolved; fixtures are
   loaded and digested. Builds read from the snapshot store, never from the live folders.
3. **Execute.** Each side is compiled in its own scratch folder and run once per fixture case
   (the baseline twice by default, to prove it is reproducible). Exit code, stdout, stderr and every
   file the program creates or changes are captured.
4. **Compare.** Baseline outputs must match the case's golden outputs and themselves across runs;
   then each output is compared with its comparator.
5. **Report.** The verdict, findings, digests and limits are sealed as signed evidence.

### Fixtures

A fixtures folder holds one sub-folder per case:

```text
fixtures/
  week-01/
    stdin          optional: standard input
    args           optional: one argument per line
    files/         input files placed in the run folder
    golden/        outputs the baseline must reproduce exactly (stdout, exit, PAYOUT.DAT …)
```

### Comparators and change specs

Without a change spec every output is compared byte for byte, and every difference is a
regression. A change spec (JSON) chooses a comparator per output and declares the approved
intended differences:

| Comparator        | Use                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact` (default) | Bytes                                                                                                                                                                                                                                                                                                                                               |
| `text`            | Records (lines); CRLF and LF are the same boundary; optional `trimTrailing`                                                                                                                                                                                                                                                                         |
| `fields`          | Fixed-position fields per record (lines, or `recordLength` for binary files): `text`, `decimal` (display: sign leading or trailing, point or implied `scale`, CR/DB) and `packed` (COMP-3). `tolerance` is explicit and defaults to `0`; `-0` and `+0` differ unless `signedZero: "equal"`. Bytes outside the declared fields are compared exactly. |

An intended entry names the output and can narrow it by fixtures, fields, record keys
(`keyField`) or record numbers, and can give the exact `expected` output the candidate must now
produce. Each difference is classed:

- `EQUIVALENT`: no difference under the comparator.
- `INTENDED_CHANGE`: the difference is covered by an intended entry, and any `expected` output matches.
- `REGRESSION`: any other difference, including a change to a covered field that does not produce the approved expectation.

The change spec, including the digests of its expected outputs, is hashed into the report and into
the approval scope, so a tolerance or an intended difference is approved together with the change.

### Verdicts

| Verdict                        | When                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`                         | Both sides built, every fixture ran, the baseline is stable, every difference is an approved intended change                                            |
| `FAIL`                         | A regression, or the candidate does not build                                                                                                           |
| `INCONCLUSIVE`                 | The baseline does not build, is not reproducible or misses its golden output; an output hit its cap; an intended change is not exercised by any fixture |
| `NOT_RUN_COMPILER_UNAVAILABLE` | No compiler for the language (always for PL/I here)                                                                                                     |
| `NOT_RUN_NO_FIXTURES`          | No fixture cases                                                                                                                                        |
| `TIMEOUT`                      | A compile or execution exceeded the time limit                                                                                                          |
| `CANCELLED`                    | The run was aborted (the process group is killed)                                                                                                       |

Missing compilers, missing fixtures, timeouts and cancellations are never reported as PASS, and
each one still produces signed evidence.

## Isolation level

Stated plainly, so that nobody reads more into it:

- Each compile and execution runs in a fresh scratch folder under the OS temp directory, removed afterwards.
- The environment is fixed and minimal: `LC_ALL=C`, `TZ=UTC`, nothing inherited (compiles also get a `PATH` to the toolchain).
- Wall-clock timeout (default 60 s) and output caps (default 4 MiB per stream or file); the whole process group is killed on timeout, cap or cancellation.
- Where `prlimit` exists: CPU seconds, file size and open-file limits on executions.
- Where unprivileged user namespaces work (`unshare -rn`): executions run in an empty network namespace, so they cannot reach the network. Where they do not, the report says `network NOT isolated`.
- It is **not** a container or virtual machine. The program runs as the same OS user and can read what that user can read. Run only trusted or synthetic source this way, or run Kurahi itself in a container.

Every report records the isolation level that actually applied.

## Change cases and approvals

A change case ties a baseline snapshot, a candidate snapshot, a change spec, a verification policy,
the fixture digest and its test runs to an approval. It follows the state machine of the KIMS
specification (`DRAFT → SNAPSHOT_FROZEN → … → TEST_REVIEW → APPROVAL_PENDING →
APPROVED_FOR_HANDOFF → EXPORTED`, with `BLOCKED`, `FAILED`, `CANCELLED`, `REJECTED` and
`RECONCILIATION_REQUIRED`); other transitions are refused.

- Approval needs a valid `PASS` run. The approver must hold the approver role and must not be the case owner or the person who requested the approval.
- The approval stores a scope hash over baseline, candidate, change spec, policy, fixtures and the test run report. A new candidate, change spec, policy or fixture set invalidates approvals and test runs and returns the case to `CHANGE_PROPOSED`.
- Handoff re-checks the approval: still valid, not expired, scope hash equal to the case as it is now, snapshots intact, and the live candidate folder unchanged since the freeze. A stale approval is invalidated and the handoff refused.
- `APPROVED_FOR_HANDOFF` is the highest R1 state. `EXPORTED` writes a handoff manifest (`deployed: false`); Kurahi does not deploy. A deployment needs its own authorisation and evidence.

Each approval, rejection, invalidation, terminal transition and handoff is sealed as signed
evidence under the case.

## Using it

As an agent tool in an Industrial Project (実行 Act mode only, because it executes the compiled
programs; paths must be inside the Project folder):

```text
modernise_verify baseline=src/v1 candidate=src/v2 fixtures=tests/payroll change_spec=specs/CHG-001.json
```

From the command line:

```bash
kurahi legacy verify \
  --baseline test/fixtures/modernisation/cobol-payroll/baseline \
  --candidate test/fixtures/modernisation/cobol-payroll/candidate-threshold \
  --fixtures test/fixtures/modernisation/cobol-payroll/fixtures \
  --change-spec test/fixtures/modernisation/cobol-payroll/change-spec-chg001.json
```

Options: `--entry`, `--dialect`, `--flag`, `--timeout`, `--project <id>` (store in that Project's
data area) or `--data <dir>`, `--json`. Exit code 0 only on PASS.

Snapshots, runs and cases are stored under the Project's data area
(`<KOLO_HOME>/projects/<id>/modernisation/`), never in the source folders.

## Verifying the evidence offline

Each run directory is a standard evidence bundle: `events.jsonl` (hash-chained), `manifest.json`
(Ed25519-signed, every file with its SHA-256), `report.json`, `REPORT.md`, the two snapshot
manifests, the change spec and the captured outputs (outputs over 1 MiB are not copied into the
bundle; their SHA-256 is in `report.json` and the omission is listed in the events).

```bash
kurahi evidence verify <run-dir> --trust-key <keyId>
```

Without `--trust-key` the verifier proves the bundle is internally consistent and signed by the key
it names. With `--trust-key` it also requires that key to be one you trust, so a bundle edited and
re-signed with another key fails. Altering a captured output, the report or the manifest fails
verification.

## Synthetic fixtures

`test/fixtures/modernisation/` holds synthetic programs written for Kurahi (MIT):

- `cobol-payroll`: payroll with a copybook, COMP-3 packed decimal, `ROUNDED`, signed adjustments, 88-levels; two fixture cases (`week-01`, `edge-zero` for zero and negative-zero amounts) with golden outputs; `candidate-threshold` (CHG-001, overtime threshold 40.0 → 45.0 hours, with `change-spec-chg001.json` and its expected outputs) and `candidate-regression` (CHG-001 plus `ROUNDED` dropped from tax).
- `fortran-loan`: loan amortisation with an external payment function; `candidate-equivalent` (refactor) and `candidate-regression` (single-precision discount factor).
- `pli-payroll`: PL/I with `%INCLUDE`, for analysis and the `NOT_RUN_COMPILER_UNAVAILABLE` path.

Results from the real toolchains on these fixtures: CHG-001 → PASS (3 intended outputs, 7
equivalent); the regression candidate → FAIL (record E00001 tax 179.56 → 179.55); FORTRAN refactor →
PASS; FORTRAN regression → FAIL on `loan-b` only; PL/I → `NOT_RUN_COMPILER_UNAVAILABLE`.
