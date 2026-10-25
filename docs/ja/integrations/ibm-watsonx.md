---
summary: "IBM watsonx 連携パック：watsonx Orchestrate、watsonx.ai、watsonx.governance、watsonx.data、Db2 を置き換えずに Kurahi と並べて使う。現在使えるもの、未検証のもの、今後の予定"
read_when:
  - 社内で IBM watsonx の製品を運用しており、Kurahi を並べて使うことを検討している
  - IBMとの連携点と、その検証状況の一覧が必要
title: "IBM watsonx"
---

# IBM watsonx 連携

English: [IBM watsonx](/integrations/ibm-watsonx)

Kurahi は、企業がすでに使っているIBMの環境を置き換えるのではなく、**並べて** 使うためのものです。
IBMが対応するオープンなプロトコル（A2A、MCP、OpenAPI、OpenTelemetry、Presto/Trinoのクライアントプロトコル）を使い、
それ以外は資料のあるIBMのREST APIを使います。すべて既定では無効で、管理者が有効にする必要があります。

**実際のIBMのサービスで動作を確認するまで、すべての連携は未検証です。** IBMの公開資料とSDKに基づき、
記録した要求と応答の形で適合テストをしています。作成にIBMのアカウントは使っていません。

## 現在使えるもの

| IBMの製品             | 方向                  | Kurahi側                                                                | ページ                                                          | 状態   |
| --------------------- | --------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| watsonx Orchestrate   | Orchestrate → Kurahi  | A2A 0.3.0サーバーとAgent Card（`a2a` プラグイン）                       | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | 未検証 |
| watsonx Orchestrate   | Orchestrate → Kurahi  | リモートMCPツールキット（レガシー解析のMCPサーバー）                    | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | 未検証 |
| watsonx Orchestrate   | Orchestrate → Kurahi  | OpenAPI 3.0のaskエンドポイント（`server.rest`）                         | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | 未検証 |
| watsonx Orchestrate   | Kurahi → Orchestrate  | `orchestrate_agent_chat`（`watsonx-orchestrate` プラグイン）            | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | 未検証 |
| watsonx.ai            | Kurahi がモデルを使う | `watsonx` プロバイダー（IAM更新、リージョン、バージョン、プロジェクト） | [watsonx.ai](/ja/providers/watsonx)                             | 未検証 |
| watsonx.governance    | Kurahi が実行を報告   | Langfuse互換属性のOTLPスパン、Orchestrateへの送信                       | [watsonx.governance](/ja/integrations/ibm-watsonx-governance)   | 未検証 |
| watsonx.data          | Kurahi が読む         | `watsonx_data_query`（`ibm-data` プラグイン）                           | [watsonx.data と Db2](/ja/integrations/ibm-watsonx-data-db2)    | 未検証 |
| Db2 for z/OS、Db2 LUW | Kurahi が読む         | `db2_service_call`（`ibm-data` プラグイン）                             | [watsonx.data と Db2](/ja/integrations/ibm-watsonx-data-db2)    | 未検証 |

## すべてに共通する決まり

- **IBMのシステムは信頼できない呼び出し元・情報源として扱います。** Orchestrate からの要求は分離されたセッションで、
  信頼できないコンテンツとして、管理者が許可しない限りツールなしで実行し、人の権限（承認、判断、自律レベル、設定）は持ちません。
  IBMのシステムからの応答や行は、信頼できないコンテンツのマーカーで囲んでモデルに渡します。
- **秘密情報はシークレットストアに置きます。** IBM CloudのAPIキー、Db2のパスワード、トークンは `{ "$secret": "<名前>" }` で参照し、
  IAMのベアラートークンはメモリー上だけに保持して期限前に更新します。
- **探索ではなく許可リスト。** モデルが指定できるのは設定済みのOrchestrateのエージェント、Db2のサービス、watsonx.dataのカタログだけです。
- **監査とテレメトリーはIDと件数だけ。** プロンプトや応答の本文は、管理者が明示的に有効にした場合だけ外に出ます。
- **既定で無効、オートパイロットの外。** 新しいツールはオートパイロットの読み取りツールに含めていません。

## 未検証・不明な点

- Orchestrate の `API_KEY` 方式がA2Aエージェントに `X-API-Key` を送るか、Orchestrate が送るA2Aの要求本文、A2A 1.0への対応
- リモートMCPサーバーに `Authorization: Bearer` を送る接続の種類
- Orchestrate のチャットAPIの応答の形
- SaaSの東京リージョンでのOpenAI互換モデルゲートウェイ、ソフトウェア版のトークン発行
- Orchestrate のトレース受付のサイズ上限とリージョン別のホスト
- SaaSの watsonx.data エンジンへのBasic認証、Db2 LUW RESTサービスの要求の形

## 今後の予定

- **OpenShift：** Red Hat OpenShift 上で watsonx と並べて動かすためのHelmチャート、Red Hatの認定（chart-verifier）、その後にOperator
- ツールを使わないモデルAPI（watsonx.ai など）を使うオートパイロットの推論バックエンド（実行の証跡つき）
- watsonx.governance の外部プロンプトテンプレートによる Kurahi エージェントの評価登録
- 実際のIBM環境での各項目の確認（確認後に状態の列を更新）
