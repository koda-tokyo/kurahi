# Management review and decisions / 経営レビュー・判断記録

Preview manual worksheet. Copy to output/ for a draft; a person verifies and maintains the record.
This does not create approvals, tasks, reminders or permissions in the work queue.
Previewの手動ひな型。下書きはoutput/へコピーし、人が確認・更新する。
案件の承認・タスク・通知・権限は作成しない。

## Review evidence / レビュー証跡

- Review ID, date/time and timezone / レビューID・日時・タイムゾーン:
- Report ID, exact version/reference and prepared by / 報告ID・対象版の参照・作成者:
- Reviewer, authority for this review and authorized audience / 確認者・確認権限・共有先:
- Snapshot reference, source Projects, readers and computedAt / 集計参照・元プロジェクト・閲覧者・集計時刻:
- Source queue/department filters, response scope (all/visible) and approval windowDays / 元キュー・部門条件・応答範囲（all/visible）・承認集計日数:
- Exception and outcome worksheet versions / 例外表・実測結果表の対象版:
- Coverage gaps, failed reads and unavailable evidence / 欠落範囲・取得失敗・取得不可の証拠:

Record pass, revise or unknown for each check, with a reason and evidence reference. A blank is
not a pass. Unresolved evidence may be reported as unknown; it cannot support a confirmed claim.
各項目に適合・要修正・不明、理由と証拠参照を記録。空欄は適合ではない。
未解決の証拠は不明として報告できるが、確定した主張の根拠にはできない。

| Check / 確認項目                                                                                                    | Finding and evidence reference / 判定・証拠参照 |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Scope, reader permissions and disclosure to the audience / 範囲・閲覧権限・共有可否                                 |                                                 |
| Current counts versus windowed approval timings; sample size and nulls / 現在件数と期間内承認時間・件数・nullの区別 |                                                 |
| Overlapping snapshots and overdue counts not added as unique cases / 重複集計・期限超過の重複加算なし               |                                                 |
| Estimates separate from measured outcomes and comparable baselines / 推定と実測・比較可能な基準の区別               |                                                 |
| Destination evidence for every completion claim / 実施完了の主張ごとの連携先証拠                                    |                                                 |

## Linked-case evidence / 部門間連携案件の証跡

Use one block per parent case. Copy only an authorized view; record unavailable evidence as
unknown. This worksheet does not create a linked plan or attach child cases.
親案件ごとに記録。権限内の表示だけを転記し、取得不可は不明とする。計画作成・子案件の紐付けは行わない。

- Source Project, parent ID, reader, capture time/timezone and response reference / 元プロジェクト・親ID・閲覧者・取得日時とタイムゾーン・応答参照:
- Parent status and revision, recorded separately from linked progress / 連携進捗とは別に記録した親の状態・版:
- Plan reference/version, done/total, complete, blocked and missing step keys / 計画の参照・版、done/total・complete・blocked・missingの工程キー:
- Per step: key, department, dependencies, child ID or not attached, state / 工程ごと：キー・部門・依存先・子IDまたは未紐付け・状態:
- Missing/unreadable evidence, owner and next check / 欠落・取得不可の証拠、担当・次回確認:
- Destination evidence reference, verifier and time for each claimed outcome / 主張する結果ごとの連携先証拠参照・確認者・日時:

Linked complete means all planned child items have status done at the time read. It does not
prove that the parent is closed, a payment settled or an account provisioned. ready means a
step can be attached; it does not mean work started. cancelled/stuck or missing require review,
not a successful outcome. Keep a missing plan, a refused read and an unavailable read distinct;
none proves zero outstanding work. Do not add parent and child counts as unique business outcomes.
連携のcompleteは取得時点で全計画子案件がdoneであること。親の終了・支払・アカウント作成の証明ではない。
readyは紐付け可能であり着手済みではない。cancelled/stuck・missingは確認対象で、成功ではない。
計画なし・取得拒否・取得不可を区別し、未完了ゼロと推定しない。親子件数を固有の業務成果として加算しない。

## Brief and routine evidence / ブリーフ・定期チェックの証跡

If an authorized person supplies a morning brief or linked-case check, record its scope separately
from the source statistics. This pack does not install or activate either routine.
権限のある人が提供したブリーフ・連携チェックは、元集計と範囲を分けて記録。本パックは定期処理を導入・有効化しない。

- Source Project, recipient, capture time and brief/run reference / 元プロジェクト・受信者・取得日時・ブリーフまたは実行参照:
- Source kind: morning brief or workitems_linked check / 種別：朝のブリーフまたはworkitems_linkedチェック:
- Coverage, truncated.linked and omitted IDs / 対象範囲・truncated.linked・省略ID:
- Unreadable records, next owner and authorized verification / 読取不可の記録・次の担当・権限内の確認:

The morning brief lists readable open parents the recipient requested, is assigned or must decide,
when steps are ready, missing or blocked, or the linked record is unreadable. It is not an inventory
of every case. An older brief without waiting.linked has no linked-case evidence; an empty display
is not proof that no cases need attention. Preserve truncated.linked; unreadable progress is unknown,
not 0/0 completed.
朝のブリーフは受信者が依頼・担当・判断する閲覧可能な未終了の親案件のうち、ready・missing・blocked・
読取不可の連携を表示する。全件一覧ではない。旧版でwaiting.linkedがなければ連携証跡なし。
空表示を対応不要の証明にせず、truncated.linkedを保持。読取不可の進捗は不明であり0/0完了ではない。

