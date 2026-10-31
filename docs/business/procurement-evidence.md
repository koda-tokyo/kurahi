---
title: "Procurement evidence"
summary: "Record spreadsheet sources and purchase-order draft checks without treating a draft as an issued order."
---

# Procurement evidence

Also available in [Japanese](/ja/business/procurement-evidence).

Use these optional ledgers alongside the procurement pack comparison worksheet and purchase process. Copy them into a project document when needed; they do not update case state.

## Spreadsheet sources

For a CSV or XLSX offer, preserve the supplier's original and record the copy used for comparison.
When file intake is available, a person places an ordinary copy under the project's `quotes/`
folder. Use the intended first visible sheet and recalculate and save formulas before intake.
Check item codes, quantities, tax-exclusive prices and tax rates against the supplier's offer.
Quantities must not contain currency marks; use unambiguous numbers such as `1200.5`.
If intake refuses the file, correct the reported problems with a person; do not omit rejected rows
or treat them as zero-priced items.

| Supplier | Original reference and version | Compared file | Returned SHA-256, if available | Checked by and date |
| -------- | ------------------------------ | ------------- | ------------------------------ | ------------------- |

Copy a returned hash exactly; leave it as “not recorded” when none is available. A matching hash
identifies the bytes read, not supplier authenticity, current prices or approval. Saving a revised
sheet does not refresh an existing comparison. Record the revised offer again, compare it again,
and have a person review the selection before preparing an order. Retain the previous source
reference and explain the revision. If the case marks the selection stale, resolve it through
human selection review; this worksheet does not clear that state.

## Purchase-order draft handoff

Before approval, open the proposed order and check its supplier, item codes, quantities, prices,
taxes and terms against the reviewed offer and selection. Record the evidence below for that
specific draft. A case entry or a displayed filename does not prove the document was checked.

| Evidence                                       | Reference |
| ---------------------------------------------- | --------- |
| Case and selected supplier                     |           |
| Reviewed offer version and compared file       |           |
| Full source SHA-256, if recorded               |           |
| Selection reviewer, date and reason            |           |
| Draft file and version checked                 |           |
| Draft checker and date                         |           |
| Approval reference                             |           |
| Order placement confirmation, after issue only |           |

Keep the source reference captured for this draft. Do not replace it with a newer sheet's hash,
even when prices and totals are unchanged. A shortened display hash is only a locator; copy the
full recorded value into this handoff, or write “not recorded” if unavailable. The hash identifies
file contents, not approval or supplier authenticity.

If the offer, selection or draft changes, retain the previous references and explain the change.
Review the affected comparison and selection, then prepare and check the corresponding draft
again before approval. If the case reports an out-of-date draft, resolve that mismatch before
using it; filling this handoff does not update the case or clear its warning. A recorded draft
remains unissued until a person places the order and records the confirmation.
