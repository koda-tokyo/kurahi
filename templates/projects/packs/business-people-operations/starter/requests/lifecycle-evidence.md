# Lifecycle task evidence / 入退社タスクの証跡

Manual companion to onboarding.md and offboarding.md. Copy one entry per stable task key.
People maintain this worksheet; it does not execute work, link cases or verify references.
入社・退社一覧の固定タスクキーごとに記入。手動の原本であり、作業実行・案件連携・参照先の検証はしません。

| Field / 項目                                                            | Value / 記入欄 |
| ----------------------------------------------------------------------- | -------------- |
| Lifecycle case ID and revision / 元案件ID・版                           |                |
| Checklist reference and task key / 一覧参照・タスクキー                 |                |
| Employee ID and department / 社員番号・部署                             |                |
| Required outcome and scope / 必要な結果・範囲                           |                |
| Task owner and reviewer / 担当者・確認者                                |                |
| Original due date and timezone / 当初期限・時間帯                       |                |
| Dependency keys and checked outcomes / 依存キー・確認した結果           |                |
| Related department request ID / 関連部署の依頼ID                        |                |
| Status / 状態                                                           | pending        |
| Authoritative system and record reference / 正式システム・記録参照      |                |
| Observed outcome and observation time / 確認結果・確認日時              |                |
| Evidence checked by and checked at / 証跡確認者・確認日時               |                |
| Difference or uncertainty / 不一致・不明点                              |                |
| Next action, owner and next review date / 次の対応・担当・再確認日      |                |
| Cancellation or reversal authorization reference / 取消・復旧の権限根拠 |                |

## Recording outcomes / 結果の記録

- Suggested manual statuses: pending, in_progress, exception, confirmed, cancelled.
  These labels do not change the work item's engine status. Unknown is not confirmed.
  手動状態の例：未着手・進行中・例外・確認済み・取消。案件の状態を自動変更しません。不明は確認済みではありません。
- Read back the actual outcome in the authoritative system. A request, approval, email or
  screenshot of a queued action alone does not prove completion. Record partial results separately.
  正式システムの実際の結果を照合。依頼・承認・メール・処理待ち画面だけでは完了の証拠になりません。一部完了は分けて記録。
- For access work, verify the authorized account and intended scope without copying passwords,
  tokens or recovery codes. For assets, record the return/receipt reference and unresolved items.
  権限作業は対象アカウントと範囲を照合し、秘密情報は転記しません。資産は受領記録と未解決項目を記録。
- For HR/payroll handoffs, distinguish receipt from application in the destination system.
  Link only authorized records; omit unnecessary salary, bank, health and identity details.
  人事・給与の引継ぎは受領と反映を区別。権限内の原本を参照し、不要な給与・口座・健康・本人確認情報は記載しません。
- An uncertain result stays exception with an owner and next check. Look up the original attempt
  before a person decides whether to retry. Preserve the original deadline and evidence on cancellation;
  authorized reversals are separate tasks whose results also require checking.
  不明は例外として担当と再確認を残します。再実行の判断前に元の処理を照会。取消でも当初期限・証跡を保持し、承認された復旧は別作業として結果を確認。

## Task handover record / タスク引継ぎ記録

Copy this record for each change of task owner; retain earlier records. Identify the same task
key and case revision as the evidence entry. A proposed replacement is not an accepted handover.
担当者の変更ごとに複製し、過去の記録を保持。同じタスクキー・案件版を指定します。
後任の指名だけでは引継ぎの受領確認になりません。

- Task key, case ID and revision / タスクキー・案件ID・版:
- Previous owner and proposed owner / 前任者・後任候補:
- Reason and authorizing reference / 変更理由・権限根拠の参照:
- Original deadline and current agreed deadline (timezone) / 当初期限・現在の合意期限（時間帯）:
- Completed outcomes and evidence references / 確認済み結果・証跡参照:
- Pending attempts, dependencies and exceptions / 処理中の試行・依存・例外:
- Next action and next check / 次の対応・再確認日時:
- Acceptance by, time and accepted scope / 受領確認者・日時・受領範囲:
- Case-owner reconciliation and unresolved coverage / 案件担当者の照合・未確保の担当範囲:

