# 証明書発行 / Employment certificates

Queue / キュー: `er-certificates`. Type: `request`.

人が記入する原本です。自動送信・取込はしません。空欄を埋め、担当者が `source.fields` に転記してください。
A person fills this source form and transfers values into `source.fields`; no automatic import or submission.

| Field key         | 項目 / Label                    | 記入欄 / Value |
| ----------------- | ------------------------------- | -------------- |
| `requester`       | 依頼者 / Requester              |                |
| `department`      | 所属部署 / Department           |                |
| `description`     | 依頼内容 / Description          |                |
| `neededBy`        | 希望日 / Needed by              |                |
| `certificateType` | 証明書の種類 / Certificate type |                |
| `purpose`         | 目的 / Purpose                  |                |
| `language`        | 言語 / Language                 |                |
| `deliveryMethod`  | 交付方法 / Delivery method      |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo); neededBy requires 2 calendar days / 希望日は2暦日以上先。
Do not include national IDs, medical details or salary data. Verify identity and delivery destination separately. / 個人番号・医療・給与情報を記載しない。本人確認と交付先確認は別途実施。
