---
summary: "Gmail 業務コネクター：Gmail API で Google Workspace のメールを一覧・検索・閲覧する。Google Cloud の OAuth クライアント設定、スコープ、データの扱い、既定は読み取り専用"
read_when:
  - Kurahi を Google Workspace ドメインの Gmail に接続する
  - Google Cloud コンソールの手順とスコープを確認する
  - コネクターが何を読み、何を書き、何を記録するかを確認する
title: "Gmail"
---

# Gmail コネクター

English: [Gmail connector](/connectors/gmail)

Gmail コネクターを使うと、Kurahi のエージェントがお客様所有の OAuth クライアントで 1 つの
メールボックスを Gmail API 経由で一覧・検索・閲覧できます。新着メールをセッションへ送る
Gmail Pub/Sub フック（`kurahi webhooks gmail`）とは別のものです。

| 項目                   | 内容                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| プラグイン ID          | `gmail`（同梱、**既定は無効**）                                                       |
| 既定のアクセス         | 読み取り専用：`gmail.readonly`                                                        |
| 追加で有効にできるもの | メール送信：`gmail.send`。送信のたびに人が承認                                        |
| サインイン             | ループバック リダイレクト（`127.0.0.1`）による PKCE 付き認可コード                    |
| トークンの保存先       | Kurahi のシークレット ストア（`connector.gmail.token`）。設定ファイルには保存しません |
| 状態                   | 提供中                                                                                |

## 管理者が Google Cloud で行う設定

1. Google Cloud コンソールで、組織が所有するプロジェクトを作成または選択します。
2. **API とサービス > ライブラリ** で **Gmail API** を有効にします。
3. **API とサービス > OAuth 同意画面**（Google Auth Platform > ブランディング / 対象）で、
   ユーザーの種類を **内部** にします。これで自社の Workspace のアカウントだけがサインインできます。
   **データアクセス** に下表のスコープを追加します。
4. **API とサービス > 認証情報 > 認証情報を作成 > OAuth クライアント ID** で、アプリケーションの種類を
   **デスクトップ アプリ** にします。クライアント ID とクライアント シークレットを控えます。デスクトップ
   クライアントのシークレットは Google の説明上は機密扱いではありませんが、Kurahi では
   シークレット ストアに保管します。
5. 任意（Workspace 全体に展開する場合）：Google 管理コンソールの **セキュリティ > アクセスとデータ管理 >
   API の制御** で、このアプリを信頼済みにします。

| 機能（設定キー）     | スコープ                                         | アクセス     |
| -------------------- | ------------------------------------------------ | ------------ |
| 常に                 | `https://www.googleapis.com/auth/gmail.readonly` | 読み取り     |
| 送信（`write.send`） | `https://www.googleapis.com/auth/gmail.send`     | **書き込み** |

`gmail.readonly` は制限付きスコープです。自社の Workspace 内だけで使う **内部** アプリであれば、
Google によるアプリの審査は不要です。外部アプリの場合は審査が必要です。

## Kurahi の設定

```bash
kurahi plugins enable gmail
kurahi secrets set connector.gmail.clientSecret        # クライアント シークレットを入力
kurahi config set plugins.entries.gmail.config '{
  "clientId": "<番号>-<ID>.apps.googleusercontent.com",
  "allowedDomain": "example.co.jp"
}' --json
kurahi gmail status
kurahi gmail login
kurahi gmail probe
```

Google のデバイス コード フローでは Gmail のスコープを使えないため、サインインには Kurahi を動かして
いるマシンに届くブラウザーが必要です。サーバーの場合はポートを固定して転送します：`redirectPort`
（例：8765）を設定し、`ssh -L 8765:127.0.0.1:8765 <サーバー>` を実行してから、サーバー上で
`kurahi gmail login` を実行し、表示されたアドレスを手元のコンピューターで開きます。

| キー                     | 既定値   | 意味                                                                        |
| ------------------------ | -------- | --------------------------------------------------------------------------- |
| `clientId`               | なし     | OAuth クライアント ID（デスクトップ アプリ）                                |
| `allowedDomain`          | なし     | メールボックスが属すべき Workspace ドメイン。他のドメインのサインインは拒否 |
| `write.send`             | `false`  | `gmail_send`                                                                |
| `redirectPort`           | ランダム | ループバックのポートを固定                                                  |
| `probeIntervalMinutes`   | 15       | 接続確認の間隔（分）                                                        |
| `ratePerSecond`          | 8        | Gmail API への 1 秒あたりの要求数の上限（クライアント側）                   |
| `approvalTimeoutSeconds` | 120      | 送信が承認を待つ時間（秒）                                                  |

`allowedDomain` はアカウント選択画面へのヒントにとどまらず、サインイン後にメールボックス自体の
アドレスで確認します。

## ツール

| ツール               | 必要なもの          | 内容                                                             |
| -------------------- | ------------------- | ---------------------------------------------------------------- |
| `gmail_list`         | `gmail.readonly`    | ラベル（既定は `INBOX`）の最近のメール                           |
| `gmail_search`       | `gmail.readonly`    | Gmail の検索構文（例：`from:billing@example.com newer_than:7d`） |
| `gmail_read`         | `gmail.readonly`    | 1 通をプレーン テキストで読む（HTML のみのメールは変換）         |
| `gmail_send`（追加） | `gmail.send` と承認 | プレーン テキストのメールを送信                                  |

## 書き込みには必ず人の承認が必要

`gmail_send` は `write.send` を有効にし、サインイン時に `gmail.send` が許可された場合にだけ登録されます。
呼び出しのたびに承認依頼（宛先、件名、本文の冒頭）を送り、時間内に人が承認しない限り送信しません。
件名とアドレスは、余分なヘッダーを差し込めないよう無害化します。

## データの扱い

- **信頼できない内容として扱う。** 本文、件名、差出人、抜粋は信頼できない外部コンテンツの境界の
  内側でのみモデルに渡します。メール内の境界マーカーは無害化します。
- **監査。** 呼び出しごとに 1 行（`connector.gmail.<操作>`）：エージェント、セッション、メッセージ ID、
  件数、サイズ、所要時間、エラー コード。件名、本文、アドレス、検索語は記録しません。
- **トークン。** Kurahi のシークレット ストアに保存し、期限前に更新します。
- **制限。** クライアント側の要求数制限、バックオフ付きの再試行、`Retry-After` への準拠（60 秒を
  超える場合は `rate_limited` で失敗）。一覧で取得するのは最大 25 通です。
- **通信先。** `accounts.google.com`、`oauth2.googleapis.com`、`gmail.googleapis.com` のみ。

## 状態と取り消し

ゲートウェイは起動時と `probeIntervalMinutes` ごとに `users/me/profile` で接続を確認します。
デスクトップのカタログが **稼働中** と表示するのは、25 時間以内の確認が成功した場合だけです。
`kurahi gmail logout` は Google 側でリフレッシュ トークンを取り消し、保存したトークンを削除します。
管理者は Google 管理コンソールからこのアプリのアクセスを削除することもできます。

## このリリースの制限

- ゲートウェイごとにメールボックスは 1 つ。ドメイン全体の委任（サービス アカウント）には未対応。
- 添付ファイルは数を表示するだけで、ダウンロードはしません。
