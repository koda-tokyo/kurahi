# Exception follow-up / 例外の対応表

Manual follow-up, not an engine-managed reconciliation state machine.
手動の対応表であり、エンジンによる照合状態の管理ではない。

- Source Project, reader, scope and capture time / 元プロジェクト・閲覧者・範囲・取得時刻:
- Source reference and coverage gaps / 原本参照・不足範囲:

| Case reference / 案件参照 | Workflow / 業務 | Observed problem / 問題 | Owner / 担当 | Next action / 次の対応 | Due / 期限 | Destination evidence / 連携先証拠 | Uncertainty / 未確認事項 | Reviewer / 確認者 |
| ------------------------- | --------------- | ----------------------- | ------------ | ---------------------- | ---------- | --------------------------------- | ------------------------ | ----------------- |
|                           |                 |                         |              |                        |            |                                   |                          |                   |

Separate approval overrides, failed checks, overdue review and uncertain external results.
Do not derive exception totals from a status name alone. Inspect permitted evidence manually.
Record an uncertain hand-off as unresolved until a person checks the destination. Never retry
or reverse an external action from this worksheet. A cancelled case does not undo a payment.
承認例外・ルール不適合・期限超過・外部結果不明を区別。状態名だけで例外件数を推定しない。
引渡し結果が不明なら未解決。連携先を人が確認し、表から再実行・取消を行わない。

- Correction/cancellation history and retained evidence / 修正・取消履歴と保持証拠:

## Repeat review and closure / 継続確認・終了判断

Assign a stable exception ID and keep a dated entry for each review. Link the same exception
across report versions instead of counting each observation as a new case. Several exceptions
may concern one case; report exception counts and distinct case counts separately.
例外に固定IDを付け、確認ごとに日付付き記録を保持。同じ例外は報告の版をまたいで関連付け、
再確認を新規案件として数えません。1案件に複数の例外がある場合、例外数と固有案件数を分けます。

- Exception ID and source case ID/revision / 例外ID・元案件IDと版:
- Previous review reference and current review time/timezone / 前回確認の参照・今回の確認日時とタイムゾーン:
- Original problem and required resolution / 当初の問題・必要な解決結果:
- New observation, evidence reference and checked by / 今回の確認結果・証拠参照・確認者:
- Decision: unresolved, resolved, withdrawn or unknown; reason / 判断：未解決・解決済み・撤回・不明と理由:
- Remaining action, owner, original due date and next check / 残る対応・担当・当初期限・次回確認:
- Changed deadline, reason and authorizing reference, if any / 期限変更があれば変更後の期限・理由・権限根拠:
- Related decision ID or superseding exception ID / 関連判断ID・置き換える例外ID:

Use resolved only when a reviewer checks evidence against the stated resolution. A disappearing
list entry, read notification, reassignment or cancelled case is not proof of resolution. If the
record becomes unreadable, preserve the last permitted evidence and mark the new result unknown;
ask an authorized owner to verify it. Do not broaden access or copy restricted evidence here.
必要な解決結果と証拠を確認してから解決済みとします。一覧からの消失・既読・担当変更・案件取消は
解決の証明ではありません。閲覧不可となった場合、保持が認められた前回証拠を残し、今回の結果は不明とし、
権限のある担当者へ確認を依頼します。権限を拡大したり、閲覧制限のある証拠を転記したりしません。

Withdrawal records why follow-up is no longer required and who authorized that decision; it does
not claim the original problem was fixed. If it recurs or the source changes, add a new review
linked to the earlier decision without erasing it. People maintain these records manually;
this worksheet does not reopen cases, change statuses or send reminders.
撤回は対応不要とした理由・権限者を記録するもので、問題解決の主張ではありません。再発や原本変更では
過去の判断を消さずに関連付けて再確認を追加します。手動記録であり、案件再開・状態変更・通知は行いません。

For an unknown result, record what could not be checked, the last successful check and the
authorized owner for follow-up. Keep unknown results separate from confirmed resolutions in
reports. When evidence becomes available, append a dated review linked to the unknown entry;
do not replace the earlier observation.
結果が不明の場合、確認できなかった範囲・最終確認日時・確認権限を持つ担当者を記録します。
報告では不明と解決確認済みを分けます。証拠を確認できたら、不明の記録に関連付けた日付付きの
確認を追記し、以前の記録を置き換えません。

