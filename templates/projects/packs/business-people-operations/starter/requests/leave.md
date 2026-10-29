# 休暇申請 / Leave requests

Queue: `people-leave`. Type: `leave`.

人が原本を記入し、`source.fields` に転記します。自動取込・提出はしません。
A person fills this source form and transfers fields; no automatic import or submission.

| Field key          | 項目 / Label                                 | 記入欄 / Value |
| ------------------ | -------------------------------------------- | -------------- |
| `employeeId`       | 社員番号 / Employee ID                       |                |
| `department`       | 所属部署 / Department                        |                |
| `leaveType`        | 休暇区分 / Leave type                        |                |
| `startDate`        | 開始日 / Start                               |                |
| `endDate`          | 終了日 / End                                 |                |
| `requestedDays`    | 申請日数 / Requested days                    |                |
| `availableDays`    | 確認時残日数 / Available days                |                |
| `attendanceSource` | 勤怠原本の参照 / Attendance source reference |                |
| `attendanceAsOf`   | 集計日 / Snapshot date                       |                |

日付は YYYY-MM-DD、Asia/Tokyo。健康・家族・個人番号など不要な機微情報は記載しない。
Dates: YYYY-MM-DD, Asia/Tokyo. Omit unnecessary health, family and identity details.

勤怠原本を attendance/ に置き、必要なら項目へ原本を添付。参照文字列は証拠の検証ではない。
Keep the source in attendance/ and attach it to the item where needed; a reference string is not verification.
残日数と申請日数の比較、休暇資格、原本の鮮度は人が確認。
A person verifies entitlement, balance versus requested days and source freshness.
