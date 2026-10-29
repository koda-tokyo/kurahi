---
summary: "データガバナンス：データ区分ごとの保持期間と決定的なスイーパー、訴訟ホールド、署名付きeDiscoveryエクスポート、外部送信ツールに対する個人情報（APPI）・マイナンバーのガード、本人からの請求への対応"
read_when:
  - Kurahiのデータ保持期間について法務・監査・コンプライアンスのレビューに回答する
  - 訴訟や監査のために訴訟ホールドをかける、または記録を提出する
  - 個人情報保護法に基づく本人からの請求に対応する
  - プロジェクトの個人情報ガードを設定する
title: "データガバナンス"
---

# データガバナンス

English: [Data governance](/security/data-governance)

業務記録を保管するシステムに対して、法務部門と監査部門は4つのことを問います。記録の種類ごとに
どれだけ保管するのか、案件のために削除を止められるのか、案件に関するすべてを第三者が検証できる形で
提出できるのか、そして個人情報の外部流出を何が防ぐのか。Kurahiはそれぞれに、モデルを使わずに動き、
署名付きの証跡を残す仕組みで答えます。

## データ区分

| 区分              | 内容                                                                       | 匿名化 | 経過日数の起点 |
| ----------------- | -------------------------------------------------------------------------- | ------ | -------------- |
| `transcripts`     | 会話記録（`KOLO_HOME/agents/<id>/sessions/`）                              | 可     | 最終書き込み   |
| `workitems`       | 履歴を含む案件（完了・取消の案件のみ）                                     | 可     | 最終更新       |
| `evidence`        | ジョブの証跡バンドルと案件の遷移バンドル（完了・取消の案件のみ）           | 不可   | ジョブ終了     |
| `audit`           | ハッシュチェーンの監査ログ（組織全体、月単位）                             | 不可   | 月末           |
| `attachments`     | アップロードと受け入れたメール添付（`attachments/`、`inbox-attachments/`） | 不可   | 最終書き込み   |
| `outputs`         | 生成物（アーティファクト）                                                 | 不可   | 最新バージョン |
| `memory`          | 判断済みのメモリ隔離レコード                                               | 可     | 判断時刻       |
| `connectorCaches` | `KOLO_HOME/connectors/<id>/cache/` 配下のファイル                          | 不可   | 最終書き込み   |

標準のコネクターは都度取得型で、現在キャッシュを持ちません。キャッシュを持つコネクターが追加された
場合に最初のファイルから管理できるよう、区分を用意しています。

## 保持期間

区分ごとに規則があります。`keepDays`（日数、または無期限の `null`）と `mode`（`delete` 削除 /
`anonymize` 匿名化）です。組織の既定は設定ファイルに置き、プロジェクトは `audit` 以外のすべての区分を
上書きできます（監査ログはインストール全体で1本のチェーンです）。

```json5
{
  governance: {
    retention: {
      transcripts: { keepDays: 365, mode: "anonymize" },
      workitems: { keepDays: 2555 }, // 7年
      attachments: { keepDays: 730 },
      evidence: { keepDays: 2555 },
      audit: { keepDays: 2555 },
    },
    minimumRetentionDays: { audit: 2555, evidence: 2555 },
    sweep: { enabled: true, hourUtc: 18 }, // 日本時間 3:00
  },
}
```

- すべての区分の既定は**無期限**です。規則を定めるまで何も削除されません。
- **証跡と監査の下限。** `minimumRetentionDays`（既定は各365日）は下限です。これを下回るプロジェクトの
  上書きは拒否され（`retention_below_minimum`）、設定ファイルの値は下限まで引き上げられます。
  `governance` を設定している場合は `kurahi evidence prune` もこの下限に従います。
- **匿名化**は構造を残して内容を置き換えます。案件はID、状態、日時、承認ルート、承認数、証跡の参照を
  残し、件名、要約、フォームの値、コメント、元資料の名前を置き換え、人はインストールごとの鍵による
  一定の仮名（`anon:<16進12桁>`）になります。会話記録はすべての行、ロール、ID、時刻を残し、本文と
  ツールのペイロードを `[anonymized]` にします。構造を残せない区分は常に削除です。
- **プロジェクトごと**：`governance.policy.set`（人のみ）がプロジェクトの上書きを置き換え、
  `governance.policy.get` が有効な方針を返します。

### スイーパー

