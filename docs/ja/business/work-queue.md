---
summary: "Business エディションのワークキュー：プロジェクトごとのバックオフィス業務（総務・人事・経理・購買）。エージェントが下書きし、ポリシールールが確認し、承認・差戻し・取消は必ず人が行う。すべての状態遷移を監査ログと署名付きエビデンスに記録"
read_when:
  - ゲートウェイに対してワークキュー画面を実装する
  - プロジェクトのワークキューポリシー（workqueue.yaml）を書く
  - 誰が何を承認できるか、それがどう記録されるかを説明する
title: "ワークキュー"
---

# ワークキュー

English: [Work queue](/business/work-queue)

ワークキューは Business エディションのバックオフィスです。総務依頼、休暇・残業申請、経費精算、
受領請求書、購買申請が、プロジェクトの中の **ワークアイテム** として届きます。エージェントが回答・
確認結果・発注案を **下書き** し、プロジェクトの **ポリシールール** がアイテムと下書きを確認し、
**人** が承認・差戻し・取消を行います。エージェントが決裁することはありません。

2026年10月24日時点：ゲートウェイのメソッド、ポリシーエンジン、エビデンス、テンプレート、型付き
クライアントは実装済みです。段階承認ルート（稟議）、「自分の申請」、承認待ち一覧、書類プレビュー、
下書きの差分、キューの集計もこれに含まれます。デスクトップ画面（左にキュー、中央にアイテムとエージェントの下書きと
元の書類、右にポリシーチェック、承認 / 差戻しボタン）はこの仕様に沿って開発中です。

## コントロール UI での確認

Business テンプレートのプロジェクトで業務キューを開くと、ソース項目、文書への参照、
固定ドラフトのメタデータ、チェック、承認記録、履歴を確認できます。
承認・差し戻し・キャンセルは、表示されたリビジョンを固定した確認フォームから送信します。
項目が変わった場合は再確認が必要です。差し戻しとキャンセルにはコメントが必要です。
例外承認を明示的に選択する場合は、10文字以上の理由が必要です。
音声からの判断操作や自動再送は行いません。権限、職務分掌、ポリシーはゲートウェイが判定します。
承認が記録されても、追加の承認者が必要な場合があります。拒否は日本語・英語の案内で表示します。
結果を確認できない場合は、再試行の前に更新してください。

項目作成、エージェントへの割り当て、文書プレビュー、ドラフト差分の UI は今後の対応です。
「固定ドラフトを読み込む」で、固定された成果物バージョンの本文をプレーンテキストで確認できます。
プロジェクト、成果物 ID、バージョン、SHA-256 を照合し、受信した UTF-8 本文のハッシュも確認します。
項目の更新でプレビューを消去します。取得失敗や不一致の場合は本文を表示しません。
ソース文書は参照のみです。この本文照合では証跡の署名は検証していません。

「証跡を検証」で、ゲートウェイにバンドルとチェーンの検証を要求できます。
成功・失敗・検証不可、応答時のローカル日時、返されたバンドル数を表示します。
空の結果は成功として扱いません。表示中の履歴にある証跡参照とルートがすべて一致する必要があります。
項目の更新や移動で結果を消去します。これは同梱の署名鍵による証跡の検証であり、
現在の項目のリビジョン、署名者の外部的な信頼性、法令適合を証明しません。
担当者による電子承認とは別の操作です。

## ワークアイテム

ワークアイテムは必ず1つのプロジェクトに属し、そのプロジェクトのデータ領域に保存されます。

```
<KOLO_HOME>/projects/<projectId>/workitems/<itemId>/item.json
<KOLO_HOME>/projects/<projectId>/workitems/<itemId>/evidence/0001-create/…
```

