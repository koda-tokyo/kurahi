---
summary: "kintone 業務コネクター：管理者が指定した kintone アプリのレコードを、許可したフィールドコードだけ読み取る。API トークンまたは OAuth。コメント追加とレコード作成は承認付きの追加設定"
read_when:
  - Kurahi を kintone（cybozu.com）に接続する
  - API トークンまたは OAuth クライアントの設定と権限を確認する
  - コネクターが何を読み、何を書き、何を記録するかを確認する
title: "kintone"
---

# kintone コネクター

English: [kintone connector](/connectors/kintone)

kintone コネクターを使うと、Kurahi のエージェントが、管理者が指定した kintone アプリのレコードを、
アプリごとに指定したフィールドコードだけ読み取れます。

| 項目                   | 内容                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| プラグイン ID          | `kintone`（同梱、**既定は無効**）                                                                 |
| 既定のアクセス         | 読み取り専用：指定したアプリ、指定したフィールドコードのみ                                        |
| 追加で有効にできるもの | レコードへのコメント追加（`write.comment`）、レコード作成（`write.createRecord`）。毎回、人が承認 |
| 認証                   | アプリごとの API トークン（既定）、または OAuth クライアント（`auth: "oauth"`）                   |
| トークンの保存先       | Kurahi のシークレット ストア（`connector.kintone.token`）。設定ファイルには保存しません           |
| 状態                   | プレビュー                                                                                        |

## 読み取るもの

- **アプリ**：`apps` に ID で指定したアプリだけです。`kintone_apps_list` はアプリ名（アプリ情報の
  取得 `GET /k/v1/app.json`）と許可されたフィールドコードを返します。
- **レコード**：`kintone_records_query` と `kintone_record_get` は、許可されたフィールドコード
  （`fields[]`）と `$id`・`$revision` だけを要求し、応答もそのフィールドだけに絞り直します。
  絞り込みと並べ替えは構造化された条件（フィールド・演算子・値）で、許可されたフィールドコード
  しか使えません。読めないフィールドで絞り込んで値を推測することはできません。文字列は kintone の
  仕様どおり `"` と `\` をバックスラッシュでエスケープします。1 回の呼び出しは最大 100 件、
  `offset` は kintone の上限 10,000 までです。
- **読み取らないもの**：指定していないアプリ、指定していないフィールド、添付ファイル（件数のみで
  ファイル名や中身は返しません）、テーブル（サブテーブル）の行（行数のみ）、コメント、アプリ名
  以外のアプリ設定。

## 書き込みは必ず人が承認

| ツール（追加設定）                              | 必要な権限                                                       | 内容                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `kintone_record_comment_add`（`write.comment`） | レコード閲覧権限のある API トークン、または `k:app_record:write` | テキストのコメントを 1 件追加（最大 2,000 文字） |
| `kintone_record_create`（`write.createRecord`） | 「レコード追加」権限の API トークン、または `k:app_record:write` | 許可されたフィールドだけでレコードを 1 件作成    |

呼び出しのたびに承認依頼（アプリ、レコード、本文の冒頭または値）を送り、期限内に人が承認しない
限り実行しません。書き込み権限のない認証では、人に尋ねる前に拒否します。API トークンで追加した
コメントの投稿者は「Administrator」と表示されます。

## 設定：API トークン（既定）

1. 各アプリで **アプリの設定 > API トークン > 生成する**。必要な権限だけにチェックします
   （読み取りは **レコード閲覧**、`write.createRecord` を使う場合のみ **レコード追加**）。保存して
   **アプリを更新** します。
2. 設定してサインインします。

```bash
kurahi plugins enable kintone
kurahi config set plugins.entries.kintone.config '{
  "subdomain": "example",
  "apps": [{ "id": 12, "fields": ["顧客名", "ステータス", "担当者"] }]
}' --json
kurahi kintone status
kurahi kintone login            # アプリごとに非表示のプロンプト。アプリが 1 つなら --stdin も可
kurahi kintone probe
```

各リクエストには、そのアプリのトークンだけを付けます（`X-Cybozu-API-Token`）。

## 設定：OAuth クライアント

1. **cybozu.com 共通管理 > システム管理 > OAuth** でクライアントを追加します。リダイレクト
   エンドポイントは `http://localhost:<port>/callback`（`redirectPort` に設定するポート）です。
