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

Status as of 23 October 2026: the gateway methods, policy engine, evidence, templates and typed
client are built. The desktop screen (queues on the left, the item in the centre with the agent's
draft next to the source document, policy checks on the right, Approve / Send back) is in
development against this contract.

## Control UI review

Open a Project created from a Business template to see **Work queue**. Choose a configured queue,
load more items, and select an item to review its source fields and document references, pinned
artifact ID/version/SHA-256, checks, approval records, override reason and history. The view supports
Japanese and English, narrow screens, and light and dark themes.

This first UI slice is read-only: it does not create items, assign agents or make decisions. Draft
content is not loaded, and displayed evidence references are not a signature-verification result.
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
| `approvals`         | Who approved, when, with what comment                                                           |
| `override`          | Who approved despite failing blocking checks, the reason and the check ids                      |
| `history`           | Every change: who (`person` / `agent` / `system`), what, when, and its evidence bundle          |
| `runIds`            | Agent runs that drafted the item (also visible in `jobs.*` and job evidence)                    |
| `revision`          | Incremented on every write; pass it as `expectedRevision` to avoid overwriting a change         |

### Lifecycle

- `new` → `workitems.assignAgent` → `drafting` → draft saved → `awaiting_review`
- `awaiting_review` → approve (all required approvers) → `approved` → `workitems.update` → `done`
- `awaiting_review` → send back (comment required) → `sent_back` → `assignAgent` again → `drafting`
- A person-made item goes to review with `workitems.update` `status: "awaiting_review"`
- Any item that is not finished → cancel (comment required) → `cancelled`
- A failed or empty run returns to where it started (`new` / `sent_back`) with `lastError`

A person can also attach an existing artifact as the draft (`workitems.update` with
`patch.draft`), which moves the item to `awaiting_review`. Changing the source or the draft clears
earlier approvals and re-runs the checks.

## Gateway methods

All methods take `projectId`; an item id from another Project answers `work item not found`.

| Method                  | Scope (pairing / operator)    | Does                                                                                                                               |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `workitems.list`        | observe / `operator.read`     | Filters (queue, status, type, priority, assignee, overdue, `q`), cursor paging, at most 200 per page, totals and per-status counts |
| `workitems.get`         | observe / `operator.read`     | The full item with history                                                                                                         |
| `workitems.config`      | observe / `operator.read`     | Queues, rules, policy source and digest (for the queue list and the checks panel)                                                  |
| `workitems.evidence`    | observe / `operator.read`     | Verifies every evidence bundle of the item and the chain between them                                                              |
| `workitems.create`      | attach / `operator.write`     | New item; field-only checks run at once                                                                                            |
| `workitems.update`      | attach / `operator.write`     | Non-decision fields; `status` only `awaiting_review` (submit) or `done` (after approval)                                           |
| `workitems.assignAgent` | attach / `operator.write`     | Starts an agent run that drafts; answers at once with `runId`                                                                      |
| `workitems.decide`      | attach / `operator.approvals` | `approve` / `send_back` / `cancel` — person only                                                                                   |

Event: `workitems.changed` `{projectId, id, queue, action, status, revision, updatedAt}`. It
carries no titles or field values; refetch with `workitems.get`. Sent to clients that can read.

The typed client exports the method types and named shapes: `WorkItem`, `WorkItemSummary`,
`WorkItemCheck`, `WorkItemHistoryEntry`, `WorkItemDecision`, `WorkQueueDef`, `WorkQueueRule`,
`WorkItemEvidenceBundle` and `WORK_ITEM_DECISION_REFUSALS` (`@kodasoken/kurahi-client`).

### Agent drafting

`workitems.assignAgent` checks that the agent is allowed in the Project (the queue's
`defaultAgent`, else `main`), moves the item to `drafting` and runs the agent in the item's own
Project session `agent:<agent>:proj-<projectId>-wi<item>`. The Project's folder scope, mode
(参照 / 計画 / 実行) and tool guard apply exactly as in a Project chat. The prompt holds the form
fields, the source document refs, the rules that apply and any send-back comments. The final
reply is saved as an artifact (status 確認中 / review), pinned as the draft, and the checks run
automatically against it. A failed or empty run puts the item back where it was, with
`lastError`. A run still `drafting` after 30 minutes (for example after a restart) may be
re-assigned.

### Decisions: person only

`workitems.decide` is refused, and the refusal audited, when:

- it carries any voice-origin marker (the shared voice approval guard, before validation);
- the connection is an agent tool connection (`backend` mode / `gateway-client`), a node, or has
  no client connection (`code: not_a_person`);
- the credential lacks `operator.approvals`.

Approve also requires: status `awaiting_review`; the pinned draft is still the artifact's latest
version (`draft_changed`); the person has not already approved (`already_approved`); with
`separationOfDuties: true` the item's creator cannot approve it when both are device or paired
identities (`separation_of_duties`); and every **blocking** check passes, re-evaluated now. A
failing blocking check needs `override.reason` (10 characters or more); the override is stored on
the item, written into the evidence and logged as its own `workitem.override` audit entry. When the
policy needs two approvers, the first approval keeps the item in `awaiting_review`. On the final
approval the draft artifact becomes 承認済み (approved); on send-back it returns to 下書き (draft).
Send back and cancel need a comment.

Refusals answer `error.details.code`: `not_a_person`, `terminal`, `comment_required`,
`not_awaiting_review`, `draft_changed`, `already_approved`, `separation_of_duties`,
`checks_failed` (with `failing`).

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
  - { id: fin-expense, name: { ja: 経費精算, en: Expense claims }, types: [expense], slaHours: 72 }
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

## Templates

| Template                                | Queues                         | Example rules                                                                                                           |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `business-general-affairs` 総務         | `ga-requests`, `ga-facilities` | Required fields, cost with second approver above 100,000 JPY, lead time, no "booked" before approval                    |
| `business-hr-leave-overtime` 人事       | `hr-leave`, `hr-overtime`      | Leave dates, month-end overtime forecast (warn 36 h, second approver 45 h, max 80 h), daily hours, separation of duties |
| `business-finance-expense-invoice` 経理 | `fin-expense`, `fin-invoice`   | Receipt attached, amount thresholds, qualified-invoice fields, no "paid" before approval                                |
| `business-procurement` 購買             | `proc-requests`                | Required fields, amount (second approver above 300,000 JPY; 稟議 above 5,000,000 JPY), two quotes, lead time            |

The HR template uses the figures and status labels of the overtime-coordinator workflow (actual
hours, month-end forecast, applicable limit; 実績で超過 / 月末見込みに基づくリスク) and its
rule that nothing is sent to an employee before a manager's approval.

## Evidence and audit

Every transition (create, update, submit, assign_agent, draft, draft_failed, decide.approve,
decide.send_back, decide.cancel, done) writes one sealed evidence bundle in the standard evidence
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
- Listing reads every item of the Project (fine for thousands of items per Project, not millions).
- The draft is the agent's final reply text (Markdown); attachments produced by tools are not
  pinned automatically.
