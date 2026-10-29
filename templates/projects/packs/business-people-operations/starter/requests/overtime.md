# 残業申請 / Overtime requests

Queue: `people-overtime`. Type: `request`.

人が原本を記入し、`source.fields` に転記します。自動取込・提出はしません。
A person fills this source form and transfers fields; no automatic import or submission.

| Field key            | 項目 / Label                                 | 記入欄 / Value |
| -------------------- | -------------------------------------------- | -------------- |
| `employeeId`         | 社員番号 / Employee ID                       |                |
| `department`         | 所属部署 / Department                        |                |
| `date`               | 残業予定日 / Overtime date                   |                |
| `hours`              | 申請時間 / Requested hours                   |                |
| `reason`             | 業務上の理由 / Business reason               |                |
| `monthToDateHours`   | 当月実績時間 / Actual month-to-date hours    |                |
| `forecastMonthHours` | 月末見込時間 / Forecast month-end hours      |                |
| `attendanceSource`   | 勤怠原本の参照 / Attendance source reference |                |
| `attendanceAsOf`     | 集計日 / Snapshot date                       |                |

日付は YYYY-MM-DD、Asia/Tokyo。健康・家族・個人番号など不要な機微情報は記載しない。
Dates: YYYY-MM-DD, Asia/Tokyo. Omit unnecessary health, family and identity details.

勤怠原本を attendance/ に置き、必要なら項目へ原本を添付。参照文字列は証拠の検証ではない。
Keep the source in attendance/ and attach it to the item where needed; a reference string is not verification.
時間は0以上の数値、申請時間は正数。見込みと実績の整合性は人が確認。
Use nonnegative hours and positive requested hours; a person verifies actual/forecast consistency.
