# 入社準備 / Onboarding checklist

Queue: `people-onboarding`. Type: `case`.

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

| Key                     | Task / 作業                                   | Depends on / 依存                               | Owner / 担当 | Due / 期限 | Status / 状態 | Evidence / 証拠 |
| ----------------------- | --------------------------------------------- | ----------------------------------------------- | ------------ | ---------- | ------------- | --------------- |
| `onboarding.hr-confirm` | HR confirms scope / 人事が範囲確認            | —                                               |              |            | pending       |                 |
| `onboarding.equipment`  | IT/Procurement equipment / IT・購買の機器手配 | `onboarding.hr-confirm`                         |              |            | pending       |                 |
| `onboarding.facilities` | General Affairs setup / 総務の準備            | `onboarding.hr-confirm`                         |              |            | pending       |                 |
| `onboarding.access`     | Authorized IT access / 権限者のアクセス設定   | `onboarding.equipment`, `onboarding.facilities` |              |            | pending       |                 |
| `onboarding.hr-close`   | HR reconciles evidence / 人事が証拠照合       | `onboarding.access`                             |              |            | pending       |                 |

Do not mark done until every required outcome is confirmed and reconciled by the case owner.
担当者が必要な結果を確認・照合するまで完了としない。

Use lifecycle-evidence.md for each task’s observed outcome, source reference, reviewer and
exception follow-up. Keep this manifest and the evidence entries consistent by task key.
各タスクの結果・原本参照・確認者・例外対応は lifecycle-evidence.md に記録し、キーで一覧と照合します。

## Department mapping for implementation / 実装用の部署対応

This mapping supplies departments for the plan prefill. Review it before explicitly creating
a linked case. Record the actual Project, queue, item ID and revision beside each task key.
Department IDs must match the configured child queue. Prefill does not create child items.
この対応表から案の部署を読み込みます。内容を確認してから連携案件を明示的に作成します。
各キーに実際のプロジェクト・キュー・案件ID・版を記録し、部署IDを子案件のキューに合わせます。
案の読み込みだけでは子案件を作成しません。

| Task key                | Department ID / 部署ID | Required outcome / 必要な結果                                                                     |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `onboarding.hr-confirm` | `hr`                   | Authorized scope, start date and named task owners / 承認範囲・開始日・各担当者                   |
| `onboarding.equipment`  | `procurement`          | Equipment received and IT acceptance recorded / 機器受領とITの受入記録                            |
| `onboarding.facilities` | `admin`                | Required workspace/facilities ready / 必要な執務環境の準備                                        |
| `onboarding.access`     | `it`                   | Authorized account scope checked in the destination system / 対象システムで承認済み権限の反映確認 |
| `onboarding.hr-close`   | `hr`                   | Every required outcome reconciled against evidence / 全必須結果と証跡の照合                       |

Equipment has one accountable department: Procurement. IT acceptance is required evidence,
not a second department value. General Affairs uses the department ID `admin`. Adapt these
examples to the actual queues and authority before use; department labels grant no access.
機器手配の責任部署は購買。ITの受入は証拠として記録し、部署値を二重にしません。
総務の部署IDは `admin`。実際のキュー・権限へ調整して使用し、部署名だけでアクセスを認めません。

Before starting access work, check both equipment and facilities outcomes. If either is cancelled,
missing or uncertain, keep the dependent task unfinished and ask the case owner to resolve the plan.
Approval of the parent does not fulfil its children; completion of children does not automatically
close this manual parent checklist. HR performs the final evidence review separately.
権限設定の前に機器・環境の両結果を確認。取消・欠落・不明なら後続は未完了として担当者へ確認。
親の承認は子の履行ではなく、子の完了だけで手動一覧も閉じません。人事が別途最終照合します。

Dotted task keys are worksheet references. The reader maps `onboarding.hr-confirm` to
`onboarding-hr-confirm`; the console shows the original worksheet key beside its proposed
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
