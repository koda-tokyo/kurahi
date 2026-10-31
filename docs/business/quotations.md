---
summary: "Business quotations: quotation requests become cases with a quotation in Word and Excel, priced from the company price list; tax per rate and totals computed by Kurahi; a person approves and sends"
read_when:
  - You are setting up quotations in Kurahi Business
  - You need to know how prices, consumption tax and totals are computed
title: "Quotations"
---

# Quotations

A quotation request becomes a case in the **Quotation requests** queue (`sales-quotes`, work item
type `quote`) with a quotation written as Word and Excel. People approve it and a person sends it.

## Who computes what

- **The model** reads the request and copies the customer, the subject and the requested lines:
  an item code when the request gives one, the item as written, and the quantity. It never gives
  a price, an amount, a discount or a total; a request line that carries a price is refused.
- **The price list** (`quotes/price-list.csv` in the Project, maintained by people) gives the
  tax-exclusive unit price, unit and tax rate of each item.
- **Kurahi** computes every amount exactly: line amounts, line and document discounts, consumption
  tax per rate (10%, 8% reduced, 0%) and the totals. Tax is rounded **once per rate per document**,
  as Japan's qualified invoice system requires; the rounding mode is floor (round down) unless
  `quotes/company.json` says `round` or `ceil`.
- A requested item the price list cannot match **exactly** (by item code, or by the exact item
  name) is shown as `【要確認】` ("to confirm") with no amount and is left out of the totals, for a person to price.

## Approval gate

`quote.prepare` writes the computed figures onto the case: `quoteNumber`, `quoteSubtotal`,
`quoteTax`, `quoteTotal`, `quoteUnpriced`, `quoteLines`, `quoteValidUntil` and `quotePriceList`
(the SHA-256 of the price list the quotation was priced from, also printed on the document). The
pack's checks use them:

Two outcomes are kept apart:

- **Final quotation**: every included item is priced and every line has a supported tax
  classification. Only then can the case be approved as final.
- **Provisional estimate**: `quote.complete` (unpriced items) and `quote.taxclass` (0% lines, while
  tax-exempt, out-of-scope and export-exempt sales are not distinguished) block final approval. A person may approve with a
  written reason, but that releases a **provisional estimate only**: the document stays titled
  "Quotation (provisional)" (`御見積書（暫定）` in Japanese), states that open items remain, and the
  case records
  `override.outcome: "provisional"` and who authorised the release. It never becomes a final
  approval. To make it final, a person prices the items, or takes them out of scope: the quotation is
  prepared again with `excluded` entries (each with the person's reason, at least 10 characters),
  printed under "Items out of scope" and no longer counted as unpriced.

A changed quotation is a **revision**: `revision: 2` with the original `number` writes
`<number>-R2`, which names the version it supersedes (R3 supersedes R2, and so on); the case records
`quoteRevision` and `quoteSupersedes`. Exclusions and revisions are a person's decisions: the
`quote.prepare` routine action refuses both.

- `quote.generated` — a quote case needs a Kurahi quotation.
- The case records the SHA-256 of the exact Word and Excel files (`quoteDocument`,
  `quoteWorkbook`) and of the price list (`quotePriceList`); the approval evidence names that item
  revision, and changing the item's source clears earlier approvals.
- `quote.amount` — a total above ¥1,000,000 (tax included) needs a second approver (example value).

Preparation, approval and sending are separate events. Approval applies to the pinned draft version;
changing the source or the draft clears earlier approvals.

## Setup

Create a Project from the **Sales quotations** template. It adds:

| Path                    | What it is                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quotes/price-list.csv` | Sample price list. Columns code, name, unit price (required), unit, tax rate, cost; the Japanese headers `品番`, `品名`, `単価`, `単位`, `税率`, `原価` are also accepted. UTF-8 or Shift_JIS (Excel's Japanese CSV). Replace the sample rows. |
| `quotes/company.json`   | Issuer name, `department`, `contact` (person), address, phone, `registrationNumber` (T + 13 digits), `lineRounding`, `taxRounding`.                                                                                                            |
| `workqueue.yaml`        | The `sales-quotes` queue, a one-stage approval route (sales lead) and checks: the quotation document is attached; the reply draft does not say the quotation was sent or the order accepted.                                                   |
| `autopilot.yaml`        | The `sales-quote-intake` routine (L1, off until you enable it).                                                                                                                                                                                |

The `quotes/` folder is read-only for agents: only people change prices.

## The routine

`sales-quote-intake` (L1 Prepare) reads quotation requests from the connected mailbox and, per
request, files the case, prepares a reply draft in Outlook, writes the quotation with
`quote.prepare` and attaches it to the draft with `mail.attach`. Nothing is sent. Flagged mail
(fraud, phishing, prompt injection, unverified senders) gets no action.

Sending a quotation is a commercial offer: it is never autonomous, at any level.

## The tool

`office_quote_create` (office plugin) writes `output/quotes/quotation_<number>.docx` and `.xlsx`
(`見積書_<number>` for a Japanese quotation), never over an earlier file. The number defaults to
`Q-YYYYMMDD`; validity defaults to 30 days. The audit row records line counts and size, never
customer names or amounts.

`office_quote_compare` compares quotations from two or more suppliers for the same request
(competing quotes). The model transcribes what each supplier quoted; Kurahi computes every amount and compares
the tax-exclusive net. A quote that leaves out an item or quotes a different quantity is incomplete
and is never named lowest: a missing item is not a free item. Ties list every supplier. The result
is not an award; a person decides. It writes nothing, and the audit row records only counts.

`office_po_create` writes a purchase order draft for the supplier **a person** chose from
that comparison: `output/purchase-orders/purchase-order_<number>.docx` and `.xlsx` (`発注書_<number>`
for a Japanese purchase order), never over an earlier file. The number defaults to `PO-YYYYMMDD`. Kurahi recomputes the
comparison from the same request and quotes, so the draft carries only computed amounts; a supplier
whose quote is incomplete is refused. The draft names the person who chose the supplier
(`selected_by`, required). Choosing a supplier other than the lowest complete quote is allowed, but
needs a written reason, which is printed on the draft for the approver. The model never chooses the
supplier. It needs a Project in Act mode, nothing is issued or sent, and the audit row records
only counts and whether the choice deviates from the lowest.

## Limitations

- The price list is CSV or an Excel workbook (.xlsx, with `price_list: quotes/<name>.xlsx`). From a
  workbook only the first visible sheet is read, and only the values Excel saved: a formula
  with no saved result, or an error cell such as #N/A (also in a CSV), leaves its row out as a
  problem rather than being read as a blank. A workbook whose XML holds a comment, a DTD or
  CDATA, uses Strict Open XML, or lists rows or cells out of order is refused whole rather than
  guessed at; save it again from Excel. kintone and Money Forward item masters are not read.
- Prices are tax-exclusive; tax-inclusive price lists are not supported yet.
- The 0% rate is one bucket; tax-exempt, out-of-scope and export-exempt sales are not distinguished yet.
- Negative amounts (credits) are refused rather than rounded.
- Tax is rounded once per rate per document, as the qualified-invoice rule requires for invoices;
  quotations use the same method. Confirm the rounding settings with your accountant before use.
- There are no discount or margin approval rules.
- The comparison is by price only; delivery, terms and quality are for the person who decides.
- There is no routine action for purchase orders yet: the supplier choice must come from a person,
  so `office_po_create` is used in a conversation, not by a routine.