スイーパーはゲートウェイの保守タイマーから、UTCで1日1回 `governance.sweep.hourUtc` 以降に動きます。
`governance.retention.run`（人のみ、`dryRun` の既定は `true`）や、ゲートウェイのホストで
`kurahi governance sweep [--dry-run]` を実行して随時動かすこともできます。動作は決定的で、モデルも
ネットワークも使わず、ディレクトリを整列した順に処理します。各レコードに、そのプロジェクトの規則を
適用し、規則より新しいもの、対象外のもの（未完了の案件、実行中のジョブ）、有効な訴訟ホールドの
対象になっているものは飛ばします。

何かを変更した実行は必ず**削除マニフェスト**を書きます。`KOLO_HOME/evidence/gov-retention-<時刻>/`
にある署名付きの証跡バンドルで、区分ごとにモード、件数（削除・匿名化・ホールド・失敗）、対象レコードの
期間、各レコードIDのSHA-256を記録します。名前、件名、内容は記録しません。他のバンドルと同じく
`kurahi evidence verify` で検証できます。削除マニフェストは期限切れになりません。実行は
`governance.retention.sweep` として監査ログにも記録されます。

## 証跡のトゥームストーン

残りの証跡が検証できなくなるような形で証跡を削除してはなりません。Kurahiは証跡バンドルを削除する
とき、必ず**トゥームストーン**を残します。

- ジョブの証跡：ジョブのディレクトリを削除し、`KOLO_HOME/evidence/_tombstones/<jobId>.json` を書く。
- 案件の証跡：バンドルのディレクトリは名前（`0003-decide`）を保ち、中身を `tombstone.json` に置き換える。

トゥームストーンには、バンドルの**署名済みの元のマニフェスト**（ジョブID、状態、時刻、イベント数、
チェーンのルート、各ファイルのSHA-256、記録時のEd25519署名）、マニフェストファイルのSHA-256、
バンドルの最初のイベントが示していた `prevBundle` / `prevRoot`、削除の時刻と理由（`retention`、
`dsr`、`prune`）、削除マニフェストのIDが残ります。トゥームストーン自体もインストールの証跡鍵で
署名されます。

これによりチェーンは検証可能なまま残ります。

1. 元のマニフェストの署名は削除したイベントではなくマニフェストの項目に対するものなので、そのまま
   検証できます。バンドルが存在し、その状態で終わり、そのルートを持っていたことが証明できます。
2. 案件のバンドルはチェーンです。N番目のバンドルの最初のイベントがN-1番目のルートを示します。
   検証（`workitems.evidence`、エクスポートのレポート）はトゥームストーンからルートを、記録された
   `prevRoot` からつながりを読むので、欠けた箇所をまたいで検証できます。削除の後の遷移は
   トゥームストーンのルートにつながります。
3. 改ざんしたトゥームストーンは自身の署名で失敗し、別のルートを主張するトゥームストーンは元の
   マニフェストの検証で失敗します。再計算できなくなるのはイベントそのものだけで、それはまさに
   保持期間によって削除したものです。

## 監査ログ

監査ログは最初の記録からの1本のハッシュチェーンです。保持期間による削除は**最も古い側から月単位で
のみ行い、最新の月は削除しません**。削除の前に署名付きのアンカー `KOLO_HOME/audit/ANCHOR.json`
（削除した最後の行のseqとSHA-256、削除した月の一覧）を書きます。以後 `kurahi audit verify` は
アンカーから検証を始め、残った最初の記録が `prev` としてアンカーのハッシュを示し、seqが続いて
いなければなりません。削除した日のヘッドはアンカーが保証します。アンカーを更新せずに月を削除すると
破断として報告され、偽造したアンカーは署名で失敗します。訴訟ホールドの対象になっている最初の月で
削除は止まります。

## 訴訟ホールド

訴訟ホールドは、人が解除するまで対象データのあらゆる削除を止めます。

| メソッド                   | パラメーター                                   |
| -------------------------- | ---------------------------------------------- |
| `governance.holds.create`  | `matterId`、`reason`、`scope`                  |
| `governance.holds.list`    | `status?`：`active`（既定）、`released`、`all` |
| `governance.holds.release` | `id`、`reason`                                 |

`scope` には `projectIds`、`workItemIds`、`persons`（レコードに現れる人：依頼者、承認者、操作者、
送信者）、`custodians`（レコードを所有・作成した人）、`from` / `to` の期間を指定できます。指定した
条件はすべて満たす必要があり、各条件の中ではいずれかの値に一致すれば対象です。ホールドは**安全側に
倒れます**。対象外であることを示せないレコード（たとえば人を索引していない会話記録に対する
`persons` のホールド）は保持されます。案件のホールドは、その案件の添付と下書きも保持します。

