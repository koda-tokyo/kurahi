---
summary: "Kurahi 全エディション共通のオートパイロット：読み取りツールで収集し、ツールを持たないモデルが判断し、人が設定した自律レベル（L0〜L3）の範囲でのみ実行する。エディションごとの禁止事項、継続承認、署名付き実行記録、実イベントだけに基づく指標"
read_when:
  - プロジェクトのルーティン（autopilot.yaml）を書く
  - ゲートウェイに対してオートパイロット画面を実装する
  - オートパイロットが単独で何をしてよく、何が必ず人に回るかを説明する
title: "オートパイロット"
---

# オートパイロット

English: [Autopilot](/autopilot)

オートパイロットは、チームの定型業務を最初から最後まで引き受けます。受信箱の仕分け、請求書の受付、レガシー資産の夜間解析、文献ウォッチ、基盤のヘルスチェックなどです。Industrial・Business・Scholars・Core のすべてのエディションで、同じエンジンと同じルールで動きます。

**モデルは、送信・支払・削除ができるツールを一切持ちません。** モデルはエンジンが収集した内容を読んで提案するだけです。エンジンが提案を一つずつルーティンの自律レベルと照合し、そのレベルで許される操作だけを実行します。それ以外はすべて案件として人に回ります。

## ループ

ルーティンの実行は、常に次の 6 段階です。

1. **トリガー**：スケジュール（cron 式とタイムゾーン）または間隔（5 分以上）、イベント（新着メール、案件の変更、期限、ファイル。後述の「トリガー」）、あるいはオペレーターによる手動実行。スケジュールのあるルーティンは Kurahi の cron ジョブ（`autopilot:<projectId>:<routineId>`）として登録され、cron ジョブやイベントで起動したときはモデルのターンを使わずエンジンが直接実行します。
2. **収集**（決定的、モデルなし）：`gather` の各ステップは**読み取りツールだけ**を、`POST /tools/invoke` と同じ経路で、ルーティン専用のプロジェクトセッションから呼び出します。読み取りツールとして使えるのは、コネクターやプラグインが読み取り専用と宣言したものだけです（例：`m365_mail_list`、`m365_mail_read`、`m365_mail_attachment_fetch`、`legacy_index`、[学術情報源](/ja/connectors/scholar-sources)の `scholar_*` ツール、`web_search`、エンジン内蔵の `health_*` チェック、およびルーティン自身のプロジェクトで止まっている未完了の部門間連携案件（取消・停止した工程、見つからない子案件、読み取れない連携記録。担当者がいないため朝のブリーフに出ない案件も含む）を報告する `workitems_linked`。案件の保存先を一覧できない場合や読み取れない案件がある場合は、0 件とせず不明としてエスカレーションします。出力は案件 ID だけです。さらに、発注書の下書きを待つ購買案件（未完了、不正の疑いフラグなし、担当者による発注先の選定が記録済みの見積と一致、その選定からの下書きが未作成）を一覧する `workitems_po_ready`。出力は案件 ID だけで、`gate: true` のステップでは対象がなければモデルを呼ばずに実行を終えます。読み取れない案件があるときは終えません）。添付ファイルは保存前に隔離・スキャンします（[添付ファイルの取り込み](/ja/security/attachment-intake)）。その後、挙動ウォッチドッグ（後述）が操作の実行前に実行を計測します。`gather` に書き込みツールを書いたファイルは無効です。実行時にも、応答したツールが宣言したプラグインのものかを確認します。
3. **判断**（ツールなしのモデル）：CLI バックエンド（読み取り専用サンドボックスの codex-cli、またはツールを一切持たない claude-cli）を、空の一時フォルダーで、セッションもワークスペースファイルもなしで実行します。収集した内容は `SOURCE` ブロックのデータとして渡し、指示としては扱いません。ルーティンが承認済みの会社情報を宣言している場合は、信頼できる事実として別の `KNOWLEDGE` ブロックで渡します（後述の「承認済みの会社情報」）。それでもバックエンドがツール呼び出しを報告した場合、その出力は破棄されます。
4. **検証**：応答はルーティンの出力スキーマ（`autopilot.plan.v1`）に一致する JSON オブジェクト一つでなければなりません。項目ごとに参照、要約、フラグ、引用元、提案する操作を持ちます。一致しなければ実行は失敗し、何も実行されず、入力は次回に再処理されます。
5. **認可と実行**：提案された操作はすべて `authorizeAction`（後述）を通ります。許可された操作はエンジンが実行し、人が必要な操作は `awaitingPerson`（理由）と保留中の操作一覧を付けた案件になり、拒否された操作は記録だけされます。
6. **記録**：実行ごとに署名付きエビデンスと、件数（items, prepared, acted, escalated, refused, failed, handled, deferred）を含む実行記録を残します。

## 自律レベル

ルーティンごとに一つのレベルを、お客様の管理者がファイルで設定します。操作は分類（prepare・internal-reversible・external・never）を持ち、レベル表は操作名ではなく分類で判断します。このため、エディションやプラグインが操作を追加しても判定ロジックは変わりません。

| レベル | 名称               | オートパイロットが単独で行えること                                                                                         |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| L0     | 観察               | 読む・分類する・報告する（実行記録）。操作は一切なし。L0 のルーティンは操作を列挙できません。                              |
| L1     | 準備               | ＋ `prepare`：案件、返信の下書き、下書きへの添付、文書、アプリ用フォルダーへのアップロード、日程候補（既定）               |
| L2     | 社内で実行         | ＋ `internal-reversible`：取り消し可能な社内操作（ファイリング、回付、担当割当、社内記録の更新）                           |
| L3     | ポリシー内で社外へ | ＋ `external`（例：`mail.send`）。すべての宛先・対象、テンプレート、1 日の上限をカバーする有効な**継続承認**がある場合のみ |
| —      | 自律では行わない   | どのレベルでも必ず人（後述の禁止事項）                                                                                     |

提案は信頼できない内容を読んだモデルから来るため、レベルを上げることも、ルーティンにない操作を加えることも、承認を指定することも、操作が受け付けない引数を渡すこともできません。判定の順序：未知の操作 → 拒否、エディション外 → 拒否、フラグ付き → 拒否、禁止操作 → 人、ルーティンにない → 拒否、不正な引数 → 拒否、L0 → 拒否、1 日の上限到達 → 人、その後にレベル表。

### フラグ

