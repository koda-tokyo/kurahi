---
title: "Procurement evidence / 購買の証跡"
summary: "Record spreadsheet sources and purchase-order draft checks without treating a draft as an issued order."
---

# Procurement evidence / 購買の証跡

Use these optional ledgers alongside the procurement pack comparison worksheet and purchase process. Copy them into a project document when needed; they do not update case state.
購買パックの比較用紙・手順と併用する任意の記録表です。必要に応じてプロジェクト文書にコピーします。案件の状態は更新しません。

## Spreadsheet sources / 表計算ファイルの原本

For a CSV or XLSX offer, preserve the supplier's original and record the copy used for comparison.
When file intake is available, a person places an ordinary copy under the project's `quotes/`
folder. Use the intended first visible sheet and recalculate and save formulas before intake.
Check item codes, quantities, tax-exclusive prices and tax rates against the supplier's offer.
Quantities must not contain currency marks; use unambiguous numbers such as `1200.5`.
If intake refuses the file, correct the reported problems with a person; do not omit rejected rows
or treat them as zero-priced items.
CSV・XLSX の見積は取引先の原本を保存し、比較に使用したコピーを記録します。
ファイル読込を利用できる場合、人がプロジェクトの `quotes/` フォルダーに通常のコピーを置きます。
対象を最初の表示シートにし、数式を再計算・保存してから読み込みます。
品目コード・数量・税抜単価・税率を取引先の原本と照合してください。
数量に通貨記号を含めず、`1200.5` のような曖昧さのない数値を使います。
読込を拒否されたら、人が指摘された問題を修正します。拒否された行を省略したり、単価ゼロとして扱ったりしません。

| Supplier / 取引先 | Original reference and version / 原本参照・版 | Compared file / 比較ファイル | Returned SHA-256, if available / 返された SHA-256（ある場合） | Checked by and date / 確認者・日付 |
| ----------------- | --------------------------------------------- | ---------------------------- | ------------------------------------------------------------- | ---------------------------------- |

Copy a returned hash exactly; leave it as “not recorded” when none is available. A matching hash
identifies the bytes read, not supplier authenticity, current prices or approval. Saving a revised
sheet does not refresh an existing comparison. Record the revised offer again, compare it again,
and have a person review the selection before preparing an order. Retain the previous source
reference and explain the revision. If the case marks the selection stale, resolve it through
human selection review; this worksheet does not clear that state.
ハッシュが返された場合はそのまま転記し、なければ「未記録」とします。
ハッシュは読み取ったファイル内容を識別するもので、取引先の真正性・価格の有効性・承認を証明しません。
シートを保存し直しても既存の比較は更新されません。改訂した見積を再登録・再比較し、
発注書の作成前に人が選定を見直します。以前の原本参照を残し、変更理由を記録してください。
案件で選定の再確認が必要と表示された場合は、人による選定確認で解決します。この用紙はその状態を解除しません。

## Purchase-order draft handoff / 発注書下書きの引継ぎ

Before approval, open the proposed order and check its supplier, item codes, quantities, prices,
taxes and terms against the reviewed offer and selection. Record the evidence below for that
specific draft. A case entry or a displayed filename does not prove the document was checked.
承認前に発注書案を開き、取引先・品目コード・数量・価格・税・条件を、確認済みの見積と選定内容に照合します。
その下書きに対応する証跡を下表に記録してください。案件への記録やファイル名の表示だけでは、文書を確認した証明になりません。

| Evidence / 証跡                                                           | Reference / 参照 |
| ------------------------------------------------------------------------- | ---------------- |
| Case and selected supplier / 案件・選定取引先                             |                  |
| Reviewed offer version and compared file / 確認済み見積の版・比較ファイル |                  |
| Full source SHA-256, if recorded / 原本の完全な SHA-256（記録がある場合） |                  |
| Selection reviewer, date and reason / 選定確認者・日付・理由              |                  |
| Draft file and version checked / 確認した下書きファイル・版               |                  |
| Draft checker and date / 下書き確認者・日付                               |                  |
| Approval reference / 承認参照                                             |                  |
| Order placement confirmation, after issue only / 発注確認（発注後のみ）   |                  |

Keep the source reference captured for this draft. Do not replace it with a newer sheet's hash,
even when prices and totals are unchanged. A shortened display hash is only a locator; copy the
full recorded value into this handoff, or write “not recorded” if unavailable. The hash identifies
file contents, not approval or supplier authenticity.
この下書きの作成時に記録した原本参照を保持します。価格や合計が同じでも、新しいシートのハッシュに置き換えません。
画面上の短縮ハッシュは照合の手掛かりです。記録された完全な値を転記し、取得できなければ「未記録」とします。
ハッシュはファイル内容を識別するもので、承認や取引先の真正性を証明しません。

If the offer, selection or draft changes, retain the previous references and explain the change.
Review the affected comparison and selection, then prepare and check the corresponding draft
again before approval. If the case reports an out-of-date draft, resolve that mismatch before
using it; filling this handoff does not update the case or clear its warning. A recorded draft
remains unissued until a person places the order and records the confirmation.
見積・選定・下書きに変更があれば、以前の参照を残して変更理由を記録します。
影響する比較と選定を見直し、対応する下書きを再作成・再確認してから承認に進みます。
案件で下書きが古いと表示された場合は、不一致を解消してから使用します。この引継ぎ表への記入は、案件の更新や警告の解除を行いません。
下書きが記録されても、人が発注して確認証跡を記録するまでは未発注です。