## Open exception counts / 未終了の例外件数

For this manual report, open means unresolved or unknown. Count each exception ID once using
its latest dated review within the stated scope and cutoff; show unresolved and unknown as
separate subtotals. For example, two unresolved and one unknown exception mean three open
exceptions, even when all three concern the same case. Resolved and authorized withdrawn
exceptions are excluded from the open count, but their review history remains.
この手動報告では、未解決または不明を未終了として数えます。対象範囲と締切時点を明記し、
各例外IDの最新の日付付き確認を用いて1件ずつ集計します。未解決と不明の内訳は別々に示します。
例：未解決2件と不明1件は、すべて同じ案件でも未終了3件です。解決済みと権限者が撤回した
例外は未終了件数から除外しますが、確認履歴は保持します。

If an exception was identified within the reporting scope by the cutoff but has no dated review
at or before that cutoff, count it once as unresolved and open. Record that the review is pending;
do not infer a resolution from a later review or from the absence of a decision. An exception first
identified after the cutoff belongs in a later report. Keep its identification time and source
reference so another reviewer can reproduce the count.
締切までに対象範囲内で特定された例外に、締切以前の日付付き確認がない場合は、未解決・未終了として
1件数えます。確認待ちと記録し、締切後の確認や判断の欠落から解決済みと推定しません。
締切後に初めて特定された例外は次回以降の報告に含めます。特定日時と原本参照を保持し、
別の確認者が件数を再確認できるようにします。

- Reporting scope and cutoff / 報告範囲・締切時点:
- Unresolved / 未解決:
- Unknown / 不明:
- Open total (unresolved + unknown) and distinct affected cases / 未終了合計（未解決＋不明）・対象の固有案件数:
- Coverage gaps and reviewer / 対象範囲の不足・確認者:

An unknown decision for an identified exception is countable; an unknown number of exceptions
is not zero. If records are missing or unreadable, label the count as the known scoped count
with a coverage gap, not a complete total. These manual counts do not change case statuses or
the statistics API.
特定済みの例外の判断が不明でも、その例外は集計できます。例外の件数自体が不明な場合は
ゼロとしません。記録の欠落・閲覧不可があれば、既知の範囲の件数と不足範囲を示し、完全な
総件数とは表示しません。この手動集計は案件状態や統計APIを変更しません。

## Approval override evidence / 承認例外の証拠

For a case allowed to proceed despite a failed check, preserve the failed result and the exact
case revision alongside the override decision. A permitted override does not prove the failed
condition was corrected. Review that condition separately before closing its exception.
ルール不適合のまま進行を認めた案件は、不適合結果・案件の版・例外承認の判断を併せて保持します。
例外承認が認められても、不適合条件が解消された証明にはなりません。例外を終了する前に条件を別途確認します。

- Exception ID, case revision and check/rule reference / 例外ID・案件の版・確認項目またはルール参照:
- Failed condition, observed value, applicable limit and check time / 不適合条件・観測値・適用基準・確認日時:
- Override decision, authorized person, reason and evidence reference / 例外承認の判断・権限者・理由・証拠参照:
- What was independently confirmed, by whom and when / 別途確認した内容・確認者・確認日時:
- Remaining uncertainty, follow-up owner and next check / 残る不明点・対応担当・次回確認:
- Separate resolution decision and supporting evidence / 別途の解決判断・裏付け証拠:

For example, a price-list file's modification time is not confirmation that its prices remain
valid. Record the exact price-list revision and the authorized person's confirmation evidence;
copying or saving the file again does not establish commercial validity. If a check or its input
is absent, record it here as not evidenced, even if the engine permits legacy cases without it.
Keep an approved exception separate
from a corrected condition and from confirmed delivery or payment.
例えば、価格表ファイルの更新日時だけでは価格の有効性を確認できません。価格表の正確な版と、
権限のある人による確認の証拠を記録します。ファイルのコピーや再保存は価格の有効性の証明ではありません。
確認項目や入力が欠けている場合、旧案件との互換性のためエンジンが許容しても、本表では証拠なしと
記録します。承認済みの例外・条件の是正・
納品や支払いの確認を区別します。

This worksheet records evidence only. It does not grant an override, replace company approval
rules, reopen a case or perform an external action.
本表は証拠の記録のみを行い、例外承認の付与・社内承認ルールの置換・案件の再開・外部操作を実行しません。
