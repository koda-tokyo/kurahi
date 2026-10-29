# 名刺 / Business cards

Queue / キュー: `er-cards`. Type: `request`.

人が記入する原本です。自動送信・取込はしません。空欄を埋め、担当者が `source.fields` に転記してください。
A person fills this source form and transfers values into `source.fields`; no automatic import or submission.

| Field key          | 項目 / Label               | 記入欄 / Value |
| ------------------ | -------------------------- | -------------- |
| `requester`        | 依頼者 / Requester         |                |
| `department`       | 所属部署 / Department      |                |
| `description`      | 依頼内容 / Description     |                |
| `neededBy`         | 希望日 / Needed by         |                |
| `printedName`      | 印字氏名 / Printed name    |                |
| `jobTitle`         | 役職 / Job title           |                |
| `workEmail`        | 業務メール / Work email    |                |
| `quantity`         | 数量 / Quantity            |                |
| `deliveryLocation` | 納品先 / Delivery location |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo); neededBy requires 2 calendar days / 希望日は2暦日以上先。
quantity: positive whole number; use business contacts only. / 数量は正の整数。業務用連絡先のみ記載。