ホールドが有効な間は、スイーパー、本人請求による削除、`sessions.delete`（`legal_hold` で拒否）、
`kurahi evidence prune` が対象データを飛ばします。ホールドの作成と解除は監査ログに記録され
（`governance.holds.create` / `governance.holds.release`）、証跡バンドル `gov-<holdId>-create` /
`-release` として封印されます。

## eDiscoveryエクスポート

`governance.export.create`（人のみ、理由必須）はバックグラウンドのジョブを開始し、
`status: "running"` で直ちに戻ります。`governance.export.get` / `governance.export.list` で状態を
確認し、`done` になったら `GET /api/governance/exports/{id}/download` からダウンロードします。
ダウンロードできるのは、エクスポートを作成した人（またはペアリング資格情報、端末）とオーナーの
資格情報だけで、それ以外には404を返します。作成、完了、ダウンロードはすべて監査ログに記録されます。

パラメーター：`reason`、`matterId?`、`scope`（ホールドと同じ）、`classes?`（既定は `workitems`、
`evidence`、`transcripts`、`attachments`、`outputs`、`memory`、`audit` のすべて）、`attachmentFiles?`
（既定はfalseでメタデータのみ）、`redact?`（既定は `governance.personalData.redactExports`）。

zipはそれ自体で検証できます。

| ファイル                     | 内容                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `manifest.json`              | エクスポートID、作成者、時刻、理由、範囲、件数、他の全ファイルのSHA-256とサイズ、署名 |
| `verification.json`          | 証跡の検証レポート：全バンドル、トゥームストーンを含む案件ごとのチェーン、監査ログ    |
| `workitems/<project>/<id>/…` | 履歴を含む `item.json` と案件の証跡バンドル                                           |
| `evidence/<jobId>/…`         | ジョブの証跡バンドル（そのまま）。範囲内の削除済みは `evidence/_tombstones/`          |
| `transcripts/<agent>/<file>` | 会話記録                                                                              |
| `attachments/index.json`     | 添付のメタデータ（SHA-256、サイズ、時刻）。`attachmentFiles` で `attachments/files/`  |
| `outputs/<artifact>/…`       | 生成物                                                                                |
| `memory/<agent>/<id>.json`   | メモリ隔離レコード                                                                    |
| `audit/rows.jsonl`           | 範囲内の監査ログの行（そのまま。各行は自身のハッシュを再計算できる）                  |

どこでも `kurahi governance verify-export <file.zip>` で検証できます（署名、全ファイルのSHA-256、
欠けたファイルや余分なファイルがないこと）。`redact` を指定すると、案件、会話記録、生成物、監査ログの
行の識別子を置き換えます（マニフェストに記録されます）。証跡バンドルは記録時にマスク済みで、1バイト
でも変えると署名が失敗するため、常にそのまま含めます。

## 個人情報（APPI）とマイナンバー

検出器は日本の個人識別子を、全角の数字やダッシュも含めて認識します。

| 種類               | 規則                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `my_number`        | チェックデジットが正しい12桁（個人番号）。チェックデジットが誤っているものは報告しない |
| `corporate_number` | 先頭のチェックデジットが正しい13桁（法人番号：公開情報で、個人情報ではない）           |
| `residence_card`   | 在留カード番号：英字2文字、数字8桁、英字2文字                                          |
| `passport`         | 旅券番号：英字2文字と数字7桁                                                           |
| `bank_account`     | 口座、普通、当座、支店、店番の後の7桁（3桁の支店番号を伴ってもよい）                   |
| `phone`            | 日本の電話番号：0X…、携帯の0X0、+81                                                    |
| `email`            | メールアドレス                                                                         |

13桁の法人番号を個人番号と誤認することはなく、より長い数字列、16進のダイジェスト、IDの中の12桁も
個人番号とはみなしません。

**外部送信のガード。** Kurahiの外へ送信・書き込みするツール（`m365_mail_send`、
`m365_mail_create_draft`、`m365_mail_attach_to_draft`、`m365_files_upload`、
`m365_calendar_create_event`、`gmail_send`、`lineworks_message_send`、`box_file_upload`、
`office_*_create`、`kintone_record_create`、`kintone_record_comment_add`）が動く前に、引数の
すべての文字列を検査します。他のすべてのポリシーと承認のガードを通った後、最終的な引数に対して、
エージェントのツール呼び出しにも、ゲートウェイから呼ぶツール（オートパイロット、`/tools/invoke`）にも
適用します。

