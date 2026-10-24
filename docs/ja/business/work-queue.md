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

2026年10月23日時点：ゲートウェイのメソッド、ポリシーエンジン、エビデンス、テンプレート、型付き
クライアントは実装済みです。デスクトップ画面（左にキュー、中央にアイテムとエージェントの下書きと
元の書類、右にポリシーチェック、承認 / 差戻しボタン）はこの仕様に沿って開発中です。

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
| `approvals`         | 承認した人・日時・コメント                                                                           |
| `override`          | ブロッキングチェック不合格のまま承認した人、理由、対象チェック                                       |
| `history`           | すべての変更：誰が（`person` / `agent` / `system`）、何を、いつ、どのエビデンスで                    |
| `runIds`            | 下書きしたエージェント実行（`jobs.*` とジョブのエビデンスでも確認可能）                              |
| `revision`          | 書き込みごとに増える番号。`expectedRevision` に渡すと他人の変更を上書きしません                      |

### ライフサイクル

- `new` → `workitems.assignAgent` → `drafting` → 下書き完了 → `awaiting_review`
- `awaiting_review` → 承認（必要人数がそろう）→ `approved` → `workitems.update` で `done`
- `awaiting_review` → 差戻し（コメント必須）→ `sent_back` → 再び `assignAgent` で `drafting`
- 人が作成したアイテムは `workitems.update` の `status: "awaiting_review"` で確認に回せます
- 終了していないアイテムはすべて、取消（コメント必須）で `cancelled`
- 実行が失敗・空の返答なら元の状態（`new` / `sent_back`）に戻り、`lastError` に理由が残ります

既存の成果物を下書きとして付けることもできます（`workitems.update` の `patch.draft`）。
申請内容や下書きが変わると、それまでの承認は無効になり、チェックが再実行されます。

## ゲートウェイのメソッド

すべて `projectId` を取ります。別プロジェクトのアイテム id は `work item not found` になります。

| メソッド                | スコープ（ペアリング / operator） | 内容                                                                                                                    |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workitems.list`        | observe / `operator.read`         | 絞り込み（キュー・状態・種別・優先度・担当・期限超過・`q`）、カーソルでページング（1ページ最大200件）、件数と状態別件数 |
| `workitems.get`         | observe / `operator.read`         | 履歴を含むアイテム全体                                                                                                  |
| `workitems.config`      | observe / `operator.read`         | キュー、ルール、ポリシーの出所とダイジェスト（キュー一覧とチェック欄用）                                                |
| `workitems.evidence`    | observe / `operator.read`         | アイテムのエビデンスをすべて検証し、つながりも確認                                                                      |
| `workitems.create`      | attach / `operator.write`         | 新規作成。申請項目だけのチェックをすぐ実行                                                                              |
| `workitems.update`      | attach / `operator.write`         | 決裁以外の項目。`status` は `awaiting_review`（確認に回す）と `done`（承認後）のみ                                      |
| `workitems.assignAgent` | attach / `operator.write`         | 下書きのエージェント実行を開始。`runId` をすぐ返す                                                                      |
| `workitems.decide`      | attach / `operator.approvals`     | `approve` / `send_back` / `cancel`。人のみ                                                                              |

イベント `workitems.changed` `{projectId, id, queue, action, status, revision, updatedAt}`。
件名や申請内容は含みません。`workitems.get` で取り直してください。読み取り権限のある接続に送られます。

型付きクライアント（`@kodasoken/kurahi-client`）はメソッドの型と、`WorkItem`、`WorkItemSummary`、
`WorkItemCheck`、`WorkItemHistoryEntry`、`WorkItemDecision`、`WorkQueueDef`、`WorkQueueRule`、
`WorkItemEvidenceBundle`、`WORK_ITEM_DECISION_REFUSALS` を公開しています。

### エージェントによる下書き

`workitems.assignAgent` は、エージェントがプロジェクトで許可されているか確認し（キューの
`defaultAgent`、なければ `main`）、アイテムを `drafting` にして、アイテム専用のプロジェクト
セッション `agent:<agent>:proj-<projectId>-wi<item>` で実行します。フォルダの範囲、モード
（参照 / 計画 / 実行）、ツールガードはプロジェクトのチャットとまったく同じです。プロンプトには
申請項目、元の書類の参照、該当するルール、差戻しコメントが入ります。最終返答は成果物
（確認中）として保存されて下書きに固定され、チェックが自動で実行されます。30分以上 `drafting`
のまま（再起動など）のアイテムは、もう一度割り当てられます。

### 決裁は人のみ

次の場合 `workitems.decide` は拒否され、拒否も監査ログに残ります。

- 音声由来の印がある（共通の音声承認ガード。スキーマ検証より前）
- エージェントのツール接続（`backend` モード / `gateway-client`）、ノード、接続のない呼び出し
  （`code: not_a_person`）
- 資格情報に `operator.approvals` がない

承認にはさらに次が必要です：状態が `awaiting_review`、固定した下書きが成果物の最新版
（`draft_changed`）、同じ人の二重承認でない（`already_approved`）、`separationOfDuties: true`
のとき作成者本人でない（どちらも端末・ペアリングの識別子の場合。`separation_of_duties`）、
**ブロッキング** チェックがすべて合格（その場で再評価）。不合格のまま承認するには
`override.reason`（10文字以上）が必要で、アイテム・エビデンス・監査ログ（`workitem.override`）
に記録されます。二名承認が必要なとき、1人目の承認では `awaiting_review` のままです。最後の
承認で下書きの成果物は承認済みに、差戻しで下書きに戻ります。差戻しと取消にはコメントが必要です。

拒否時の `error.details.code`：`not_a_person`、`terminal`、`comment_required`、
`not_awaiting_review`、`draft_changed`、`already_approved`、`separation_of_duties`、
`checks_failed`（`failing` 付き）。

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
  - { id: fin-expense, name: { ja: 経費精算, en: Expense claims }, types: [expense], slaHours: 72 }
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

## テンプレート

| テンプレート                            | キュー                         | ルール例                                                                                        |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `business-general-affairs` 総務         | `ga-requests`, `ga-facilities` | 必須項目、費用（10万円超は二名承認）、リードタイム、承認前に「手配済み」と書かない              |
| `business-hr-leave-overtime` 人事       | `hr-leave`, `hr-overtime`      | 休暇の日付、月末残業見込み（36時間で注意、45時間で二名承認、80時間で不可）、1日の時間、職務分離 |
| `business-finance-expense-invoice` 経理 | `fin-expense`, `fin-invoice`   | 領収書の添付、金額しきい値、適格請求書の記載事項、承認前に「支払済み」と書かない                |
| `business-procurement` 購買             | `proc-requests`                | 必須項目、金額（30万円超は二名承認、500万円超は稟議）、相見積2社、納期                          |

人事テンプレートは残業コーディネーターのワークフローと同じ数値と状態ラベル（実績・月末見込み・
上限、実績で超過 / 月末見込みに基づくリスク）を使い、管理者の承認前に社員へ何も送らないという
ルールも引き継いでいます。

## エビデンスと監査

すべての状態遷移（create, update, submit, assign_agent, draft, draft_failed, decide.approve,
decide.send_back, decide.cancel, done）ごとに、標準のエビデンス形式（`events.jsonl` のハッシュ
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
- 一覧はプロジェクトのアイテムをすべて読みます（1プロジェクト数千件までは問題ありません）。
- 下書きはエージェントの最終返答（Markdown）です。ツールが作ったファイルは自動では固定されません。