モデルは項目に `suspected_fraud`、`phishing`、`prompt_injection`、`unverified_sender`、`unverified_citation`、`malicious_attachment` を付けられます。[添付ファイルの取り込み](/ja/security/attachment-intake)がメッセージの添付を拒否した場合は、エンジン自身がその項目に `malicious_attachment` を付けます（どの項目にも対応しないメッセージには専用の項目を作ります）。フラグ付きの項目には一切の操作を行わず、エンジンがフラグとともに人に回します。フラグは案件そのもの（`flags`、`flagReason`）に付き、エージェントのメール取り込みと同じ扱いになります。フラグを解除できるのは人だけで（`workitems.clearFlag`、理由が必要）、`suspected_fraud` が付いている間は承認も完了もできません（`fraud_flag_uncleared`）。口座情報の変更（`bank.change`、禁止操作）が提案された項目にも `suspected_fraud` が付きます。ワークキューにないフラグ（`unverified_citation` や情報用のフラグ）は `autopilotFlags` 欄に残ります。[ワークキューのリスクフラグ](/ja/business/work-queue)を参照してください。

### 基本の操作カタログ

| 操作               | 分類     | 実行方法                                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `workitem.intake`  | prepare  | `autopilot:<routineId>` として案件を起票（読んだメールはメール取り込みで）                       |
| `mail.draft`       | prepare  | `m365_mail_create_draft`（下書きのみ。送信は人が Outlook から）                                  |
| `office.create`    | prepare  | 型付きの仕様から Word・PowerPoint・Excel を office プラグインで output/ に作成                   |
| `quote.prepare`    | prepare  | 価格表から見積書（Word・Excel）を office プラグインで作成（[見積管理](/ja/business/quotations)） |
| `mail.attach`      | prepare  | `m365_mail_attach_to_draft`：この項目の文書をこの項目の下書きに添付                              |
| `files.upload`     | prepare  | `m365_files_upload`（サインインしたユーザーの OneDrive アプリ用フォルダーのみ）                  |
| `calendar.propose` | prepare  | 候補日時を載せた案件。カレンダーには何も書き込みません                                           |
| `brief.deliver`    | prepare  | メンバーの朝のブリーフ。本人宛ての Outlook 下書き、または `output/briefs/`                       |
| `mail.send`        | external | `m365_mail_send` または `gmail_send`。継続承認がある場合のみ                                     |

`workitem.intake` は `title`、`type`、`priority`、`note` と、Business では `department` を受け付けます。プロジェクトに `<department>-work` キューがあればそこへ（企業業務テンプレートにはあります）、なければルーティンの `queue` へ起票します。

コネクター自身の書き込みガードはそのまま有効です。送信のたびに人の承認を求めるコネクターは、継続承認を自ら検証できる場合を除き、求め続けます（後述の「L3 の送信」）。

## メール取り込みと冪等性

項目の `ref` が、今回の実行でメールコネクターの読み取りツール（展開ステップの `m365_mail_read`、`gmail_read`）で読んだメッセージである場合、または項目がそのような収集元を一つだけ引用している場合、エンジンは**メール取り込み**（`workitems.intakeEmail` と同じモジュール）で起票します。案件にはメッセージへの参照（コネクター、メッセージ id、差出人アドレス、件名、受信日時。本文は保存しません）、モデルの要約、フラグが残ります。メールかどうかはエンジンが読んだものから決まり、モデルの計画では決まりません。それ以外の項目はワークキューのライフサイクル API で作成します。どちらも実行とルーティンの情報を `source.fields`（`autopilotRoutine`、`autopilotRun`、`autopilotKind`、`autopilotRef` など）に残します。

冪等性はエンジンと取り込みで同じ規則です：プロジェクト内でメッセージごとに案件は 1 件。メールの項目に操作する前に、エンジンはそのメッセージの起票済みの案件（このルーティン・他のルーティン・人・ツールのいずれが起票したものでも）を探し、あればその項目の操作を一切繰り返しません（実行記録では `already_handled`）。再実行や状態のリセットで返信の下書きが二重になることはありません。実行が失敗しても、案件がキューに届いたメッセージは処理済みとして記録し、それ以外は次回に読み直します。

## 文書と添付

`office.create` は `{ "kind": "docx" | "pptx" | "xlsx", "file": "<名前>.<kind>", "spec": {…} }` を受け取ります。`spec` は office プラグインの文書仕様から `path` を除いたものです（docx：タイトルと、見出し・段落・箇条書き・表のブロック。pptx：タイトルとスライド。xlsx：シート）。仕様は 3 回、いずれも安全側で確認します。計画スキーマが種類ごとに仕様の型を確認し（未知のキーがあれば計画全体が無効）、書き込む前にエンジンが office プラグイン自身のパーサーで検証し（ゲートウェイで office プラグインが有効でなければ失敗）、最後にルーティンのプロジェクト セッションでプラグインのツール（`office_docx_create` など）を通して作成します。ツールのガードはそのまま適用されます：プロジェクトは 実行 Act モードであること、ファイルは `output/autopilot/<runId>/<n>/<file>`（書き込み可能なフォルダー、シンボリックリンク経由は不可、既存ファイルの上書きは不可）。応答したツールは office プラグインのものでなければなりません。ルーティンは独自の `outputFolder`（`output/literature` などの書き込み可能なプロジェクト内フォルダー。`output/autopilot` とプロジェクトのルートは不可）を指定でき、その場合の文書は `<outputFolder>/<YYYY-MM-DD>/<runId>-<n>-<file>` に作成され、人が見つけやすくなります。ルーティンの出力フォルダーを監視する files トリガーは書けません（ファイルが無効になります）。

計画項目の案件には根拠が残ります。`autopilotEvidence` には、引用した `SOURCE` のうち今回の実行で取得したものを、ツール名と先頭行（展開したソースでは読み取りの対象 `ref: <id>`）とともに列挙し、`autopilotDocument` にはその項目の `office.create` が作成した文書を記録します。

一つの項目の中で `mail.draft`、`office.create`、`mail.attach` は宣言された順序で動きます。`mail.attach` は引数を取らず、この項目の `office.create` が作成した文書を、この項目の `mail.draft` が作成した下書き（モデルが別のメッセージを指定しない限り、その項目のメールへの返信）に添付します。モデルは下書きもファイルも指定しないため、別のファイルを添付したり別の下書きを変えたりすることはできません。途中の手順が失敗すると後続も失敗し、項目は保留中の操作とともに人に回ります。

## 承認済みの会社情報

