# Hand-off review / 受け渡し確認

Manual worksheet; it does not submit a transaction or update a work-item/hand-off state.
手動の記録用紙です。取引の送信や案件・受け渡し状態の更新は行いません。
Keep access-controlled source references here, not bank credentials or full account details.
権限管理された原本の参照先を記載し、認証情報や口座情報の全文は記載しません。

## Approved scope / 承認範囲

- Case ID and approved revision / 案件ID・承認版:
- Action and objective (accounting entry, not payment) / 操作・目的（会計登録、支払ではない）:
- Approver and approval evidence / 承認者・承認証跡:
- Exact destination product and company / 連携先の正確な製品名・会社:
- Responsible person and next review date / 担当者・次回確認日:

## Destination evidence / 連携先の証跡

- Entered/submitted snapshot reference, version and hash where available / 入力・送信内容の控え参照・版・取得可能なハッシュ:
- Who entered it, when, and attempt/correlation reference / 入力者・日時・試行参照ID:
- Destination record ID, actual status, read-back time and source / 外部レコードID・実際の状態・再取得日時・原本参照:
- Evidence missing or delivery uncertain / 不足証跡・送信結果の不明点:

If entry or delivery is uncertain, keep it unfinished. Look up the existing record before any
person-authorised retry; this worksheet grants no permission to retry or write.
入力・送信結果が不明なら未完了のままにします。人が再試行を承認する前に既存レコードを検索します。
この用紙は再試行や書き込みの権限を付与しません。

## Read-back comparison / 再取得結果との照合

| Field / 項目                                                              | Approved / 承認済み | Entered/submitted / 入力・送信 | Destination / 連携先 | Difference and evidence / 差異・証跡 |
| ------------------------------------------------------------------------- | ------------------- | ------------------------------ | -------------------- | ------------------------------------ |
| Company, supplier identifier, invoice ID / 会社・取引先ID・請求書番号     |                     |                                |                      |                                      |
| Issue/due dates, currency / 発行日・期日・通貨                            |                     |                                |                      |                                      |
| Net, tax categories/rates/amounts, gross / 税抜・税区分・税率・税額・税込 |                     |                                |                      |                                      |
| Account, department, cost centre, project / 勘定・部門・原価部門・案件    |                     |                                |                      |                                      |
| Attachments and workflow status / 添付・処理状態                          |                     |                                |                      |                                      |

For each difference: owner, next action, due date, resolution evidence, and the person who
accepted it. Unknown or unchecked fields are not matches. Material changes need renewed approval.
差異ごとに担当者・次の作業・期限・解決証跡・承認した人を記録します。未確認は一致ではありません。
重要な変更には再承認が必要です。

## Outcome / 結果

- Unresolved differences and missing evidence / 未解決の差異・不足証跡:
- Reviewer, review time and evidence references / 確認者・確認日時・証跡参照:
- Outcome / 結果: unfinished / 未完了 OR hand-off completed — payment not verified / 受け渡し完了・支払いは未確認

Only record hand-off completion after the destination evidence and comparison are checked and
all differences are resolved or explicitly accepted by an authorised person. An accounting record
is not settlement evidence. Payment verification is separate work in the accounting system;
this starter never declares an invoice paid. Purchase-order/receipt/invoice matching is also
separate from this transfer comparison.
連携先の証跡と照合結果を確認し、全差異が解決済みまたは権限を持つ人に明示的に承認された後にのみ、
受け渡し完了を記録します。会計レコードは決済証跡ではありません。支払確認は会計システム側の別作業であり、
このスターターは支払済みと宣言しません。発注・検収・請求の三点照合も、この転記照合とは別です。