| 項目                | 意味                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `queue`             | プロジェクトのポリシーで定義したキュー（例 `fin-expense`）                                           |
| `type`              | `request` `case` `document` `invoice` `leave` `expense` `purchase` `custom`                          |
| `source`            | `documents`（添付・プロジェクト内ファイル・成果物への参照。プロジェクト外は不可）と申請項目 `fields` |
| `status`            | `new` `drafting` `awaiting_review` `approved` `sent_back` `done` `cancelled`                         |
| `assignee`          | `{kind: "agent" \| "person", id}` または null                                                        |
| `priority`, `dueAt` | 優先度と期限。期限は指定がなければキューの SLA（`slaHours`）から計算                                 |
| `draft`             | 確認者が見る成果物の id・版・SHA-256（固定）                                                         |
| `checks`            | `[{policyId, label, result: pass\|fail\|warn, blocking, evidence, draftVersion, policyDigest}]`      |
| `requiredApprovals` | 必要な承認者の人数（二名承認ルールに該当すると 2）                                                   |
| `requestedBy`       | アイテムを作成した接続の識別子（「自分の申請」の持ち主）                                             |
| `route`             | アイテムに確定した承認ルート：段階、現在の段階、条件で外れた段階（後述）                             |
| `approvals`         | 承認した人・日時・コメント・段階（`stageId`、`via`、`onBehalfOf`）                                   |
| `override`          | ブロッキングチェック不合格のまま承認した人、理由、対象チェック                                       |
| `history`           | すべての変更：誰が（`person` / `agent` / `system`）、何を、いつ、どのエビデンスで                    |
| `runIds`            | 下書きしたエージェント実行（`jobs.*` とジョブのエビデンスでも確認可能）                              |
| `revision`          | 書き込みごとに増える番号。`expectedRevision` に渡すと他人の変更を上書きしません                      |

### ライフサイクル

- `new` → `workitems.assignAgent` → `drafting` → 下書き完了 → `awaiting_review`
- `awaiting_review` → ルートの各段階で承認 → `approved` → `workitems.update` で `done`
- `awaiting_review` → 差戻し（コメント必須）→ `sent_back` → 再び `assignAgent` で `drafting`
- 人が作成したアイテムは `workitems.update` の `status: "awaiting_review"` で確認に回せます
- 終了していないアイテムはすべて、取消（コメント必須）で `cancelled`
- 実行が失敗・空の返答なら元の状態（`new` / `sent_back`）に戻り、`lastError` に理由が残ります

既存の成果物を下書きとして付けることもできます（`workitems.update` の `patch.draft`）。
申請内容や下書きが変わると、それまでの承認は無効になり、チェックが再実行されます。

## ゲートウェイのメソッド

すべて `projectId` を取ります。別プロジェクトのアイテム id は `work item not found` になります。
読み取りと変更は、申請者・承認者の権限でも制限されます（後述の「申請者と閲覧権限」を参照）。

