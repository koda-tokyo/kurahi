---
summary: "Business functional packs: what each pack provides, its limitations, and the boundaries between review and execution."
title: "Functional packs"
---

# Functional packs

Also available in [Japanese](/ja/business/functional-packs).

Kurahi Business is a governed work and approval layer over your existing business systems.
It prepares requests, checks configured rules, supports human review and records evidence.
Your accounting, HR and other systems remain the systems of record. A read-only connector does
not complete a transaction, and an approval record does not prove that an order, payment or
notification was delivered.

The 15 department workspaces are **navigation, not 15 business applications**. Department labels
do not grant access. Configure Project and queue permissions before handling confidential records.
See [Work queue](/business/work-queue) for the shared review and evidence capabilities.

## Status guide

This catalogue describes the scope of Kurahi 2.3.0 (29 October 2026).

- **Available**: a starter workflow is provided with the limitations listed below. It is not a
  complete business system; company configuration and access setup still apply.

| Pack                          | Status    | Current foundation                                                                                          |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| Employee requests             | Available | Request queues, bilingual instructions and form templates, L1 mail preparation                              |
| Spend: quotation and purchase | Available | Sales quotations, supplier quote comparison, purchase-order drafts; finance and procurement review starters |
| People operations             | Available | Leave/overtime review and manual onboarding/offboarding case checklists                                     |
| Contracts and obligations     | Available | Register, review and obligation queues, date checks and human hand-off forms                                |
| Management oversight          | Available | Manual workload, exception and outcome worksheets using existing statistics                                 |

## What a complete business system requires

A pack is a complete business system only when all six criteria below hold. This catalogue does
not claim that any pack meets them; an available shared engine feature does not make a pack a
complete business system.

1. A complete employee-to-reviewer workflow works end to end.
2. Access restrictions are in place.
3. Notifications and overdue handling work.
4. Exception, retry and cancellation behaviour is defined and works.
5. Downstream results are confirmed wherever the workflow hands off to another system.
6. A representative user completes the workflow without developer help.

## 1. Employee requests

**Workflows:** equipment/IT requests, business cards, facilities requests and certificate requests.
Mail intake prepares an acknowledgement draft and opens an item in the initial triage queue.
A person classifies the request, completes its structured fields and arranges the appropriate
queue review; intake is not automatic request-type routing.

**Forms:** Japanese and English Markdown request templates for each request type. These are
worksheets for supplying information, not specialized interactive forms in the console.

**Rules:** required request details and queue-specific checks support review. Adapt the starter
policy, approval authority and access permissions to your company. Human approval remains distinct
from fulfilment. Do not describe a request as issued, ordered or completed without confirmation.

**Integrations:** the optional L1 routine requires a configured mail connector with mail-read and
draft permissions. It prepares drafts; a person reviews and sends them. The routine is disabled by default and uses a dedicated Microsoft 365 mailbox. The pack does not configure
credentials or activate a customer mailbox by itself.

**Outputs:** request items with status, review history and evidence, plus draft acknowledgements.
Source: `templates/projects/packs/business-employee-requests/`.

**Limitations:** no automatic notification or delivery, equipment fulfilment, account/access
provisioning, certificate issuance or payment. Cross-department linked cases and specialized form
UI are not included. Mail intake ownership is not the authenticated employee identity, so it does not automatically populate that employee’s My requests view. A department filter is not a privacy boundary.

## 2. Spend: quotation and purchase

**Workflows:** sales quotations, supplier quote comparison and purchase-order drafts for the
supplier a person chose (see below and [Quotations](/business/quotations)). Existing Finance and
Procurement starters support expense/invoice review and purchase-request review. The pack does not
include purchase-order hand-off, receipt confirmation, three-way matching, duplicate checks,
cost-centre coding or accounting hand-off, and does not implement the full quotation-to-invoice
chain.

**Forms:** existing review tables and quote-comparison Markdown templates; structured expense and
purchase request fields. There are no end-to-end receipt or matching forms.

**Rules:** the starters check required fields, configured amount thresholds, supporting documents
and lead dates. Procurement uses separation of duties. Thresholds are examples to adapt, not a
statement of your company's approval policy.

