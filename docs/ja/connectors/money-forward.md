---
summary: "マネーフォワード クラウド 業務コネクター：クラウド請求書の公開 API v3 で請求書・見積書・取引先を読み取る。マネーフォワードのどの製品に公開 API があるか"
read_when:
  - Kurahi をマネーフォワード クラウドに接続する
  - アプリの設定、スコープ、クライアント認証方式を確認する
  - どのマネーフォワード製品が対象かを確認する
title: "マネーフォワード クラウド"
---

# マネーフォワード クラウド コネクター

English: [マネーフォワード クラウド connector](/connectors/money-forward)

| 項目             | 内容                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| プラグイン ID    | `money-forward`（同梱、**既定は無効**）、CLI は `kurahi moneyforward`                               |
| 製品             | マネーフォワード クラウド請求書、API v3                                                             |
| アクセス         | **常に読み取り専用**。要求するのは `mfc/invoice/data.read` だけ                                     |
| サインイン       | ループバック リダイレクトによる OAuth 2.0 認可コード。クライアントシークレットはシークレット ストア |
| トークンの保存先 | Kurahi のシークレット ストア（`connector.money-forward.token`）                                     |
| 状態             | 実装済み。記録済みの API 応答でテスト済み。**実環境での検証はまだです**                             |

## 公開 API がある製品

[開発者ポータル](https://developers.biz.moneyforward.com/) で確認（2026-10-25）：

| 製品               | 公開 API                                                                                         | このコネクター           |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------ |
| クラウド請求書     | あり、API v3（OAuth 2.0）                                                                        | **対応（読み取り専用）** |
| クラウド会計       | あり、`api-accounting.moneyforward.com` の API v3（OAuth 2.0 または API キー。会計の権限で制御） | このリリースでは未対応   |
| クラウド経費       | あり（[経費 API](https://expense.moneyforward.com/api/index.html)）                              | このリリースでは未対応   |
| クラウド債務支払   | あり（[債務支払 API](https://payable.moneyforward.com/api/index.html)）                          | このリリースでは未対応   |
| クラウド連結会計   | パートナー向け API として掲載（パートナー限定とみられる）                                        | 対象外                   |
| クラウド給与・勤怠 | 公開 API は見つかりませんでした                                                                  | 対象外                   |

## 読み取るもの

| ツール                     | API                  | 返す内容                                                                                                                                              |
| -------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mf_invoice_billings_list` | `GET /billings`      | ID、番号、件名、取引先、日付、合計、入金・計上状態。取引先と期間（`range_key`：billing_date、due_date、sales_date、created_at、updated_at）で絞り込み |
| `mf_invoice_billing_get`   | `GET /billings/{id}` | 請求書、品目（名前、数量、単位、単価）、メモ                                                                                                          |
| `mf_invoice_quotes_list`   | `GET /quotes`        | ID、番号、件名、取引先、日付、合計                                                                                                                    |
| `mf_invoice_partners_list` | `GET /partners`      | ID、名前、コード。名前・コードで絞り込み                                                                                                              |

ページングは `per_page` 最大 100（API の上限）、`page` 最大 50。**読み取らないもの**：PDF の
ダウンロード URL（`pdf_url` は返しません）、事業者の住所・電話番号、取引先の部門・担当者、
送付履歴。書き込みスコープは要求しないため、請求書の作成・変更・送付はできません。

## 設定

1. 開発者ポータルでアプリを作成し、リダイレクト URI を `http://localhost:<port>/callback`、
   スコープを `mfc/invoice/data.read` にします。アプリ詳細画面に表示されるクライアント認証方式
   （`CLIENT_SECRET_BASIC` または `CLIENT_SECRET_POST`）を確認します。
2. 設定します。

```bash
kurahi plugins enable money-forward
kurahi secrets set connector.money-forward.clientSecret
kurahi config set plugins.entries.money-forward.config '{
  "clientId": "<client id>", "clientAuth": "basic", "redirectPort": 12345
}' --json
kurahi moneyforward status
kurahi moneyforward login
kurahi moneyforward probe
```

| キー            | 既定値  | 意味                                                              |
| --------------- | ------- | ----------------------------------------------------------------- |
| `clientId`      | なし    | アプリの Client ID                                                |
| `clientAuth`    | `basic` | `basic`（CLIENT_SECRET_BASIC）または `post`（CLIENT_SECRET_POST） |
| `redirectPort`  | なし    | 登録したリダイレクト URI のポート（必須）                         |
| `ratePerSecond` | 3       | クライアント側のリクエスト上限                                    |

## データの扱い

- **信頼できないコンテンツ**：件名、品目名、メモ、取引先名は、信頼できないコンテンツの境界の内側で
  だけモデルに渡します。
- **監査**：呼び出しごとに 1 行（`connector.money-forward.<operation>`）。ID、件数、所要時間、
  エラーコードのみ。金額、件名、名前は記録しません。
- **トークン**：アクセストークンは 1 時間、リフレッシュトークンは 540 日で 1 回限り（更新のたびに
  入れ替わります）。トークン エンドポイントにはレート制限があるため、期限が近いときだけ更新します。
- **接続先**：`api.biz.moneyforward.com` と `invoice.moneyforward.com` のみ。

## 状態と取り消し

ゲートウェイは `GET /office` でプローブします。`kurahi moneyforward logout` は `/revoke` で
トークン（アクセスとリフレッシュ）を取り消し、ローカルからも削除します。

## 確認済みと未確認

確認済み（2026-10-25）：OAuth のエンドポイントと有効期間、クライアント認証方式、取り消し、
スコープ、パス・パラメーター・応答の形式。出典 URL は
[英語版](/connectors/money-forward#verified-and-not-verified) にあります。

明記されておらず、保守的に実装したもの：PKCE（送信するが未対応なら無視される）、取り消しの
パラメーター名（`token` とクライアント資格情報、RFC 7009）、読み取り API のレート制限（明記されて
いるのは書き込み 6 種の 3 回/秒のみ。コネクターはすべて 3 回/秒以内にしています）。
