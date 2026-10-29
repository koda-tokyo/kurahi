# People review / 人事確認手順

1. A person fills requests/leave.md or overtime.md and transfers fields through
   workitems.create/update. Attach the attendance source if authorized. Markdown forms are
   not interactive UI forms and do not import files automatically.
   人が原本を記入し項目へ転記。権限の範囲で勤怠原本を添付。自動取込はしない。
2. Verify source period, snapshot date and employee/department against trusted records.
   Leave: check requestedDays against availableDays and entitlement manually.
   Overtime: actual monthToDateHours and forecastMonthHours are separate; reconcile forecasts
   with actuals and the requested hours. No automatic balance/hour calculation ships here.
   対象期間・集計日・本人・部署を照合。休暇残数・資格と申請日数、残業実績・見込みを人が比較。
3. Submit the item with expectedRevision. Leave routes to department manager then HR;
   overtime routes to manager, then a distinct HR reviewer if forecastMonthHours > 45.
   Sample rules warn above 36 monthly hours and block normal approval above 80; daily hours
   above 8 block normal approval. Date lead time is calendar days, not business days.
   版指定で提出。休暇は所属長→人事、残業見込み45時間超は別人の人事確認。
   月36時間超注意・80時間超と日8時間超は通常承認を停止する設定例。暦日で判定。
4. A person handles send-back/cancellation and records corrections. Refresh before retrying
   an uncertain write to avoid duplicate requests. Only claim payroll/attendance updates
   after checking the downstream result; approval alone proves no such update.
   差戻し・取消・修正は人が行う。不明な書込結果は再試行前に確認。承認は勤怠・給与反映ではない。

## Onboarding/offboarding / 入退社

Use requests/onboarding.md or offboarding.md as a manual task manifest. Store a case in
people-onboarding/offboarding with the employee, department, effectiveOn, caseOwner and
checklistReference. HR review authorizes the plan, not employment or task completion.
原本のタスク一覧を使用し、対象者・部署・予定日・担当者・参照先をcaseに記録。人事確認は計画の確認。

Each stable task key has an owner, due date, dependencies, status and required outcome evidence.
People create separate departmental requests if needed and record their IDs in the manifest;
these are references only, not engine-linked children. This pack installs no automatic dependency gating or
all-children-done rule. Case owner checks every required task before marking done.
各キーに担当・期限・依存・状態・結果証拠を記入。関連依頼IDは参照のみで親子案件ではない。
このパックは依存制御・全子完了判定を設定しません。担当者が全結果を確認してから完了にする。

Use the department mappings in onboarding.md/offboarding.md when planning departmental requests;
confirm the actual queue department and access, and record item IDs and revisions by task key.
部署対応を使い依頼を計画し、実際のキュー部署・アクセス権を確認。キーごとに案件ID・版を記録。

Use requests/lifecycle-evidence.md for each task’s source, observed result, reviewer and
exception follow-up. Reconcile every required key before closing the checklist; references and
manual statuses do not change engine state or execute downstream work.
各タスクの原本・結果・確認者・例外対応は証跡シートへ記録。全キーを照合してから一覧を閉じる。
参照・手動状態は案件状態を変更せず、他システムの作業を実行しない。

For failed or uncertain handoffs, retain pending/exception status in the manifest, an owner and
next action. Do not retry access/payroll actions blindly. Handle cancellation per task: preserve
completed evidence, record authorized reversals separately. A cancelled case does not undo work.
不明・失敗は担当者と次の対応を残す。権限・給与操作を無確認で再試行しない。
取消は各作業で確認し、完了証拠を保持。案件取消だけでは実施済み作業は元に戻らない。

SLA examples: leave24h, overtime8h, onboarding72h, offboarding24h from item creation; not the
employment date or actual service completion. Review overdue work manually; no notifications,
HR/attendance sync, access changes, payroll writes or autopilot routine are included.
SLAは登録から休暇24h・残業8h・入社72h・退社24hの例。入退社日や実施完了ではない。
期限超過は人が確認。通知・同期・権限変更・給与書込・自動ルーチンは含まない。