| メソッド                | スコープ（ペアリング / operator） | 内容                                                                                                                                                                            |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workitems.list`        | observe / `operator.read`         | 絞り込み（キュー・状態・種別・優先度・担当・期限超過・`q`・`mine`・`awaitingMe`・`stage`・`department`・`flagged`）、カーソルでページング（1ページ最大200件）、件数と状態別件数 |
| `workitems.get`         | observe / `operator.read`         | 履歴を含むアイテム全体                                                                                                                                                          |
| `workitems.config`      | observe / `operator.read`         | キュー（`department` 付き）、部門一覧 `departments`、ルール、承認ルート、権限設定の概要、呼び出し元（`viewer`）、ポリシーの出所とダイジェスト                                   |
| `workitems.evidence`    | observe / `operator.read`         | アイテムのエビデンスをすべて検証し、つながりも確認                                                                                                                              |
| `workitems.document`    | observe / `operator.read`         | 元の書類または固定した下書きの安全なプレビュー                                                                                                                                  |
| `workitems.draftDiff`   | observe / `operator.read`         | 固定した下書きの2つの版の行単位の差分と、その由来                                                                                                                               |
| `workitems.stats`       | observe / `operator.read`         | 状態・キュー・段階ごとの件数、期限超過件数、承認までの時間の中央値と90パーセンタイル。`department` で絞り込み可                                                                 |
| `workitems.create`      | attach / `operator.write`         | 新規作成。申請項目だけのチェックをすぐ実行                                                                                                                                      |
| `workitems.update`      | attach / `operator.write`         | 決裁以外の項目。`status` は `awaiting_review`（確認に回す）と `done`（承認後）のみ                                                                                              |
| `workitems.assignAgent` | attach / `operator.write`         | 下書きのエージェント実行を開始。`runId` をすぐ返す                                                                                                                              |
| `workitems.decide`      | attach / `operator.approvals`     | 現在の段階に対する `approve` / `send_back` / `cancel`。人のみ                                                                                                                   |
| `workitems.delegate`    | attach / `operator.approvals`     | 現在の段階の判断を他の人に委任。人のみ                                                                                                                                          |
| `workitems.intakeEmail` | attach / `operator.write`         | メールから参照付きでアイテムを作成。同じメッセージは1件のみ（後述の「メールの取り込み」）                                                                                       |
| `workitems.clearFlag`   | attach / `operator.approvals`     | リスクフラグを理由を書いて1つ解除。人のみ（後述の「リスクフラグ」）                                                                                                             |

イベント `workitems.changed` `{projectId, id, queue, action, status, revision, updatedAt}`。
件名や申請内容は含みません。`workitems.get` で取り直してください。読み取り権限のある接続に送られます。

型付きクライアント（`@kodasoken/kurahi-client`）はメソッドの型と、`WorkItem`、`WorkItemSummary`、
`WorkItemCheck`、`WorkItemHistoryEntry`、`WorkItemDecision`、`WorkQueueDef`、`WorkQueueRule`、
`WorkItemEvidenceBundle`、`WorkItemApproval`、`WorkItemRoute`、`WorkItemStage`、
`WorkItemStageStatus`、`WorkItemStageSummary`、`WorkItemDelegation`、`WorkItemDelegateInput`、
`WorkQueueRouteDef`、`WorkQueueAccess`、`WorkQueueViewer`、`WorkItemDocumentPreview`、
`WorkItemDraftDiff`、`WorkItemDiffHunk`、`WorkItemDiffLine`、`WorkItemDraftProvenance`、
`WorkQueueStats`、`WorkQueueStageStats`、`WorkItemOrigin`、`WorkItemFlag`、
`WorkItemFlagClearance`、`WorkItemIntakeEmailInput`、`WorkItemIntakeEmailResult`、
`WorkItemClearFlagInput`、拒否コードの一覧 `WORK_ITEM_DECISION_REFUSALS`・
`WORK_ITEM_DELEGATION_REFUSALS`・`WORK_ITEM_ACCESS_REFUSALS`・`WORK_ITEM_FLAG_REFUSALS`・
`WORK_ITEM_INTAKE_REFUSALS` を公開しています。

### エージェントによる下書き

`workitems.assignAgent` は、エージェントがプロジェクトで許可されているか確認し（キューの
`defaultAgent`、なければ `main`）、アイテムを `drafting` にして、アイテム専用のプロジェクト
セッション `agent:<agent>:proj-<projectId>-wi<item>` で実行します。フォルダの範囲、モード
（参照 / 計画 / 実行）、ツールガードはプロジェクトのチャットとまったく同じです。プロンプトには
申請項目、元の書類の参照、該当するルール、差戻しコメントが入ります。最終返答は成果物
（確認中）として保存されて下書きに固定され、チェックが自動で実行されます。差戻し後の再作成は
同じ成果物の次の版として保存されるので、`workitems.draftDiff` で前回との違いを確認できます。30分以上 `drafting`
のまま（再起動など）のアイテムは、もう一度割り当てられます。

### 決裁は人のみ

次の場合 `workitems.decide` は拒否され、拒否も監査ログに残ります。

- 音声由来の印がある（共通の音声承認ガード。スキーマ検証より前）
- エージェントのツール接続（`backend` モード / `gateway-client`）、ノード、接続のない呼び出し
  （`code: not_a_person`）
- 資格情報に `operator.approvals` がない

承認にはさらに次が必要です：現在の段階を判断できる人であること（`not_an_approver`）、段階承認
ルートでは前の段階を承認していないこと、状態が `awaiting_review`、固定した下書きが成果物の最新版
（`draft_changed`）、同じ人の二重承認でない（`already_approved`）、`separationOfDuties: true`
のとき作成者本人でない（どちらも端末・ペアリングの識別子の場合。`separation_of_duties`。
段階承認ルートでは常に適用）、
**ブロッキング** チェックがすべて合格（その場で再評価）。不合格のまま承認するには
`override.reason`（10文字以上）が必要で、アイテム・エビデンス・監査ログ（`workitem.override`）
に記録されます。段階の承認人数が足りないとき、または次の段階があるときは `awaiting_review` の
ままです。最後の段階の最後の承認で下書きの成果物は承認済みに、申請者への差戻しで下書きに戻ります。
差戻しと取消にはコメントが必要です。差戻しは現在の段階を判断できる人が、取消は申請者・運用担当者・
現在の段階を判断できる人が行えます。

拒否時の `error.details.code`：`not_a_person`、`terminal`、`comment_required`、
`not_awaiting_review`、`draft_changed`、`already_approved`、`separation_of_duties`、
`checks_failed`（`failing` 付き）、`not_an_approver`（`stage` 付き）、`not_authorised`、
`fraud_flag_uncleared`（`flags` 付き。後述の「リスクフラグ」）。

## メールの取り込み

Microsoft 365 または Gmail のコネクタでメールを読む Business エージェントは、メッセージを
ワークアイテムにできます。秘書室の文書トレイや経理の請求書台帳に、実際のメールに基づく案件が
並びます。

- **エージェントのツール** `workitems_intake_email`：プロジェクトのセッションでのみ使え、常にその
  セッションのプロジェクトに作成します。引数は `queue`、`title`、`type`、`priority`、`due?`、
  `summary`、`source`、`flags?`、`flagReason?`。ゲートウェイのプロセス内では、ツール自身の接続に
  `workitems.intakeEmail` が適用するもの（同じ検証、同じエージェントとしての操作者、同じ重複確認、
  同じ `workitems.changed` イベント）のまま取り込みモジュールを直接呼び、呼び出しごとにゲートウェイ
  接続を開きません。別プロセスのエージェントでは、エージェント接続として `workitems.intakeEmail`
  を呼びます。
- **オートパイロット**：ルーティンが読んだメールも同じ取り込みで起票します（メッセージごとに1件、
  フラグはアイテムに付き、実行とルーティンの情報は `source.fields` に残ります）。
  [オートパイロット](/ja/autopilot)を参照してください。
- **ゲートウェイのメソッド** `workitems.intakeEmail {projectId, queue, title, type, priority,
dueAt?, summary, source, flags?, flagReason?}` は `{item, created}` を返します。
- `source` は写しではなく **参照** です：`{kind: "email", connector: "microsoft-365" | "gmail",
messageId, receivedAt?, from?, subject?}`。アイテムの `source.origin` に保存され、一覧の行にも
  出ます。本文は保存しません。**本文はメールボックスに残り**、必要なときにコネクタで読み直します。
  `summary`（2000文字以内）は、メールの依頼内容をエージェント自身の言葉でまとめたものです。
- 検証は厳格です：`messageId` は1〜512文字の id 文字（空白や `..` は不可）、`receivedAt` は
  タイムゾーン付きの ISO 8601 日時（UTC で保存）、`from` は表示名なしのアドレスのみ、`subject` は
  1行300文字以内、ほかの項目は不可（`body` は拒否）。`title`・`summary`・`subject` にコネクタの
  信頼できないコンテンツの境界マーカー（ツール出力の貼り付け）があれば拒否します。
- プロジェクト内で `(connector, messageId)` ごとに **1件のみ**：同じメッセージをもう一度取り込むと、
  既存のアイテムを変更せずに `created: false` で返します（2件目もイベントも作りません）。呼び出し元に
  そのアイテムの閲覧権限がなければ、アイテムを含まず `duplicate_source` を返します。確認と作成は
  プロセスをまたいでプロジェクト単位のロックの中で行います。
- 新しいアイテムは必ず `new`（準備）から始まります。取り込みで確認に回したり承認したりはしません。
  ほかのアイテムと同じく、人が確認して決裁します。
- 拒否コード：`duplicate_source`。そのほかの不正な入力は項目名を示すメッセージで拒否します。

## リスクフラグ

アイテムには `flags`（`suspected_fraud`・`phishing`・`prompt_injection`・`unverified_sender`・
`malicious_attachment` の組み合わせ。`malicious_attachment` は[添付ファイルの取り込み](/ja/security/attachment-intake)が
メッセージの添付を拒否したときにエンジンが付ける）と、任意の `flagReason`（500文字以内）を付けられます。取り込むエージェントが
付けます（振込先の変更、急ぎの支払いの催促、エージェント宛ての指示、確認できない差出人など）。
件名がプロンプトインジェクションのパターンに当たると、自動で `prompt_injection` が付きます。
オートパイロットが人に回す案件にも同じくルーティンのフラグが付き（口座情報の変更の提案には
`suspected_fraud`）、以下の規則がそのまま適用されます。
`workitems.list {flagged: true}` はフラグ付きのアイテムだけを返し（`false` はフラグなしのみ）、
閲覧権限の絞り込みの後にゲートウェイで絞り込むので、`total` と `counts` も一致します。

- **`suspected_fraud` または `malicious_attachment` が付いている間は承認できません**（どの段階でも、種別に関係なく
  `workitems.decide` は `fraud_flag_uncleared` を返します）。**完了にもできません**。
  `override.reason` でも回避できません。
- **フラグを解除できるのは人だけです**：`workitems.clearFlag {projectId, id, flag, reason,
expectedRevision?}` には `operator.approvals`、10文字以上の `reason`、人の接続が必要です。
  エージェントのツール接続・ノード・音声は決裁と同じく拒否されます（`not_a_person`）。解除できるのは
  運用担当者と、アイテムが回ってきた後のそのアイテムの承認者です。`workitems.update` ではフラグを
  変更できません。
- 解除はアイテムの `flagClearances`（`flag`、`by`、`at`、`reason`）に残り、エビデンスと履歴
  （`flag.clear`）に書かれ、監査ログ（`workitem.flag.clear`。拒否は `denied`）に記録されます。最後の
  フラグを解除すると `flags` と `flagReason` はなくなります。
- 拒否コード：`not_a_person`、`invalid_flag`、`reason_required`、`terminal`、`flag_not_set`、
  `not_authorised`。

## 承認ルート（稟議）

プロジェクトのポリシーでは **ルート**（キューごとの、順序のある承認段階の並び）を定義できます。
種別や条件で対象を絞ることもできます。`queues`・`types`・`when` が一致した最初のルートが、確認に
回した時点でアイテムに確定します。審査中のアイテムは、後からポリシーを変えても動きません。

```yaml
routes:
  - id: fin-ringi
    name: { ja: 支出稟議, en: Spending approval }
    queues: [fin-ringi]
    stages:
      - id: manager
        name: { ja: 所属長承認, en: Manager approval }
        approvers: { roles: [approver], departmentField: department }
        minApprovals: 1 # 既定は 1
        dueHours: 48 # 段階の期限。過ぎると期限超過の印が付く
        onReturn: requester # requester（既定）| previous
        delegation: true # 既定は false
        escalation: { afterHours: 72, to: { roles: [director] } }
      - id: finance
        when: [{ field: amount, gte: 100000 }] # すべての条件を満たすときだけ含める
        approvers: { roles: [finance] }
        onReturn: previous
      - id: director
        when: [{ field: amount, gte: 1000000 }]
        approvers: { principals: [device:abc123def456] }
