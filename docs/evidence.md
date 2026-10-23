---
summary: "Evidence bundles: a signed, hash-chained record of every agent job that an auditor can replay and verify offline"
read_when:
  - You need to show what an agent did, which files it touched and which policy decisions applied
  - You are verifying a bundle someone sent you
  - You want to turn evidence off, cap it, or shorten how long it is kept
title: "Evidence bundles"
---

# Evidence bundles

Every agent run is a [job](/cli/jobs). While a job runs, the gateway appends an ordered, hash-chained
event log for it under `KOLO_HOME/evidence/<jobId>/events.jsonl`. When the job ends, the log is
closed with the outcome and a manifest is signed with the gateway's Ed25519 continuity key (the same
key that signs [continuity manifests](/continuity)). A bundle is that log plus everything needed to
check it without the gateway: `kurahi evidence verify` recomputes every hash and both signatures from
the bundle's own files.

## What is recorded

| Event         | Fields                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job.start`   | agent, session, kind, provider and model requested, run id, workspace, SHA-256 and length of the prompt, SHA-256 of the policy in force and the inventory configuration digest |
| `model.turn`  | provider, model, token usage, stop reason, SHA-256 and length of the assistant text, a redacted excerpt (512 bytes)                                                            |
| `tool.call`   | tool name, meta, SHA-256 of the arguments, the arguments redacted and bounded                                                                                                  |
| `tool.result` | SHA-256 and length of the result, the result text redacted and bounded, duration, error flag                                                                                   |
| `snapshot`    | id and file list of the [pre-edit snapshot](/tools/snapshots) taken before an edit tool ran                                                                                    |
| `permission`  | allow or deny from the [permission rules](/agents-permissions), class, target, matching rule                                                                                   |
| `approval`    | a human decision on a policy approval request: tool, allow or deny, rule, approval id, approver, SHA-256 of the arguments                                                      |
| `loop_guard`  | reason, summary, step count and limits when the loop guard stopped the run                                                                                                     |
| `audit`       | seq and hash of an [audit chain](/cli/security) entry written for this job (loop stop, denial)                                                                                 |
| `truncated`   | the log hit `evidence.maxEvents` or `evidence.maxBytesPerJob`; only `job.end` follows                                                                                          |
| `job.end`     | status, steps, tool calls, duration, error, summary, declared outputs (path and SHA-256), cost snapshot (tokens per model priced from the KODA tested catalogue, price date)   |

Every line carries `seq`, `ts`, `prev` (hash of the previous line, 64 zeros for the first) and `hash`
(`sha256(prev + "\n" + canonical JSON of the line without prev and hash)`). Editing, removing,
reordering or appending a line breaks the chain from that point.

The model's reasoning is **not** recorded unless `evidence.includeReasoning` is `true`; then each
`model.turn` carries `reasoningDigest` (SHA-256 of the raw text), `reasoningChars` and the redacted
`reasoning`, cut to `evidence.maxEventBytes` (`reasoningClipped` when cut).

Prompts and full assistant text are **not** stored unless `evidence.includePrompts` is `true`; the
digests let an auditor confirm a prompt they are shown is the one that ran. Tool arguments and
results go through the audit redactor (secret-looking keys, token patterns, PEM blocks) and are cut to
`evidence.maxEventBytes`. The full [privacy statement](/security/privacy) lists what a bundle never
contains.

## Commands

```bash
kurahi evidence list                                  # jobs with evidence, newest first
kurahi evidence show <jobId>                          # counts, files, policy decisions, signing key
kurahi evidence export <jobId> --out ./out/<jobId>.zip   # or a directory
kurahi evidence verify ./out/<jobId>.zip              # exit 0 on PASS, 1 on any failure
kurahi evidence replay ./out/<jobId>.zip --step 4     # the job's state after event 4
kurahi evidence replay <jobId>                        # interactive: n, p, j <step>, q
kurahi evidence prune --days 30 --dry-run             # retention
```

In the terminal UI, `/evidence <jobId>` opens the same stepper; `/evidence next`, `/evidence prev` and
`/evidence jump <step>` move through it.

## Bundle layout

| File                                                 | Content                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.json`                                      | job identity and outcome, `events.count` and `events.root`, SHA-256 and size of every other file, the signer (`alg`, `keyId`, raw public key), the export signature, and under `recorded` the signature the recorder made at job end |
| `events.jsonl`                                       | the event log, byte for byte as recorded                                                                                                                                                                                             |
| `audit-slice.jsonl`                                  | audit entries written during the job for its session or job id; each keeps its own `prev` and `hash`                                                                                                                                 |
| `snapshots/index.json`, `snapshots/objects/<sha256>` | pre-edit file contents the job's snapshots captured, content-addressed                                                                                                                                                               |
| `REPORT.md`                                          | what was asked, what was done, files changed, tools run, policy decisions, how to verify                                                                                                                                             |

