# 契約レビュー依頼 / Contract review request

Queue: `co-review`. Type: `request`.

人が記入し `source.fields` に転記します。自動取込はしません。
A person completes this form and transfers fields into `source.fields`; no automatic import.

| Field key           | 項目 / Label                  | 記入欄 / Value |
| ------------------- | ----------------------------- | -------------- |
| `contractId`        | 契約ID / Contract ID          |                |
| `owner`             | 担当者 / Owner                |                |
| `description`       | 内容 / Description            |                |
| `documentReference` | 文書参照 / Document reference |                |
| `documentVersion`   | 原本の版 / Source version     |                |
| `reviewQuestion`    | 確認事項 / Review question    |                |
| `neededBy`          | 希望日 / Needed by            |                |

Dates / 日付: YYYY-MM-DD (Asia/Tokyo).
担当者は実在する責任者を指定。権限・証跡は人が確認します。
Name an accountable owner; a person verifies authority and evidence.

The document reference locates the source; documentVersion identifies the exact revision being registered or reviewed (for example, a repository revision or a document-system version ID). A person verifies the reference and version together. A filename or “latest” link alone may change; preserve an access-controlled copy or immutable version reference. documentVersion is a human-supplied identifier, not an engine-enforced version pin or verified hash. These checks require a value but do not fetch or verify the document.
文書参照は保管場所、documentVersion は登録・確認する原本の特定の版（リポジトリのリビジョン、文書管理システムの版IDなど）です。人が参照先と版を照合してください。ファイル名や「最新版」リンクだけでは内容が変わるため、アクセス制限した原本の写し、または変更されない版の参照を保管します。documentVersion は人が記入する識別子で、エンジンによる版の固定や検証済みハッシュではありません。自動チェックは入力の有無のみで、文書の取得・検証は行いません。

## Manual review decision / レビュー判断の手動記録

These notes are maintained by people, not validated source.fields. Record each decision against the version above; do not copy an approval to a changed document.
以下は人が管理するメモで、source.fields の検証対象ではありません。判断を上記の版に関連付け、変更後の文書に以前の承認を流用しないでください。

| Review record / 確認記録                                                                               | Value / 記入欄 |
| ------------------------------------------------------------------------------------------------------ | -------------- |
| Reviewed version and clause/page / 確認した版・条項・ページ                                            |                |
| Question, finding and unresolved issue / 確認事項・所見・未解決事項                                    |                |
| Decision, reviewer and reviewed-at time / 判断・確認者・確認日時                                       |                |
| Company approval reference and scope / 社内承認の参照・範囲                                            |                |
| Changed version, affected terms and previous review reference / 変更版・影響する条件・前回レビュー参照 |                |
| Responsible owner and next action / 責任者・次の対応                                                   |                |

If the source changes, preserve the previous decision and source version, record the differences, and submit a new review request with the changed documentVersion. Obtain any company-required approvals again for the changed terms. The starter does not detect document changes, invalidate earlier approvals or link review requests automatically. Review approval is not permission to sign; the signature hand-off must identify the version actually approved by authorized people.
原本が変更された場合、以前の判断と原本の版を保持し、差分を記録して変更後の documentVersion で新しいレビュー依頼を提出します。変更条件について会社規程上必要な承認を再取得してください。スターターは文書変更の検出、以前の承認の失効処理、レビュー依頼間の自動関連付けを行いません。レビュー承認は署名の許可ではなく、署名引継ぎには権限者が実際に承認した版を指定します。

## Source completeness check / 原本の完全性確認

A text preview helps locate clauses; it is not a complete representation of the contract. Before deciding, compare the recorded version with the original document in an approved viewer, including tables, images, annotations, signatures and referenced schedules. Missing preview text does not mean a clause is absent. A matching file hash does not establish extraction completeness or signing authority.
テキストプレビューは条項を探す補助です。契約書全体を再現するものではありません。判断前に、記録した版と原本文書を会社で認められたビューアーで照合し、表・画像・注釈・署名・参照別紙も確認してください。プレビューにない条項が原本にもないとは限りません。ファイルのハッシュ一致は、抽出の完全性や署名権限を証明しません。

Keep this manual record with the review decision; do not transfer these notes to source.fields. Keep sensitive excerpts in the approved document system and record references here.
この手動記録はレビュー判断と一緒に保管し、source.fields へ転記しません。機密の抜粋は承認された文書管理システムに保管し、ここには参照を記録します。

| Check / 確認事項                                                                                              | Evidence / 証跡 |
| ------------------------------------------------------------------------------------------------------------- | --------------- |
| Original reference/version and reviewer/time / 原本参照・版・確認者・日時                                     |                 |
| Clauses, schedules and non-text content checked / 確認した条項・別紙・非テキスト内容                          |                 |
| Missing, truncated or unreadable content and affected question / 欠落・省略・判読不能の内容と影響する確認事項 |                 |
| Resolution source/version, owner and recheck result / 解決に用いた原本・版・担当者・再確認結果                |                 |

If the preview is incomplete, unavailable or inconsistent with the original, record the gap and pause the affected decision until a person verifies the necessary original content. Do not approve from an older preview or silently replace the reviewed version. If a corrected source changes the version, preserve this record and follow the new-review process above. These are manual checks; this worksheet does not block workflow actions automatically.
プレビューが不完全・表示不可・原本と不一致の場合は、不足事項を記録し、人が必要な原本内容を確認するまで影響する判断を保留します。古いプレビューで承認したり、確認済みの版を黙って差し替えたりしないでください。修正版で版が変わる場合はこの記録を残し、上記の新規レビュー手順に従います。これは手動確認であり、この記録票がワークフロー操作を自動で止めるものではありません。