```

- **承認者**：`roles`（`access` で人に割り当てる役割）、名前で指定する `principals`、またはその両方。
  `departmentField` を指定すると、その申請項目に書かれた部署に所属する人だけが承認者になります。
  項目がないアイテムは、エスカレーションされるまでその段階の役割による承認者がいません。
- **条件**（ルートまたは段階の `when`）：`{field, gte|gt|lte|lt|eq|ne|in|present}`。すべてを
  満たす必要があります。外れた段階は理由付きで `route.skipped` に残ります（例
  `amount gte 100000 not met (value: 80000)`）。金額のしきい値は会社ごとの設定です。自社の
  決裁権限規程に合わせて設定してください。
- **進行**：`decide` は `route.current` の段階に対して働きます。段階で `minApprovals` 人の承認が
  そろうと次の段階に進み、最後の段階が承認されて初めてアイテムが `approved` になります。1人が
  承認できるのは1アイテムにつき1段階までで、申請者本人はどの段階も承認できません。
- **差戻し**：`onReturn: previous` は前の段階に戻します（`awaiting_review` のまま、その段階の承認は
  取り消し）。`requester`（または最初の段階）は `sent_back` に戻し、ルートをやり直します。
- **ルートがない場合**（またはポリシーが無効な場合）は、承認権限のある人なら誰でも判断できる
  `single` の1段階になり、`requiredApprovals` 人の承認が必要です。これまでと同じ動作で、
  `secondApproverAbove` もそのまま使えます。ルート導入前に保存されたアイテムは、最初の判断の時点で
  この段階が付きます。段階承認ルートでは `requiredApprovals` は各段階の `minApprovals` の合計です。

### 代理承認とエスカレーション

`workitems.delegate {projectId, id, to, reason, expiresAt}` で、現在の段階の承認者は（段階が
`delegation: true` のとき）その判断を他の人に委任できます。理由（5文字以上）と、30日以内の
有効期限が必要です。代理人は承認者に代わって承認・差戻しを行い（`approvals[].onBehalfOf`、
`via: "delegation"`）、期限が切れた委任は無効です。代理人がさらに委任することはできず、申請者を
代理人にすることもできません。委任はそれぞれ独立した遷移として、エビデンスと監査ログ
（`workitem.delegate`）に記録されます。拒否コード：`not_a_person`、`not_awaiting_review`、
`delegation_not_allowed`、`not_an_approver`、`already_approved`、`invalid_delegate`、
`reason_required`、`invalid_expiry`。

段階の期限は、アイテムの取得・一覧・集計のたびと、ゲートウェイの定期処理（5分ごと）で確定的に
確認されます。`dueHours` を過ぎると段階に `overdueAt` が付き（`stage.overdue`）、
`escalation.afterHours` を過ぎると `escalatedAt` が付いて（`stage.escalate`）、エスカレーション先
もその段階を判断できるようになります（`via: "escalation"`）。それぞれ一度だけ、`system` として
エビデンス付きで記録されます。

## 申請者と閲覧権限

識別子は、ゲートウェイがその接続に使っているものと同じです。ペアリングの資格情報は
`pair:<fingerprint>`、ペアリング済み端末は `device:<id>`、端末のないゲートウェイトークンは
`owner` です。作成時に `requestedBy` として、承認ごとに `by` として記録されます。ポリシーの
`access` で、識別子に役割と部署を割り当てます。

```yaml
access:
  fallback: none # none（既定）| any_approver：メンバー登録までは承認権限のある人なら誰でも可
  members:
    - { principal: device:abc123def456, name: 営業部長, roles: [approver], departments: [sales] }
    - { principal: device:0123456789ab, name: 経理課長, roles: [finance] }
  groups: {} # ディレクトリのグループ（Entra ID など）用。将来の連携フック経由
