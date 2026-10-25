---
summary: "Business edition work queue: back-office work items per Project (general affairs, HR, finance, procurement) where agents draft, policy rules check, and only a person approves, sends back or cancels; every transition audited and signed as evidence"
read_when:
  - Building the work queue screen against the gateway
  - Writing a work queue policy (workqueue.yaml) for a Project
  - Explaining who may approve what, and how it is recorded
title: "Work queue"
---

# Work queue

日本語: [ワークキュー](/ja/business/work-queue)

The work queue is the back office of the Business edition: requests, leave and overtime,
expense claims, invoices and purchase requests arrive as **work items** in a Project. An agent
drafts the reply, review or order proposal; the Project's **policy rules** check the item and the
draft; a **person** approves, sends back or cancels. Agents never decide.

Status as of 24 October 2026: the gateway methods, policy engine, evidence, templates and typed
client are built, including staged approval routes (稟議), "My requests", the approver inbox,
document previews, draft diffs and the queue overview. The desktop screen (queues on the left, the item in the centre with the agent's
draft next to the source document, policy checks on the right, Approve / Send back) is in
development against this contract.

## Control UI review

### Department workspaces

Create a Project from **Company operations — all departments** to start with 15 configured
queues: Secretariat, Finance, General Affairs, HR, Planning, IT, Procurement, Sales, Marketing,
Customer Service, Operations, Legal/Risk, Product/R&D, Facilities and Quality. Open its Work queue
view and choose a department. **Enterprise** shows the individual departments; **SME** groups the
same functions into six desks. Grouping changes navigation only, not permissions.

The selected department shows its configured queues and a working view using returned records:
agenda-style due dates, financial review tables, people/quality checks, milestones or service
requests. Counts and pagination refer to the selected queue, not an organization-wide total.
Search and status filters run at the gateway. Selecting another department clears prior item
details, previews and evidence. **All queues** keeps custom and unmapped queues accessible.

Queue definitions can specify optional `department` using the identifiers below. Existing
General Affairs, Finance, HR and Procurement templates include this metadata. Older versions of
those templates have exact template/queue mappings in the UI; arbitrary custom queues are never
classified by name or item type. A department without a configured queue shows an empty state.

```yaml
queues:
  - id: office-requests
    department: secretariat
    name: { en: Office requests, ja: 秘書室への依頼 }
    types: [request, case, document]
```

Allowed IDs: `secretariat`, `finance`, `admin`, `hr`, `planning`, `it`, `procurement`, `sales`,
`marketing`, `service`, `operations`, `legal`, `product`, `facilities`, `quality`.
Department metadata is not an access-control boundary. Configure the Project's existing access
roles before adding confidential records. The Company operations starter retains separation of
duties and the existing `fallback: none` policy; it does not grant everyone departmental access.

Choose a configured queue, then **New work item**. Enter the requester label, title, description
and an allowed item type. Optional Project-relative file references point to files already in the
Project; they do not upload or verify documents. The requester label describes the request;
authenticated ownership still comes from the gateway's `requestedBy`. Explicitly creating the
item saves it and reads back policy checks. It does not submit, approve, send, book or pay.
If creation cannot be confirmed, inspect the queue before acknowledging the outcome and retrying.

The unified starter supports requests, cases and document reviews. Use the specialized Finance,
HR and Procurement templates for their configured expense, leave, overtime and purchase rules.
Department views do not imply calendar sync, accounting posting, payroll execution, external
delivery or automatic cross-department transfers. Those require separately configured capabilities.

Open a Project created from a Business template to see **Work queue**. Choose a configured queue,
load more items, and select an item to review its source fields and document references, pinned
artifact ID/version/SHA-256, checks, approval records, override reason and history. The view supports
Japanese and English, narrow screens, and light and dark themes.

The review screen offers explicit **Approve**, **Send back** and **Cancel** forms. Confirming a
form submits the revision shown when it was opened; a changed item requires another review.
Send back and Cancel require a comment. An explicit approval override requires a reason of at
least 10 characters. Decisions are never submitted through voice or automatically retried.
The gateway checks the person's authority, separation of duties and policy rules. A recorded
approval may still need another approver. Refusals appear as localized notices; an uncertain
response prompts a refresh before trying again.