**Integrations:** confirmed, person-approved write hand-offs to accounting and procurement systems
are not included. Reading accounting records does not post entries or place an order.

**Outputs:** existing review drafts, comparison tables, order proposals and approval evidence.
Source: `templates/projects/packs/business-finance-expense-invoice/` and
`templates/projects/packs/business-procurement/`.

**Limitations:** no complete automated three-way match or confirmed downstream transaction is
promised by these starters. A person places the order after approval; payments remain in the
accounting system.

### Accounting hand-off review — manual worksheet

The Finance starter includes `templates/02-handoff-review.md` for recording an approved invoice
version, the exact destination product/company, external record evidence and a read-back comparison.
Uncertain delivery and unresolved differences stay unfinished with an owner and next review date.
A person checks the evidence; an unchecked field is not a match, and material changes need renewed
approval. Look up the existing destination record before considering a person-authorised retry.

This worksheet does not invoke hand-off APIs, change runtime states, enable connector writes or
perform automatic reconciliation. Its completion wording is **Hand-off completed — payment not
verified**. An accounting record does not prove settlement. Payment verification and purchase-order/
receipt/invoice matching are separate work and are not part of this pack.

### Sales quotations

The [Sales quotations starter](/business/quotations) prepares Word and Excel quotations from a
human-maintained CSV or Excel (.xlsx) price list. Kurahi computes amounts and tax; unmatched items are marked for
review without an amount and excluded from totals. The model copies requested items and quantities,
not prices. A sales lead reviews the quotation, and a person sends it.

The optional L1 mail routine is disabled by default. After mailbox, office-plugin and Project
setup, it creates a quotation work item and a reply draft with the quotation attached. It does not
send an offer or accept an order. Configure reviewer access and replace the sample price list
before use. Source: `templates/projects/packs/business-sales-quotation/`.

CSV and Excel (.xlsx) price lists and tax-exclusive prices are supported. Item-master
connections and discount/margin approval rules are not included. Quotations do not complete the
wider purchase-to-invoice workflow.

### Supplier quotation comparison — review support

With the office plugin configured and `office_quote_compare` available to the Project agent,
compare two or more suppliers against the same requested item codes and quantities. A person
checks the transcribed prices, tax rates, discounts and source references against the quotations.
The tool calculates amounts and compares tax-exclusive net totals; it writes no comparison file,
places no order and makes no award. Copy the result and source references into the review worksheet.

A quote with a missing item or a different quantity is incomplete and cannot be named lowest for
the whole request. Missing prices are not zero. Ties retain every lowest supplier; if no quote is
complete, there is no overall lowest. Item-level lowest prices are separate from whole-request
eligibility: an incomplete supplier may still have the lowest price for an individual item.
A person reviews delivery, validity, payment terms and quality before deciding.

The procurement starter supplies a bilingual comparison worksheet and manual review guidance.
It does not install an automatic comparison routine or connect comparison results to approval
fields. Receipt, matching and invoice settlement are not part of this pack. See [Sales quotations](/business/quotations) for
shared calculation limitations.

## 3. People operations

**Workflows:** leave and overtime review with attendance source references, plus manual
onboarding/offboarding checklists held as case items. People supply the source facts, submit for
review and record the outcome of work performed in other systems.

**Forms:** bilingual Markdown source forms for leave and overtime, attendance review and employee
lifecycle checklists. Attendance review records the source reference and as-of time and separates
actual hours from forecasts. Checklist rows carry stable task keys, owners, dependencies and
evidence references. These are Markdown fields; reading them into the console does not create child cases.

The lifecycle evidence worksheet records each task’s authoritative source, observed outcome,
reviewer and exception follow-up. The case owner reconciles all required task keys manually;
cancellation preserves evidence and any reversal requires separate authorization and confirmation.
The onboarding/offboarding worksheets also map stable task keys to accountable department IDs and
required outcomes. People record actual Project, queue, item ID and revision; the console can use the worksheet tables to prefill a linked-case plan for review. Cancelled or missing tasks do not count as successful outcomes.

**Rules:** required fields, date and sample hour checks support review. The manager approval route
adds an HR second stage for overtime when forecast monthly hours exceed the sample threshold of 45 hours. Leave requests always require HR review after the manager.
Adapt thresholds and reviewer roles to company policy; this does not establish legal compliance.
Configure access restrictions before recording employee information.

