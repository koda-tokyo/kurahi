# 契約台帳 / Contract register

Queue: `co-register`. Type: `request`.

人が記入し `source.fields` に転記します。自動取込はしません。
A person completes this form and transfers fields into `source.fields`; no automatic import.

| Field key           | 項目 / Label                  | 記入欄 / Value |
| ------------------- | ----------------------------- | -------------- |
| `contractId`        | 契約ID / Contract ID          |                |
| `owner`             | 担当者 / Owner                |                |
| `description`       | 内容 / Description            |                |
| `counterparty`      | 相手方 / Counterparty         |                |
| `documentReference` | 文書参照 / Document reference |                |
| `documentVersion`   | 原本の版 / Source version     |                |
| `startsOn`          | 開始日 / Start date           |                |
| `endsOn`            | 終了日 / End date             |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo).
担当者は実在する責任者を指定。権限・証跡は人が確認します。
Name an accountable owner; a person verifies authority and evidence.

The document reference locates the source; documentVersion identifies the exact revision being registered or reviewed (for example, a repository revision or a document-system version ID). A person verifies the reference and version together. A filename or “latest” link alone may change; preserve an access-controlled copy or immutable version reference. documentVersion is a human-supplied identifier, not an engine-enforced version pin or verified hash. These checks require a value but do not fetch or verify the document.
文書参照は保管場所、documentVersion は登録・確認する原本の特定の版（リポジトリのリビジョン、文書管理システムの版IDなど）です。人が参照先と版を照合してください。ファイル名や「最新版」リンクだけでは内容が変わるため、アクセス制限した原本の写し、または変更されない版の参照を保管します。documentVersion は人が記入する識別子で、エンジンによる版の固定や検証済みハッシュではありません。自動チェックは入力の有無のみで、文書の取得・検証は行いません。
