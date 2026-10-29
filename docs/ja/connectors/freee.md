---
summary: "freee 会計 業務コネクター：freee API で事業所、取引、取引先、勘定科目、証憑のメタデータを読み取る。常に読み取り専用（取引 API に下書き状態がないため書き込みツールはありません）"
read_when:
  - Kurahi を freee 会計に接続する
  - freee アプリの設定と権限を確認する
  - コネクターが取引を作成できない理由を確認する
title: "freee 会計"
---

# freee 会計 コネクター

English: [freee 会計 connector](/connectors/freee)

freee コネクターを使うと、Kurahi のエージェントが、管理者が指定した freee の事業所の会計データを、
お客様所有の freee アプリで freee API 経由で読み取れます。

| 項目             | 内容                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| プラグイン ID    | `freee`（同梱、**既定は無効**）                                                                     |
| アクセス         | **常に読み取り専用**。書き込みツールはありません                                                    |
| サインイン       | ループバック リダイレクトによる OAuth 2.0 認可コード。クライアントシークレットはシークレット ストア |
| トークンの保存先 | Kurahi のシークレット ストア（`connector.freee.token`）                                             |
| 状態             | 提供中                                                                                              |

## 書き込みツールがない理由

このコネクターでは、取引の作成は **下書きとしてのみ** 許される前提でした。freee の `POST /deals`
には下書きや承認の項目がなく、`status`（`unsettled` / `settled`）は決済状態です。作成した取引は
必ず帳簿に反映されます。下書き（`draft: true`）があるのは各種申請・経費申請・支払依頼
（`POST /approval_requests`、`/expense_applications`、`/payment_requests`）だけで、これらは取引では
なくワークフローの申請です。そのため、このリリースには書き込みツールがありません。

## 読み取るもの

| ツール                     | API                  | 返す内容                                                                                             |
| -------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `freee_companies_list`     | `GET /companies`     | 指定した事業所の ID、名前、権限                                                                      |
| `freee_deals_list`         | `GET /deals`         | ID、種別、日付、金額、決済状態、取引先 ID、明細数。種別・状態・取引先・発生日で絞り込み。最大 100 件 |
| `freee_deal_get`           | `GET /deals/{id}`    | 取引と明細（勘定科目、税区分、金額、備考）                                                           |
| `freee_partners_list`      | `GET /partners`      | ID、コード、名前、正式名称。最大 100 件                                                              |
| `freee_account_items_list` | `GET /account_items` | ID、名前、区分（最大 500 件を表示）                                                                  |
| `freee_receipts_list`      | `GET /receipts`      | メタデータ：ID、状態、発行日、ファイル形式、メモ。最大 100 件                                        |

**読み取らないもの**：指定していない事業所、証憑ファイル（ダウンロードせず、ファイル URL も返しません）、
取引先の口座・住所・連絡先、ユーザー、給与（freee 人事労務は別製品で対象外）。

## 設定

1. freee アプリストアの開発者ページでアプリを作成し、上記のリソース（取引、取引先、勘定科目、
   証憑・ファイルボックス、事業所）の **参照** 権限だけを付けます。コールバック URL は
   `http://localhost:<port>/callback` です。
2. 設定します。

```bash
kurahi plugins enable freee
kurahi secrets set connector.freee.clientSecret
kurahi config set plugins.entries.freee.config '{
  "clientId": "<client id>", "companyIds": [1234567], "redirectPort": 8765
}' --json
kurahi freee status
kurahi freee login
kurahi freee probe
```

freee には `scope` パラメーターがありません。権限はアプリで選び、同意画面で確認され、トークンには
`read` / `write` として表示されます。すべてのツールは `read` を必要とします。

| キー                   | 既定値 | 意味                                      |
| ---------------------- | ------ | ----------------------------------------- |
| `clientId`             | なし   | freee アプリの Client ID                  |
| `companyIds`           | なし   | 読み取ってよい事業所。それ以外は拒否      |
| `redirectPort`         | なし   | 登録したコールバック URL のポート（必須） |
| `ratePerSecond`        | 3      | クライアント側のリクエスト上限            |
| `probeIntervalMinutes` | 60     | ヘルスプローブの間隔                      |

## データの扱い

- **信頼できないコンテンツ**：備考、名前などお客様が入力したテキストは、信頼できないコンテンツの
  境界の内側でだけモデルに渡します。
- **監査**：呼び出しごとに 1 行（`connector.freee.<operation>`）。ID、件数、所要時間、エラーコードのみ。
  金額、備考、名前は記録しません。
- **上限**：freee は事業所・アプリごとに 1 日の呼び出し数を数え（プランにより 3,000〜10,000）、
  短時間の大量アクセスには約 10 分間 403 を返します。コネクターは自らレート制限（既定 3 回/秒）し、
  バックオフ付きで再試行します。アクセストークンは 6 時間、リフレッシュトークンは 1 回限りで毎回
  更新されます。
- **接続先**：`accounts.secure.freee.co.jp` と `api.freee.co.jp` のみ。

## 状態と取り消し

ゲートウェイは `GET /companies` でプローブします。`kurahi freee logout` は `/public_api/revoke` で
トークンを取り消し、ローカルからも削除します。

## 参考資料

freee 公式ドキュメント：エンドポイントとクライアントシークレット、取り消し、トークンの有効期間、
パス・パラメーター・上限、および取引に下書き項目がないこと。出典 URL は
[英語版](/connectors/freee#references) にあります。

設定のメモ：サインインは PKCE を送信し（未対応の環境では無視されます）、`http://localhost` の
コールバック URL を使います。freee のアプリにこのコールバックを登録してください（freee はローカル検証用に
`urn:ietf:wg:oauth:2.0:oob`、それ以外は HTTPS を案内しています。localhost を登録できないアプリは、
このリリースではサインインできません）。取り消しではトークンとともにクライアント資格情報を送信します。
