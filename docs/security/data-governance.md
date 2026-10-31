---
summary: "Data governance: retention per data class with a deterministic sweeper, legal holds, signed eDiscovery exports, the APPI / My Number guard on outbound tools, and data subject requests"
read_when:
  - Answering a legal, audit or compliance review about how long Kurahi keeps data
  - Placing a legal hold or producing records for litigation or an audit
  - Handling a data subject request under APPI
  - Configuring the personal data guard for a Project
title: "Data governance"
---

# Data governance

Also available in [Japanese](/ja/security/data-governance).

Legal and audit departments ask four questions of any system that keeps business records: how
long is each kind of record kept, can deletion be stopped for a matter, can everything about a
matter be produced in a form a third party can verify, and what stops personal data from leaving.
Kurahi answers each with a mechanism that runs without a model and leaves signed evidence.

## Data classes

| Class             | What it is                                                                          | Anonymize | Age is measured from |
| ----------------- | ----------------------------------------------------------------------------------- | --------- | -------------------- |
| `transcripts`     | conversation transcripts (`KOLO_HOME/agents/<id>/sessions/`)                        | yes       | last write           |
| `workitems`       | work items with their history (closed items only: done, cancelled)                  | yes       | last update          |
| `evidence`        | job evidence bundles and work item transition bundles (closed items only)           | no        | job end              |
| `audit`           | the hash-chained audit log (organisation-wide, whole months)                        | no        | month end            |
| `attachments`     | uploaded files and accepted mail attachments (`attachments/`, `inbox-attachments/`) | no        | last write           |
| `outputs`         | generated outputs (artifacts)                                                       | no        | last version         |
| `memory`          | decided memory quarantine records                                                   | yes       | decision             |
| `connectorCaches` | files under `KOLO_HOME/connectors/<id>/cache/`                                      | no        | last write           |

Built-in connectors are read-through and keep no cache today; the class exists so that a connector
that adds one is governed from the first file.

## Retention

Each class has a rule: `keepDays` (a number, or `null` for indefinite) and a `mode`, `delete` or
`anonymize`. The organisation default lives in config; a Project may override every class except
`audit`, which is one chain for the installation.

```json5
{
  governance: {
    retention: {
      transcripts: { keepDays: 365, mode: "anonymize" },
      workitems: { keepDays: 2555 }, // 7 years
      attachments: { keepDays: 730 },
      evidence: { keepDays: 2555 },
      audit: { keepDays: 2555 },
    },
    minimumRetentionDays: { audit: 2555, evidence: 2555 },
    sweep: { enabled: true, hourUtc: 18 }, // 03:00 JST
  },
}
```

- The default for every class is **indefinite**: nothing is deleted until a rule says so.
- **Minimum for evidence and audit.** `minimumRetentionDays` (default 365 days each) is a floor.
  A Project override below it is refused (`retention_below_minimum`); a config value below it is
  raised to it. With `governance` configured, `kurahi evidence prune` also respects it.
- **Anonymize** keeps structure and replaces content. A work item keeps its id, status, dates,
  route, approvals count and evidence references; title, summary, form values, comments and
  source document names are replaced, and people become stable pseudonyms (`anon:<12 hex>`, keyed
  per installation). A transcript keeps every line, role, id and timestamp; message text and tool
  payloads become `[anonymized]`. Classes that cannot keep structure are always deleted.
- **Per Project**: `governance.policy.set` (person-only) replaces a Project's override;
  `governance.policy.get` shows the effective policy.

### The sweeper

The sweeper runs once per UTC day after `governance.sweep.hourUtc` from the gateway's maintenance
timer, or on demand with `governance.retention.run` (person-only; `dryRun` defaults to `true`) or
`kurahi governance sweep [--dry-run]` on the gateway host. It is deterministic: no model, no
network, sorted directory order. For every record it applies the rule of the record's Project and
skips a record that is younger than its rule, not eligible (an open work item, a running job) or
covered by an active legal hold.

Every run that changes anything writes a **deletion manifest**: a signed evidence bundle at
`KOLO_HOME/evidence/gov-retention-<time>/` that lists, per class, the mode, the counts (deleted,
anonymized, held, failed), the time range of the records and the SHA-256 of every record id. It
never lists names, titles or content. Verify it like any bundle with `kurahi evidence verify`.
Deletion manifests are never expired. The run is also audited as `governance.retention.sweep`.

## Evidence tombstones

Evidence must not be deleted in a way that makes the remaining evidence unverifiable. Kurahi
never removes an evidence bundle without leaving a **tombstone**:

- Job evidence: the job's directory is removed and `KOLO_HOME/evidence/_tombstones/<jobId>.json`
  is written.
- Work item evidence: the bundle directory keeps its name (`0003-decide`) and its contents are
  replaced by `tombstone.json`.

A tombstone keeps the bundle's **original signed manifest** (job id, status, times, event count,
chain root, SHA-256 of every file, the recorder's Ed25519 signature), the SHA-256 of the manifest
file, the `prevBundle` / `prevRoot` link the bundle's first event named, when and why it was
deleted (`retention`, `dsr`, `prune`) and the deletion manifest id. The tombstone itself is signed
with the installation's evidence key.