Choose **Load pinned draft** to read its exact artifact version as plain text. The UI checks the
returned Project, artifact ID, version and SHA-256 against the item, including a hash of the
received UTF-8 text. Refreshing the item clears the preview. Failed or mismatched responses
never display content. This content check does not verify evidence signatures.

Choose **New expense request** when the Project has a configured queue accepting expenses.
Enter a title, employee ID, amount in the Project's currency, expense date, category and purpose.
Optional existing Project file references use one relative path per line; this does not upload
files or verify receipts. **Save request** creates a new item and opens its policy checks. It does
not submit for approval, assign an agent or make a payment. Company policy remains authoritative.
If the save outcome is uncertain, refresh and inspect the queue before choosing **I checked the
queue** to permit another creation. The UI never automatically retries a save.

Saved expense requests can be edited and explicitly submitted with revision checks. Other intake
types, assigning agents, source document previews and draft diffs are still pending UI work.

For staged approval routes, the item shows each stage in order with its recorded status, approval
count, required count and deadline. Overdue and escalation markers reflect the gateway response,
not the browser clock. Skipped stages show the configured reason. This display does not determine
who may approve; the gateway remains authoritative.
Source documents remain references. Choose **Verify evidence** to request the gateway's bundle and
chain checks. The screen shows verified, failed or unavailable, the local response time and returned
bundle count. Empty results never count as verified; all evidence references in the displayed history
must be present with matching roots. Refresh, navigation and item changes clear the result.
This checks the returned evidence under its bundled signing keys; it does not attest the current
item revision, externally establish signer trust, or certify legal compliance. Electronic approval
is a separate human decision.
Policy loading errors remain visible. The queue refreshes after work-item events, event gaps,
reconnect and manual Refresh. Changing Project or gateway connection clears the prior review state.

Fictional visual fixtures can be captured locally with `node ui/visual/capture-business.mjs`;
they do not connect to a gateway.

## Work items

A work item belongs to exactly one Project and is stored in that Project's data area:

```
<KOLO_HOME>/projects/<projectId>/workitems/<itemId>/item.json
<KOLO_HOME>/projects/<projectId>/workitems/<itemId>/evidence/0001-create/…
```

| Field               | Meaning                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `queue`             | Queue id from the Project's policy (e.g. `fin-expense`)                                         |
| `type`              | `request` `case` `document` `invoice` `leave` `expense` `purchase` `custom`                     |
| `source`            | `documents` (attachment, project file or artifact refs, inside the Project) and form `fields`   |
| `status`            | `new` `drafting` `awaiting_review` `approved` `sent_back` `done` `cancelled`                    |
| `assignee`          | `{kind: "agent" \| "person", id}` or null                                                       |
| `priority`, `dueAt` | `low` `normal` `high` `urgent`; due date from the queue SLA (`slaHours`) unless given           |
| `draft`             | Pinned artifact id, version and SHA-256 the reviewer sees                                       |
| `checks`            | `[{policyId, label, result: pass\|fail\|warn, blocking, evidence, draftVersion, policyDigest}]` |
| `requiredApprovals` | Distinct people needed (2 when a threshold rule asks for a second approver)                     |
| `requestedBy`       | Principal of the connection that created the item (owner of "My requests")                      |
| `route`             | The approval route fixed on the item: stages, current stage, skipped stages (see below)         |
| `approvals`         | Who approved, when, with what comment, in which stage (`stageId`, `via`, `onBehalfOf`)          |
| `override`          | Who approved despite failing blocking checks, the reason and the check ids                      |
| `history`           | Every change: who (`person` / `agent` / `system`), what, when, and its evidence bundle          |
| `runIds`            | Agent runs that drafted the item (also visible in `jobs.*` and job evidence)                    |
| `revision`          | Incremented on every write; pass it as `expectedRevision` to avoid overwriting a change         |

### Lifecycle

- `new` → `workitems.assignAgent` → `drafting` → draft saved → `awaiting_review`
- `awaiting_review` → approve each stage of the route → `approved` → `workitems.update` → `done`
- `awaiting_review` → send back (comment required) → `sent_back` → `assignAgent` again → `drafting`
- A person-made item goes to review with `workitems.update` `status: "awaiting_review"`
- Any item that is not finished → cancel (comment required) → `cancelled`
- A failed or empty run returns to where it started (`new` / `sent_back`) with `lastError`

