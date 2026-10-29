# 更新・通知期限 / Renewal and notice dates

Queue: `co-renewals`. Type: `request`.

人が記入し `source.fields` に転記します。自動取込はしません。
A person completes this form and transfers fields into `source.fields`; no automatic import.

| Field key      | 項目 / Label               | 記入欄 / Value |
| -------------- | -------------------------- | -------------- |
| `contractId`   | 契約ID / Contract ID       |                |
| `owner`        | 担当者 / Owner             |                |
| `description`  | 内容 / Description         |                |
| `renewalOn`    | 更新日 / Renewal date      |                |
| `noticeBy`     | 通知期限 / Notice deadline |                |
| `noticeMethod` | 通知方法 / Notice method   |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo).
担当者は実在する責任者を指定。権限・証跡は人が確認します。
Name an accountable owner; a person verifies authority and evidence.

通知期限は本日以降、更新日以前。通知期間は契約原本から人が算出します。自動通知はありません。
Notice deadline must be today or later and on or before renewal. A person calculates the notice period from the contract; no scheduled alerts.

## Manual renewal evidence / 更新証跡の手動記録

These notes accompany the request; they are not additional validated fields. Keep evidence in an access-controlled location and record references here.
以下は申請に添えるメモで、追加の自動検証項目ではありません。証跡はアクセス制限された場所に保管し、ここには参照先を記入します。

| Review record / 確認記録                                                                      | Value / 記入欄 |
| --------------------------------------------------------------------------------------------- | -------------- |
| Source version, amendment, clause/page / 原本の版・変更契約・条項・ページ                     |                |
| Renewal trigger and source date / 更新の条件・原本の日付                                      |                |
| Notice period, calendar/business days, counting basis / 通知期間・暦日か営業日か・起算方法    |                |
| Deadline calculation and reviewer / 期限の算出過程・確認者                                    |                |
| Required arrival or dispatch, cutoff time and timezone / 到達か発送か・締切時刻・時間帯       |                |
| Recipient, address and permitted method / 宛先・住所等・許可された通知方法                    |                |
| Human decision and approval reference / 人の判断・承認参照                                    |                |
| Calendar owner, entry reference and next review date / カレンダー担当者・予定参照・次回確認日 |                |
| Notice version, sender and sent-at evidence / 通知の版・送信者・送付日時の証跡                |                |
| Receipt or delivery evidence and checked-at time / 受領・送達証跡と確認日時                   |                |
| Unresolved issue, responsible person and next action / 未解決事項・責任者・次の対応           |                |

Check amendments and the actual clause before copying dates. Record the counting basis; do not assume calendar days, arrival equals dispatch, or that same-day notice is valid. If terms or dates are uncertain, record the uncertainty and ask the assigned reviewer; do not invent a deadline. Preserve any overdue date and escalate separately instead of changing it to pass checks.
転記前に変更契約と条項を確認します。起算方法を記録し、暦日、発送と到達の同一扱い、更新日当日の通知可否を推測しません。不明点は担当確認者に照会し、期限を捏造しません。超過した期限は保持し、検証を通すために変更せず別途エスカレーションします。

A person creates and checks the separate calendar entry. A draft or approval is not a sent notice; a sent notice is not proof of receipt. Record only what the evidence supports, leaving unknown delivery unresolved. This worksheet schedules no reminders, sends no notices and provides no signature or legal validation.
別のカレンダーへの登録と確認は人が行います。下書き・承認は送付の証明ではなく、送付は受領の証明ではありません。証跡で確認できる事実だけを記録し、不明な送達は未解決のままにします。この記入用紙はリマインダー予約・通知送付・署名検証・法的有効性の判断を行いません。

## Decision and renewal cycle history / 判断・更新周期の履歴

Keep one record per renewal cycle. Record the chosen course (renew, renegotiate, give notice, or pending), its scope and the human approval reference; do not infer a decision from an empty field or from silence.
更新周期ごとに記録を残します。選択した対応（更新・再交渉・通知・保留）、対象範囲、人の承認参照を記録し、空欄や返答がないことから判断を推測しません。

Copy the table below for each cycle and give each copy a unique cycle reference. For a changed decision within that cycle, keep the earlier copy and add a dated revision linked to it.
周期ごとに下の表を複製し、固有の周期参照を付けます。同じ周期内で判断を変更する場合は以前の表を保持し、その参照と改訂日を記載した新しい表を追加します。

| Cycle record / 周期の記録                                                                                         | Value / 記入欄 |
| ----------------------------------------------------------------------------------------------------------------- | -------------- |
| Cycle, case reference and reviewed source version / 周期・案件参照・確認した原本の版                              |                |
| Decision, scope, decision-maker and time / 判断・範囲・判断者・日時                                               |                |
| Approval reference and remaining conditions / 承認参照・未充足の条件                                              |                |
| Confirmed outcome, evidence reference and checked-at time / 確認済みの結果・証跡参照・確認日時                    |                |
| Superseded decision reference, change and reason / 変更前の判断参照・変更内容・理由                               |                |
| Next cycle, owner, source-based dates and calendar reference / 次の周期・担当者・原本に基づく日付・カレンダー参照 |                |
| Next-cycle case reference or pending action / 次回案件の参照または未完了の対応                                    |                |
| Receiving owner, handoff acceptance time and evidence / 引継ぎ先の担当者・引受確認日時・証跡                      |                |

When handing over the next cycle, record the receiving owner's confirmation and the new case reference once created. Until confirmed, keep the handoff pending with an accountable owner and follow-up date in the review record above.
次の周期を引き継ぐ際は、引継ぎ先の担当者による引受確認と、作成後の新しい案件参照を記録します。確認までは引継ぎを未完了とし、上の確認記録に責任者と次回確認日を残します。

A changed decision retains the previous record and requires the responsible person to check approvals, notices already sent and the calendar entry again. Leave an unconfirmed outcome pending. Start the next cycle only after a person verifies the applicable source and dates; do not copy last year's dates or treat queue approval as evidence that renewal or termination took effect. This history is manual and does not update case status or create the next request.
判断変更時は以前の記録を保持し、責任者が承認・送付済み通知・カレンダー登録を再確認します。未確認の結果は保留とします。次の周期は人が適用される原本と日付を確認してから開始し、前年の日付の転用や、経路承認だけによる更新・終了の効力発生の判断はしません。この履歴は手動管理で、案件状態の更新や次回申請の作成は行いません。
