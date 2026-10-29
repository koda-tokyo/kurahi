# 履行義務 / Obligations

Queue: `co-obligations`. Type: `request`.

人が記入し `source.fields` に転記します。自動取込はしません。
A person completes this form and transfers fields into `source.fields`; no automatic import.

| Field key          | 項目 / Label                 | 記入欄 / Value |
| ------------------ | ---------------------------- | -------------- |
| `contractId`       | 契約ID / Contract ID         |                |
| `owner`            | 担当者 / Owner               |                |
| `description`      | 内容 / Description           |                |
| `obligation`       | 履行義務 / Obligation        |                |
| `dueOn`            | 履行期限 / Due date          |                |
| `evidenceRequired` | 必要証跡 / Required evidence |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo).
担当者は実在する責任者を指定。権限・証跡は人が確認します。
Name an accountable owner; a person verifies authority and evidence.

履行期限は本日以降。過去の未履行案件は担当者へ別途エスカレーションしてください。
Due date must be today or later; escalate already overdue obligations separately to the owner.

## Manual obligation evidence / 履行証跡の手動記録

Use one record per obligation. These notes accompany the request; they are not additional validated fields. Store evidence under appropriate access restrictions and record references rather than copying confidential contents.
義務ごとに記録します。以下は申請に添えるメモで、追加の自動検証項目ではありません。証跡は適切なアクセス制限の下で保管し、機密内容を複写せず参照先を記入します。

| Review record / 確認記録                                                                   | Value / 記入欄 |
| ------------------------------------------------------------------------------------------ | -------------- |
| Source version, amendment, clause/page / 原本の版・変更契約・条項・ページ                  |                |
| Obligation scope and acceptance criteria / 義務の範囲・受入基準                            |                |
| Trigger, date calculation, cutoff time and timezone / 起算条件・期限算出・締切時刻・時間帯 |                |
| Accountable owner and reviewer / 責任者・確認者                                            |                |
| Required evidence and accepting person / 必要証跡・受入確認者                              |                |
| External task/reference and next manual review date / 外部作業の参照・次回手動確認日       |                |
| Work performed, version and completion time / 実施内容・版・実施日時                       |                |
| Evidence reference, checked by and checked at / 証跡参照・確認者・確認日時                 |                |
| Acceptance outcome and supporting reference / 受入結果・根拠参照                           |                |
| Missing evidence or dispute, owner and next action / 不足証跡・異議・担当者・次の対応      |                |

Check the source clause and any amendments for the actual due date and acceptance criteria. Record uncertainty for human review; preserve the original overdue date and escalate separately. The owner checks progress and the reviewer compares the evidence with the required scope. Missing, partial or disputed evidence remains unresolved; approval of this request alone never proves fulfillment.
実際の期限と受入基準は原本の条項と変更契約で確認します。不明点は人の確認に回し、超過した期限は保持して別途エスカレーションします。担当者が進捗を確認し、確認者が証跡を必要な範囲と照合します。証跡の不足・部分履行・異議は未解決として記録し、申請承認だけで履行済みとしません。

This worksheet neither performs the obligation nor schedules reminders. Signature checks and legal validation remain human work outside this starter.
この記入用紙は義務を実行せず、リマインダーも予約しません。署名確認と法的有効性の判断は、このスターターの外で人が行います。
