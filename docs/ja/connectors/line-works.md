---
summary: "LINE WORKS 業務コネクター：アプリの Service Account で認証する 1 つの Bot。チャンネル情報とメンバーを読み取る（メッセージ履歴の API はありません）。指定したチャンネル・ユーザーへのテキスト送信は承認付き"
read_when:
  - Kurahi を LINE WORKS に接続する
  - Developer Console の設定（Service Account、秘密鍵、Bot）を確認する
  - コネクターがメッセージを読めない理由を確認する
title: "LINE WORKS"
---

# LINE WORKS コネクター

English: [LINE WORKS connector](/connectors/line-works)

| 項目                   | 内容                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| プラグイン ID          | `line-works`（同梱、**既定は無効**）、CLI は `kurahi lineworks`                                |
| 既定のアクセス         | 読み取り専用：指定したチャンネルの情報とメンバー（`bot.read`）                                 |
| 追加で有効にできるもの | 指定したチャンネル・ユーザーへのテキスト送信（`bot.message`）。毎回、人が承認                  |
| 認証                   | Service Account：アプリの秘密鍵で署名した JWT（RS256）をトークンに交換                         |
| シークレット           | `connector.line-works.privateKey`、`connector.line-works.clientSecret`、キャッシュしたトークン |
| 状態                   | プレビュー                                                                                     |

## メッセージは読み取れません

LINE WORKS API 2.0 には、メッセージ履歴を一覧・取得する API がありません。Bot がメッセージを受け取る
のは、Callback URL（HTTPS、Bot Secret で署名）に送られるイベントだけです。このコネクターは Callback
エンドポイントを持たないため、**メッセージは読み取りません**。読み取れるのはチャンネル情報（名前・種別）
とメンバーです。

## ツール

| ツール                                   | 必要な権限           | 内容                                                                     |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `lineworks_channel_get`                  | `bot.read`           | 指定したチャンネル 1 つの名前と種別                                      |
| `lineworks_channel_members`              | `bot.read`           | メンバーのユーザー ID（1 回最大 100 件、カーソルで続き）                 |
| `lineworks_message_send`（`write.send`） | `bot.message` と承認 | 指定したチャンネルまたはユーザーへテキストを 1 件送信（最大 2,000 文字） |

宛先にできるのは `channels` のチャンネルと `users` のユーザーだけで、それ以外はリクエスト前に拒否します。
送信のたびに人に承認を求め（宛先、文字数、本文の冒頭）、期限内に承認されなければ送信しません。
`bot.message` のない認証では、人に尋ねる前に拒否します。常設（オートパイロット）承認には **対応して
いません**。常設送信の仕組みはメールの宛先を前提にしているため、LINE WORKS のメッセージは毎回人が承認します。

## 設定

1. LINE WORKS Developer Console でアプリを作成し、**Service Account** を発行して **Private Key** を
   ダウンロードします。OAuth Scope に `bot.read`（送信する場合は `bot.message` も）を追加し、
   Client ID と Client Secret を控えます。
2. Bot を登録して使うチャンネルに追加し、Bot ID とチャンネル ID を控えます。
3. 設定します。

```bash
kurahi plugins enable line-works
kurahi secrets set connector.line-works.privateKey --stdin < private_key.key
kurahi secrets set connector.line-works.clientSecret
kurahi config set plugins.entries.line-works.config '{
  "clientId": "<client id>", "serviceAccount": "<id>.serviceaccount@<domain>",
  "botId": "<bot id>", "channels": ["<channel id>"], "users": []
}' --json
kurahi lineworks status
kurahi lineworks login      # 保存した鍵でトークンを 1 回発行し、鍵・シークレット・スコープを確認
kurahi lineworks probe
```

| キー                     | 既定値  | 意味                                             |
| ------------------------ | ------- | ------------------------------------------------ |
| `clientId`               | なし    | アプリの Client ID                               |
| `serviceAccount`         | なし    | Service Account ID                               |
| `botId`                  | なし    | 使う Bot                                         |
| `channels`、`users`      | なし    | Bot が読み取り・送信できる唯一の宛先             |
| `write.send`             | `false` | `lineworks_message_send`                         |
| `ratePerSecond`          | 1       | クライアント側の上限（フリープランは毎分 60 回） |
| `approvalTimeoutSeconds` | 120     | 送信が人の承認を待つ時間                         |

## データの扱い

- **信頼できないコンテンツ**：チャンネル名とメンバー ID は、信頼できないコンテンツの境界の内側で
  だけモデルに渡します。
- **監査**：呼び出しごとに 1 行（`connector.line-works.<operation>`）。チャンネル・ユーザーの ID、件数、
  所要時間、エラーコードのみ。本文は記録せず、メールアドレス形式の ID も監査行から除きます。
- **トークン**：JWT は最長 60 分で 1 回だけ使います。アクセストークン（Developer Console の設定で
  1 時間または 24 時間）はシークレット ストアにキャッシュし、期限の少し前に再発行します。リフレッシュ
  トークンは保持しません。
- **上限**：API ごとにフリープラン毎分 60 回、スタンダード・アドバンスト毎分 240 回、並列は最大 5。
  コネクターは既定で毎秒 1 回に抑えます。
- **接続先**：`auth.worksmobile.com` と `www.worksapis.com` のみ。

## 状態と取り消し

ゲートウェイは最初のチャンネル（なければ `GET /bots`）でプローブします。`kurahi lineworks logout` は
キャッシュしたトークンを削除します。アクセスを止めるには Developer Console で秘密鍵または
Client Secret を再発行・削除します。

## 参考資料

LINE WORKS 公式ドキュメント：JWT のクレーム、トークン エンドポイント、有効期間、Service Account の
スコープ制限、送信 API、テキストの上限、チャンネル API、履歴 API がないこと、レート制限。出典 URL は
[英語版](/connectors/line-works#references) にあります。

設定のメモ：チャンネル API は `bot.read` スコープを使います。お使いのドメインでそれ以上が必要な場合は
`bot` も追加してください（ドキュメントには `bot`、`bot.message`、`bot.read` が並んでいます）。
