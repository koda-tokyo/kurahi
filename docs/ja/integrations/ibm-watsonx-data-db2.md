---
summary: "IBMのデータを読み取り専用で扱うツール：watsonx.data のPrestoまたはTrinoエンジンにHTTPクライアントプロトコルで1文のSQLを送る（カタログとスキーマの許可リスト、SELECTのみのガード、行数とバイト数の上限）。許可したDb2 RESTサービス（Db2 for z/OSのネイティブREST、Db2 LUWのRESTサーバー）をネイティブドライバーなしで呼び出す"
read_when:
  - 既存のIBM環境と並べて、エージェントが watsonx.data や Db2 のデータを読む必要がある
  - データ用ツールが何にアクセスでき、何にアクセスできないかを確認する
title: "watsonx.data と Db2"
---

# watsonx.data と Db2（読み取り専用）

English: [watsonx.data and Db2](/integrations/ibm-watsonx-data-db2)（設定例を含む完全版）

`ibm-data` プラグイン（同梱、既定は無効）は任意のツールを2つ追加します。どちらも読み取りだけで、結果は信頼できないコンテンツとして返し、
監査ログにはID、SQLのハッシュ、行数、パラメーター名、結果だけを残します（SQL本文、パラメーターの値、行は残しません）。
どちらもオートパイロットの読み取りツールには含めていません。

**状態：未検証。** Presto/TrinoのクライアントプロトコルとIBMのDb2 RESTの資料に基づき、記録した応答の形でテストしています。

## watsonx_data_query

watsonx.data の Presto（JavaまたはC++）またはTrinoのエンジンに、HTTPクライアントプロトコル（`POST /v1/statement` と `nextUri` の取得）で1文を送ります。JDBCやドライバーは使いません。

- **許可リスト：** セッションのカタログとスキーマ、および `FROM`・`JOIN` のあとのすべての表の参照が、設定したカタログとスキーマの中にある必要があります。`SHOW CATALOGS` は拒否します。
- **読み取り専用：** 1文だけ。`SELECT`、`WITH`、`SHOW`、`DESCRIBE` で始まる必要があり、書き込みやセッションを変える語（`INSERT`、`DELETE`、`CREATE`、`CALL`、`SET`、`EXPLAIN` など）と表関数 `TABLE(...)` は拒否します。
- **上限：** `maxRows` 行と約 `maxBytes` バイトに達したら、クエリーを取り消して結果を「切り詰め」と示します。全体の時間は `timeoutMs` です。
- **認証情報の保護：** すべての `nextUri` は設定したオリジンの中である必要があり、リダイレクトは拒否します。

このガードは二重の防御です。watsonx.data のアクセス制御で、エンジンのユーザーを読み取り専用かつ許可したカタログだけに制限してください。

## db2_service_call

Db2のRESTサービスは、静的SQLを1文だけ含むパッケージで、Db2の管理者が作成します。ツールは設定したサービスだけを `POST` で呼び出し、最大 `maxRows` 行を返します。
サービスのSQLはツールから見えないため、読み取り専用のサービスだけを登録してください。

| 種類  | 要求                                                                                                                                           | 読み取る内容                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `zos` | `POST <url>/services/<collection>/<service>[/<version>]`（Basic認証、JSONのパラメーター）                                                      | `ResultSet Output` の行、出力パラメーター |
| `luw` | `POST <url>/v1/auth`（`dbParms`）のあと `POST <url>/v1/services/<service>/<version>`（`authorization` ヘッダー、`{ parameters, sync: true }`） | `resultSet` の行                          |

パラメーターは設定した名前だけ、値は文字列（4000文字まで）、数値、真偽値、nullだけです。ネイティブのDb2ドライバー（`ibm_db`）は使いません。
LUWのサービスのパス、ヘッダー、本文の形は公式資料で確認できておらず、未検証です。

全体の概要：[IBM watsonx 連携](/ja/integrations/ibm-watsonx)