## Verifying a bundle as a third party

You need the bundle and a copy of `kolo` (any machine, no gateway, no network):

```bash
kurahi evidence verify ./bundle.zip
```

What it checks, and what you can recompute yourself with a JSON parser and SHA-256:

1. **Chain.** For each line of `events.jsonl` in order: `seq` increases by one; `prev` equals the
   previous line's `hash`; `hash` equals `sha256(prev + "\n" + canonicalJson({seq, ts, type, jobId, data}))`
   where canonical JSON sorts object keys recursively and has no whitespace.
2. **Root and count.** The last `hash` equals `manifest.events.root`; the number of lines equals
   `manifest.events.count`; the last line is `job.end` and its status equals `manifest.status`.
3. **Files.** Every path under `manifest.files` exists with the listed SHA-256 and size; the bundle holds
   no file that is not listed (other than `manifest.json` itself).
4. **Signer.** `signer.alg` is `ed25519` and `sha256(base64url-decode(signer.publicKey))` in hex equals
   `signer.keyId`.
5. **Export signature.** `signature` verifies with `signer.publicKey` over the string

   ```
   kolo-evidence-manifest\n1\n<jobId>\n<status>\n<endedAt>\n<createdAt>\n<events.count>\n<events.root>\n<sha256(canonicalJson(files))>
   ```

6. **Job-end signature.** `recorded.signature` verifies with `recorded.signer.publicKey` over the same
   layout with `recorded.createdAt`, `recorded.count`, `recorded.root` and a `files` map holding only
   `events.jsonl`; `recorded.root` equals `events.root`. This ties the exported log to what the gateway
   signed the moment the job ended, so an export cannot quietly carry a different log.
7. **Audit slice.** Every line's `hash` recomputes from its canonical form (the same rule the audit log
   uses); lines are in `seq` order. To tie them to the full audit log, compare `seq` and `hash` with
   `kurahi audit tail` or `GET /api/audit/chain?seq=<n>` on the gateway.
8. **Snapshots.** Each object under `snapshots/objects/` hashes to its own name, and every included
   entry in `snapshots/index.json` points at an existing object.

Compare `signer.keyId` with the key the operator publishes (`GET /api/continuity/manifest` shows the
same `keyId`). A bundle that verifies with an unknown key proves internal consistency, not origin.

### What a bundle proves, and what it does not

- It proves the recorded sequence of model turns, tool calls, file snapshots and policy decisions has
  not changed since the gateway signed it, and that the export is the same log.
- It does not prove the gateway recorded everything: a tool that bypasses the runtime, a process the
  agent started outside the tool layer, or a log cut by the size cap (`truncated`) is outside it.
- The signing key lives on the gateway host (`KOLO_HOME/identity/continuity-signing.json`, mode 0600).
  Whoever controls that host can sign a different log; the key id and the audit chain are what let an
  auditor notice.
- Redaction is pattern-based. A secret in an unusual format may reach the log; `evidence.maxEventBytes`
  and `includePrompts: false` (the default) limit what is stored at all.

## API

| Operation               | Route                                                   | Scope    |
| ----------------------- | ------------------------------------------------------- | -------- | ----- |
| `getJobEvidence`        | `GET /api/jobs/{id}/evidence`                           | attach   |
| `listJobEvidenceEvents` | `GET /api/jobs/{id}/evidence/events?from=&limit=`       | attach   |
| `exportJobEvidence`     | `POST /api/jobs/{id}/evidence/export` (`{"format":"zip" | "dir"}`) | admin |
| `getEvidenceView`       | `GET /evidence/{id}` (HTML, read-only)                  | attach   |

A paired credential restricted to sessions sees only the jobs of those sessions. Exports requested
through the API are written under `KOLO_HOME/evidence-exports/` on the gateway host and audited as
`evidence.export`.

## Configuration

```json5
{
  evidence: {
    enabled: true, // default true
    includePrompts: false, // store the raw prompt and assistant text (bounded)
    maxEvents: 5000, // per job
    maxEventBytes: 8192, // per argument, result or excerpt
    maxBytesPerJob: 16777216,
    retentionDays: 30, // kurahi evidence prune, and once per gateway start
  },
}
```

Retention runs once per gateway process at the first job and on `kurahi evidence prune`. A job that is
still running is never removed.