Until acceptance is recorded, keep the handover pending and ask the case owner to resolve any
coverage gap; do not assume an unavailable previous owner can continue. The receiving owner checks
pending attempts in the authoritative system before retrying, and verifies access through the
normal authorization process. This record grants no access and changes no engine assignment.
受領確認までは引継ぎを未完了とし、担当の空白は案件担当者へ確認します。不在の前任者が継続できると
仮定しません。後任は再実行前に正式システムで処理中の試行を照会し、通常の権限手続でアクセスを確認。
この記録は権限付与やエンジン上の担当変更を行いません。

Preserve the original deadline and actual task outcome. Record any authorized deadline change
separately with its reason. A handover does not complete a task, clear an exception or make old
evidence current; changed scope or source requires a new evidence review.
当初期限と実際の結果は保持し、承認された期限変更は理由とともに別途記録。引継ぎだけで作業完了・
例外解消・旧証跡の有効化とはしません。範囲や原本の変更は証跡を再確認します。

## Case-owner reconciliation / 案件担当者の照合

Before closing the checklist, compare every required task key with its evidence entry and
related request. Record any omitted task, unresolved dependency or exception; keep the checklist
open until resolved or explicitly dispositioned by an authorized person with a recorded reason.
A cancelled task is not a successful outcome. Record the final reviewer, time, scope and remaining
follow-up. This is a manual review record, not an automatic all-tasks-complete gate.
一覧を閉じる前に、必要な全タスクキー・証跡・関連依頼を照合。不足・未解決の依存・例外は残し、
解消するか権限者が理由付きで処置を決めるまで未完了とします。取消は成功ではありません。
最終確認者・日時・範囲・残る対応を記録。全タスク完了を自動判定する機能ではありません。

## Closure decision worksheet / 終了判断シート

Keep one case-level copy alongside the task entries. Start from the approved checklist's full
set of required keys, including tasks without evidence; do not build this list only from completed
entries. Record the checklist version and case revision reviewed.
タスク別証跡とともに案件単位で1部保存。承認された一覧の全必須キーを転記し、証跡がない作業も含めます。
完了済みの記録だけから作成しません。確認した一覧の版・案件の版を記録します。

- Case ID / 案件ID:
- Case revision and checklist version / 案件版・一覧版:
- Reviewer and review time (timezone) / 確認者・確認日時（時間帯）:

| Required task key / 必須キー | Evidence reference and checked result / 証跡参照・確認結果 | Outstanding dependency or exception / 未解決依存・例外 | Disposition, authority and reason / 処置・権限根拠・理由 | Follow-up owner and due date / 後続担当・期限 |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------- |
|                              |                                                            |                                                        |                                                          |                                               |

- Decision / 判断: keep open / 未完了を維持
- Decision scope and reason / 判断の範囲・理由:
- Remaining follow-up references / 残る対応の参照先:

Change the default decision only after reviewing every required key. If an authorized person
accepts an exception, record their authority, reason and follow-up; keep the task's actual failed,
cancelled or unknown outcome visible. Acceptance does not turn it into confirmed completion.
全必須キーを確認してから判断を変更します。権限者が例外を受け入れる場合も権限根拠・理由・後続対応を記録し、
失敗・取消・不明という実際の結果を残します。例外の受入れは作業完了の確認ではありません。

If the source, scope, effective date or checklist changes after review, preserve this decision
and record a new review with the affected keys and revisions. Recheck dependent outcomes before
closing again. This worksheet neither enforces a gate nor reopens or closes an engine case.
確認後に原本・範囲・予定日・一覧が変更された場合、元の判断を保持し、影響するキー・版を指定して再確認を記録します。
依存先の結果も再照合します。このシートは案件の制御・再開・終了を自動実行しません。