This keeps the chain verifiable:

1. The original manifest signature covers the manifest fields, not the deleted events, so it still
   verifies: the bundle provably existed, ended with that status and had that chain root.
2. A work item's bundles are a chain: bundle N's first event names bundle N-1's root. The
   verifier (`workitems.evidence`, the export report) reads a tombstoned bundle's root from the
   tombstone and its link from the recorded `prevRoot`, so the chain verifies across the gap. A new
   transition after a deletion links to the tombstone's root.
3. A changed tombstone fails its own signature; a tombstone that claims a different root fails
   the original manifest check. Only the events themselves can no longer be re-hashed, which is
   exactly what retention removed.

## Audit log

The audit log is one hash chain from its first entry. Retention removes **whole months from the
oldest end only, never the newest month**, and only after writing a signed anchor,
`KOLO_HOME/audit/ANCHOR.json`: the seq and the SHA-256 of the last removed line, and the list of
removed months. `kurahi audit verify` then starts from the anchor: the first remaining entry must
name the anchored hash as its `prev` and continue its seq; day heads of removed days are vouched
for by the anchor. A month removed without moving the anchor is reported as a break; a forged
anchor fails its signature. Pruning stops at the first month a legal hold covers.

## Legal hold

A legal hold stops every deletion of the data it covers until a person releases it.

| Method                     | Params                                           |
| -------------------------- | ------------------------------------------------ |
| `governance.holds.create`  | `matterId`, `reason`, `scope`                    |
| `governance.holds.list`    | `status?`: `active` (default), `released`, `all` |
| `governance.holds.release` | `id`, `reason`                                   |

`scope` takes any of `projectIds`, `workItemIds`, `persons` (identities named in a record:
requester, approver, actor, sender), `custodians` (identities that own or created a record) and a
`from` / `to` date range. Every dimension that is set must match; within a dimension any value
matches. Holds **fail closed**: a record that cannot be shown to fall outside the scope (for
example a transcript, whose people are not indexed, under a `persons` hold) is held. A work item
hold also holds the item's attachments and drafts.

While a hold is active, the sweeper, data subject request deletions, `sessions.delete` (refused
with `legal_hold`) and `kurahi evidence prune` skip covered data. Creating and releasing a hold is
audited (`governance.holds.create` / `governance.holds.release`) and sealed as an evidence bundle
`gov-<holdId>-create` / `-release`.

## eDiscovery export

`governance.export.create` (person-only, reason required) starts a background job and returns at
once with `status: "running"`. Poll `governance.export.get` / `governance.export.list`; when the
status is `done`, download the archive from `GET /api/governance/exports/{id}/download`. Only the
person (or pairing credential, or device) that created the export, or the owner credential, may
download it; anyone else gets 404. Creation, completion and every download are audited.

Params: `reason`, `matterId?`, `scope` (as for holds), `classes?` (default all of `workitems`,
`evidence`, `transcripts`, `attachments`, `outputs`, `memory`, `audit`), `attachmentFiles?`
(default false: metadata only), `redact?` (default `governance.personalData.redactExports`).

The zip is self-verifying:

| File                         | Content                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `manifest.json`              | export id, who, when, reason, scope, counts, SHA-256 and size of every other file, signed |
| `verification.json`          | evidence verification report: every bundle, every work item chain with tombstones, audit  |
| `workitems/<project>/<id>/…` | `item.json` with history, and the item's evidence bundles                                 |
| `evidence/<jobId>/…`         | job evidence bundles, verbatim; `evidence/_tombstones/` for deleted ones in scope         |
| `transcripts/<agent>/<file>` | transcripts                                                                               |
| `attachments/index.json`     | attachment metadata (SHA-256, size, time); `attachments/files/` with `attachmentFiles`    |
| `outputs/<artifact>/…`       | generated outputs                                                                         |
| `memory/<agent>/<id>.json`   | memory quarantine records                                                                 |
| `audit/rows.jsonl`           | audit rows in scope, raw lines (each recomputes its own hash)                             |

Verify anywhere with `kurahi governance verify-export <file.zip>`: the signature, every file's
SHA-256, no missing and no extra file. With `redact`, identifiers are replaced in items,
transcripts, outputs and audit rows (the manifest says so); evidence bundles are always verbatim,
because they are redacted when recorded and a changed byte would fail their signature.

## Personal data (APPI) and My Number

The detector recognises Japanese personal identifiers, with full-width digits and dashes:

| Kind               | Rule                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `my_number`        | 12 digits whose check digit validates (Individual Number). Invalid check digits are not reported                                               |
| `corporate_number` | 13 digits whose leading check digit validates (corporate number: public, never personal data)                                                  |
| `residence_card`   | Residence card: 2 letters, 8 digits, 2 letters                                                                                                 |
| `passport`         | 2 letters and 7 digits                                                                                                                         |
| `bank_account`     | 7 digits after `口座`, `普通`, `当座`, `支店` or `店番` (account, ordinary, current, branch, branch no.; with an optional 3-digit branch code) |
| `phone`            | Japanese numbers: 0X…, mobile 0X0, +81                                                                                                         |
| `email`            | addresses                                                                                                                                      |

