# Metric definitions / 集計定義

workitems.stats: projectId required; queue, department and windowDays optional (1–365, default30).
Capture the response computedAt and scope: all means privileged scope, visible means readable
items. Queue/department filters still apply. Neither means all Projects or company-wide coverage.
projectId必須、queue・department・windowDays任意。応答のcomputedAt・scopeを保存。
allでも指定範囲のみ。visibleは閲覧可能分。いずれも全社集計ではない。

- total, byStatus, byQueue, stages: current readable records, not restricted by windowDays.
  現在の閲覧可能な件数・段階。windowDaysはこれらの期間絞込みではない。
- overdue: dueAt before now, except done/cancelled. An approved item can remain overdue.
  stageOverdue: overdue active stages on awaiting_review items. Do not add these counts as
  unique cases. 期限超過はdone/cancelledを除く。段階期限超過とは重複し得る。
- timeToApprove: count, medianHours, p90Hours, windowDays. First awaiting_review to latest
  approved transition, where that approval is within the window. Empty sample: null timings,
  not zero. This is elapsed time, including waits/rework, not labor effort or an average.
  承認時間は最初の確認待ちから最新承認まで。窓内の承認が対象。空集合はnull、作業時間や平均ではない。
- No historical trend, saved time, money, destination result or denied-queue inventory is
  returned. A missing queue is not proof of zero work. Estimates require separate labelled
  assumptions; measured outcomes require evidence in reports/outcomes.md.
  履歴傾向・削減時間・金額・外部結果・拒否キュー一覧は返さない。不在をゼロと推定しない。

Stats are not paginated. If a separate item list/export is used, record its filters and limits.
Reading stats may apply due escalations under existing policy; this pack schedules no reads.
集計はページ分割なし。別の一覧は上限を明記。取得時に既存方針の期限エスカレーションが起こり得る。
