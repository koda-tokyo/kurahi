# 署名引継ぎ / Human signature handoff

Queue: `co-signature`. Type: `request`.

人が記入し `source.fields` に転記します。自動取込はしません。
A person completes this form and transfers fields into `source.fields`; no automatic import.

| Field key             | 項目 / Label                      | 記入欄 / Value |
| --------------------- | --------------------------------- | -------------- |
| `contractId`          | 契約ID / Contract ID              |                |
| `owner`               | 担当者 / Owner                    |                |
| `description`         | 内容 / Description                |                |
| `approvedVersion`     | 承認された版 / Approved version   |                |
| `authorizedSigner`    | 署名権限者 / Authorized signer    |                |
| `handoffInstructions` | 引継ぎ手順 / Handoff instructions |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo).
担当者は実在する責任者を指定。権限・証跡は人が確認します。
Name an accountable owner; a person verifies authority and evidence.