**Integrations:** attendance and HR records are supplied and checked by people. There is no attendance
sync, payroll write or automatic account/access change. Manual dependencies do not trigger work in
another department or enforce completion order.

**Outputs:** review notes distinguishing actuals from forecasts, leave/overtime request status,
manager and applicable HR decisions, and manual onboarding/offboarding case checklists with
recorded evidence. Source: `templates/projects/packs/business-people-operations/`.
The earlier leave/overtime starter remains at `templates/projects/packs/business-hr-leave-overtime/`.

**Limitations:** no automatic leave entitlement calculation, notification, employee lifecycle
execution or confirmed downstream hand-off. Checklist task keys do not link work items; owners,
dependencies and evidence must be maintained and verified by a person. Approval does not establish
that payroll, equipment or access changes occurred. The worksheet prefill described below is available; lifecycle execution is not automated.

### Review a worksheet plan in the console

In the linked-case create form, an available onboarding or offboarding worksheet can prefill
steps, departments and dependencies. The read is read-only. Review the proposed plan, then
explicitly create it; selecting a worksheet does not create child items, grant access or perform
HR, equipment or account changes. The pack is a starter workflow, not a complete business system.

Keep the worksheet's `Key | Task | Depends on` and `Task key | Department ID` table headers,
unique keys and exact dependency references. The picker orders valid steps so prerequisites come
first. Missing, unreadable or invalid worksheets are not usable plans; the picker shows a reason
for a rejected plan when it has a file name. Check the worksheet before retrying rather than
deleting a dependency to make a plan selectable.
General Affairs is department `admin`. Check every department against the destination queue.

The worksheet reader maps `onboarding.hr-confirm` to `onboarding-hr-confirm`. Before submission,
the console shows the original worksheet key beside its proposed numbered key, such as `step-1`.
Prerequisite ordering and row removal can change the numbering. Record the final displayed
mapping alongside child item and evidence references: the created plan does not retain worksheet
source keys. Do not substitute the reader's dashed key for the actual created step key.

Unedited prefilled titles retain the worksheet's Japanese and English text. When the screen
language has no nonblank title, the form displays the worksheet's other language without
translating it. Editing a title discards the carried translations and labels the new text with
the screen language used for that edit. Switching the screen language afterwards does not
translate or relabel that edited text. Review both the wording and its language before creating
the plan. Worksheet status and evidence cells do not prove child completion or a downstream result.

## 4. Contracts and obligations

**Workflows:** fixed-term contract register entries, review requests, renewal/notice-date review,
obligations with named owners and signature hand-off review.
A person transfers facts from the supplied forms into work items, submits them for configured
review and records the result of any external signature or notice delivery.

**Forms:** five bilingual Markdown worksheets for registration, review, renewal/notice dates,
obligations and signature hand-off, with reviewer guidance. These are source forms, not dedicated console inputs
or automatic document extraction.

**Rules:** required fields and date checks support review of renewal dates, notice deadlines and
obligation due dates. Configure the named reviewer roles and Project/queue access before use;
the starter grants no fallback access and requires separation of duties. Required-field checks
establish presence, not the identity or authority of the named owner. Dates use calendar days;
notice on the renewal date is allowed by the starter, so a person must check the actual notice
period. Historical register dates are accepted; past renewal/notice, review and obligation due
dates fail normal checks and need human escalation with the original dates preserved.

**Integrations:** signature and notice delivery are human steps in your existing systems.
The pack does not activate a signing service or a scheduled renewal-notification routine.

**Outputs:** register, review and obligation work items, human decisions, review notes and hand-off
records. Source: `templates/projects/packs/business-contracts-obligations/`.

**Limitations:** date rules validate supplied fields during policy checks; they do not monitor the
calendar or send renewal alerts. A shared contract reference does not create linked parent/child
cases. Work-item approval is not contract execution, signature verification or fulfillment of an
obligation. Record downstream confirmation separately. The pack sends no renewal or obligation
notifications and does not automate lifecycle transitions.

### Contract source version and review decisions

