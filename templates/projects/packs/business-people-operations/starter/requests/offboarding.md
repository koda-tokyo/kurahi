# 退社準備 / Offboarding checklist

Queue: `people-offboarding`. Type: `case`.

人が原本を記入し、`source.fields` に転記します。自動取込・提出はしません。
A person fills this source form and transfers fields; no automatic import or submission.

| Field key            | 項目 / Label                             | 記入欄 / Value |
| -------------------- | ---------------------------------------- | -------------- |
| `employeeId`         | 社員番号 / Employee ID                   |                |
| `department`         | 所属部署 / Department                    |                |
| `effectiveOn`        | 入退社予定日 / Effective date            |                |
| `caseOwner`          | 担当者 / Case owner                      |                |
| `checklistReference` | チェックリスト参照 / Checklist reference |                |

日付は YYYY-MM-DD、Asia/Tokyo。健康・家族・個人番号など不要な機微情報は記載しない。
Dates: YYYY-MM-DD, Asia/Tokyo. Omit unnecessary health, family and identity details.

## Manual task manifest / 手動タスク一覧

Stable task keys identify worksheet steps. The console can read this worksheet to prefill a
linked-case plan for human review. These tables are not executable configuration; reading them
does not create a plan or perform the tasks.
固定キーは原本のステップを識別します。コンソールで連携案件の案へ読み込めますが、
読み取りだけでは計画を作成せず、作業も実行しません。担当者・期限・証拠は人が記入。

| Key                      | Task / 作業                                                  | Depends on / 依存                                                 | Owner / 担当 | Due / 期限 | Status / 状態 | Evidence / 証拠 |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------ | ---------- | ------------- | --------------- |
| `offboarding.hr-confirm` | HR confirms authorized departure / 人事が退社手続の権限確認  | —                                                                 |              |            | pending       |                 |
| `offboarding.access`     | Authorized IT revocation / 権限者のアクセス停止              | `offboarding.hr-confirm`                                          |              |            | pending       |                 |
| `offboarding.assets`     | IT/General Affairs asset return / IT・総務の資産返却         | `offboarding.hr-confirm`                                          |              |            | pending       |                 |
| `offboarding.records`    | HR record and payroll handoff / 人事記録・給与担当への引継ぎ | `offboarding.hr-confirm`                                          |              |            | pending       |                 |
| `offboarding.hr-close`   | HR reconciles all outcomes / 人事が結果照合                  | `offboarding.access`, `offboarding.assets`, `offboarding.records` |              |            | pending       |                 |

Do not mark done until every required outcome is confirmed and reconciled by the case owner.
Urgent access revocation follows approved incident procedures without waiting for asset return.
担当者が必要な結果を確認・照合するまで完了としない。緊急の権限停止は資産返却を待たず承認済み手順で実施。

Use lifecycle-evidence.md for each task’s observed outcome, source reference, reviewer and
exception follow-up. Keep this manifest and the evidence entries consistent by task key.
各タスクの結果・原本参照・確認者・例外対応は lifecycle-evidence.md に記録し、キーで一覧と照合します。

## Department mapping for implementation / 実装用の部署対応

This mapping supplies departments for the plan prefill; review before explicitly creating a
linked case. Prefill creates no child items. Preserve stable keys and record the actual Project,
queue, item ID and revision. Department IDs must match the child queue and grant no access.
対応表から案の部署を読み込み、確認してから連携案件を明示的に作成します。読み込みだけでは
子案件を作成しません。固定キーと実際のプロジェクト・キュー・案件ID・版を記録。
部署IDを子案件のキューと一致させ、部署名だけでアクセスを認めません。

| Task key                 | Department ID / 部署ID | Required outcome / 必要な結果                                                                      |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `offboarding.hr-confirm` | `hr`                   | Authorized scope, effective time and named owners / 承認範囲・適用日時・各担当者                   |
| `offboarding.access`     | `it`                   | Authorized revocation checked in destination systems / 対象システムで承認済み権限停止を確認        |
| `offboarding.assets`     | `admin`                | Asset custody/return evidence, including IT acceptance / ITの確認を含む資産返却・保管の証拠        |
| `offboarding.records`    | `hr`                   | HR updates and payroll handoff outcome checked separately / 人事更新と給与引継ぎの結果を別々に確認 |
| `offboarding.hr-close`   | `hr`                   | Access, assets and records outcomes all reconciled / 権限・資産・記録の全結果を照合                |

General Affairs (`admin`) owns the asset-return task and obtains IT confirmation; a shared label
such as “IT/General Affairs” is not a department ID. Map these examples to company queues before use.
Keep access, assets and records as parallel tasks after HR scope confirmation. The final HR review
depends on all three; a cancellation or missing child is an unresolved outcome, not completion.
総務 (`admin`) が資産返却を担当しITへ確認。「IT・総務」のような併記は部署IDではありません。
実際のキューへ対応付けて使用。人事の範囲確認後、権限・資産・記録は並行し、最終照合は3件すべてに依存。
取消・子案件の欠落は未解決で、完了ではありません。

Record the authorized effective time and timezone, not just the date. A dependency checklist is
not a scheduler or revocation mechanism. Urgent revocation follows the approved incident route;
record its authorization and actual outcome here afterwards without waiting for equipment return.
適用日時と時間帯を記録。一覧は予約実行や権限停止の機構ではありません。緊急停止は承認済みの事故対応経路で
実施し、資産返却を待たずに権限根拠と実際の結果を後から記録します。

Dotted task keys are worksheet references. The reader maps `offboarding.hr-confirm` to
`offboarding-hr-confirm`; the console shows the original worksheet key beside its proposed
numbered key, such as `step-1`, before submission. Valid steps are reordered prerequisites-first,
so check the displayed mapping rather than assuming worksheet row numbers are the created keys.
Removing a row can change the numbering. Record the final worksheet-to-step mapping, child item
and evidence reference manually: the created plan does not retain the worksheet source keys.
Do not substitute the reader's dashed key for the actual created step key.
ドット付きキーは原本参照です。読み取り時は上例のようにハイフン付きへ変換します。
コンソールは提出前に原本キーと `step-1` などの作成予定キーの対応を表示します。
有効なステップは前提が先になるよう並べ替えるため、原本の行番号で判断せず表示を確認します。
行の削除でも連番が変わります。作成後の計画は原本キーを保持しないため、最終的な対応と
子案件・証跡を手動で記録し、読み取り時のハイフン付きキーで実際のキーを代用しません。
