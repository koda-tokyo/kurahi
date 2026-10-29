# 会議室・施設 / Rooms and facilities

Queue / キュー: `er-facilities`. Type: `request`.

人が記入する原本です。自動送信・取込はしません。空欄を埋め、担当者が `source.fields` に転記してください。
A person fills this source form and transfers values into `source.fields`; no automatic import or submission.

| Field key     | 項目 / Label              | 記入欄 / Value |
| ------------- | ------------------------- | -------------- |
| `requester`   | 依頼者 / Requester        |                |
| `department`  | 所属部署 / Department     |                |
| `description` | 依頼内容 / Description    |                |
| `neededBy`    | 希望日 / Needed by        |                |
| `location`    | 利用場所 / Location       |                |
| `startsOn`    | 開始日 / Start date       |                |
| `endsOn`      | 終了日 / End date         |                |
| `attendees`   | 参加人数 / Attendee count |                |
| `purpose`     | 目的 / Purpose            |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo); neededBy requires 2 calendar days / 希望日は2暦日以上先。
Use startsOn <= endsOn (date-only). Time slots and conflicts require manual review; same-day events are allowed. / 開始日≦終了日。同日利用は可。時間枠・重複は人が確認。