- `myNumber`（既定 `block`）：正しい個人番号があると、規則 `personal-data:my_number` で呼び出しを拒否する。
- `otherIdentifiers`（既定 `warn`）：呼び出しは続行し、検出を監査ログに記録する。
- どちらも `block`、`warn`、`off` を、組織全体（`governance.personalData`）またはプロジェクトごと
  （`governance.policy.set`）に設定できる。

拒否（`governance.personalData.block`）と警告（`governance.personalData.flag`）はすべて、ツール、
引数のパス、位置、鍵付きダイジェスト（`KOLO_HOME/governance/pd.key` のインストールごとの鍵による
HMAC-SHA256）とともに監査ログに記録され、値そのものは記録しません。単純なハッシュでは不十分です。
12桁の番号は、すべての候補を試せばSHA-256から復元できてしまうためです。

**ログ。** 正しい個人番号は、監査ログの行と封印した証跡イベントで常に `[マイナンバー]` にマスク
されます。`governance.personalData.redactLogs: true` にすると上記のすべての種類をマスクします。

## 本人からの請求

`governance.dsr.find`（人のみ、理由必須）は、1つの識別子（`kind`：`email`、`phone`、`principal`、
`text`。`projectIds` で絞り込み可）をすべての区分から探し、レポートを返します。識別子を含む各レコード、
出現回数、扱い（`deletable` 削除可、`held` ホールド中（ホールドID付き）、`retained` 保持：署名済みで
保持期間中の証跡、未完了の案件）です。識別子を含む監査ログの行数も数えます。レポートには識別子では
なく、その鍵付きダイジェストを保存します。

`governance.dsr.execute`（人のみ）は、レポートID、識別子（ダイジェストと一致すること）、`mode`
（`anonymize`：各出現を一定の仮名に置き換える / `delete`：レコードを削除する。完了した案件のみ）、
理由を受け取ります。ホールドは実行時に再確認し、レポートの後にかけたホールドが優先されます。変更は
署名付きの削除マニフェスト（`gov-dsr-<id>`）に記録され、監査ログにも記録されます。

## 削除しないもの

- 削除マニフェスト（`gov-retention-*`、`gov-dsr-*`）とホールドの記録（`gov-hold-*`）。
- 削除した証跡のトゥームストーンと監査ログのアンカー。
- 監査ログの最新の月と、設定した下限より新しい監査ログ。
- 本人請求による証跡と監査ログの行（保持として報告）。
- 有効な訴訟ホールドの対象になっているもの。
- 未完了の案件、実行中のジョブ、レビュー待ちのメモリ書き込み。

## リファレンス

| メソッド                   | スコープ  | 人のみ | 結果                                         |
| -------------------------- | --------- | ------ | -------------------------------------------- |
| `governance.policy.get`    | observe   | いいえ | `{ org, project }`                           |
| `governance.policy.set`    | approvals | SSO    | `{ org, project }`                           |
| `governance.retention.run` | approvals | SSO    | 区分ごとの件数、`manifestId`                 |
| `governance.holds.create`  | approvals | SSO    | `{ hold }`                                   |
| `governance.holds.list`    | approvals | はい   | `{ holds }`                                  |
| `governance.holds.release` | approvals | SSO    | `{ hold }`                                   |
| `governance.export.create` | approvals | SSO    | `{ export }`（`status: "running"`）          |
| `governance.export.get`    | approvals | はい   | `{ export }`（完了後は `downloadPath` 付き） |
| `governance.export.list`   | approvals | はい   | `{ exports }`                                |
| `governance.dsr.find`      | approvals | SSO    | `{ report }`                                 |
| `governance.dsr.execute`   | approvals | SSO    | `{ report }`（`executed` 付き）              |

「approvals」は attach スコープと `operator.approvals` で、音声由来のリクエストは拒否します。「SSO」は
人のみで、エンタープライズIDを設定している場合はSSOによる本人のセッションが必要です（ブレイクグラス
では不十分）。拒否コード（`error.details.code`）：`not_a_person`、`reason_required`、
`matter_required`、`bad_scope`、`hold_not_found`、`hold_released`、`retention_below_minimum`、
`org_only_class`、`anonymize_unsupported`、`unknown_class`、`project_not_found`、`bad_classes`、
`export_not_found`、`report_not_found`、`report_executed`、`identifier_mismatch`、`bad_mode`、
`bad_kind`、`bad_identifier`。`sessions.delete` は `legal_hold` で拒否します。変更時には
`governance.changed`（`kind`、`id`、`at`。内容は含まない）を配信します。

関連：[セキュリティ概要](/ja/security/SECURITY_OVERVIEW)、[エンタープライズ ID](/ja/security/identity)、
[プライバシー](/ja/security/privacy)。