2. クライアントシークレットを保存して設定します。

```bash
kurahi secrets set connector.kintone.clientSecret
kurahi config set plugins.entries.kintone.config '{
  "subdomain": "example", "auth": "oauth", "clientId": "<client id>", "redirectPort": 8765,
  "apps": [{ "id": 12, "fields": ["顧客名"] }]
}' --json
kurahi kintone login
```

要求するスコープは `k:app_record:read` と `k:app_settings:read`（アプリ名）で、書き込みの追加設定が
ある場合だけ `k:app_record:write` を加えます。クライアント認証は kintone の仕様どおり HTTP Basic です。

| キー                     | 既定値       | 意味                                                 |
| ------------------------ | ------------ | ---------------------------------------------------- |
| `subdomain`              | なし         | `https://example.cybozu.com` なら `example`          |
| `domain`                 | `cybozu.com` | または `kintone.com`                                 |
| `apps`                   | なし         | `[{ id, fields }]`：許可するアプリとフィールドコード |
| `auth`                   | `apiToken`   | または `oauth`                                       |
| `write.comment`          | `false`      | `kintone_record_comment_add`                         |
| `write.createRecord`     | `false`      | `kintone_record_create`                              |
| `dailyRequestsPerApp`    | 10000        | アプリごとの 1 日のリクエスト上限（超えると停止）    |
| `ratePerSecond`          | 5            | クライアント側のリクエスト上限                       |
| `approvalTimeoutSeconds` | 120          | 書き込みが人の承認を待つ時間                         |

## データの扱い

- **信頼できないコンテンツ**：レコードの値は、信頼できないコンテンツの境界の内側でだけモデルに
  渡します。値に含まれる境界マーカーは無効化します。
- **監査**：呼び出しごとに 1 行（`connector.kintone.<operation>`）。エージェント、セッション、
  アプリとレコードの ID、件数、所要時間、エラーコードのみ。フィールドの値、コメント本文、
  絞り込み条件は記録しません。
- **上限**：kintone の同時接続はドメインあたり 100、リクエストはアプリあたり 1 日 10,000
  （スタンダードコース）です。コネクターは自らレート制限し、バックオフ付きで再試行し、
  `dailyRequestsPerApp` に達したアプリをその日は停止します（ゲートウェイのプロセス内で数えるため
  再起動でリセットされますが、kintone 側の上限は変わりません）。
- **接続先**：`https://<subdomain>.cybozu.com`（または `kintone.com`）のみ。

## 状態と取り消し

ゲートウェイは起動時と `probeIntervalMinutes` ごとに、最初のアプリのレコード ID を 1 件読む
プローブを実行します。デスクトップのカタログが **Active** になるのは、プローブが成功した後だけです。
`kurahi kintone logout` は保存したトークンを削除します。kintone にはトークン取り消しの API が
ないため、アプリ設定で API トークンを削除するか、共通管理で OAuth クライアントを削除してください。

## 参考資料

cybozu.dev の kintone 公式ドキュメント：API トークンのヘッダーとアプリ単位の利用、アプリ情報の取得は
API トークン可・アプリ一覧の取得は不可、レコード取得の上限、クエリの書式とエスケープ、コメントと
レコード追加の形式、リクエスト上限、OAuth のエンドポイントとスコープ。出典 URL は
[英語版](/connectors/kintone#references) にあります。

設定のメモ：OAuth のサインインは PKCE を送信し（未対応の環境では無視されます）、`http://localhost` の
リダイレクトエンドポイントを使います。お使いの環境で使えない場合は API トークン（既定）を使ってください。
kintone が新しいリフレッシュトークンを返さない場合は、現在のものを使い続けます。ゲストスペースのアプリ（`/k/guest/<id>/v1`）はこのリリースでは
対象外です。
