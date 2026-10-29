# Workload snapshot / 業務量のスナップショット

Blank worksheet; a person copies authorized source facts. No automatic collection.
未記入のひな型。権限内の原本を人が転記。自動収集なし。

- Report ID and version / 報告ID・版:
- Prepared by and reviewer / 作成者・確認者:
- Source Project ID / 元プロジェクトID:
- Reader identity and authorized scope / 閲覧者と権限範囲:
- Request filters (including omitted filters) / 条件（未指定も明記）:
- Capture time and timezone / 取得時刻・タイムゾーン:
- Response scope (all/visible) and computedAt / 応答範囲・集計時刻:
- Approval windowDays (default 30) / 承認集計日数（既定30）:
- Source export/reference / 原本参照:
- Coverage, errors, known omissions and source list limits / 対象範囲・失敗・既知の欠落・原本一覧上限:

| Metric / 指標                                 | Value / 値     | Definition and source field / 定義・元項目 | Evidence reference / 証跡 |
| --------------------------------------------- | -------------- | ------------------------------------------ | ------------------------- |
| Total in scope / 対象件数                     | unknown / 不明 | total                                      |                           |
| Status counts / 状態別                        | unknown / 不明 | byStatus                                   |                           |
| Queue counts / キュー別                       | unknown / 不明 | byQueue                                    |                           |
| Stage statistics / 段階別集計                 | unknown / 不明 | stages                                     |                           |
| Stage overdue / 段階期限超過                  | unknown / 不明 | stageOverdue                               |                           |
| Overdue / 期限超過                            | unknown / 不明 | overdue                                    |                           |
| Approval sample size / 承認対象件数           | unknown / 不明 | timeToApprove.count                        |                           |
| Median approval hours / 承認時間中央値        | unknown / 不明 | timeToApprove.medianHours                  |                           |
| P90 approval hours / 承認時間90パーセンタイル | unknown / 不明 | timeToApprove.p90Hours                     |                           |

Do not sum overlapping Projects/queues/snapshots or infer company-wide totals. A date range
written on this form does not filter the statistics API. Missing data is not zero.
重複範囲を加算せず、全社合計と推定しない。ここに期間を記入してもAPIの期間絞込みにはならない。

- Reviewer findings / 確認結果:
- Revisions and original snapshot / 修正と元スナップショット:
- Approved audience and distribution by person / 許可された共有先・人による配布:

## Source freshness review / 原本の更新確認

Capture time and computedAt record when the response was obtained or calculated; they do not
prove that every source record was checked at that moment. Before using a snapshot for a
time-sensitive decision, record what is known about source freshness. A refresh alone is not
proof that delayed or previously omitted records have been included.
取得時刻とcomputedAtは応答の取得・計算時刻であり、すべての原本をその時点で確認した証拠ではありません。
期限に関わる判断に使う前に、原本の更新確認状況を記録します。再取得だけでは、反映が遅れた記録や
以前欠落していた記録が含まれたことを確認できません。

- Source product/version and documented freshness limits, if known / 原本システム・版・判明している更新反映の制約:
- Relevant source revision, last confirmed change and evidence / 関連原本の版・最終確認済み変更・証拠:
- Last independent source check, reviewer and time/timezone / 原本を別途確認した最終日時・確認者・タイムゾーン:
- Known delay or unknown freshness; affected metric/decision / 判明している反映遅延または更新状況不明・影響する指標と判断:
- Decision: usable with stated limits, qualified or awaiting verification; reason / 判断：制約を明示して使用可・条件付き・確認待ちと理由:
- Verification owner, next check and replacement report reference / 確認担当・次回確認・差替報告の参照:

If freshness cannot be established, mark it unknown and qualify affected claims. Ask an authorized
source owner to verify decision-critical records; keep their evidence with the snapshot. Do not
assign a universal freshness interval or present a later check as evidence of an earlier state.
This worksheet does not refresh source systems, invalidate caches or schedule verification.
更新状況を確認できなければ不明とし、影響する主張に制約を明記します。判断に必要な記録は権限のある
原本担当者へ確認を依頼し、証拠を集計とともに保持します。一律の更新間隔を仮定したり、後日の確認を
過去時点の証拠としたりしません。本表は原本の更新・キャッシュ無効化・確認の予約を実行しません。

## Reconciling a case list with statistics / 案件一覧と統計の照合

A page of cases and a statistics response are separate reads. Record both before explaining a
mismatch; a refresh does not establish that they describe the same moment. Do not replace a
reported total with the number of rows on one page.
案件一覧と統計は別々の取得。差を説明する前に両方を記録し、再取得だけで同時点とは判断しない。
1ページの行数で報告済みの総件数を置き換えない。