ルーティンは `knowledge:` で、プロジェクトの**読み取り専用**フォルダー内にある `.md` または `.txt` ファイルを最大 10 個まで宣言できます（例：`knowledge/company-facts.md`。会社概要、標準価格、連絡先）。その内容は、収集した内容（常に信頼できないデータ）とは別の `KNOWLEDGE` ブロックで、**信頼できる**事実としてモデルに渡します。信頼の根拠はファイルの置き場所です：エージェントもオートパイロットも読み取り専用フォルダーには書き込めず、ルーティンファイルは管理者が設定します。上限は 1 ファイル 64 KB、合計 20,000 文字。読み取り専用フォルダーの外のパスや、プロジェクトの外に出るパスがあれば、モデルを呼ぶ前に実行は失敗します。宣言したファイルがまだない場合は飛ばし、`knowledge` の収集行に記録します。

## 禁止事項

どのエディションでも、どのレベルでも自律では行いません：支払の実行（`payment.execute`）、口座情報の変更（`bank.change`）、契約・署名（`contract.sign`）、人に関する法務・人事上の判断（`hr.decision`）、秘密情報・権限の変更（`secrets.change`）、データの削除（`data.delete`）、詐欺・フィッシング・インジェクションの疑いがあるもの。これらは可能な限り準備し、人がワンクリックで判断します。

### Business

上記のとおり、支払・口座情報・契約・人に関する判断・フラグ付き項目は必ず人に回ります。経理のスターター ルーティンは請求書をフラグ付きで受け付けるだけで、支払を提案することはありません。

### Industrial

本番 OT や PLC へは書き込みません（`ot.write`、`plc.write`）。顧客システムへのマージやデプロイも行いません（`repo.merge`、`deploy`）。プルリクエストの作成（`repo.open_pr`）は `external` で、L3 と対象リポジトリを指定した継続承認が必要です。legacy-analyzer の `legacy.analyze`、`legacy.design_doc`、`legacy.baseline_advance` は `prepare` です（ソースは読み取りのみ、結果は解析キャッシュへ。`legacy.design_doc` に `output_format: docx` を指定すると、設計書を新しい Word ファイルとして `output/design-docs/` にも書き出し、その案件から参照されます）。`legacy.baseline_advance` は案件の起票後にだけ実行されます。エンジンは `workitem.intake` の後に実行し、起票に失敗した場合は実行しないため、担当者に案件が届く前に変更が基準から消えることはありません。

### Scholars

論文や助成金申請を提出しません（`journal.submit`、`grant.submit`）。研究参加者に連絡しません（`participant.contact`）。引用を捏造しません：各項目は根拠の `SOURCE` id を引用する必要があり、今回の収集で取得していないものを引用した項目には `unverified_citation` が付きます（Scholars のルーティンでは既定で有効、`requireCitations`）。その項目の操作は実行されず、フラグ付きで人に回ります。`research.search` は `prepare` です。

**研究・学術**テンプレートには、L1 のスターター ルーティン 3 つ、ワークキュー（`res-literature` 文献レビュー、`res-writing` 執筆、`res-grants` 研究費・締切、`res-data` データ・再現性。執筆と研究費の案件では「投稿済み」「採択済み」「申請済み」「submitted」「accepted」などを拒否するルール付き）、[学術情報源](/ja/connectors/scholar-sources)と office のプラグインが含まれます。`knowledge/` は読み取り専用で、研究者が記入する 2 つの様式から始まります：`knowledge/research-profile.md`（テーマ、キーワード、情報源、言語）と `knowledge/grants.md`（締切 1 件につき `- YYYY-MM-DD | 名称 | メモ` の 1 行）。オープンアクセス PDF は `corpus-inbox/` に保存され、確認したい原稿は `output/drafts/` に置きます。ルーティンにはプロジェクトの 実行 Act モードが必要です。

| ルーティン         | トリガー                            | 収集                                                                                                               | 起票                                                                                                                               |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `literature-watch` | 毎週月曜 07:00（Asia/Tokyo）        | 前回の成功した実行以降を、プロフィールの `topics` と `sources` で `scholar_search`、新しい論文ごとに `scholar_get` | 関連する論文ごとに `res-literature` へ 1 件（要約、重要な理由、レコードからの引用）と、`output/literature/` に Word のダイジェスト |
| `citation-check`   | `output/drafts/` の原稿の変更、手動 | `scholar_cite_check` で原稿の版を一覧し、新しい版ごとに 1 回だけ確認                                               | 解決しない・一致しない参考文献のある原稿ごとに `res-writing` へ 1 件（`unverified_citation` 付き）                                 |
| `grant-deadlines`  | 平日 08:00、`knowledge/` の変更     | `scholar_grant_deadlines` で今日のリマインダーを一覧し、新しいものを読む                                           | リマインダー（締切の 30・14・7・3・1 日前と当日）ごとに `res-grants` へ 1 件                                                       |

新しいもの（新しい論文、原稿の新しい版、該当するリマインダー）がない場合や、研究プロフィールにまだテーマがない場合は、モデルを呼ばずに `no_input` で終わります。

### Core

破壊的な操作、秘密情報・権限の変更は行いません。Core のルーティンは決定的な基盤チェック（ディスク、メモリ、時計、ポリシーと停止スイッチ、エビデンス署名鍵）を実行し、失敗したときに案件を起票します。

## 継続承認

継続承認があると、L3 のルーティンは一つの社外操作を、範囲内に限って毎回確認せずに行えます。

- 送信してよい `addresses` と `domains`（cc を含むすべての宛先が一致すること）、メール以外の操作では `targets`（例：リポジトリ）
- 使ってよい `templates`（`mail.send` では必須）
- `maxPerDay`、および最長 90 日先までの `expiresAt`
- 文章による `reason`

作成と取り消しは、`operator.approvals` を持つ**人**だけが行えます。エージェントのツール接続、cron セッション、接続のない呼び出し、音声由来の操作は拒否されます。L3 の操作はすべて、根拠となった承認 id を実行記録とエビデンスに残します。作成・取り消し・使用はすべて監査ログに記録され（`autopilot.approval.use`。使用・拒否とも承認 id 付き）、取り消しは次の操作から有効です。

### L3 の送信

承認を選ぶのは `authorizeAction` ですが、送信の時点でコネクターが改めて検証します。エンジンはツール呼び出しをすべて**エンジンの実行コンテキスト**の中で行います。これはエンジンのコードだけが設定するもので、ツールの引数ではありません（cron のコマンドを `KOLO_EXEC_ORIGIN` で区別するのと同じ考え方です）。`m365_mail_send` が人の承認を省くのは、呼び出しがそのコンテキストの中で、そのツールとルーティン自身のセッションのために行われ、その時点で保存領域から承認を検証できた場合だけです：有効（期限切れでも取り消し済みでもない）、このルーティンと操作のもの、ルーティンが L3 のままで操作を含む、cc を含むすべての宛先が範囲内、テンプレートが範囲内、当日の残りがある。当日の使用回数は原子的に 1 回分使います（承認と日ごとに一つのカウンター `approval-uses.json`。認可の段階も同じカウンターを読みます）。エンジンの呼び出し 1 回につき送信は 1 回です。それ以外（モデルやエージェントのセッションからの呼び出しを含む）は従来どおり人に承認を求め、誰も承認しなければ拒否します。人が承認して送信した場合、実行記録は `approvalId: null`、`code: person_approved` になります。テンプレート id はエンジンのコンテキストとして範囲と照合し、ツールには渡しません。[Microsoft 365 コネクター](/ja/connectors/microsoft-365)も参照してください。