```

メンバーには `email`（業務用のメールアドレス）も設定できます。オートパイロットはそのメンバーの[朝のブリーフ](/ja/autopilot#朝のブリーフ)をこの宛先の下書きにします。権限は何も与えません。

役割：`requester`（全員）、`approver`（部署付き）、`finance`、`operator`、`admin`、および
`director` などの独自の役割。ゲートウェイの `operator.admin` スコープ、またはプロジェクトでの
`operator` / `admin` の役割を持つ人は **運用担当者** として扱われます。

- 申請者が読み取り・変更（update、assignAgent）できるのは自分のアイテムだけです。運用担当者は
  すべて扱えます。それ以外は `not_authorised` になります。
- 承認者は、現在の段階を判断できるアイテム（代理・エスカレーションを含む）と、自分が関わった
  アイテムを読めます。
- `workitems.list` は呼び出し元が読めるアイテムだけを返します。`mine: true` は自分の申請だけ
  （運用担当者も同じ）、`awaitingMe: true` は今自分が承認できるアイテム、`stage` は現在の段階 id
  で絞り込みます。一覧の各行には `currentStage`
  `{id, name, index, count, dueAt, overdue, escalated, approvals, minApprovals}` が付きます。
- `workitems.config` は画面用に `viewer` `{principal, privileged, roles, departments, listed}`
  を返します。メンバー一覧は運用担当者にだけ返します。
- 運用担当者であっても、承認者でない段階を判断することはできません。

`setPrincipalGroupResolver()`（src/workitems/access.ts）は将来のディレクトリ連携用のフックです。
識別子のグループ id を返すと、`access.groups` がそれを役割に対応付けます。

## 書類プレビュー・下書きの差分・集計

`workitems.document {projectId, id, ref, maxChars?}` は、`draft`（固定した下書き）、
`draft@<版>`（同じ成果物の別の版）、またはアイテムの元の書類の `ref` をプレビューします。返すのは
これらの参照だけで、添付とファイルの参照は今もプロジェクトの中にあるかを確認し直します（外を指す
シンボリックリンクは `outside_project`）。テキストはテキスト形式の内容からだけ取り出し（バイナリは
`binary: true`、`text: null`）、制御文字を除き、64,000文字で打ち切り（`truncated`）、HTML
エスケープして（`escaped: "html"`）、`untrusted: true` を付けます。書類の文章はデータであり、
指示として扱ってはいけません。応答には `bytes`、`sha256`、記録済みの `recordedSha256` と
`sha256Matches`、成果物の `version`、`provenance`（成果物 id、作成者、エージェント、実行 id、
固定版かどうか）が付きます。拒否コード：`no_draft`、`unknown_ref`、`outside_project`、
`document_not_found`、`not_authorised`。

`workitems.draftDiff {projectId, id, fromVersion, toVersion}` は、固定した下書きの成果物の2つの
版を行単位で比べます。`hunks`（前後3行。`op` は `eq` / `add` / `del`、HTML エスケープ済みの
テキスト、行番号）、`stats`、`identical`、`truncated`（入力は5,000行・1行2,000文字、出力は
4,000行まで）と、`from` / `to` の由来（版、SHA-256、サイズ、作成者、エージェント、実行 id、
固定版かどうか）を返します。

`workitems.stats {projectId, queue?, windowDays?, department?}` はゲートウェイ側で、呼び出し元が読めるすべての
アイテムについて計算します（運用担当者はすべて：`scope: "all"`、それ以外は `scope: "visible"`）。
`byStatus`、`byQueue`、`overdue`（SLA 超過）、`stageOverdue`、`stages`（段階ごとの待ち件数・
期限超過・エスカレーション）、`timeToApprove`（最初に確認に回してから承認までの時間の中央値と
90パーセンタイル。`windowDays` 日以内の承認が対象、既定30日）を返します。`department` を指定すると、
読めるアイテムのうちキューがその部門に対応するものだけを数えます（「部門」を参照）。

## ポリシールール（workqueue.yaml）

最初に見つかったファイルを使います：`<プロジェクトフォルダ>/context/workqueue.(yaml|yml|json)`
（お客様自身のもの）、`<KOLO_HOME>/projects/<id>/workqueue.(yaml|yml|json)`（管理者）、テンプレートの
`templates/projects/packs/<templateId>/workqueue.yaml`。読めない・不正なファイルは安全側に倒れ、
ブロッキングの `policy.invalid` チェックが1件出ます。各チェックにはポリシーの SHA-256 が残ります。

```yaml
version: 1
timezone: Asia/Tokyo
separationOfDuties: true
queues:
  - id: fin-expense
    department: finance # 任意。「部門」を参照
    name: { ja: 経費精算, en: Expense claims }
    types: [expense]
    slaHours: 72