A person can also attach an existing artifact as the draft (`workitems.update` with
`patch.draft`), which moves the item to `awaiting_review`. Changing the source or the draft clears
earlier approvals and re-runs the checks.

## Gateway methods

All methods take `projectId`; an item id from another Project answers `work item not found`.
Reads and changes are also limited by ownership (see [Ownership and access](#ownership-and-access)).

| Method                  | Scope (pairing / operator)    | Does                                                                                                                                                                                       |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workitems.list`        | observe / `operator.read`     | Filters (queue, status, type, priority, assignee, overdue, `q`, `mine`, `awaitingMe`, `stage`, `department`, `flagged`), cursor paging, at most 200 per page, totals and per-status counts |
| `workitems.get`         | observe / `operator.read`     | The full item with history                                                                                                                                                                 |
| `workitems.config`      | observe / `operator.read`     | Queues (with `department`), the `departments` catalogue, rules, routes, access summary, the caller (`viewer`), policy source and digest                                                    |
| `workitems.evidence`    | observe / `operator.read`     | Verifies every evidence bundle of the item and the chain between them                                                                                                                      |
| `workitems.document`    | observe / `operator.read`     | Safe preview of a source document or the pinned draft                                                                                                                                      |
| `workitems.draftDiff`   | observe / `operator.read`     | Line diff between two versions of the pinned draft, with provenance                                                                                                                        |
| `workitems.stats`       | observe / `operator.read`     | Counts by status, queue and stage, overdue counts, median / 90th percentile time to approve; optional `department`                                                                         |
| `workitems.create`      | attach / `operator.write`     | New item; field-only checks run at once                                                                                                                                                    |
| `workitems.update`      | attach / `operator.write`     | Non-decision fields; `status` only `awaiting_review` (submit) or `done` (after approval)                                                                                                   |
| `workitems.assignAgent` | attach / `operator.write`     | Starts an agent run that drafts; answers at once with `runId`                                                                                                                              |
| `workitems.decide`      | attach / `operator.approvals` | `approve` / `send_back` / `cancel` on the current stage — person only                                                                                                                      |
| `workitems.delegate`    | attach / `operator.approvals` | Hand the caller's decision on the current stage to another principal — person only                                                                                                         |
| `workitems.intakeEmail` | attach / `operator.write`     | New item from an email, by reference; idempotent per message (see [Email intake](#email-intake))                                                                                           |
| `workitems.clearFlag`   | attach / `operator.approvals` | Clear one risk flag with a written reason — person only (see [Risk flags](#risk-flags))                                                                                                    |

Event: `workitems.changed` `{projectId, id, queue, action, status, revision, updatedAt}`. It
carries no titles or field values; refetch with `workitems.get`. Sent to clients that can read.

The typed client exports the method types and named shapes: `WorkItem`, `WorkItemSummary`,
`WorkItemCheck`, `WorkItemHistoryEntry`, `WorkItemDecision`, `WorkQueueDef`, `WorkQueueRule`,
`WorkItemEvidenceBundle`, `WorkItemApproval`, `WorkItemRoute`, `WorkItemStage`,
`WorkItemStageStatus`, `WorkItemStageSummary`, `WorkItemDelegation`, `WorkItemDelegateInput`,
`WorkQueueRouteDef`, `WorkQueueAccess`, `WorkQueueViewer`, `WorkItemDocumentPreview`,
`WorkItemDraftDiff`, `WorkItemDiffHunk`, `WorkItemDiffLine`, `WorkItemDraftProvenance`,
`WorkQueueStats`, `WorkQueueStageStats`, `WorkItemOrigin`, `WorkItemFlag`,
`WorkItemFlagClearance`, `WorkItemIntakeEmailInput`, `WorkItemIntakeEmailResult`,
`WorkItemClearFlagInput`, and the refusal code lists `WORK_ITEM_DECISION_REFUSALS`,
`WORK_ITEM_DELEGATION_REFUSALS`, `WORK_ITEM_ACCESS_REFUSALS`, `WORK_ITEM_FLAG_REFUSALS` and
`WORK_ITEM_INTAKE_REFUSALS` (`@kodasoken/kurahi-client`).

### Agent drafting

`workitems.assignAgent` checks that the agent is allowed in the Project (the queue's
`defaultAgent`, else `main`), moves the item to `drafting` and runs the agent in the item's own
Project session `agent:<agent>:proj-<projectId>-wi<item>`. The Project's folder scope, mode
(参照 / 計画 / 実行) and tool guard apply exactly as in a Project chat. The prompt holds the form
fields, the source document refs, the rules that apply and any send-back comments. The final
reply is saved as an artifact (status 確認中 / review), pinned as the draft, and the checks run
automatically against it. After a send back, the re-draft is saved as the next version of the
same artifact, so `workitems.draftDiff` can compare the rounds. A failed or empty run puts the item back where it was, with
`lastError`. A run still `drafting` after 30 minutes (for example after a restart) may be
re-assigned.

### Decisions: person only

`workitems.decide` is refused, and the refusal audited, when:

- it carries any voice-origin marker (the shared voice approval guard, before validation);
- the connection is an agent tool connection (`backend` mode / `gateway-client`), a node, or has
  no client connection (`code: not_a_person`);
- the credential lacks `operator.approvals`.

Approve also requires: the person may decide the current stage (`not_an_approver`), and in a
staged route has not approved an earlier stage; status `awaiting_review`; the pinned draft is still the artifact's latest
version (`draft_changed`); the person has not already approved (`already_approved`); with
`separationOfDuties: true` the item's creator cannot approve it when both are device or paired
identities (`separation_of_duties`; in a staged route this always applies); and every
**blocking** check passes, re-evaluated now. A
failing blocking check needs `override.reason` (10 characters or more); the override is stored on
the item, written into the evidence and logged as its own `workitem.override` audit entry. When the
stage needs more approvals, or more stages follow, the item stays in `awaiting_review`. On the
last stage's final approval the draft artifact becomes 承認済み (approved); on a send back to the
requester it returns to 下書き (draft). Send back and cancel need a comment. Send back is open to
the people who may decide the current stage; cancel to the requester, operators and those people.

Refusals answer `error.details.code`: `not_a_person`, `terminal`, `comment_required`,
`not_awaiting_review`, `draft_changed`, `already_approved`, `separation_of_duties`,
`checks_failed` (with `failing`), `not_an_approver` (with `stage`), `not_authorised`,
`fraud_flag_uncleared` (with `flags`; see [Risk flags](#risk-flags)).

## Email intake

A Business agent that reads mail through the Microsoft 365 or Gmail connector can turn a message
into a work item, so the Secretariat correspondence tray and the Finance invoice register show
real, mail-backed cases.

- **Agent tool** `workitems_intake_email`, offered only in Project sessions and always for that
  session's Project: `queue`, `title`, `type`, `priority`, `due?`, `summary`, `source`, `flags?`,
  `flagReason?`. Inside the gateway process it calls the intake module directly, with what
  `workitems.intakeEmail` applies to the tool's own connection (same validation, same agent
  actor, same duplicate check, same `workitems.changed` event) and without opening a gateway
  connection per call; in a separate agent process it calls `workitems.intakeEmail` as an agent
  connection.
- **Autopilot**: routines file the messages they read through the same intake (one item per
  message, flags on the item, run and routine attribution in `source.fields`); see
  [Autopilot](/autopilot#email-intake-and-idempotency).
- **Gateway method** `workitems.intakeEmail {projectId, queue, title, type, priority, dueAt?,
summary, source, flags?, flagReason?}` answers `{item, created}`.
- `source` is a **reference**, not a copy: `{kind: "email", connector: "microsoft-365" | "gmail",
messageId, receivedAt?, from?, subject?}`. It is stored on the item as `source.origin` and shown
  in list rows. The message body is never stored: it **stays in the mailbox** and is read again
  through the connector when someone needs it. `summary` (at most 2000 characters) is the
  agent's own description of what the message asks for.
- Validation is strict: `messageId` 1-512 id characters (no spaces, no `..`); `receivedAt` an
  ISO 8601 date-time with a time zone (stored in UTC); `from` a bare address, no display name;
  `subject` one line of at most 300 characters; no other fields (a `body` is refused). Text that
  carries the connector's untrusted-content boundary markers (pasted tool output) is refused in
  `title`, `summary` and `subject`.
- **Idempotent** per `(connector, messageId)` in the Project: taking the same message in again
  returns the existing item unchanged with `created: false` (no second item, no event). If the
  caller may not read that item, the answer is `duplicate_source` without the item. The check
  and the insert run under one Project-wide lock, across processes.
- New items always start as `new` (準備). Intake never submits or approves anything; people review
  and decide as for any other item.
- Refusal code: `duplicate_source`; other invalid input answers with a message naming the field.

## Risk flags

Items may carry `flags`, a subset of `suspected_fraud`, `phishing`, `prompt_injection`,
`unverified_sender` and `malicious_attachment` (set by the engine when the
[attachment intake](/security/attachment-intake) refused an attachment of the item's message), with an optional `flagReason` (at most 500 characters). The intake agent
raises them (for example changed bank details, urgent payment pressure, instructions aimed at the
agent, or a sender that cannot be verified); a subject that matches prompt-injection patterns is
flagged `prompt_injection` automatically. Autopilot escalations carry the routine's flags the same
way (a proposed bank-detail change flags `suspected_fraud`), so the rules below apply to them. `workitems.list {flagged: true}` returns only flagged
items (`false`: only unflagged ones), filtered on the gateway after visibility, so `total` and
`counts` match.

- **While `suspected_fraud` or `malicious_attachment` is set, the item cannot be approved** (at any stage, whatever its
  type: `workitems.decide` answers `fraud_flag_uncleared`) **nor marked done**. An override reason
  does not bypass it.
- **Only a person clears a flag**: `workitems.clearFlag {projectId, id, flag, reason,
expectedRevision?}` needs `operator.approvals`, a written `reason` of 10 characters or more,
  and a person connection. Agent tool connections, nodes and voice are refused (`not_a_person`),
  as for decisions. Operators may clear; so may approvers of the item once it is routed to them.
  Flags are not part of `workitems.update`.
- Each clearance is kept on the item in `flagClearances` (`flag`, `by`, `at`, `reason`), written
  to the evidence bundle and history (`flag.clear`) and audited (`workitem.flag.clear`, refusals
  as `denied`). When the last flag is cleared, `flags` and `flagReason` are removed.
- Refusal codes: `not_a_person`, `invalid_flag`, `reason_required`, `terminal`, `flag_not_set`,
  `not_authorised`.

## Approval routes (稟議)

A Project's policy can define **routes**: an ordered list of stages for a queue (and optionally
item types and conditions). The first route whose `queues`, `types` and `when` match is fixed on
the item when it is submitted; later policy edits do not move items already in review.

```yaml
routes:
  - id: fin-ringi
    name: { ja: 支出稟議, en: Spending approval }
    queues: [fin-ringi]
    stages:
      - id: manager
        name: { ja: 所属長承認, en: Manager approval }
        approvers: { roles: [approver], departmentField: department }
        minApprovals: 1 # default 1
        dueHours: 48 # stage due time; past it the stage is marked overdue
        onReturn: requester # requester (default) | previous
        delegation: true # default false
        escalation: { afterHours: 72, to: { roles: [director] } }
      - id: finance
        when: [{ field: amount, gte: 100000 }] # include only when all conditions hold
        approvers: { roles: [finance] }
        onReturn: previous
      - id: director
        when: [{ field: amount, gte: 1000000 }]
        approvers: { principals: [device:abc123def456] }
```

- **Approvers**: `roles` (mapped to people in `access`), named `principals`, or both.
  `departmentField` restricts a role to members of the department named in that form field; an
  item without the field has no role approver for that stage until it escalates.
- **Conditions** (`when`, on a route or a stage): `{field, gte|gt|lte|lt|eq|ne|in|present}`; all
  must hold. Excluded stages are kept in `route.skipped` with the reason (e.g.
  `amount gte 100000 not met (value: 80000)`). Thresholds are company configuration: set them to
  your own approval authority table.
- **Progress**: `decide` acts on `route.current`. When a stage has `minApprovals` approvals, the
  next stage becomes active; the item is `approved` only after the last stage. One person
  approves at most one stage of an item, and the requester approves none.
- **Send back**: `onReturn: previous` returns the item to the previous stage (still
  `awaiting_review`, that stage's approvals cleared); `requester` (or the first stage) returns it
  to `sent_back` and resets the route.
- **Without a route** (or with an invalid policy) the item gets one `single` stage that anyone
  with approval permission may decide, needing `requiredApprovals` people — the earlier
  behaviour, including `secondApproverAbove`. Items stored before routes existed get this stage
  on their first decision. In a staged route, `requiredApprovals` is the sum of the stages'
  `minApprovals`.

### Delegation and escalation

`workitems.delegate {projectId, id, to, reason, expiresAt}` lets an approver of the current stage
(when the stage has `delegation: true`) hand that decision to another principal, with a reason
(5 characters or more) and an expiry within 30 days. The delegate approves or sends back "on
behalf of" the approver (`approvals[].onBehalfOf`, `via: "delegation"`); an expired delegation no
longer counts. A delegate cannot delegate again, and the requester cannot be a delegate. Every
delegation is a transition with its own evidence bundle and audit entry (`workitem.delegate`).
Refusals: `not_a_person`, `not_awaiting_review`, `delegation_not_allowed`, `not_an_approver`,
`already_approved`, `invalid_delegate`, `reason_required`, `invalid_expiry`.

Stage timers are checked deterministically when items are read, listed or counted, and every
5 minutes by the gateway's maintenance tick. Past `dueHours` the stage gets `overdueAt` (action
`stage.overdue`); after `escalation.afterHours` it gets `escalatedAt` (action `stage.escalate`)
and the escalation targets may decide the stage as well (`via: "escalation"`). Each mark is
written once, by `system`, with evidence.

## Ownership and access

Identity is the gateway's own principal for the connection: `pair:<fingerprint>` for a pairing
credential, `device:<id>` for a paired device identity, `owner` for the gateway token without a
device. It is recorded as `requestedBy` when an item is created and as `by` on every approval.
The policy's `access` block maps principals to roles and departments:

```yaml
access:
  fallback: none # none (default) | any_approver: role stages accept any approver until members are listed
  members:
    - { principal: device:abc123def456, name: 営業部長, roles: [approver], departments: [sales] }
    - { principal: device:0123456789ab, name: 経理課長, roles: [finance] }
  groups: {} # reserved for directory groups (e.g. Entra ID) via a resolver hook
```

A member may also carry `email` (a plain work address): the autopilot drafts that member's
[morning brief](/autopilot#morning-brief) to it. It grants nothing.

Roles: `requester` (everyone), `approver` (with departments), `finance`, `operator`, `admin`, and
custom ids such as `director`. A principal is **privileged** with the `operator.admin` gateway
scope or the `operator` / `admin` role in the Project.

- A requester reads and changes (update, assignAgent) only their own items; privileged callers
  read and change all. Others answer `not_authorised`.
- Approvers read the items whose current stage they may decide (including by delegation or
  escalation), and items they acted on.
- `workitems.list` returns only items the caller may read. `mine: true` is the caller's own
  requests only (also for operators); `awaitingMe: true` the items whose current stage the caller
  may approve now; `stage` filters on the active stage id. Summaries carry `currentStage`
  `{id, name, index, count, dueAt, overdue, escalated, approvals, minApprovals}`.
- `workitems.config` returns `viewer` `{principal, privileged, roles, departments, listed}` for
  the UI, and the access member list only to privileged callers.
- Privilege never lets anyone decide a stage they are not an approver of.

`setPrincipalGroupResolver()` (src/workitems/access.ts) is the hook for a future directory
integration: it returns a principal's group ids, which `access.groups` maps to roles.

## Documents, draft diffs and overview

`workitems.document {projectId, id, ref, maxChars?}` previews `draft` (the pinned draft),
`draft@<version>` (another version of the same artifact) or the `ref` of one of the item's source
documents. Only those references are served, and attachment and file references are re-checked to
still resolve inside the Project (symbolic links out of it answer `outside_project`). Text is
extracted from text-like content only (binary content answers `binary: true`, `text: null`),
control characters removed, capped at 64,000 characters (`truncated`), HTML-escaped
(`escaped: "html"`) and flagged `untrusted: true`: document text is data, never instructions. The
answer carries `bytes`, `sha256`, the recorded `recordedSha256` and `sha256Matches`, the artifact
`version` and `provenance` (artifact id, author, agent, run id, pinned). Refusals: `no_draft`,
`unknown_ref`, `outside_project`, `document_not_found`, `not_authorised`.

`workitems.draftDiff {projectId, id, fromVersion, toVersion}` diffs two versions of the pinned
draft artifact line by line: `hunks` (3 lines of context; `op` `eq` / `add` / `del`, HTML-escaped
text, line numbers), `stats`, `identical`, `truncated` (inputs capped at 5,000 lines of 2,000
characters, output at 4,000 lines), and `from` / `to` provenance (version, SHA-256, size, author,
agent, run id, pinned).

`workitems.stats {projectId, queue?, windowDays?, department?}` is computed on the gateway over every item the
caller may read (all items for privileged callers, `scope: "all"`; otherwise `scope: "visible"`):
`byStatus`, `byQueue`, `overdue` (past the SLA), `stageOverdue`, `stages` (waiting / overdue /
escalated per route stage) and `timeToApprove` (median and 90th percentile hours from first
submission to approval, for approvals within `windowDays`, default 30). `department` narrows the
counts to the readable items whose queue maps to that department (see [Departments](#departments)).

## Policy rules (workqueue.yaml)

The first file found is used: `<project folder>/context/workqueue.(yaml|yml|json)` (the client's
own), then `<KOLO_HOME>/projects/<id>/workqueue.(yaml|yml|json)` (administrator), then the
template's `templates/projects/packs/<templateId>/workqueue.yaml`. An unreadable or invalid file
fails closed: one blocking `policy.invalid` check. Every check records the policy's SHA-256.

```yaml
version: 1
timezone: Asia/Tokyo
separationOfDuties: true
queues:
  - id: fin-expense
    department: finance # optional; see Departments
    name: { ja: 経費精算, en: Expense claims }
    types: [expense]
    slaHours: 72
rules:
  - id: fin.expense.required
    kind: required
    fields: [employeeId, amount, expenseDate, category, purpose]
  - id: fin.expense.amount
    kind: threshold # alias: amount
    field: amount
    warnAbove: 30000
    secondApproverAbove: 50000 # → requiredApprovals 2
    max: 300000 # above: the rule's severity
  - id: fin.expense.date
    kind: date
    field: expenseDate
    maxLeadDays: 0 # also notInPast, minLeadDays, before: <otherField>
  - id: fin.receipt
    kind: attachment
    min: 1
  - id: fin.phrases
    kind: forbiddenPhrases
    target: both # draft | fields | both
    phrases: [支払済み, has been paid]
```

Every rule may set `severity: warn` (default `fail`), `blocking: false`, `types: […]`,
`queues: […]` and a `label: {ja, en}`. Results carry their evidence: the missing fields, the value
and the threshold crossed, the lead days and the timezone, the matched phrase with an excerpt, the
attachment count.

## Departments

The Business console groups queues into department workspaces. Each queue may set an optional
`department`, one of a fixed catalogue (in this order):

`secretariat`, `finance`, `admin`, `hr`, `planning`, `it`, `procurement`, `sales`, `marketing`,
`service`, `operations`, `legal`, `product`, `facilities`, `quality`.

- A queue without `department` is unmapped. Any other value is a policy error naming the queue
  and the value, and the policy fails closed like any invalid policy (it is never silently
  dropped).
- `workitems.config` returns `department` on each mapped queue and `departments`, the catalogue
  above. The catalogue holds ids only; the UI owns the Japanese and English labels.
- `workitems.list` and `workitems.stats` take an optional `department`: a department id, or
  `unmapped` for items whose queue has no department (including queue ids the policy no longer
  defines). Any other value is an invalid-params error. The filter runs on the gateway after
  every visibility and ownership filter, so `total`, `counts` and the stats cover exactly the
  filtered set the caller may read.
- **A department is a view, not an authorization boundary.** It never grants or limits access:
  who may read or decide an item is set only by ownership, routes and `access` (see
  [Ownership and access](#ownership-and-access)). The `departments` of an access member are a
  separate setting used by routes.

## Templates

| Template                                | Queues                                    | Example rules                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business-general-affairs` 総務         | `ga-requests`, `ga-facilities`            | Required fields, cost with second approver above 100,000 JPY, lead time, no "booked" before approval                                                                              |
| `business-hr-leave-overtime` 人事       | `hr-leave`, `hr-overtime`                 | Leave dates, month-end overtime forecast (warn 36 h, second approver 45 h, max 80 h), daily hours, separation of duties                                                           |
| `business-finance-expense-invoice` 経理 | `fin-expense`, `fin-invoice`, `fin-ringi` | Receipt attached, amount thresholds, qualified-invoice fields, no "paid" before approval; example 稟議 route manager → finance (from 100,000 JPY) → director (from 1,000,000 JPY) |
| `business-procurement` 購買             | `proc-requests`                           | Required fields, amount (second approver above 300,000 JPY; 稟議 above 5,000,000 JPY), two quotes (a three-quote rule is included as a comment), lead time                        |

The bundled templates map their queues to departments: general affairs → `admin`, finance (including
`fin-ringi`) → `finance`, HR → `hr`, procurement → `procurement`.

The finance template's route amounts are an example of company configuration. Its `access` block
starts with `fallback: any_approver` so the example works before people are listed; list the
members and set `fallback: none` so only they can decide.

The HR template uses the figures and status labels of the overtime-coordinator workflow (actual
hours, month-end forecast, applicable limit; 実績で超過 / 月末見込みに基づくリスク) and its
rule that nothing is sent to an employee before a manager's approval.

## Evidence and audit

Every transition (create, update, submit, assign_agent, draft, draft_failed, decide.approve,
decide.send_back, decide.cancel, delegate, stage.overdue, stage.escalate, done) writes one sealed evidence bundle in the standard evidence
format — `events.jsonl` hash chain and an Ed25519-signed `manifest.json` — so
`kolo evidence verify <bundle folder>` and `verifyEvidenceBundle()` check it like a job bundle. Each bundle's
`job.start` names the previous bundle and its root, so `workitems.evidence` can show a tampered
or missing step. The bundles stay with the item and are not removed by job evidence retention.
Each transition is also an audit entry (`workitem.<action>`, scope = Project id) that names its
evidence bundle; refused decisions are audited as `denied`.

## Limitations

- A command-line call made from an agent's shell (`kolo gateway call …`) identifies as `cli` and
  cannot be told apart from a person at a terminal. Give decision makers paired device
  credentials with `operator.approvals` and keep it off agent credentials.
- Policy changes take effect on the next check; earlier checks keep the digest they ran against.
- Listing and `workitems.stats` read every item of the Project (fine for thousands of items per
  Project, not millions).
- Principals are connection identities. Several people sharing one credential, or the gateway
  token without a device identity (`owner`), cannot be told apart; give each person their own
  paired device. Directory groups (Entra ID) are a hook only; no directory is queried yet.
- Delegations cannot be withdrawn before they expire (a new delegation from the same approver
  replaces the earlier one). Escalation adds deciders; it does not notify anyone by itself beyond
  the `workitems.changed` event.
- Approvals here are workflow records with signed evidence. Whether they meet a particular legal
  or contractual requirement for signatures or records is for the company to assess.
- Document previews extract text from text-like files only; PDF and Office files show metadata
  and hashes, not their text.
- The draft is the agent's final reply text (Markdown); attachments produced by tools are not
  pinned automatically.

## Department conversations

Open a Business project and choose a department. The **Talk to your agent** message box opens the full conversation view with streaming replies, history, attachments and follow-up messages. **Send** sends the typed message; **Open conversation** carries the draft into chat without sending it. Prompt suggestions only fill the draft. With All queues selected, the conversation uses the general project agent.

Department conversations retain their department context in their project session key, including when reopened from history. The chat header identifies the project, department and configured agent, and **Department work** returns to the department's records. New conversations started from a department chat retain that department. The agent selector is locked to the configured department agent.

The gateway validates the department's configured queues and their agent routing when creating the conversation and again on every message. All queues for a department must resolve to the same agent, and that agent must be allowed in the project. Missing departments or conflicting routing produce an error; ordinary project chats remain available. Department context does not grant data access, tools or approval authority. Existing project modes, permissions and human approval requirements still apply.

Conversation history and queued sends are guarded against late responses after switching sessions. An unsent draft or active run in an existing chat must be finished before opening a new department conversation.