The workitems_linked check covers open parents in its run's Project, including those without an
assignee. It escalates blocked, missing-child or unreadable links; ready steps alone are normal
progress. stuck counts parent cases; blocked, missing and unreadable are overlapping categories.
Do not add them as unique cases. stuckIds shows at most ten IDs; a short list is not full coverage
when stuck is larger. A check verdict or a routine intake is not proof of repair or notification.
workitems_linkedは実行元プロジェクトの未終了の親案件（担当未設定を含む）を対象とする。
blocked・子欠落・読取不可が確認対象で、readyだけでは異常としない。stuckは親案件数、
blocked・missing・unreadableは重複し得るため加算しない。stuckIdsは最大10件で、stuckが大きければ
全IDではない。判定や案件の起票は修復・通知の証明ではない。

## Notification coverage / 通知の対象範囲

Use this block when an authorized person supplies notification evidence. This worksheet does
not create a notification, mark it read or send a reminder.
権限のある人が提供した通知証跡を記録する欄。通知作成・既読化・リマインダー送信は行わない。

- Source Project, item ID/revision, recipient and capture time / 元プロジェクト・案件IDと版・受信者・取得日時:
- Evidence kind: calculated recipient, stored record, delivery receipt or person acknowledgement / 証跡種別：受信候補の計算・保存記録・送達確認・本人による受領確認:
- Evidence reference, channel and verified status (or unknown) / 証跡参照・経路・確認済み状態（または不明）:
- Recipient coverage, omitted group-only members and next verification owner / 受信対象範囲・グループ経由のみの構成員の欠落・次の確認担当:
- Outstanding work checked separately, with source and time / 別途確認した未対応案件・参照・日時:

A calculated recipient is not a stored notification or proof of delivery. A stored or read record
is not an approval, acknowledgement by the person or completed work. Record each only when its
own evidence is available. Never infer zero pending work from an empty notification list.
受信候補の計算は通知保存・送達の証明ではない。保存・既読の記録も承認・本人による受領確認・作業完了ではない。
各状態は対応する証跡がある場合だけ記録。通知一覧が空でも未対応ゼロとは推定しない。

The current recipient calculation enumerates explicit principals; it cannot enumerate people
known only through group membership. An otherwise eligible group-only approver may therefore
receive no notification. A person verifies coverage against an authorized source and arranges
follow-up separately. Do not copy a private directory or hidden item details into this report.
現在の受信候補計算は明示されたプリンシパルを列挙するが、グループ所属のみで判定される人は列挙できない。
承認可能でも通知対象から漏れる場合がある。人が権限内の原本で範囲を確認し、別途対応を手配する。
非公開の名簿や閲覧できない案件情報をこの報告へ転記しない。

## Decisions and follow-up / 判断・次の対応

Repeat this block for each decision. Use stable IDs to link revisions and later reviews.
判断ごとに以下を記入。固定IDで修正・次回レビューと関連付ける。

- Decision ID and related finding/case reference / 判断ID・関連指摘・案件参照:
- Decision, rationale and evidence version / 判断・理由・証拠の版:
- Decision maker and recorded time / 判断者・記録時刻:
- Owner, next action, due date/timezone and next review / 担当・次の対応・期限とタイムゾーン・次回確認:
- Required separate approval or source-system action / 別途必要な承認・元システムでの操作:
- Progress: open, blocked, completed or withdrawn; reason / 状況：未着手・阻害・完了・撤回と理由:
- Completion evidence reference, verified by and verification time / 完了証拠参照・確認者・確認時刻:
- Superseded decision ID and revision reason / 置き換えた判断ID・変更理由:

A management decision does not approve a source case or authorize an external transaction.
An owner or due date here creates no assignment or reminder. People arrange authorized work
separately. Close a follow-up only against its stated action and checked evidence; report review
completion does not prove payment, delivery or other downstream completion. If blocked or overdue,
keep it open and record who will review it next. Withdrawal does not undo an external action.
経営判断は元案件の承認や外部取引の許可ではない。担当・期限の記入で割当や通知は発生しない。
権限のある人が別途手配する。記載した対応と確認済み証拠に基づいてのみ完了とする。
報告確認の完了は支払・納品などの完了を証明しない。阻害・期限超過は未完了のまま次の確認者を記録。
撤回しても外部操作は取り消されない。

## Report release and corrections / 報告の共有・訂正

- Review disposition: ready for stated audience, revise or hold / 確認結果：指定先へ共有可・要修正・保留:
- Remaining uncertainties disclosed and excluded claims / 明示した未確認事項・除外した主張:
- Person confirming the version and audience, with time / 対象版と共有先の確認者・時刻:
- Actual distribution by person, time and reference (or not shared) / 実際の配布者・時刻・参照（または未共有）:
- Correction/withdrawal reason, prior and replacement versions / 訂正・撤回理由・旧版・新版:
- Recipients informed by person, evidence and outstanding contacts / 人による訂正連絡先・証拠・未連絡先:

Retain the original report and decision references. A person checks that recipients may receive
the revised evidence before sharing it. This worksheet neither sends nor withdraws a report.
元報告と判断の参照を保持。修正版の証拠を共有できる相手か、人が確認する。
この表は報告の送信・撤回を実行しない。