A 13-digit corporate number is never read as an Individual Number, nor is a 12-digit run inside a longer number, a hex
digest or an id.

**Outbound guard.** Before a tool that sends or writes outside Kurahi runs (`m365_mail_send`,
`m365_mail_create_draft`, `m365_mail_attach_to_draft`, `m365_files_upload`,
`m365_calendar_create_event`, `gmail_send`, `lineworks_message_send`, `box_file_upload`,
`office_*_create`, `kintone_record_create`, `kintone_record_comment_add`), every string in its
arguments is checked, after every policy and approval guard and with the final arguments, both
for agent tool calls and for gateway-invoked tools (autopilot, `/tools/invoke`):

- `myNumber` (default `block`): a valid Individual Number refuses the call with rule `personal-data:my_number`.
- `otherIdentifiers` (default `warn`): the call proceeds and the finding is audited.
- Either may be `block`, `warn` or `off`, organisation-wide (`governance.personalData`) or per
  Project (`governance.policy.set`).

Every block (`governance.personalData.block`) and warning (`governance.personalData.flag`) is
audited with the tool, the argument path, offsets and a keyed digest (HMAC-SHA256 with a per
installation key in `KOLO_HOME/governance/pd.key`); never the value. A plain hash would not do:
a 12-digit number can be recovered from its SHA-256 by trying every candidate.

**Logs.** A valid Individual Number is always masked (`[マイナンバー]`) in audit rows and in sealed evidence
events. `governance.personalData.redactLogs: true` masks every kind above.

## Data subject requests

`governance.dsr.find` (person-only, reason required) searches every class for one identifier
(`kind`: `email`, `phone`, `principal` or `text`; optionally limited to `projectIds`) and returns a
report: each record that names it, how often, and its disposition, `deletable`, `held` (with the
hold ids) or `retained` (evidence, which is signed and kept for its retention period; an open work
item). It also counts audit rows that name the identifier. The report stores a keyed digest of the
identifier, never the identifier.

`governance.dsr.execute` (person-only) takes the report id, the identifier again (it must match
the digest), `mode` (`anonymize`: each occurrence becomes a stable pseudonym; `delete`: the record
is removed, closed work items only) and a reason. Holds are checked again at execution: a hold
placed after the report wins. Changes are listed in a signed deletion manifest
(`gov-dsr-<id>`) and audited.

## What is never deleted

- Deletion manifests (`gov-retention-*`, `gov-dsr-*`) and hold records (`gov-hold-*`).
- Tombstones of deleted evidence, and the audit anchor.
- The newest audit month, and audit history newer than the configured minimum.
- Evidence and audit rows by a data subject request (reported as retained).
- Anything under an active legal hold.
- Open work items, running jobs and memory writes waiting for review.

## Reference

| Method                     | Scope     | Person-only | Result                                     |
| -------------------------- | --------- | ----------- | ------------------------------------------ |
| `governance.policy.get`    | observe   | no          | `{ org, project }`                         |
| `governance.policy.set`    | approvals | SSO         | `{ org, project }`                         |
| `governance.retention.run` | approvals | SSO         | counts per class, `manifestId`             |
| `governance.holds.create`  | approvals | SSO         | `{ hold }`                                 |
| `governance.holds.list`    | approvals | yes         | `{ holds }`                                |
| `governance.holds.release` | approvals | SSO         | `{ hold }`                                 |
| `governance.export.create` | approvals | SSO         | `{ export }` (`status: "running"`)         |
| `governance.export.get`    | approvals | yes         | `{ export }` with `downloadPath` when done |
| `governance.export.list`   | approvals | yes         | `{ exports }`                              |
| `governance.dsr.find`      | approvals | SSO         | `{ report }`                               |
| `governance.dsr.execute`   | approvals | SSO         | `{ report }` with `executed`               |

"approvals" = the attach scope plus `operator.approvals`; voice-origin requests are refused. "SSO" =
person-only, and with enterprise identity configured an SSO person session (break-glass is not
enough). Refusal codes (in `error.details.code`): `not_a_person`, `reason_required`,
`matter_required`, `bad_scope`, `hold_not_found`, `hold_released`, `retention_below_minimum`,
`org_only_class`, `anonymize_unsupported`, `unknown_class`, `project_not_found`, `bad_classes`,
`export_not_found`, `report_not_found`, `report_executed`, `identifier_mismatch`, `bad_mode`,
`bad_kind`, `bad_identifier`; `sessions.delete` refuses with `legal_hold`. Changes broadcast
`governance.changed` (`kind`, `id`, `at`; never content).

Related: [Security overview](/security/SECURITY_OVERVIEW), [Evidence](/evidence),
[Enterprise identity](/security/identity), [Privacy](/security/privacy).