rules:
  - id: fin.expense.required
    kind: required
    fields: [employeeId, amount, expenseDate, category, purpose]
  - id: fin.expense.amount
    kind: threshold # 別名: amount
    field: amount
    warnAbove: 30000
    secondApproverAbove: 50000 # → 二名承認
    max: 300000 # 超えるとルールの severity
  - id: fin.expense.date
    kind: date
    field: expenseDate
    maxLeadDays: 0 # ほかに notInPast, minLeadDays, before: <別の項目>
  - id: fin.receipt
    kind: attachment
    min: 1
  - id: fin.phrases
    kind: forbiddenPhrases
    target: both # draft | fields | both
    phrases: [支払済み, has been paid]
```

各ルールには `severity: warn`（既定は `fail`）、`blocking: false`、`types`、`queues`、
`label: {ja, en}` を指定できます。結果には根拠が付きます：不足項目、値と超えたしきい値、
何日先か とタイムゾーン、一致した語句と前後の抜粋、添付の数。

## 部門

Business のコンソールは、キューを部門ごとのワークスペースにまとめて表示します。各キューには任意で
`department` を指定できます。値は次の固定の一覧（この順）のいずれかです：

`secretariat`, `finance`, `admin`, `hr`, `planning`, `it`, `procurement`, `sales`, `marketing`,
`service`, `operations`, `legal`, `product`, `facilities`, `quality`。

- `department` のないキューは「未割り当て」です。一覧にない値はキューと値を示すポリシーエラーに
  なり、ほかの不正なポリシーと同じく安全側に倒れます（黙って無視されることはありません）。
- `workitems.config` は割り当て済みのキューに `department` を、また上の一覧を `departments` として
  返します。一覧は id だけで、日本語・英語の表示名は UI 側が持ちます。
- `workitems.list` と `workitems.stats` は任意の `department` を取ります：部門 id か、キューに部門が
  ない（ポリシーにもう定義のないキューを含む）アイテムを表す `unmapped`。それ以外の値は
  パラメータ不正のエラーです。絞り込みはゲートウェイ側で、閲覧権限と申請者の絞り込みをすべて
  終えたあとに行うので、`total`・`counts`・集計は呼び出し元が読める絞り込み後の件数と一致します。
- **部門は表示のための区分で、権限の境界ではありません。** アクセスを与えることも制限することも
  ありません。だれがアイテムを読めるか・判断できるかは、申請者、承認ルート、`access` だけで
  決まります（「申請者と閲覧権限」を参照）。`access` のメンバーの `departments` はルートが使う
  別の設定です。

## テンプレート

| テンプレート                            | キュー                                    | ルール例                                                                                                                                           |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business-general-affairs` 総務         | `ga-requests`, `ga-facilities`            | 必須項目、費用（10万円超は二名承認）、リードタイム、承認前に「手配済み」と書かない                                                                 |
| `business-hr-leave-overtime` 人事       | `hr-leave`, `hr-overtime`                 | 休暇の日付、月末残業見込み（36時間で注意、45時間で二名承認、80時間で不可）、1日の時間、職務分離                                                    |
| `business-finance-expense-invoice` 経理 | `fin-expense`, `fin-invoice`, `fin-ringi` | 領収書の添付、金額しきい値、適格請求書の記載事項、承認前に「支払済み」と書かない。稟議ルートの例：所属長 → 経理（10万円以上）→ 役員（100万円以上） |
| `business-procurement` 購買             | `proc-requests`                           | 必須項目、金額（30万円超は二名承認、500万円超は稟議）、相見積2社（3社見積の規則をコメントで同梱）、納期                                            |

