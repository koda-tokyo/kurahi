---
summary: "SmartHR 業務コネクター：従業員（コードで強制する厳格な許可リストの業務項目のみ）と部署を読み取る。マイナンバー、口座、保険、給与などの個人情報は読み取らない。読み取り専用"
read_when:
  - Kurahi を SmartHR に接続する
  - アクセストークンの設定と読み取る項目を確認する
  - 読み取らない個人情報を確認する
title: "SmartHR"
---

# SmartHR コネクター

English: [SmartHR connector](/connectors/smarthr)

| 項目             | 内容                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| プラグイン ID    | `smarthr`（同梱、**既定は無効**）                                                       |
| アクセス         | **常に読み取り専用**。書き込みツールはありません                                        |
| 認証             | SmartHR の管理者が発行するアクセストークン（`kurahi smarthr login` の非表示プロンプト） |
| トークンの保存先 | Kurahi のシークレット ストア（`connector.smarthr.token`）                               |
| 状態             | 提供中                                                                                  |

## 項目の許可リスト

従業員のリクエストには必ず許可リストを `fields=` で付け、応答もそのリストに絞り直します。API が
ほかの項目を返しても、要求もせず返しもしません。許可リストはコードで固定（`CREW_FIELD_CEILING`）され、
`crewFields` では狭めることしかできません。

`id`、`emp_code`、`last_name`、`first_name`、`last_name_yomi`、`first_name_yomi`、
`business_last_name`、`business_first_name`、`business_last_name_yomi`、
`business_first_name_yomi`、`emp_status`、`employment_type`、`department`、`departments`、
`position`、`positions`、`entered_at`、`email`（`crewFields` に書いた場合のみ）。

入れ子のオブジェクトは ID、名前、正式名称、コードだけにします。

**設定にかかわらず読み取らないもの**：マイナンバー（公開 API にそもそもありません）、口座、
雇用保険・社会保険・健康保険の被保険者番号と基礎年金番号およびその画像、保険料、給与、標準報酬月額、
配偶者の収入、通勤手当、税区分、生年月日、性別、電話番号、住所（現住所・住民票・緊急連絡先）、
在留カード・国籍・在留資格、本人確認書類、障害・寡婦・勤労学生の情報、履歴書、前職、契約条件、
退職理由、家族（コネクターが呼ばない別エンドポイント）、カスタム項目。もう一つ独立したパターン検査
（`SENSITIVE_FIELD`）が、許可リストに加えられたとしてもこうした項目名を拒否します。テストでは公開
スキーマの Crew の 144 項目すべてを両方の検査にかけています。

## 読み取るもの

| ツール                     | API                   | 返す内容                                                                                                                 |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `smarthr_crews_list`       | `GET /v1/crews`       | 許可リストの項目。在籍状況・部署 ID・社員番号・氏名/部署/役職の検索（`q`）で絞り込み。1 ページ最大 100 件、50 ページまで |
| `smarthr_crew_get`         | `GET /v1/crews/{id}`  | 従業員 1 名、許可リストの項目                                                                                            |
| `smarthr_departments_list` | `GET /v1/departments` | ID、名前、正式名称、コード、親部署 ID                                                                                    |

## 設定

1. SmartHR の管理者がアクセストークンを発行します（共通設定 > API アクセストークン）。プランで
   可能なら、従業員と部署の **参照** のみ、従業員項目は上記のみに制限してください。
2. 設定します。

```bash
kurahi plugins enable smarthr
kurahi config set plugins.entries.smarthr.config '{ "tenant": "example" }' --json
kurahi smarthr status
kurahi smarthr login        # 非表示のプロンプト。または printf '%s' "$TOKEN" | kurahi smarthr login --stdin
kurahi smarthr probe
```

| キー            | 既定値             | 意味                                                    |
| --------------- | ------------------ | ------------------------------------------------------- |
| `tenant`        | なし               | `https://example.smarthr.jp` なら `example`             |
| `sandbox`       | `false`            | `https://<tenant>.daruma.space`（サンドボックス）を使う |
| `crewFields`    | 許可リスト − email | 許可リストを狭める。リスト外の名前は拒否                |
| `ratePerSecond` | 5                  | クライアント側のリクエスト上限                          |

## データの扱い

- **信頼できないコンテンツ**：氏名、部署、役職は、信頼できないコンテンツの境界の内側でだけモデルに
  渡します。
- **監査**：呼び出しごとに 1 行（`connector.smarthr.<operation>`）。従業員と部署の ID、件数、
  所要時間、エラーコードのみ。氏名などの値は記録しません。
- **上限**：SmartHR はトークンあたり毎秒 10 回・毎時 5,000 回（テナントあたり毎分 50,000 回）です。
  コネクターは毎秒 5 回以内に抑え、429 ではバックオフします。
- **接続先**：`https://<tenant>.smarthr.jp/api`（サンドボックスは `daruma.space`）のみ。

## 状態と取り消し

ゲートウェイは `GET /v1/crews?fields=id&per_page=1` でプローブします。`kurahi smarthr logout` は
保存したトークンを削除します。取り消すには管理者が SmartHR でトークンを削除します。

## 参考資料

SmartHR 公式ドキュメント：ベース URL、Bearer 認証、ページング、レート制限、サンドボックスのドメイン、
`fields`・`q`・各エンドポイント、Crew の 144 項目。出典 URL は
[英語版](/connectors/smarthr#references) にあります。

設定のメモ：アクセストークンには、コネクターが読む従業員の項目とリソースの読み取り権限を付けてください
（SmartHR のトークン権限は項目・リソース単位で設定します）。部署の一覧は一般的なページサイズの上限 100 を使います。
