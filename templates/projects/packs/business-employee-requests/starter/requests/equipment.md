# 備品・IT機器 / Equipment and IT devices

Queue / キュー: `er-equipment`. Type: `request`.

人が記入する原本です。自動送信・取込はしません。空欄を埋め、担当者が `source.fields` に転記してください。
A person fills this source form and transfers values into `source.fields`; no automatic import or submission.

| Field key        | 項目 / Label                          | 記入欄 / Value |
| ---------------- | ------------------------------------- | -------------- |
| `requester`      | 依頼者 / Requester                    |                |
| `department`     | 所属部署 / Department                 |                |
| `description`    | 依頼内容 / Description                |                |
| `neededBy`       | 希望日 / Needed by                    |                |
| `item`           | 品目 / Item                           |                |
| `quantity`       | 数量 / Quantity                       |                |
| `estimatedCost`  | 見積費用（円） / Estimated cost (JPY) |                |
| `budgetCode`     | 予算コード / Budget code              |                |
| `businessReason` | 業務上の理由 / Business reason        |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo); neededBy requires 2 calendar days / 希望日は2暦日以上先。
estimatedCost: numeric JPY, quantity: positive whole number. / 費用は円の数値、数量は正の整数。