同梱テンプレートのキューは部門に割り当て済みです：総務 → `admin`、経理（`fin-ringi` を含む）→
`finance`、人事 → `hr`、購買 → `procurement`。

経理テンプレートのルートの金額は、会社ごとの設定の一例です。`access` は最初
`fallback: any_approver` になっているので、メンバーを登録する前でも例として動きます。メンバーを
登録したら `fallback: none` にして、登録した人だけが判断できるようにしてください。

人事テンプレートは残業コーディネーターのワークフローと同じ数値と状態ラベル（実績・月末見込み・
上限、実績で超過 / 月末見込みに基づくリスク）を使い、管理者の承認前に社員へ何も送らないという
ルールも引き継いでいます。

## エビデンスと監査

すべての状態遷移（create, update, submit, assign_agent, draft, draft_failed, decide.approve,
decide.send_back, decide.cancel, delegate, stage.overdue, stage.escalate, done）ごとに、標準のエビデンス形式（`events.jsonl` のハッシュ
チェーンと Ed25519 署名付き `manifest.json`）で封印したバンドルを1つ書きます。
`kolo evidence verify <バンドルのフォルダ>` や `verifyEvidenceBundle()` でジョブのバンドルと同じ
ように検証できます。各バンドルの `job.start` は前のバンドルとそのルートを指すので、
`workitems.evidence` は改ざんや欠落を示せます。バンドルはアイテムと一緒に保存され、ジョブの
エビデンス保持期間では削除されません。各遷移は監査ログ（`workitem.<action>`、スコープ = プロジェクト
id）にもエビデンスの名前付きで記録され、拒否された決裁は `denied` として残ります。

