---
summary: "Autopilot for every Kurahi edition: routines that gather through read tools, reason with a tool-less model, and act only inside an autonomy level (L0 to L3) set by a person; never-lists per edition, standing approvals, signed run evidence and metrics from real events"
read_when:
  - Writing routines (autopilot.yaml) for a Project
  - Building the Autopilot panel against the gateway
  - Explaining what the autopilot may do alone and what always goes to a person
title: "Autopilot"
---

# Autopilot

Also available in [Japanese](/ja/autopilot).

The autopilot carries the repetitive work of a team end to end: inbox triage, invoice intake, a
nightly analysis of a legacy code base, a literature watch, platform health checks. It runs in
every edition (Industrial, Business, Scholars, Core) with the same engine and the same rules.

**The model never holds a tool that can send, pay or delete.** It reads what the engine gathered
and proposes; the engine checks each proposal against the routine's autonomy level and executes
only what that level allows. Everything else goes to a person as a work item.

## The loop

Every routine run is the same six steps:

1. **Trigger**: a schedule (cron expression and time zone) or an interval (at least 5 minutes),
   events (new mail, work item changes, deadlines, files; see [Triggers](#triggers)), or a manual
   run by an operator. Scheduled routines are registered as Kurahi cron jobs
   (`autopilot:<projectId>:<routineId>`); when one fires, or an event trigger fires, the engine
   runs it directly, with no model turn.
2. **Gather** (deterministic, no model): the routine's `gather` steps call **read tools only**,
   through the same path as `POST /tools/invoke`, in the routine's own Project session. A tool is
   readable only when its connector or plugin declares it read-only (for example
   `m365_mail_list`, `m365_mail_read`, `m365_mail_attachment_fetch`, `legacy_index`,
   the [scholar sources](/connectors/scholar-sources) `scholar_*` tools, `web_search`, the
   engine's `health_*` checks, and `workitems_linked`, which reports the open linked cases in the
   routine's own Project that are stuck: a step cancelled or stopped, a child item missing, or a
   record that cannot be read, including cases nobody is assigned, which no morning brief shows;
   a work items store it cannot list, or a work item it cannot read, escalates as unknown rather
   than reporting zero; it lists work item ids only), and `workitems_po_ready`, which lists the
   procurement cases waiting for a purchase order draft: open, no fraud flag, a person's supplier
   choice that still matches the recorded quotes, and no draft from that choice yet (ids only; as a
   `gate: true` step, none due ends the run with no model call, while unreadable items do not). Attachments are quarantined and scanned before
   anything is stored ([Attachment intake](/security/attachment-intake)).
   The [behaviour watchdog](#behaviour-watchdog) then measures the run before anything executes. A routines file that names a write tool in `gather` is invalid. At run time the engine
   also checks that the tool that answered comes from the plugin that declared it.
3. **Reason** (model with no tools): a CLI backend (codex-cli in its read-only sandbox, or
   claude-cli with no tools at all) runs in an empty temporary folder with no session and no
   workspace files; or the `api` backend calls an OpenAI-compatible model API (Sakura AI Engine,
   a Qwen endpoint, a local Ollama: `reasoner: { backend: api, model: sakura/gpt-oss-120b }`) with
   no tools in the request, so the model is never offered one. Gathered content is passed as data in `SOURCE` blocks, never as
   instructions. Approved company knowledge, when the routine declares it, is a separate
   `KNOWLEDGE` block of trusted facts (see [Approved company knowledge](#approved-company-knowledge)).
   If the backend still reports a tool call, its output is discarded.
4. **Validate**: the reply must be one JSON object matching the routine's output schema
   (`autopilot.plan.v1`): items, each with a reference, summary, flags, cited sources and
   proposed actions. Anything else fails the run; nothing is executed and the inputs are retried
   on the next run.
5. **Authorize and act**: each proposed action goes through `authorizeAction` (below). Allowed
   actions are executed by the engine; actions that need a person become a work item with an
   `awaitingPerson` reason and the list of pending actions; refused actions are recorded.
6. **Record**: every run writes a signed evidence bundle and a run record with counts (items,
   prepared, acted, escalated, refused, failed, handled, deferred).

## Autonomy levels

Each routine has one level, set in its file by the customer's administrator. That level is the
maximum: a person can accept a lower or earned level and the engine can demote a routine by
itself (see [Earned autonomy](#earned-autonomy)), so the level every action is checked against is
the **effective level**, `min(file level, override)`. Actions are
classified (prepare, internal-reversible, external, never) and the level table works on the
class, not on action names, so editions and plugins can add actions without touching the check.

| Level | Name                       | What the autopilot may do alone                                                                                                                                    |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L0    | Observe                    | Read, classify, report (the run record). No actions; an L0 routine lists none.                                                                                     |
| L1    | Prepare                    | + `prepare` actions: work items, reply drafts, attachments to drafts, documents, uploads to the app folder, meeting time proposals (default)                       |
| L2    | Act internal               | + `internal-reversible` actions (file, route, assign, update internal records)                                                                                     |
| L3    | Act external within policy | + `external` actions (for example `mail.send`), only under a valid **standing approval** that covers every recipient or target, the template and the daily maximum |
| —     | Never autonomous           | Always a person, at every level (see the never-lists)                                                                                                              |

The proposal comes from a model that reads untrusted content, so it can never raise the level,
add an action the routine does not list, name an approval, or pass arguments the action does not
accept. Order of the check: unknown action → refused; action not in the edition → refused; item
flagged → refused; never action → person; not in the routine → refused; invalid arguments →
refused; L0 → refused; routine daily maximum reached → person; then the level table.

### Flags

The model may flag an item `suspected_fraud`, `phishing`, `prompt_injection`,
`unverified_sender`, `unverified_citation` or `malicious_attachment`. The engine itself flags an
item `malicious_attachment` when the [attachment intake](/security/attachment-intake) refused an
attachment of its message (a message no item covers gets its own item). A flagged item gets no action at all; the engine
puts it in front of a person with the flags. The flags are set on the work item itself
(`flags`, `flagReason`), the same flags an agent's email intake raises, so the work queue's rules
apply: only a person clears a flag (`workitems.clearFlag`, with a written reason), and while
`suspected_fraud` is set the item cannot be approved or completed (`fraud_flag_uncleared`). A
proposed `bank.change` (a `never` action) also flags the item `suspected_fraud`. Flags the work
queue has no flag for (`unverified_citation`, the informational flags) stay in the
`autopilotFlags` field. See [Risk flags](/business/work-queue#risk-flags).

### Core action catalogue

| Action             | Class    | Executed as                                                                                                       |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `workitem.intake`  | prepare  | a work item created by `autopilot:<routineId>` (email intake for a message the routine read)                      |
| `mail.draft`       | prepare  | `m365_mail_create_draft` (a draft; a person sends it from Outlook)                                                |
| `office.create`    | prepare  | a Word, PowerPoint or Excel file from a typed spec, rendered by the office plugin into output/                    |
| `mail.attach`      | prepare  | `m365_mail_attach_to_draft`: this item's document to this item's draft                                            |
| `quote.prepare`    | prepare  | a quotation (Word and Excel) priced from the price list by the office plugin ([Quotations](/business/quotations)) |
| `files.upload`     | prepare  | `m365_files_upload` (the signed-in user's OneDrive app folder only)                                               |
| `calendar.propose` | prepare  | a work item with the proposed times; nothing is written to a calendar                                             |
| `brief.deliver`    | prepare  | the member's morning brief: an Outlook draft to their own address, or `output/briefs/`                            |
| `mail.send`        | external | `m365_mail_send` or `gmail_send`, only under a standing approval                                                  |

`workitem.intake` accepts `title`, `type`, `priority`, `note` and, in Business, `department`:
the item goes to the `<department>-work` queue when the Project has it (the company operations
template does), otherwise to the routine's `queue`.

The connectors' own write guards still apply: a connector that asks a person to approve every
send keeps asking unless it verifies the standing approval itself (see [L3 sends](#l3-sends)).

## Email intake and idempotency

When an item's `ref` is a message the routine read through a mail connector's read tool in this
run (`m365_mail_read`, `gmail_read` in a fan-out step), or the item cites exactly one such
source, the engine files it through **email intake** (the same module as
`workitems.intakeEmail`): the item keeps a reference to the message (connector, message id,
sender address, subject, received time; never the body), the model's summary, and the flags. The
origin comes from what the engine read, never from the plan. Other items are created with the
work queue's lifecycle API. Both carry the run and routine attribution in `source.fields`
(`autopilotRoutine`, `autopilotRun`, `autopilotKind`, `autopilotRef`, …).

Idempotency is one rule for the engine and intake: one work item per message per Project. Before
acting on an email item the engine looks for an item already filed for that message, by this
routine, another routine, a person or a tool; when there is one, none of the item's actions runs again (`already_handled` in the run
record), whatever the plan proposes, so a retried run or a reset state never drafts a second
reply. When a run fails, the messages whose item already reached the queue are still marked
seen; the others are read again on the next run.

## Documents and attachments

`office.create` takes `{ "kind": "docx" | "pptx" | "xlsx", "file": "<name>.<kind>", "spec": {…} }`.
The spec is the office plugin's document spec without `path` (docx: title and blocks of headings,
paragraphs, bullets and tables; pptx: title and slides; xlsx: sheets). It is checked three times,
each failing closed: the plan schema types the spec per kind (unknown keys fail the whole plan);
before anything is written the engine validates it with the office plugin's own parser (the
office plugin not enabled for the gateway: the action fails); then the engine renders it through the
plugin's tool (`office_docx_create`, …) in the routine's Project session, so the tool's guards
apply unchanged: the Project must be in Act mode, the file goes to
`output/autopilot/<runId>/<n>/<file>` (a writable folder, never through a symbolic link, never
over an existing file). The answering tool must come from the office plugin. A routine may name
its own `outputFolder` (a writable Project folder such as `output/literature`, never
`output/autopilot` or the Project root): its documents then go to
`<outputFolder>/<YYYY-MM-DD>/<runId>-<n>-<file>`, where people find them. No files trigger may
watch a routine's output folder (the file is invalid otherwise).

The work item of a plan item carries what it rests on: `autopilotEvidence` lists each cited
`SOURCE` that was retrieved in the run, with its tool and first line (for a fan-out source the
`ref: <id>` it was read for), and `autopilotDocument` names the document its `office.create`
wrote.

Within one item the actions `mail.draft`, `office.create`, `mail.attach` form a declared
sequence: `mail.attach` takes no arguments and attaches the document this item's `office.create`
wrote to the draft this item's `mail.draft` created (a reply to the item's message unless the
model names another). The model names neither the draft nor the file, so it can never attach
another file or change another draft. When a step fails, the next ones fail too and the item
goes to a person with the pending actions.

## Approved company knowledge

A routine may declare `knowledge:`, up to 10 Project-relative `.md` or `.txt` files under a
**read-only** folder of the Project (for example `knowledge/company-facts.md`: company profile,
standard prices, contacts). Their text is given to the model as **trusted** facts, in its own
`KNOWLEDGE` block before the gathered sources, which stay untrusted data. Trust comes from where
the file lives: agents and the autopilot cannot write a read-only folder, and the routines file
is set by an administrator. Bounded: at most 64 KB per file and 20,000 characters in total. A
path outside every read-only folder, or one leading out of the Project, fails the run before the
model is called; a declared file that does not exist yet is skipped (recorded on the
`knowledge` gather row).

## Never-lists

Never autonomous, at any level, in every edition: payment execution (`payment.execute`), bank
detail changes (`bank.change`), contracts and signatures (`contract.sign`), legal or HR decisions
about a person (`hr.decision`), secret or access changes (`secrets.change`), deleting data
(`data.delete`), and anything flagged fraud, phishing or injection. These are prepared as far as
possible; a person decides in one click.

### Business

As above: payments, bank details, contracts, decisions about people and flagged items always go
to a person. The finance starter routine intakes invoices with flags and never proposes a
payment.

### Industrial

Never writes to production OT or a PLC (`ot.write`, `plc.write`), never merges into or deploys to
a customer system (`repo.merge`, `deploy`). Opening a pull request (`repo.open_pr`) is
`external`: it needs L3 and a standing approval naming the repository. The legacy-analyzer
actions `legacy.analyze`, `legacy.design_doc` and `legacy.baseline_advance` are `prepare`
(read-only on the sources; results go to the analyser cache, and `legacy.design_doc` with
`output_format: docx` also writes the design document as a new Word file in `output/design-docs/`, which the
item's work item references). `legacy.baseline_advance` runs only after the item's work item is
filed: the engine executes it after `workitem.intake`, and never when filing failed, so a change
cannot be dropped from the baseline before a person has the item.

### Scholars

Never submits a paper or a grant application (`journal.submit`, `grant.submit`), never contacts
research participants (`participant.contact`), never fabricates citations: every item must cite
the `SOURCE` ids it came from, and a citation that names nothing retrieved in this run flags the
item `unverified_citation` (on by default in Scholars routines, `requireCitations`): the item
gets no action and goes to a person with the flag. `research.search` is `prepare`.

The **Research & academic** template ships three L1 starter routines, a work queue
(`res-literature` literature review, `res-writing` writing, `res-grants` grants and deadlines,
`res-data` data and reproducibility, with a rule that refuses "submitted", "accepted", `投稿済み`,
`採択済み`, `申請済み` (their Japanese equivalents) … in
writing and grant items) and the [scholar sources](/connectors/scholar-sources) and office plugins.
Its `knowledge/` folder is read-only and starts with two forms the researcher fills in:
`knowledge/research-profile.md` (topics, keywords, sources, languages) and `knowledge/grants.md`
(one `- YYYY-MM-DD | name | note` line per deadline). Open-access PDFs land in `corpus-inbox/`;
drafts to check go in `output/drafts/`. The routines need the Project in Act mode.

| Routine            | Trigger                                     | Gather                                                                                                                | Files                                                                                                                                             |
| ------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `literature-watch` | Mondays 07:00 (Asia/Tokyo)                  | `scholar_search` with the profile's `topics` and `sources` since the last successful run, `scholar_get` per new paper | One item per relevant paper in `res-literature` (summary, why it matters, the citation from the record) and a Word digest in `output/literature/` |
| `citation-check`   | A draft in `output/drafts/` changes; manual | `scholar_cite_check` lists the draft versions, then checks each new version once                                      | One item per draft with unresolved or mismatched references, flagged `unverified_citation`, in `res-writing`                                      |
| `grant-deadlines`  | Weekdays 08:00; `knowledge/` changes        | `scholar_grant_deadlines` lists today's reminders, then reads each new one                                            | One item per reminder (30, 14, 7, 3, 1 days before and on the day) in `res-grants`                                                                |

A routine with nothing new (no new paper, no new draft version, no reminder due, or a research
profile without topics yet) ends as `no_input` without calling the model.

### Core

Never destructive operations, never secret or access changes. Core routines run the
deterministic platform checks (disk, memory, clock, policy and kill switch, evidence signing key)
and open a work item when one fails.

## Standing approvals

A standing approval lets an L3 routine take one external action without asking each time, inside
a scope:

- `addresses` and `domains` the action may reach (every recipient, including cc, must match),
  or `targets` for non-mail actions (for example repositories);
- `templates` the action may use (required for `mail.send`);
- `maxPerDay`, and `expiresAt` at most 90 days ahead;
- a written `reason`.

Only a **person** with `operator.approvals` creates or revokes one: agent tool connections, cron
sessions, calls without a connection and voice origins are refused. Every L3 action records the
approval id it ran under, in the run record and its evidence. Create, revoke and every use are
audited (`autopilot.approval.use`, used or refused, with the approval id). Revoking takes effect
on the next action.

### L3 sends

`authorizeAction` picks the approval; the connector verifies it again at send time. The engine
runs each of its tool calls under an **engine invocation context** that only engine code sets (it
is not a tool argument), the way `KOLO_EXEC_ORIGIN` marks a cron command. `m365_mail_send` skips
its person approval only when the call runs under that context, for that tool and the routine's
own session, and the approval verifies from the store at that moment: active (not expired, not
revoked), for this routine and action, the routine still L3 and listing the action, every
recipient including cc in scope, the template in scope, and a use left today. The day's use is
taken atomically (one counter per approval and day, `approval-uses.json`; the authorize step
reads the same counter). One engine call sends at most once. Anything else, including any call
from a model or agent session, asks a person as before, and is refused when nobody approves. The
run record then shows `approvalId: null` and `code: person_approved` for a send a person
approved. The template id is engine context checked against the scope, never passed to the tool.
See [Microsoft 365](/connectors/microsoft-365#sending-under-a-standing-approval).

## Routines file

Routines live in `autopilot.yaml` in the Project, looked up like the work queue policy: the
Project's `context/autopilot.yaml`, then `<KOLO_HOME>/projects/<id>/autopilot.yaml` (set by an
administrator), then the template pack's starter file. Validation is strict and fails closed: one
invalid routine makes the whole file invalid, no routine of the Project runs and their cron jobs
are switched off until it is fixed.

```yaml
version: 1
timezone: Asia/Tokyo
reasoner: { backend: codex-cli }
routines:
  - id: secretariat-inbox
    edition: business # industrial | business | scholars | core
    area: secretariat # business: a department id; see the edition areas below
    name: { ja: 受信箱の仕分けと返信下書き, en: Inbox triage and reply drafts }
    trigger: { schedule: "*/15 8-19 * * 1-5", tz: Asia/Tokyo } # or { interval: 30 }
    gather:
      - { id: inbox, tool: m365_mail_list, args: { top: 25 } }
      - id: mail
        tool: m365_mail_read
        each: { from: inbox, match: "id: (\\S+)", arg: id, max: 10 }
    reasoning: { prompt: mail-triage, schema: autopilot.plan.v1 } # or promptText (up to 8 KB)
    actions: [workitem.intake, mail.draft]
    knowledge: [knowledge/company-facts.md] # optional; under a read-only folder
    outputFolder: output/replies # optional; where office.create writes (default output/autopilot)
    level: L1
    limits: { maxItemsPerRun: 10, maxActionsPerDay: 200 }
    queue: ga-requests
    metrics: { baselineMinutes: 4 }
```

`each` fans a step out over the ids a previous step returned; ids already processed by an
earlier successful run are skipped, so a routine with nothing new does not call the model.
`gate: true` on a step makes it the run's gate: when its tool reports nothing to process
(`details.noInput`, as `legacy_changes` does with no change since the baseline), the run ends
`no_input` with the tool's reason, without the remaining steps and without a model call. A gate
step cannot fan out.

### Arguments from knowledge and from the engine

A gather argument may be a reference instead of a fixed value, so a starter routine does not
hard-code what only the customer knows:

```yaml
knowledge: [knowledge/research-profile.md]
gather:
  - id: search
    tool: scholar_search
    args:
      queries: { fromKnowledge: topics, max: 5 } # the `- ` lines under "## Topics"
      sources: { fromKnowledge: sources, max: 4, optional: true }
      since: { var: lastRun, fallbackDays: 14 }
      limit: 20
```

- `{ fromKnowledge: <key>, max?: 1-25 (10), optional?: bool, join?: <separator>, file?: <path> }`:
  the bullet list under the key in one of the routine's `knowledge` files (a heading `## Topics`
  or a line `topics:`, matched without regard to case; lines in HTML comments are ignored), as a
  list, or one string with `join`. Values are bounded (200 characters each). The file must be a
  declared knowledge file, so the values come from a read-only folder people maintain. An empty
  list ends the run as `no_input` (nothing to look for yet) unless `optional`, which leaves the
  argument out.
- `{ var: lastRun, fallbackDays?: 1-365 (7) }`: the date (YYYY-MM-DD, UTC) the last successful
  run of the routine started (`ok`, `escalated` or `no_input`; a held, stopped or failed run does
  not move it), or `fallbackDays` before now for the first run.
- `{ var: today }`: today in the routine's time zone.

References are checked when the file loads (unknown keys, a key that is not a plain name, a file
the routine does not declare or a number out of range make the file invalid) and resolved for
each run. Only top-level argument values can be references; any other value is passed as
written. The engine also gives the model the run's date (`Run date: YYYY-MM-DD`) so documents and
reminders never guess it.

Edition areas: Industrial `modernisation`, `analysis`, `design-docs`, `ot-monitoring`,
`quality`; Business the work queue departments (`secretariat`, `finance`, `admin`, `hr`, …);
Scholars `literature`, `data`, `writing`, `grants`, `lab`; Core `platform-ops`, `security`,
`backup`, `integrity`.

Built-in prompts: `mail-triage`, `mail-secretariat`, `invoice-intake`, `legacy-changes`,
`literature-watch`, `citation-check`, `grant-deadlines`, `platform-health`, `linked-cases`, and
`morning-brief`
(an engine-built plan, no model).

Starter routines: `secretariat-inbox` (Business General Affairs pack), `secretariat-inbox-full`
and `morning-brief` (Business Company Operations pack, below and [Morning brief](#morning-brief)), `finance-invoice-intake` (Business Finance pack), `sales-quote-intake` (Business Sales quotation pack, [Quotations](/business/quotations)),
`procurement-po-draft` (Business Procurement pack: off until enabled; on `supplier.selected` in
`proc-requests` and weekdays at half past each hour 09:30 to 18:30, `po.prepare` for each case
`workitems_po_ready` lists. Each draft is recorded on the case (`purchaseOrderDraft`), so a choice
is drafted once; new quotes or a new choice make it due again, and a draft whose choice changed
mid-run is refused),
`nightly-legacy-analysis` (Industrial pack), `literature-watch`, `citation-check` and
`grant-deadlines` (Research pack, see [Scholars](#scholars)) and
`platform-health` (`templates/autopilot/core-platform-health.yaml`) and `linked-cases`
(`templates/autopilot/core-linked-cases.yaml`: weekdays 09:00 and 15:00, one work item when
`workitems_linked` finds blocked, missing-step or unreadable linked cases).

`nightly-legacy-analysis` (L1, nightly at 01:30 Asia/Tokyo and after a source drop in `source/`)
compares the sources with the stored baseline
([change detection](/tools/legacy-analyzer#change-detection)). Its gate step is
`legacy_changes`: the first run only creates the baseline and a night with no change ends
`no_input`, with no model call and no work item. When something changed, the `legacy-changes`
prompt gets the changes and the wave plan and proposes one item: a title, a summary in the
project language with each change and its `path:line` evidence, the impact (callers, job steps,
tables, wave plan effect) and the review a person should do, never a claim that anything was
deployed, merged or written to OT. The engine then regenerates the design document as Word
(`legacy.design_doc` with `output_format: docx`, into `output/design-docs/`
as `設計書_<YYYYMMDD>.docx` for a Japanese document, `design-doc_<YYYYMMDD>.docx` for English),
files the work item in `ind-analysis` (its summary is the plan's summary, or the intake note when
the summary is empty, and it references the Word file), and only then advances the baseline
(`legacy.baseline_advance`), so the next night compares against tonight.

`secretariat-inbox-full` (L1) files every new email as a case in its department's queue (email
intake, flags), prepares a reply draft for clean routine mail and, when the email explicitly asks
for a document, writes a Word document from `knowledge/company-facts.md` and attaches it to the
draft (`workitem.intake`, `mail.draft`, `office.create`, `mail.attach`). Nothing is sent; flagged
mail gets no draft. It needs the Microsoft 365 connector with mail read and `write.mailDraft`,
the office plugin enabled for the gateway (the engine calls tools through the gateway tool path,
which sees the gateway's plugins, not a template's per-Project plugins) and the Project in Act
mode for documents. The template keeps `knowledge/` read-only. It and
`finance-invoice-intake` start on new mail ([Triggers](#triggers)) with an hourly schedule as the
safety net.

## Triggers

A routine runs on a schedule, on events, or both. Events make it react within seconds instead of
waiting for the next slot. Triggers are deterministic: watchers in the gateway turn events into
signals and no model is involved until the routine actually runs. A triggered run is the same
run as a scheduled one (same gather, policy check, watchdog and evidence) with `trigger: "event"`
and the sources it coalesced in `triggerSources`, on the run record and in its evidence.

```yaml
trigger:
  schedule: "0 8-19 * * 1-5" # optional: keep a slow safety schedule (or interval)
  tz: Asia/Tokyo
  event:
    - { source: m365.mail, folder: inbox } # new mail in a folder (default inbox)
    - { source: workitems, queue: ga-requests, actions: [created, decided] } # queue, actions optional
    - { source: deadline, withinHours: 24 } # 1 to 168
    - { source: files, folder: inbox/scans } # a read-only or writable Project folder
  debounceSeconds: 30 # 5 to 600
  maxRunsPerHour: 12 # 1 to 60
```

Validation fails closed like the rest of the file: an unknown source or key, a mail folder that is
not a folder name or id, a files folder that is not under a read-only or writable folder of the
Project (or is the routines' own output folder `output/autopilot`), or a value out of range makes
the whole file invalid. A routine with only `event` has no cron job.

| Source      | What signals                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `m365.mail` | New mail in the folder, from one Microsoft Graph delta-query watcher per connector sign-in (every 60 s by default; see [Microsoft 365](/connectors/microsoft-365#autopilot-mail-triggers)). It says only that mail arrived; the routine's gather reads it as on any run.                                                       |
| `workitems` | A work item of the Project is created (`created`), changed (`changed`), decided (`decided`), has a flag cleared (`flag.clear`) or has its supplier chosen by a person (`supplier.selected`, the point to draft a purchase order with `po.prepare`), optionally in one queue. Changes the routine made itself never trigger it. |
| `deadline`  | Every 5 minutes: open items whose due date falls within `withinHours` (overdue included). Each item window (item and due date) signals once; a new due date is a new window.                                                                                                                                                   |
| `files`     | A file under the folder changes (fs watch, polling every 30 s where watching is not available). The routines' output folder, hidden files and editor temporaries are ignored.                                                                                                                                                  |

Dispatch, per routine:

- Signals within `debounceSeconds` after the first one coalesce into **one** run.
- At most `maxRunsPerHour` event runs per rolling hour; later signals wait for a free slot and
  then run once. Scheduled and manual runs are not counted.
- A routine already running (any trigger) is never started twice: one follow-up run is queued
  and starts when the current run ends.
- `autopilot.stopAll`, the STOP file and a paused routine drop signals (nothing piles up); the
  safety schedule catches up once the routine runs again.
- Loop guard: a routine triggered by its own outputs (later changes of work items its runs
  created, file changes while or just after it ran) more than 5 times in 10 minutes is paused by
  the watchdog (`pausedBy: "watchdog"`, reason `trigger_loop`). A person resumes it with a written
  reason, like any watchdog pause.

`autopilot.routines.list` shows each source's health in `routine.state.triggers`:
`{ source, status, lastSignalAt, lastError }`, `status` being `active`, `degraded` (the watcher has
a problem it retries or a person must fix, for example `reauth_required` after the Microsoft 365
sign-in expired, `rate_limited`, `folder_missing`) or `disabled` (the connector is not enabled,
or the routine is paused, disabled or stopped). Health changes emit `autopilot.changed` with
`kind: "trigger"`. A degraded mail trigger does not spin: it waits for a new sign-in while the
safety schedule keeps the routine running.

## Behaviour watchdog

Every run is measured **before any of its actions execute**: gather calls, bytes read, items and
actions the model proposed (in total and per action kind) and the time spent so far. Each metric
is compared with the routine's own baseline once it has at least 5 normal runs (threshold:
`max(3 × p95, static cap)`), and with static caps derived from the routine file before that:

| Metric        | Static cap                                                               |
| ------------- | ------------------------------------------------------------------------ |
| `gatherCalls` | one per plain step, `each.max` per fan-out step                          |
| `bytesRead`   | gather calls × 12,000 characters (the per-call cap)                      |
| `items`       | the larger of `maxItemsPerRun` and the fan-out maxima                    |
| `actions`     | items cap × the number of actions the routine lists; per kind: items cap |
| `durationMs`  | the reasoning timeout + 60 s per gather call                             |

The run also trips on a burst of refusals (more than 5 in one run, not counting the expected
`flagged` and `already_handled`), on any proposal of an action the routine does not list or no
catalogue knows (`not_in_routine`, `unknown_action`, `edition_mismatch`), and on reasoner tool-call
attempts in 2 consecutive runs.

A trip **executes nothing**: every action the level would allow is recorded as `needs_person`
with code `watchdog_hold` and waits for a person, items still reach the queue, the routine is
paused (`pausedBy: "watchdog"`, cron job switched off on the next sync) and one work item carries
the anomaly summary. The trip is audited (`autopilot.watchdog.trip`) and sealed in the run's
evidence (a `loop_guard` event). Tripped runs never enter the baseline. Only a person resumes the
routine, with a written reason (`autopilot.resume` with `reason`; refused with `reason_required`
otherwise). Pausing an already-paused routine is refused with `already_paused`, so a person cannot
overwrite the watchdog's pause and skip that reason. `autopilot.routines.list` (`state.watchdog`) and `autopilot.stats` (`watchdog` per
routine) show the baseline, the thresholds, the last trip and its reasons; each run record has
`watchdog` (tripped, reasons, metrics).

## Stopping every routine

Two switches stop the autopilot everywhere:

- **`autopilot.stopAll`** (person only, `operator.approvals`, voice refused, a written `reason`)
  pauses every routine of every Project (`pausedBy: "stopAll"`) and blocks new runs until
  **`autopilot.startAll`** (same rules) lifts it. The state is kept in
  `<KOLO_HOME>/autopilot/control.json` and survives restarts. `startAll` resumes only the routines
  `stopAll` paused; a routine a person or the watchdog paused stays paused. While the stop holds,
  no routine can be resumed on its own, whoever paused it (`stopped_all`). A second `stopAll`
  while the stop holds still pauses any routine that is not paused yet, but keeps the first stop's
  `by`, `at` and `reason` in `control` and answers `alreadyStopped: true`. Likewise a `startAll`
  when nothing is stopped keeps the last start's record and answers `alreadyStarted: true`.
- **The emergency STOP file**: while `<KOLO_HOME>/autopilot/STOP` exists, no routine runs (runs
  and resumes are refused with `emergency_stop`), even when the gateway API cannot be reached.
  Create it with any tool that can make a file on the gateway host (`touch`, Explorer, a remote
  shell); remove it to allow runs again.

Both are checked before every run and again right before a run's actions, so a stop set while a
run gathers or reasons still prevents its actions (the run is recorded as `skipped` and its
inputs are read again later). Both changes are audited and emit `autopilot.changed` (`stopAll`,
`startAll`) for every Project. `autopilot.routines.list` and `autopilot.stats` return `control`
(`stopped`, `by`, `at`, `reason`, `emergencyStop`).

## Evidence

Each run writes one bundle under
`<KOLO_HOME>/projects/<id>/autopilot/runs/<runId>/evidence/` in the standard evidence format
(hash-chained `events.jsonl`, Ed25519-signed `manifest.json`), so `kolo evidence verify` checks it.
Events record the routine digest, each gather call (tool, count, bytes), the reasoning output
digest, every action decision (class, decision, code, approval id, what it produced) and the
counts; never mail bodies or addresses. Each bundle names the previous run's root, chaining the
routine's runs. `autopilot.runs.get` verifies a run's bundle.

## Metrics

`autopilot.stats` reports per routine, per edition area and in total, from recorded events only:
runs, failed runs, items, prepared, acted, escalated, handled (items the autopilot carried
without a person) and **corrected by person** (autopilot-created work items a person edited,
sent back or cancelled: the learning signal). **Minutes saved** appear only when the routine sets
`metrics.baselineMinutes` (measured by the customer): handled minus corrected, times the
baseline. Without a baseline the value is `null`, never an estimate.

## Earned autonomy

A routine earns autonomy from its own record, and loses it the same way. Three rules hold
throughout: the routine file's `level` is the **maximum** (an administrator sets it), the engine
only ever moves a level **down**, and raising a level always needs a **person**.

**Effective level.** Each routine's state may carry an `override` (a lower level a person
accepted, or a demotion). The effective level is `min(file level, override)`; it is what
`authorizeAction` checks every action against, what the run record's `level` shows, and what the
connector re-checks before an L3 send under a standing approval (a demotion ends L3 sends at
once). An override above the file's level has no effect. `autopilot.routines.list` returns
`level` (the file's), `effectiveLevel`, `override` (`level`, `kind`: `accepted` or `demoted`,
`by`, `at`, `reason`, `changeId`) and `lastDemotion` (`from`, `to`, `cause`, `by`, `reason`,
`runId`, `itemId`, `at`).

**Proposals.** `autopilot.autonomy.proposals` reads the evidence over 30 days and proposes, per
routine, one step from its effective level: up (at most 5% corrected over at least 20 work items,
no failed run), down (20% or more corrected over at least 10 items) or a hold with the reason. It
never changes a level. Each proposal shows `fileLevel` and `acceptBlocker`: `above_file_level`
(the step would pass the file's level; an administrator raises it in the file) or
`no_standing_approval` (a promotion to L3 needs an active standing approval for the routine), or
`null` otherwise. `null` on a hold does not make it acceptable: accept refuses a hold with
`nothing_to_accept`.

**Accept.** `autopilot.autonomy.accept` (person only, `operator.approvals`, voice refused, a
written reason) applies the proposal the person was shown. It is recomputed first and must still
match (`kind`, `proposed`), otherwise `proposal_changed` (also when a demotion landed meanwhile);
a hold answers `nothing_to_accept`. Refused as well: `above_file_level` and, for a promotion to
L3, `no_standing_approval`. The accepted level becomes the routine's override; accepting the
file's own level clears the override, so the routine follows its file again.

**Decline.** `autopilot.autonomy.decline` (same rules) records that a person declined the
proposal they were shown; nothing changes. The proposal is recomputed and must still match
(`proposal_changed`; a hold answers `nothing_to_decline`). The same proposal comes back marked
`declined` for 30 days, or until the evidence produces a different one.

**Automatic demotion** (the safe direction only). The effective level drops one step at once,
never below L0, when:

- the [behaviour watchdog](#behaviour-watchdog) trips (`cause: "watchdog"`, with the run id; the
  routine is also paused as before);
- a person marks a work item the autopilot created as a serious error with
  `autopilot.reportError` (`projectId`, `itemId`, written `reason`; person only,
  `operator.approvals`, voice refused). The person must be able to read the item (otherwise
  `item_not_found`), the item must come from a routine (`not_autopilot_item`), and one item is
  reported once (`already_reported`). The demotion links the item and the run that produced it.

A routine demoted to L0 refuses every action with `level_observe`; those refusals do not count
toward the watchdog's refusal burst.

**Record.** Every accept and demotion is one line in
`<KOLO_HOME>/projects/<id>/autopilot/autonomy-changes.jsonl` (`id`, `kind`, `fileLevel`, `from`,
`to`, `by`, `at`, `reason`, `cause`, `runId`, `itemId`, `proposal`) with its own signed evidence
bundle under `autopilot/autonomy/<changeId>/evidence/`, written under the Project lock together
with the new override. It is audited (`autopilot.autonomy.accept`, `autopilot.autonomy.demote`)
and emits `autopilot.changed` with kind `autonomy`.

## Morning brief

Each Project member gets a short brief of what happened and what waits for them, built from
recorded data only (run records, routine state, the work queue); no model is called.

A brief covers a window (default: the 24 hours before now) and holds:

- **handled**: runs, items, prepared, acted, escalated, handled without a person, reply drafts,
  failed runs, and the same counts per department or edition area;
- **documents**: the Office documents routines wrote (`office.create`), with run and routine;
- **waiting**: decisions on items whose current stage the person may decide now, flagged items
  the person may clear (the `workitems.clearFlag` rule), and earned-autonomy proposals they may
  accept (not yet declined), with `acceptBlocker`; and `linked`: open linked cases the person
  requested, is assigned or must decide whose steps are ready to open, whose child item is missing,
  that are blocked (a step cancelled or stuck), or whose record cannot be read (`unreadable`).
  Read-only: the brief never creates a plan, opens a step or attaches a child. `notifications`
  counts the person's unread in-app notifications on items they can still read
  (`unreadable: true` when their notification record cannot be read); it does not mark anything read;
- **commitments**: open items the person requested, is assigned or must decide, due by the end of
  the next day (or overdue);
- **problems**: watchdog trips, failed and skipped runs, demotions in the window, paused
  routines, an invalid routines file, and the global stop.

Work items appear only when the person can already read them, with the same rules as the work
queue; every item entry carries `projectId` and `itemId` as its deep link (open it with
`workitems.get`). Routine-level facts are the ones any observer already sees in
`autopilot.routines.list` and `autopilot.stats`.

**Reading it.** `autopilot.brief.get` (`observe`, person only; optional `from` and `to`) returns
the caller's own brief as structured JSON. Proposals are included when the caller holds
`operator.approvals`.

The Project’s Autopilot panel shows **Your morning brief** in English or Japanese, including handled work, documents, decisions, flagged items, commitments and problems. It reads only the signed-in caller’s brief and keeps history filters separate. Refresh reloads the snapshot; snapshots over an hour old are marked stale. Loading, unavailable and disconnected states hide prior brief content. Lists display up to 50 entries with a limit notice; draft counts cover at most the newest 500 runs in the period. Document paths are displayed as text.

**Delivering it.** The `brief.deliver` action (class `prepare`, so L1 is enough) renders the brief
as Japanese, then English text and either creates an **Outlook draft** addressed to the member's
own work address through `m365_mail_create_draft`, or, for a member without an address, writes it
to `output/briefs/<day>-<principal>.md` in the Project (a new file each time, never over an
existing one; the Project mode must allow writing `output/`). The address comes from the work queue
policy, never from a plan:

```yaml
access:
  members:
    - { principal: device:abc123def456, name: 佐藤, roles: [approver], email: sato@example.co.jp }
```

Nothing is sent, and nothing goes to LINE or WhatsApp; a person reads the draft in Outlook. A file
in `output/briefs/` is readable by everyone who can read the Project folder, so give members an
`email` when their briefs must stay private.

A routine whose reasoning names the built-in `morning-brief` gets its plan from the engine (one
`brief.deliver` per member of `access.members`) and calls no model; its run record shows
`reasoning.backend: "engine"`. The starter routine `morning-brief` (Business Company Operations
pack) runs weekdays at 07:30 Asia/Tokyo at L1:

```yaml
- id: morning-brief
  edition: business
  area: secretariat
  name: { ja: 朝のブリーフ, en: Morning brief }
  trigger: { schedule: "30 7 * * 1-5", tz: Asia/Tokyo }
  reasoning: { prompt: morning-brief, schema: autopilot.plan.v1 }
  actions: [brief.deliver]
  level: L1
  limits: { maxItemsPerRun: 50, maxActionsPerDay: 100 }
```

It needs the Microsoft 365 connector with `write.mailDraft` for members with an address.

## Gateway methods

| Method                         | Scope                           | Notes                                                                                                     |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `autopilot.routines.list`      | observe                         | routines with state, action catalogue, areas                                                              |
| `autopilot.routines.sync`      | admin                           | re-register the Project's cron jobs (idempotent)                                                          |
| `autopilot.runs.list`          | observe                         | newest first, `total` for the filter, cursor                                                              |
| `autopilot.runs.get`           | observe                         | full run record and evidence verification                                                                 |
| `autopilot.run`                | attach (operator.write)         | manual run, same path as a scheduled run                                                                  |
| `autopilot.pause` / `resume`   | attach, person only             | a written reason to pause; cron job switched off; resume after a watchdog or stopAll pause needs `reason` |
| `autopilot.approvals.create`   | operator.approvals, person only | scoped, expiring, audited                                                                                 |
| `autopilot.approvals.list`     | observe                         | active by default, `includeInactive` for history                                                          |
| `autopilot.approvals.revoke`   | operator.approvals, person only | written reason, audited                                                                                   |
| `autopilot.stats`              | observe                         | optional `from` / `to`                                                                                    |
| `autopilot.autonomy.proposals` | observe                         | proposals only, never applied                                                                             |
| `autopilot.autonomy.accept`    | operator.approvals, person only | written reason, audited; the proposal becomes the override, never above the file's level                  |
| `autopilot.autonomy.decline`   | operator.approvals, person only | written reason, audited; records the decision, changes no level                                           |
| `autopilot.reportError`        | operator.approvals, person only | an autopilot item is a serious error: its routine drops one level; written reason, audited                |
| `autopilot.brief.get`          | observe, person only            | the caller's own morning brief (items the caller can read)                                                |
| `autopilot.stopAll`            | operator.approvals, person only | written reason; pauses every routine, blocks runs                                                         |
| `autopilot.startAll`           | operator.approvals, person only | written reason; lifts the stop                                                                            |

Changes emit `autopilot.changed` (`projectId`, `routineId`, `kind`: run, paused, resumed,
approval, autonomy, sync, watchdog, trigger, stopAll, startAll). Refusals answer `INVALID_REQUEST` with
`error.details.code` (for example `not_a_person`, `paused`, `routines_invalid`, `invalid_scope`,
`invalid_expiry`, `reason_required`, `already_paused`, `not_paused`, `stopped_all`, `emergency_stop`, `proposal_changed`,
`nothing_to_accept`, `above_file_level`, `no_standing_approval`, `item_not_found`, `not_autopilot_item`, `already_reported`).
A watchdog trip emits both `watchdog` and `autonomy` (the routine was demoted).

## Console proposal review

Open a Project's Autopilot tab to inspect server-provided autonomy proposals. Edition and area
filters restrict proposals to the displayed routines. Each card shows current and proposed levels,
the reason, evidence dates, work-item and correction counts, and the correction rate. A missing
rate is shown as unknown. Policy thresholds come from the server.

A person with approval permission can accept or decline a promotion or demotion with a written
reason (4–1,000 characters). Accept applies the displayed proposed level through
`autopilot.autonomy.accept`; it stays within the file ceiling and requires an active standing
approval for L3. Holds cannot be accepted, and a server-reported acceptance blocker disables
Accept. Declining records who declined it, when, and why without changing the routine level.
If the proposal or acceptance requirements changed, the console refreshes them and retains the
reason for another decision. An uncertain write is never retried automatically: refresh and
review the routine before trying again. Accept, Decline, Pause and Resume share one pending
operation guard. If proposals are unavailable, run history remains available; Refresh retries
the read.

The console offers Pause and Resume to people with approval permission. Pause requires a written reason (1–1,000 characters); resuming a watchdog or stopAll pause requires at least four trimmed characters. A global stop blocks Resume. Stale state is refreshed and reasons survive failures; uncertain writes are never retried automatically.

Routine cards show the server-reported effective level separately from the file ceiling, with
the current override attribution and the last automatic reduction (time, cause and reason).
A past reduction remains history even if a later acceptance restores the level. Proposal cards
show the file ceiling and any server-reported acceptance blocker. These displays do not change
levels or create standing approvals.