## ルーティンファイル

ルーティンはプロジェクトの `autopilot.yaml` に書き、ワークキューのポリシーと同じ順序で探します：プロジェクトの `context/autopilot.yaml`、次に `<KOLO_HOME>/projects/<id>/autopilot.yaml`（管理者が設定）、最後にテンプレートのスターターファイル。検証は厳格で、失敗時は安全側に倒れます。ルーティンが一つでも不正ならファイル全体が無効になり、修正されるまでそのプロジェクトのルーティンは一つも実行されず、cron ジョブも停止します。

```yaml
version: 1
timezone: Asia/Tokyo
reasoner: { backend: codex-cli }
routines:
  - id: secretariat-inbox
    edition: business # industrial | business | scholars | core
    area: secretariat # business では部門 id。下のエディション別領域を参照
    name: { ja: 受信箱の仕分けと返信下書き, en: Inbox triage and reply drafts }
    trigger: { schedule: "*/15 8-19 * * 1-5", tz: Asia/Tokyo } # または { interval: 30 }
    gather:
      - { id: inbox, tool: m365_mail_list, args: { top: 25 } }
      - id: mail
        tool: m365_mail_read
        each: { from: inbox, match: "id: (\\S+)", arg: id, max: 10 }
    reasoning: { prompt: mail-triage, schema: autopilot.plan.v1 } # または promptText（8 KB まで）
    actions: [workitem.intake, mail.draft]
    knowledge: [knowledge/company-facts.md] # 任意。読み取り専用フォルダー内
    outputFolder: output/replies # 任意。office.create の出力先（既定は output/autopilot）
    level: L1
    limits: { maxItemsPerRun: 10, maxActionsPerDay: 200 }
    queue: ga-requests
    metrics: { baselineMinutes: 4 }
```

`each` は前のステップが返した id ごとにステップを展開します。成功した過去の実行で処理済みの id は飛ばすため、新しい入力がなければモデルは呼び出されません。ステップに `gate: true` を付けると、そのステップが実行の関門になります。ツールが処理対象なしを報告すると（`details.noInput`。`legacy_changes` は基準から変更がない場合にこれを返します）、残りのステップもモデル呼び出しも行わず、ツールの理由とともに `no_input` で終了します。関門のステップは展開（`each`）できません。

### ナレッジとエンジンから受け取る引数

収集の引数には、固定値の代わりに参照を書けます。スターター ルーティンが顧客しか知らないことを決め打ちしないためです。

```yaml
knowledge: [knowledge/research-profile.md]
gather:
  - id: search
    tool: scholar_search
    args:
      queries: { fromKnowledge: topics, max: 5 } # 「## Topics」の下の「- 」行
      sources: { fromKnowledge: sources, max: 4, optional: true }
      since: { var: lastRun, fallbackDays: 14 }
      limit: 20
```

- `{ fromKnowledge: <キー>, max?: 1〜25（10）, optional?: 真偽値, join?: <区切り>, file?: <パス> }`：ルーティンの `knowledge` ファイルのいずれかで、そのキー（見出し `## Topics` または行 `topics:`。大文字小文字は区別しない。HTML コメント内の行は無視）の下にある箇条書き。リストとして、`join` を指定すると 1 つの文字列として渡します。値は 1 件 200 文字までに制限します。ファイルは宣言済みのナレッジファイルに限られるため、値は人が管理する読み取り専用フォルダーから来ます。リストが空なら実行は `no_input`（まだ探すものがない）で終わります。`optional` の場合は引数を省きます。
- `{ var: lastRun, fallbackDays?: 1〜365（7） }`：このルーティンの最後に成功した実行（`ok`、`escalated`、`no_input`。保留・停止・失敗した実行では進まない）の開始日（YYYY-MM-DD、UTC）。初回は現在から `fallbackDays` 日前。
- `{ var: today }`：ルーティンのタイムゾーンでの今日の日付。

参照はファイルを読み込むときに検証し（未知のキー、単純な名前でないキー、宣言していないファイル、範囲外の数値はファイルを無効にします）、実行ごとに解決します。参照にできるのは引数の最上位の値だけで、それ以外の値はそのまま渡します。また、エンジンは実行日（`Run date: YYYY-MM-DD`）をモデルに渡すため、文書やリマインダーが日付を推測することはありません。

エディション別の領域：Industrial は `modernisation`、`analysis`、`design-docs`、`ot-monitoring`、`quality`。Business はワークキューの部門（`secretariat`、`finance`、`admin`、`hr` など）。Scholars は `literature`、`data`、`writing`、`grants`、`lab`。Core は `platform-ops`、`security`、`backup`、`integrity`。

組み込みプロンプト：`mail-triage`、`mail-secretariat`、`invoice-intake`、`legacy-changes`、`literature-watch`、`citation-check`、`grant-deadlines`、`platform-health`、`linked-cases`。