Register and review requests require `documentVersion` alongside `documentReference`, so the
submitted record names the exact revision. Required-field checks establish presence only; a person
verifies the source and preserves an immutable version reference or an access-controlled copy.
The review worksheet records findings, reviewer, time and company approval references. When terms
change, preserve the earlier evidence and submit a new review request for the changed version,
obtaining any required human reapproval. The starter does not fetch documents, detect version
changes, invalidate prior approvals or link review requests automatically. A review decision does
not authorize signature. Existing Projects must explicitly adopt the updated fields and policy;
this starter update does not migrate their human-maintained forms or policy.

### Renewal and obligation evidence — manual worksheets

The renewal and obligation source forms include bilingual evidence sections for the exact source
version and clause, deadline reasoning, responsible people, next manual review and external outcome
references. A person checks amendments, calendar versus business days, cutoff time/timezone and
whether notice must arrive or be dispatched by the deadline. Uncertain terms go to the assigned
reviewer; overdue dates stay unchanged and need separate escalation.

A person maintains the reminder calendar and verifies delivery or acceptance evidence. Missing,
partial or disputed evidence stays unresolved. These Markdown notes are not automatically imported
or validated, and they do not schedule reminders, send notices, perform obligations, verify
signatures or validate legal enforceability. The pack is a starter workflow, not a complete
business system.

## 5. Management oversight

**Workflows:** manual report preparation from authorized work-queue statistics and evidence.
Choose the Management oversight project starter, supply authorized source exports, and prepare
review drafts. This report Project neither aggregates other Projects nor inherits their access.

**Forms:** bilingual Markdown worksheets for workload snapshots, exception follow-up and measured
outcomes, plus a management review and decision record with metric definitions. Record source
Project, reader, queue/department filters, response scope, capture time, approval window and
coverage gaps. Drafts go to output/.

**Review record:** `reports/review-decisions.md` ties findings and decisions to the exact report
version. Record owners, due dates, separate approvals needed, completion evidence and the next
review for unresolved actions. People verify the audience and record actual distribution; revisions
retain prior versions and correction notices. Recording a decision does not approve a source case,
assign a task, send a reminder or authorize an external transaction.

**Linked-case review:** the decision worksheet records the source Project, parent, plan,
per-step departments/dependencies/children, capture time, blocked/missing evidence and next owner.
All child items done does not prove parent closure or a downstream outcome. Record destination
evidence separately; never count a parent and its children as unique business outcomes.
This remains manual evidence capture, with no plan creation or child attachment.
The worksheet also records supplied [morning briefs and linked-case checks](/autopilot).
A morning brief covers the recipient's readable open parents needing attention; the
`workitems_linked` check covers open parents in its run's Project, including unassigned cases.
Record list truncation and unreadable evidence. Older briefs without `waiting.linked` provide no
linked-case evidence. Check categories can overlap and `stuckIds` lists at most ten parents;
do not sum categories or treat the ID list as exhaustive. Ready steps alone do not trigger the
check's escalation. This pack installs neither routine; a verdict or intake does not prove repair.

**Notification evidence:** the review worksheet separates calculated recipients, stored records,
delivery receipts and person acknowledgements. None alone proves approval or completed work.
The current recipient calculation cannot enumerate approvers known only through group membership;
record that coverage gap and verify outstanding work separately. An empty notification list does
not prove that no action is needed. This pack creates no notifications or reminders.

**Rules:** preserve source references; distinguish unknown from zero, estimates from measurements,
and approval from confirmed downstream completion. Review and distribution are manual. The
worksheets are instructions, not executable validation or access policy.

**Integrations:** existing work-item statistics and evidence, supplied by authorized people.
No scheduled collection, notifications, new review queues or downstream writes are installed.
Reading source statistics can apply existing due-escalation policy.

**Outputs:** snapshot, exception and outcome report drafts. Current counts and overdue statistics
are separate from windowed approval median/p90 hours and sample size. The statistics API returns
no measured savings or downstream outcome totals; those require separately verified evidence.
Source: `templates/projects/packs/business-management-oversight/`.

**Limitations:** no cross-Project dashboard, historical trend calculation, automatic reconciliation
or confirmed outcome measurement. Queue counts do not prove company-wide coverage. A missing queue
is not evidence of zero work. Statistics are not paginated; separate item exports may be limited.
The starter does not meet all six completion criteria.