## 制限事項

- エージェントのシェルからのコマンドライン呼び出し（`kolo gateway call …`）は `cli` として識別され、
  ターミナルの前の人と区別できません。決裁者にはペアリング済み端末の資格情報と `operator.approvals`
  を与え、エージェントの資格情報には与えないでください。
- ポリシーの変更は次のチェックから有効です。過去のチェックは実行時のダイジェストを保持します。
- 一覧と `workitems.stats` はプロジェクトのアイテムをすべて読みます（1プロジェクト数千件までは
  問題ありません）。
- 識別子は接続単位です。1つの資格情報を複数の人で共有している場合や、端末のないゲートウェイ
  トークン（`owner`）は区別できません。一人ひとりにペアリング済み端末を用意してください。
  ディレクトリのグループ（Entra ID）はフックのみで、まだ問い合わせは行いません。
- 委任は期限前に取り消せません（同じ承認者が新しく委任すると、前の委任は置き換わります）。
  エスカレーションは判断できる人を増やすだけで、`workitems.changed` イベント以外の通知は行いません。
- ここでの承認は、署名付きエビデンスを伴うワークフロー上の記録です。特定の法令や契約が求める
  署名・記録の要件を満たすかどうかは、各社でご判断ください。
- 書類プレビューはテキスト形式のファイルからだけ文章を取り出します。PDF や Office のファイルは
  メタデータとハッシュのみを表示します。
- 下書きはエージェントの最終返答（Markdown）です。ツールが作ったファイルは自動では固定されません。

## 経費申請の作成

経費に対応したキューがプロジェクトに設定されている場合、**経費申請を作成**を選べます。
申請件名、社員番号、プロジェクトの通貨での金額、経費発生日、費目、目的を入力してください。
既存のプロジェクトファイルは相対パスを1行に1件指定できます。アップロードや領収書の検証ではありません。
**申請を保存**すると新規項目を作成し、ポリシーチェックを表示します。承認依頼、エージェント割り当て、支払いは行いません。
保存結果が不明な場合はキューを更新して確認し、**キューを確認しました**を選んでから別の申請を作成してください。自動再試行は行いません。
保存済みの経費申請はリビジョンを確認して編集・承認依頼できます。ほかの申請種別の入力フォームは今後対応します。

## 段階承認ルートの表示

段階承認では、各段階の状態、承認数と必要数、期限を順番に表示します。期限超過とエスカレーションの
表示はブラウザーの時計ではなく、ゲートウェイが返した記録に基づきます。省略された段階には理由を
表示します。この表示は承認権限を判定するものではなく、権限はゲートウェイが確認します。