スターター ルーティン：`secretariat-inbox`（Business 総務パック）、`secretariat-inbox-full` と `morning-brief`（Business 企業業務パック、下記と[朝のブリーフ](#朝のブリーフ)）、`finance-invoice-intake`（Business 経理パック）、`sales-quote-intake`（Business 販売見積パック、[見積管理](/ja/business/quotations)）、`procurement-po-draft`（Business 購買パック。有効にするまで停止。`proc-requests` の `supplier.selected` と平日 9:30〜18:30 の毎時 30 分に、`workitems_po_ready` が挙げた案件ごとに `po.prepare`。下書きは案件に記録（`purchaseOrderDraft`）され、同じ選定から二度作成しません。見積の更新や選定のやり直しで再び対象になり、実行中に選定が変わった下書きは拒否します）、`nightly-legacy-analysis`（Industrial パック）、`literature-watch`・`citation-check`・`grant-deadlines`（研究パック、[Scholars](#scholars)を参照）、`platform-health`（`templates/autopilot/core-platform-health.yaml`）、`linked-cases`（`templates/autopilot/core-linked-cases.yaml`：平日 9:00 と 15:00。`workitems_linked` が停止・未作成ステップ・読めない記録の連携案件を見つけたとき作業項目を 1 件作成）。

`nightly-legacy-analysis`（L1。毎晩 1:30 Asia/Tokyo と、`source/` にソースが届いた後）は、ソースを保存済みの基準と比較します（[変更検知](/tools/legacy-analyzer#change-detection)、英語）。関門のステップは `legacy_changes` です。初回は基準を作るだけで、変更のない夜は `no_input` で終了し、モデルも呼ばず案件も作りません。変更があると、`legacy-changes` プロンプトが変更点とウェーブ計画を受け取り、案件を 1 件提案します。件名、プロジェクトの言語による概要（各変更とその `path:line` の根拠）、影響（呼出し元、ジョブステップ、テーブル、ウェーブ計画への影響）、担当者が行うべき確認です。デプロイ、マージ、OT への書き込みを行ったとは決して書きません。エンジンはその後、設計書を Word で再生成し（`legacy.design_doc`、`output_format: docx`、`output/design-docs/設計書_<YYYYMMDD>.docx`）、`ind-analysis` に案件を起票し（概要は計画の概要、空なら起票メモ。Word ファイルを参照します）、そのうえで基準を進めます（`legacy.baseline_advance`）。翌晩は今夜の状態と比較します。

`secretariat-inbox-full`（L1）は、新着メールをすべて部門のキューに案件として起票し（メール取り込み、フラグ付き）、問題のない定型メールには返信の下書きを用意し、メールが文書を明示的に求めている場合は `knowledge/company-facts.md` から Word 文書を作成して下書きに添付します（`workitem.intake`、`mail.draft`、`office.create`、`mail.attach`）。送信は一切しません。フラグ付きのメールには下書きを作りません。Microsoft 365 コネクター（メールの読み取りと `write.mailDraft`）、ゲートウェイで有効な office プラグイン（エンジンはゲートウェイのツール経路でツールを呼ぶため、テンプレートのプロジェクト単位のプラグインではなくゲートウェイのプラグインが対象です）、文書作成のためにプロジェクトの 実行 Act モードが必要です。テンプレートは `knowledge/` を読み取り専用にしています。このルーティンと `finance-invoice-intake` は新着メールで起動し（後述の「トリガー」）、1 時間ごとのスケジュールを安全網として併用します。

## トリガー

ルーティンはスケジュール、イベント、またはその両方で起動します。イベントを使うと、次の時刻を待たずに数秒で反応します。トリガーは決定的に動きます。ゲートウェイ内のウォッチャーがイベントをシグナルに変え、ルーティンが実際に実行されるまでモデルは一切関与しません。イベントによる実行は、スケジュール実行とまったく同じ実行（同じ収集、ポリシー確認、ウォッチドッグ、エビデンス）で、実行記録とエビデンスに `trigger: "event"` とまとめたソースの一覧 `triggerSources` が記録されます。

```yaml
trigger:
  schedule: "0 8-19 * * 1-5" # 任意：低頻度の安全網スケジュール（または interval）
  tz: Asia/Tokyo
  event:
    - { source: m365.mail, folder: inbox } # フォルダーへの新着メール（既定は inbox）
    - { source: workitems, queue: ga-requests, actions: [created, decided] } # queue と actions は任意
    - { source: deadline, withinHours: 24 } # 1〜168
    - { source: files, folder: inbox/scans } # プロジェクトの読み取り専用または書き込み可能フォルダー
  debounceSeconds: 30 # 5〜600
  maxRunsPerHour: 12 # 1〜60
```

検証はファイルの他の部分と同じく安全側に倒れます。未知のソースやキー、フォルダー名や id でないメールフォルダー、プロジェクトの読み取り専用・書き込み可能フォルダーの外にある（またはルーティン自身の出力フォルダー `output/autopilot` である）files フォルダー、範囲外の値があると、ファイル全体が無効になります。`event` だけのルーティンには cron ジョブがありません。

| ソース      | シグナルになるもの                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `m365.mail` | フォルダーへの新着メール。コネクターのサインインごとに一つの Microsoft Graph 差分クエリ（delta）ウォッチャーが確認します（既定 60 秒ごと。[Microsoft 365](/ja/connectors/microsoft-365) を参照）。伝えるのは「メールが届いた」ことだけで、メールは通常の実行と同じく収集で読みます。 |
| `workitems` | プロジェクトの案件の作成（`created`）、変更（`changed`）、決裁（`decided`）、フラグ解除（`flag.clear`）、担当者による発注先の決定（`supplier.selected`、`po.prepare` で発注書を作成する時点）。キューで絞り込めます。ルーティン自身による変更では起動しません。                      |
| `deadline`  | 5 分ごと：期限が `withinHours` 以内の未完了の案件（期限切れを含む）。案件と期限の組み合わせごとに一度だけ通知し、期限が変わると新しい期間として扱います。                                                                                                                            |
| `files`     | フォルダー内のファイルの変更（fs watch。使えない環境では 30 秒ごとのポーリング）。ルーティンの出力フォルダー、隠しファイル、エディターの一時ファイルは無視します。                                                                                                                   |

ルーティンごとの起動の扱い：

- 最初のシグナルから `debounceSeconds` 以内のシグナルは**一回**の実行にまとめます。
- イベントによる実行は直近 1 時間で最大 `maxRunsPerHour` 回です。超えたシグナルは空きを待ってから一回だけ実行します。スケジュール実行と手動実行は数えません。
- 実行中のルーティン（どのトリガーでも）を二重に起動することはありません。フォローアップの実行を一つだけ予約し、現在の実行が終わってから始めます。
- `autopilot.stopAll`、STOP ファイル、一時停止中のルーティンではシグナルを捨てます（溜め込みません）。再び実行できるようになれば安全網のスケジュールが追いつきます。
- ループ防止：自分の出力（自分の実行が作った案件のその後の変更、実行中または直後のファイル変更）で 10 分間に 5 回を超えて起動されたルーティンは、ウォッチドッグが理由 `trigger_loop` で一時停止します（`pausedBy: "watchdog"`）。他のウォッチドッグによる停止と同じく、人が理由を書いて再開します。

`autopilot.routines.list` は各ソースの状態を `routine.state.triggers` に `{ source, status, lastSignalAt, lastError }` で返します。`status` は `active`、`degraded`（ウォッチャーに再試行中または人の対応が必要な問題がある。例：Microsoft 365 のサインイン期限切れによる `reauth_required`、`rate_limited`、`folder_missing`）、`disabled`（コネクターが無効、またはルーティンが一時停止・無効・全停止中）のいずれかです。状態の変化は `kind: "trigger"` の `autopilot.changed` で通知します。degraded になったメールトリガーは再試行を繰り返さず、新しいサインインを待ちます。その間も安全網のスケジュールでルーティンは動き続けます。

## 挙動ウォッチドッグ

実行は**操作を一つも実行する前に**計測します：収集の呼び出し数、読み込んだバイト数、モデルが提案した項目数と操作数（合計と操作の種類ごと）、それまでの所要時間。各指標は、通常の実行が 5 回以上たまるとルーティン自身のベースライン（しきい値：`max(3 × p95, 静的上限)`）と比べ、それまではルーティンファイルから求めた静的上限と比べます。

| 指標          | 静的上限                                                        |
| ------------- | --------------------------------------------------------------- |
| `gatherCalls` | 通常のステップは 1、ファンアウトのステップは `each.max`         |
| `bytesRead`   | 収集の呼び出し数 × 12,000 文字（1 回あたりの上限）              |
| `items`       | `maxItemsPerRun` とファンアウトの最大数の大きい方               |
| `actions`     | 項目の上限 × ルーティンが列挙する操作の数。種類ごとは項目の上限 |
| `durationMs`  | 判断のタイムアウト + 収集 1 回あたり 60 秒                      |

次の場合もウォッチドッグが作動します：1 回の実行で拒否が 5 件を超えた（想定どおりの `flagged` と `already_handled` は数えない）、ルーティンにない操作やカタログにない操作が提案された（`not_in_routine`、`unknown_action`、`edition_mismatch`）、判断バックエンドのツール呼び出しが 2 回連続した。

作動すると**何も実行しません**。レベル上は許可される操作もすべて `needs_person`（コード `watchdog_hold`）として人を待ち、項目はキューに届きます。ルーティンは一時停止され（`pausedBy: "watchdog"`、次の同期で cron ジョブも停止）、異常の要約を載せた案件が 1 件作られます。作動は監査ログ（`autopilot.watchdog.trip`）と実行のエビデンス（`loop_guard` イベント）に残ります。作動した実行はベースラインに入りません。ルーティンを再開できるのは人だけで、理由の記入が必要です（`reason` 付きの `autopilot.resume`。理由がなければ `reason_required` で拒否）。一時停止中のルーティンをさらに一時停止しようとすると `already_paused` で拒否されるため、ウォッチドッグの停止を上書きして理由の記入を省くことはできません。`autopilot.routines.list`（`state.watchdog`）と `autopilot.stats`（ルーティンごとの `watchdog`）で、ベースライン、しきい値、最後の作動とその理由を確認できます。実行記録には `watchdog`（作動の有無、理由、指標）が入ります。

## すべてのルーティンの停止

オートパイロット全体を止める手段が二つあります。

- **`autopilot.stopAll`**（人のみ、`operator.approvals`、音声は拒否、`reason` の記入が必要）は、すべてのプロジェクトのすべてのルーティンを一時停止し（`pausedBy: "stopAll"`）、**`autopilot.startAll`**（同じ条件）で解除するまで新しい実行を止めます。状態は `<KOLO_HOME>/autopilot/control.json` に保存され、再起動後も維持されます。`startAll` が再開するのは `stopAll` が止めたルーティンだけで、人やウォッチドッグが止めたルーティンは止まったままです。停止中は、誰が止めたかにかかわらず、ルーティンを個別に再開することはできません（`stopped_all`）。停止中にもう一度 `stopAll` を呼ぶと、まだ止まっていないルーティンは一時停止しますが、`control` の `by`・`at`・`reason` は最初の停止のまま残し、`alreadyStopped: true` を返します。同様に、何も止まっていないときの `startAll` は直前の解除の記録をそのまま残し、`alreadyStarted: true` を返します。
- **緊急停止ファイル**：`<KOLO_HOME>/autopilot/STOP` が存在する間は、どのルーティンも実行・再開されません（`emergency_stop` で拒否）。ゲートウェイの API に到達できない場合でも有効です。ゲートウェイのホストでファイルを作れる手段（`touch`、エクスプローラー、リモートシェルなど）で作成し、削除すると実行が再び可能になります。

どちらも実行の前と、実行の操作の直前に確認するため、収集や判断の途中で停止しても、その実行の操作は行われません（実行は `skipped` として記録され、入力は後で再び読まれます）。いずれの変更も監査され、すべてのプロジェクトについて `autopilot.changed`（`stopAll`、`startAll`）を通知します。`autopilot.routines.list` と `autopilot.stats` は `control`（`stopped`、`by`、`at`、`reason`、`emergencyStop`）を返します。

## エビデンス

実行ごとに `<KOLO_HOME>/projects/<id>/autopilot/runs/<runId>/evidence/` へ標準形式（ハッシュチェーンの `events.jsonl` と Ed25519 署名の `manifest.json`）のバンドルを一つ書き、`kolo evidence verify` で検証できます。記録するのは、ルーティンのダイジェスト、収集の各呼び出し（ツール、回数、バイト数）、判断出力のダイジェスト、各操作の判定（分類、判定、コード、承認 id、生成物）と件数です。メール本文や宛先は記録しません。各バンドルは直前の実行のルートを参照し、ルーティンの実行を連鎖させます。`autopilot.runs.get` で実行のバンドルを検証できます。

## 指標

`autopilot.stats` は、記録されたイベントだけからルーティン別・エディション領域別・合計を返します：実行数、失敗数、項目数、準備（prepared）、実行（acted）、人へ回付（escalated）、人の手を介さず完了（handled）、そして**人による修正**（オートパイロットが起票した案件を人が編集・差戻し・取消した数。学習のシグナル）。**削減時間**は、ルーティンが `metrics.baselineMinutes`（お客様が測定した値）を設定している場合だけ、（handled − 修正）× 基準時間 で表示します。基準がなければ `null` で、推定値は出しません。

## 獲得型の自律

ルーティンは自分の実績で自律レベルを獲得し、同じく実績で失います。原則は 3 つです。ルーティンファイルの `level` が**上限**（管理者が設定）、エンジンが自分でレベルを動かすのは**下げる方向だけ**、レベルを上げるには必ず**人**が必要です。

**実効レベル**：各ルーティンの状態には `override`（人が承認した低いレベル、または自動引き下げ）が入ることがあります。実効レベルは `min(ファイルのレベル, override)` です。`authorizeAction` はすべての操作をこのレベルで判定し、実行記録の `level` にもこの値が入ります。継続承認による L3 送信の直前にコネクターが行う再確認も実効レベルを見るため、引き下げは L3 送信を即座に止めます。ファイルのレベルを超える override は効果がありません。`autopilot.routines.list` は `level`（ファイルの値）、`effectiveLevel`、`override`（`level`、`kind`：`accepted` または `demoted`、`by`、`at`、`reason`、`changeId`）、`lastDemotion`（`from`、`to`、`cause`、`by`、`reason`、`runId`、`itemId`、`at`）を返します。

**提案**：`autopilot.autonomy.proposals` は 30 日分の記録を読み、ルーティンごとに実効レベルから 1 段階、上げる（修正率 5% 以下・案件 20 件以上・失敗なし）、下げる（修正率 20% 以上・案件 10 件以上）、または理由付きの据え置きを提案します。レベルは変更しません。各提案には `fileLevel` と `acceptBlocker` が付きます。`above_file_level`（ファイルのレベルを超える。管理者がファイルで上げる）、`no_standing_approval`（L3 への昇格にはそのルーティンの有効な継続承認が必要）、それ以外は `null` です。据え置きは `null` でも承認できません（accept は `nothing_to_accept` で拒否します）。

**承認**：`autopilot.autonomy.accept`（人のみ、`operator.approvals`、音声は拒否、理由が必要）は、表示された提案を適用します。提案はその場で再計算され、`kind` と `proposed` が一致しなければ `proposal_changed`（その間に引き下げがあった場合も同じ）、据え置きなら `nothing_to_accept` を返します。`above_file_level` と、L3 への昇格で継続承認がない場合の `no_standing_approval` も拒否されます。承認したレベルはルーティンの override になります。ファイルと同じレベルを承認すると override は消え、ルーティンは再びファイルに従います。

**見送り**：`autopilot.autonomy.decline`（同じ条件）は、人が表示された提案を見送ったことを記録するだけで、何も変わりません。提案は再計算され、一致しなければ `proposal_changed`、据え置きなら `nothing_to_decline` です。同じ提案は 30 日間、または記録から別の提案が出るまで `declined` 付きで表示されます。

**自動引き下げ**（安全な方向のみ）：次の場合、実効レベルが即座に 1 段階下がります（L0 より下にはなりません）。

- [挙動ウォッチドッグ](#挙動ウォッチドッグ)が作動したとき（`cause: "watchdog"`、実行 ID 付き。従来どおりルーティンも一時停止）
- オートパイロットが起票した案件を、人が `autopilot.reportError`（`projectId`、`itemId`、理由 `reason`。人のみ、`operator.approvals`、音声は拒否）で重大な誤りとして報告したとき。報告者はその案件を読める必要があり（読めなければ `item_not_found`）、案件はルーティンが起票したもの（`not_autopilot_item`）で、1 件につき報告は 1 回です（`already_reported`）。引き下げは案件と、それを生んだ実行に紐づきます。

L0 に下がったルーティンは、すべての操作を `level_observe` で拒否します。この拒否はウォッチドッグの拒否バーストには数えません。

**記録**：承認と引き下げはそれぞれ `<KOLO_HOME>/projects/<id>/autopilot/autonomy-changes.jsonl` の 1 行（`id`、`kind`、`fileLevel`、`from`、`to`、`by`、`at`、`reason`、`cause`、`runId`、`itemId`、`proposal`）になり、`autopilot/autonomy/<changeId>/evidence/` に専用の署名付きエビデンスが作られます。新しい override と同じプロジェクトのロックの下で書き込まれます。監査（`autopilot.autonomy.accept`、`autopilot.autonomy.demote`）され、kind `autonomy` の `autopilot.changed` を通知します。

## 朝のブリーフ

プロジェクトのメンバーそれぞれに、起きたことと自分を待っていることの短いまとめを届けます。記録データ（実行記録、ルーティンの状態、ワークキュー）だけから作り、モデルは呼びません。

ブリーフは期間（既定は直前の 24 時間）を対象に、次を含みます。

- **処理（handled）**：実行数、項目数、準備、実行、人へ回付、人手なしで完了、返信下書き、失敗した実行、および部門・領域別の同じ件数
- **文書（documents）**：ルーティンが作成した Office 文書（`office.create`）と、その実行・ルーティン
- **待ち（waiting）**：その人が今判断できる段階の案件、その人が解除できるフラグ付き案件（`workitems.clearFlag` と同じ規則）、その人が承認できる獲得型自律の提案（見送り済みを除く。`acceptBlocker` 付き）、および `linked`：その人が依頼した・担当している・判断すべき未完了の親案件のうち、開始可能な工程がある、子案件が見つからない、取消・停止した工程がある、または連携記録を読み取れない（`unreadable`）部門間連携案件。読み取りのみで、計画作成・工程の開始・子案件の紐付けは行いません。`notifications` は、その人が現在も閲覧できる案件についての未読のアプリ内通知の件数です（通知記録を読み取れない場合は `unreadable: true`）。既読にはしません
- **期限（commitments）**：その人が依頼した・担当している・判断すべき未完了の案件で、翌日末までに期限が来るもの（超過を含む）
- **問題（problems）**：ウォッチドッグの作動、失敗・スキップした実行、期間内の引き下げ、一時停止中のルーティン、無効なルーティンファイル、全体停止

案件は、その人がすでに読めるものだけが、ワークキューと同じ規則で入ります。各案件には `projectId` と `itemId` がディープリンクとして付きます（`workitems.get` で開きます）。ルーティン単位の情報は、`autopilot.routines.list` と `autopilot.stats` で観察者が既に見られるものです。

**読む**：`autopilot.brief.get`（`observe`、人のみ。`from`・`to` は任意）は、呼び出した人自身のブリーフを構造化 JSON で返します。提案は、呼び出した人が `operator.approvals` を持つ場合に含まれます。

プロジェクトのオートパイロット画面では、処理した業務、文書、判断待ち案件、フラグ付き案件、期限付き案件、問題を「あなたの朝のブリーフ」として表示します。ログイン中の本人が閲覧できる情報のみを取得し、履歴フィルターは適用しません。「更新」で再取得できます。1時間以上前の情報には注意を表示し、読み込み中・取得失敗・切断中は以前の内容を隠します。各一覧は最大50件で、上限に達した場合は明示します。下書き数は対象期間の新しい実行から最大500件の集計です。文書のパスはテキストで表示します。

**届ける**：操作 `brief.deliver`（区分 `prepare`。L1 で実行可）は、ブリーフを日本語、続いて英語のテキストにし、`m365_mail_create_draft` でメンバー本人の業務アドレス宛ての **Outlook 下書き**を作るか、アドレスのないメンバーについてはプロジェクトの `output/briefs/<日付>-<プリンシパル>.md` に書き込みます（毎回新しいファイル。既存ファイルは上書きしません。プロジェクトのモードが `output/` への書き込みを許している必要があります）。宛先はワークキューのポリシーから取り、計画からは取りません。

```yaml
access:
  members:
    - { principal: device:abc123def456, name: 佐藤, roles: [approver], email: sato@example.co.jp }
```

送信は一切せず、LINE や WhatsApp にも送りません。下書きは人が Outlook で確認します。`output/briefs/` のファイルはプロジェクトのフォルダーを読める全員が読めるため、ブリーフを非公開にしたいメンバーには `email` を設定してください。

推論に組み込みの `morning-brief` を指定したルーティンは、エンジンが計画を作り（`access.members` の各メンバーに `brief.deliver` を 1 つ）、モデルを呼びません。実行記録には `reasoning.backend: "engine"` と記録されます。スターター ルーティン `morning-brief`（Business 企業業務パック）は平日 7:30（Asia/Tokyo）に L1 で動きます。

```yaml
- id: morning-brief
  edition: business
  area: secretariat
  name: { ja: 朝のブリーフ, en: Morning brief }
  trigger: { schedule: "30 7 * * 1-5", tz: Asia/Tokyo }
  reasoning: { prompt: morning-brief, schema: autopilot.plan.v1 }
  actions: [brief.deliver]
  level: L1
  limits: { maxItemsPerRun: 50, maxActionsPerDay: 100 }
```

アドレスのあるメンバーには、`write.mailDraft` を持つ Microsoft 365 コネクターが必要です。

## ゲートウェイメソッド

| メソッド                       | スコープ                   | 備考                                                                                                         |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `autopilot.routines.list`      | observe                    | 状態付きルーティン、操作カタログ、領域                                                                       |
| `autopilot.routines.sync`      | admin                      | プロジェクトの cron ジョブを再登録（冪等）                                                                   |
| `autopilot.runs.list`          | observe                    | 新しい順、フィルター全体の `total`、カーソル                                                                 |
| `autopilot.runs.get`           | observe                    | 実行記録の全体とエビデンス検証                                                                               |
| `autopilot.run`                | attach（operator.write）   | 手動実行。スケジュール実行と同じ経路                                                                         |
| `autopilot.pause` / `resume`   | attach、人のみ             | 一時停止には理由が必要。cron ジョブも停止。ウォッチドッグや stopAll による停止からの再開には `reason` が必要 |
| `autopilot.approvals.create`   | operator.approvals、人のみ | 範囲・期限付き、監査                                                                                         |
| `autopilot.approvals.list`     | observe                    | 既定は有効なもの、履歴は `includeInactive`                                                                   |
| `autopilot.approvals.revoke`   | operator.approvals、人のみ | 理由が必要、監査                                                                                             |
| `autopilot.stats`              | observe                    | `from` / `to` は任意                                                                                         |
| `autopilot.autonomy.proposals` | observe                    | 提案のみ。レベルは変更しない                                                                                 |
| `autopilot.autonomy.accept`    | operator.approvals、人のみ | 理由が必要、監査。提案を override にする（ファイルのレベルが上限）                                           |
| `autopilot.autonomy.decline`   | operator.approvals、人のみ | 理由が必要、監査。判断を記録するだけでレベルは変更しない                                                     |
| `autopilot.reportError`        | operator.approvals、人のみ | オートパイロットの案件を重大な誤りとして報告。ルーティンが 1 段階下がる。理由が必要、監査                    |
| `autopilot.brief.get`          | observe、人のみ            | 呼び出した人自身の朝のブリーフ（読める案件のみ）                                                             |
| `autopilot.stopAll`            | operator.approvals、人のみ | 理由が必要。全ルーティンを停止し実行を止める                                                                 |
| `autopilot.startAll`           | operator.approvals、人のみ | 理由が必要。停止を解除                                                                                       |

変更時は `autopilot.changed`（`projectId`、`routineId`、`kind`：run・paused・resumed・approval・autonomy・sync・watchdog・trigger・stopAll・startAll）を通知します。拒否は `INVALID_REQUEST` と `error.details.code`（例：`not_a_person`、`paused`、`routines_invalid`、`invalid_scope`、`invalid_expiry`、`reason_required`、`already_paused`、`not_paused`、`stopped_all`、`emergency_stop`、`proposal_changed`、`nothing_to_accept`、`above_file_level`、`no_standing_approval`、`item_not_found`、`not_autopilot_item`、`already_reported`）で返します。ウォッチドッグの作動時は `watchdog` と `autonomy`（ルーティンが引き下げられた）の両方を通知します。

## コンソールでの提案確認

プロジェクトの Autopilot タブで、サーバーが返す自律レベルの提案を確認できます。
エディションと分野のフィルターは、表示対象のルーチンの提案にも適用されます。
現在と提案のレベル、理由、証拠の集計期間、案件数、修正件数、修正率を表示します。
修正率がない場合は「不明」と表示します。判定基準はサーバーの値を使用します。

承認権限を持つ担当者は、4～1,000文字の理由を記入して昇格・降格の提案を承認または却下できます。
承認は `autopilot.autonomy.accept` で表示中の提案レベルを適用します。ファイルの上限を超えることはできず、L3 には有効な継続承認が必要です。据え置きは承認できず、サーバーが承認を妨げる理由を返した場合も承認ボタンは無効です。
却下した担当者・日時・理由をカードに表示します。却下してもレベルは変わりません。
提案や承認条件が変わった場合は再取得し、入力した理由を保持します。結果が不明な操作は自動再試行しません。更新してルーチンを確認してから再試行してください。
承認・却下・一時停止・再開は同時に実行できません。提案を取得できない場合も実行履歴は確認でき、更新で再試行できます。

コンソールでは承認権限のある担当者がルーチンを一時停止・再開できます。一時停止には1〜1,000文字の理由が必要です。watchdog または stopAll による停止からの再開には、前後の空白を除いて4文字以上の理由が必要です。全体停止中は再開できません。状態が変わった場合は再取得し、失敗時も理由を保持します。結果が不明な操作は自動再試行しません。

ルーチンカードは、サーバーが返す実効レベルとファイルの上限を分けて表示します。現在の override の担当者・日時・理由と、前回の自動引き下げの日時・原因・理由も確認できます。その後の承認でレベルが戻っても、前回の引き下げは履歴として残ります。提案カードにはファイルの上限と承認を妨げる理由を表示します。これらの表示によってレベルが変わったり、継続承認が作成されたりすることはありません。
