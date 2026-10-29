# Management report preparation / 経営報告の準備

Preview: manual worksheets using existing statistics and evidence.
プレビュー：既存の集計・証跡を人が確認し、報告用ひな型へ転記する。

1. A person selects each source Project and authorized queues. Record the reader identity,
   filters, capture time/timezone and source in reports/snapshot.md. Export permitted data only.
   Department labels grant no access; this Project inherits no permissions or aggregation.
   元プロジェクト・権限内のキューを選び、閲覧者・条件・取得時刻・参照先を記録。
   この報告プロジェクトは他のプロジェクトの権限を継承せず、自動集計もしない。
2. Keep authorized source exports in sources/ (read-only to the agent). Prepare the report in
   output/ from the worksheets in reports/. Unknown, unavailable and inaccessible are distinct
   from zero. Do not infer hidden records or paste confidential case text into a broad report.
   許可済み原本はsources/、ひな型はreports/、下書きはoutput/。不明・取得不可はゼロにしない。
3. Use the metric definitions in templates/01-metric-definitions.md. Workload is a snapshot;
   approval timing is not effort or payment duration. Record gaps and failed reads. Partial
   access or a limited list page cannot establish a company-wide total.
   集計定義を使用。業務量は取得時点、承認時間は作業時間・支払時間ではない。欠落を明記。
4. Record exceptions in reports/exceptions.md with an owner, next action, due date and evidence.
   Preserve failed or uncertain downstream results. Before retrying any transaction, a person
   checks the destination; report preparation cannot retry, cancel or reverse it.
   例外に担当・次の対応・期限・証拠を記載。不明な外部結果を完了にせず、人が連携先を確認。
5. Use reports/outcomes.md only for outcomes backed by destination evidence and comparable
   baselines. Review scope, calculations and redaction before sharing.
   Use reports/snapshot.md for comparisons and corrections; retain original versions and
   recipient follow-up evidence.
   結果は連携先の証拠と比較可能な基準で確認。共有前に人が範囲・計算・秘匿情報を確認。
   比較・訂正は集計表に記録し、原版・共有先への対応証拠を保持。

6. Use reports/review-decisions.md to record the reviewed version, findings, decisions, owners,
   due dates and completion evidence. People handle follow-up and distribution separately.
   判断記録に対象版・指摘・判断・担当・期限・完了証拠を記載。対応と配布は人が行う。
   For linked cases, use its linked-case evidence block; keep child progress, parent status and
   destination outcomes separate. 連携案件は同表の証跡欄で子進捗・親状態・外部結果を区別。
   Record brief/check scope and truncation in that worksheet; unreadable means unknown.
   ブリーフ・チェックの範囲と省略を同表に記録。読取不可は不明。
   Record notification coverage there; check pending work separately.
   通知範囲を同表に記録し、未対応案件を別途確認。

No scheduled collection, automatic notifications, new work queues, approval routes or downstream
writes are installed by this pack. Review and distribution are manual. Existing source queue
policies continue to apply; installing this report starter does not modify them.
自動収集・通知・新規キュー・承認経路・外部書込は追加しない。確認と配布は手動。