- List and statistics evidence references, capture times and timezone / 一覧・統計の証拠参照・取得日時とタイムゾーン:
- Same Project, reader, department/queue/status filters and scope? / プロジェクト・閲覧者・部門・キュー・状態条件・範囲は同一か:
- Pages inspected, page size, reported total and incomplete reads / 確認ページ・ページ件数・応答総件数・未取得部分:
- Cases changed between reads and supporting revision evidence, if known / 取得間に変化した案件と版の証拠（判明時）:
- Unexplained difference, affected claims, investigation owner and next check / 未説明の差・影響する主張・調査担当・次回確認:
- Reviewer decision: reconciled, qualified or unresolved / 確認判断：照合済み・条件付き・未解決:

Keep unexplained differences unresolved; do not infer missing cases, lost work or completed work
from counts alone. A person reviews the source evidence before distributing a corrected report.
未説明の差は未解決とし、件数だけで案件の欠落・消失・完了を推定しない。訂正版の配布前に人が原本を確認する。

## Comparison with an earlier snapshot / 前回集計との比較

Complete this block before describing a change. Keep both source exports and their capture times;
never replace the earlier evidence with a new read. A count difference alone does not identify
which cases arrived, finished or moved between queues.
変化を記述する前に本欄を記入。両方の原本と取得時刻を保持し、再取得値で過去の証拠を上書きしない。
件数差だけでは新規・完了・キュー移動の案件を特定できない。

- Earlier and current report versions, source references and computedAt / 前回・今回の報告版・原本参照・集計時刻:
- Reviewer and comparison date/timezone / 確認者・比較日時とタイムゾーン:

| Comparability check / 比較条件                                                                            | Same, changed or unknown; evidence / 同一・変更・不明と証拠 |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Source Project, reader permissions and response scope / 元プロジェクト・閲覧権限・応答範囲                |                                                             |
| Queue/department filters and source coverage / キュー・部門条件・対象範囲                                 |                                                             |
| Metric definition and unit / 指標定義・単位                                                               |                                                             |
| Approval windowDays, sample sizes and null values / 承認集計日数・対象件数・null                          |                                                             |
| Failed reads, omissions and export limits / 取得失敗・欠落・出力上限                                      |                                                             |
| Source freshness evidence and known delays for both captures / 両取得時点の更新確認の証拠・既知の反映遅延 |                                                             |

- Decision: comparable, qualified comparison or not comparable; reasons / 判断：比較可能・条件付き・比較不可と理由:
- Supported difference, calculation and limitations / 裏付けのある差・計算・制約:

Changed permissions or filters can change counts without a business change. When coverage is
unknown, keep the comparison unknown. Rolling approval windows can overlap; do not add their
samples or average their medians/P90s. A zero or unknown baseline cannot support a percentage
change. Measured productivity claims need the separate outcomes worksheet.
権限・条件の変更でも件数は変わる。範囲不明なら比較も不明。移動期間は重複し得るため、
対象件数の加算・中央値やP90の平均は行わない。基準がゼロ・不明なら増減率を算出しない。
生産性の実測には別の結果表が必要。

If different or unknown source freshness could explain the difference, leave the affected trend
unverified and record a verification owner and next check. Keep each capture's freshness review
with its evidence; a check performed now cannot establish the earlier capture's source state.
更新反映の差や更新状況の不明が指標の差の原因となり得る場合、影響する傾向は未確認とし、確認担当と
次回確認を記録します。各取得時点の更新確認記録と証拠を保持し、現在の確認を過去時点の原本状態の
証拠にしません。

- Unverified trend, verification owner and next check / 未確認の傾向・確認担当・次回確認:

## Correction and withdrawal record / 訂正・撤回記録

Keep the reviewed original and make a new version for a correction. A person records the affected
claims, evidence and review decision before distributing a replacement. This worksheet does not
recall copies or notify recipients automatically.
確認済み原版を保持し、訂正は新版にする。影響する主張・証拠・確認判断を記録してから人が再配布する。
本表は配布済み写しの回収・受信者への通知を自動実行しない。

| Original and replacement versions / 原版・差替版 | Corrected claim and reason / 訂正内容・理由 | Evidence reference / 証拠参照 | Reviewer and decision time / 確認者・判断日時 | Authorized recipients to contact / 連絡すべき許可済み共有先 | Contact/receipt evidence or pending owner / 連絡・受領の証拠または未確認の担当 |
| ------------------------------------------------ | ------------------------------------------- | ----------------------------- | --------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
|                                                  |                                             |                               |                                               |                                                             |                                                                                |

Record a withdrawn report as withdrawn even if no replacement exists. Sending a correction does
not prove every recipient received it; keep unconfirmed receipt and follow-up ownership explicit.
差替版がなくても撤回は撤回として記録。訂正送信だけで全員の受領を確定せず、未確認と対応担当を明記。
