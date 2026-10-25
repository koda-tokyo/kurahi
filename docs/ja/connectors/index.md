---
summary: "業務コネクター：Microsoft 365、Gmail、Entra ID と日本の SaaS コネクター（kintone、freee、マネーフォワード、SmartHR、LINE WORKS、Box）。すべて既定は無効・読み取り専用、書き込みは毎回人が承認"
read_when:
  - Kurahi が接続できる業務システムを確認する
  - すべての業務コネクターに共通するルールを確認する
title: "業務コネクター"
---

# 業務コネクター

English: [Business connectors](/connectors)

業務コネクターはすべて同梱プラグインで、**既定は無効**、**既定は読み取り専用** です。書き込みは
管理者が個別に有効にする追加設定で、実行のたびに人の承認を待ちます。トークンは Kurahi の
シークレット ストアに保存し、監査行は ID と件数だけ、取得したテキストは信頼できないコンテンツの
境界の内側でだけモデルに渡します。デスクトップのカタログが **Active** になるのは接続確認（プローブ）が
成功した後だけです。どれも `kurahi <cli> login`・`status`・`probe`・`logout` を備えています。

| コネクター                                                | CLI            | 読み取るもの                                        | 追加設定の書き込み（毎回承認）                       | 状態       |
| --------------------------------------------------------- | -------------- | --------------------------------------------------- | ---------------------------------------------------- | ---------- |
| [Microsoft 365](/ja/connectors/microsoft-365)             | `m365`         | メール、カレンダー、OneDrive・SharePoint のファイル | 送信、下書き、予定、アプリフォルダーへのアップロード | プレビュー |
| [Gmail](/ja/connectors/gmail)                             | `gmail`        | メール                                              | 送信                                                 | プレビュー |
| [Microsoft Entra ID](/ja/connectors/entra)                | `entra`        | サインイン、ユーザーとグループ                      | なし                                                 | プレビュー |
| [kintone](/ja/connectors/kintone)                         | `kintone`      | 指定アプリのレコード（許可したフィールドのみ）      | コメント追加、レコード作成                           | プレビュー |
| [freee 会計](/ja/connectors/freee)                        | `freee`        | 事業所、取引、取引先、勘定科目、証憑メタデータ      | なし（API に取引の下書きがない）                     | プレビュー |
| [マネーフォワード クラウド](/ja/connectors/money-forward) | `moneyforward` | クラウド請求書：請求書、見積書、取引先              | なし                                                 | プレビュー |
| [SmartHR](/ja/connectors/smarthr)                         | `smarthr`      | 従業員（業務項目のみ）、部署                        | なし                                                 | プレビュー |
| [LINE WORKS](/ja/connectors/line-works)                   | `lineworks`    | チャンネル情報とメンバー（履歴 API なし）           | Bot のテキスト送信                                   | プレビュー |
| [Box](/ja/connectors/box)                                 | `box`          | 検索、メタデータ、スキャン済みの取り込み            | 指定フォルダーへのアップロード                       | プレビュー |

研究向けには、[学術情報源](/ja/connectors/scholar-sources)プラグイン（Kurahi Scholars）が arXiv・OpenAlex・Crossref・PubMed を無料の公開 API で読み取ります。サインインもキーも不要です。

上記のコネクターはすべて **プレビュー** として提供しています。実装済みで既定は無効、インストールごとに有効にします。
お使いのテナントで各コネクター自身の接続確認が成功すると、デスクトップのカタログで **Active** になります。
