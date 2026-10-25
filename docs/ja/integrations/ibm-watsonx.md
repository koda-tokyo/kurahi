---
summary: "IBM watsonx 連携パック：watsonx Orchestrate、watsonx.ai、watsonx.governance、watsonx.data、Db2 を置き換えずに Kurahi と並べて使う。現在使えるもの、設定のメモ、今後の予定"
read_when:
  - 社内で IBM watsonx の製品を運用しており、Kurahi を並べて使うことを検討している
  - IBMとの連携点と、その状態の一覧が必要
title: "IBM watsonx"
---

# IBM watsonx 連携

English: [IBM watsonx](/integrations/ibm-watsonx)

Kurahi は、企業がすでに使っているIBMの環境を置き換えるのではなく、**並べて** 使うためのものです。
IBMが対応するオープンなプロトコル（A2A、MCP、OpenAPI、OpenTelemetry、Presto/Trinoのクライアントプロトコル）を使い、
それ以外は資料のあるIBMのREST APIを使います。すべて既定では無効で、管理者が有効にする必要があります。

連携パックは **プレビュー** として提供しています。IBMの公開資料とSDKに沿って実装し、すべての連携を Kurahi の適合テストで確認しています。

## 現在使えるもの

| IBMの製品             | 方向                  | Kurahi側                                                                | ページ                                                          | 状態       |
| --------------------- | --------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| watsonx Orchestrate   | Orchestrate → Kurahi  | A2A 0.3.0サーバーとAgent Card（`a2a` プラグイン）                       | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | プレビュー |
| watsonx Orchestrate   | Orchestrate → Kurahi  | リモートMCPツールキット（レガシー解析のMCPサーバー）                    | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | プレビュー |
| watsonx Orchestrate   | Orchestrate → Kurahi  | OpenAPI 3.0のaskエンドポイント（`server.rest`）                         | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | プレビュー |
| watsonx Orchestrate   | Kurahi → Orchestrate  | `orchestrate_agent_chat`（`watsonx-orchestrate` プラグイン）            | [watsonx Orchestrate](/ja/integrations/ibm-watsonx-orchestrate) | プレビュー |
| watsonx.ai            | Kurahi がモデルを使う | `watsonx` プロバイダー（IAM更新、リージョン、バージョン、プロジェクト） | [watsonx.ai](/ja/providers/watsonx)                             | プレビュー |
| watsonx.governance    | Kurahi が実行を報告   | Langfuse互換属性のOTLPスパン、Orchestrateへの送信                       | [watsonx.governance](/ja/integrations/ibm-watsonx-governance)   | プレビュー |
| watsonx.data          | Kurahi が読む         | `watsonx_data_query`（`ibm-data` プラグイン）                           | [watsonx.data と Db2](/ja/integrations/ibm-watsonx-data-db2)    | プレビュー |
| Db2 for z/OS、Db2 LUW | Kurahi が読む         | `db2_service_call`（`ibm-data` プラグイン）                             | [watsonx.data と Db2](/ja/integrations/ibm-watsonx-data-db2)    | プレビュー |

## すべてに共通する決まり

- **IBMのシステムは信頼できない呼び出し元・情報源として扱います。** Orchestrate からの要求は分離されたセッションで、
  信頼できないコンテンツとして、管理者が許可しない限りツールなしで実行し、人の権限（承認、判断、自律レベル、設定）は持ちません。
  IBMのシステムからの応答や行は、信頼できないコンテンツのマーカーで囲んでモデルに渡します。
- **秘密情報はシークレットストアに置きます。** IBM CloudのAPIキー、Db2のパスワード、トークンは `{ "$secret": "<名前>" }` で参照し、
  IAMのベアラートークンはメモリー上だけに保持して期限前に更新します。
- **探索ではなく許可リスト。** モデルが指定できるのは設定済みのOrchestrateのエージェント、Db2のサービス、watsonx.dataのカタログだけです。
- **監査とテレメトリーはIDと件数だけ。** プロンプトや応答の本文は、管理者が明示的に有効にした場合だけ外に出ます。
- **既定で無効、オートパイロットの外。** 新しいツールはオートパイロットの読み取りツールに含めていません。

## 設定のメモ

- **A2Aの認証：** Orchestrate では `BEARER_TOKEN` を推奨します。`API_KEY` を使うテナント向けに、`X-API-Key`（`apiKeyHeader: true`）も受け付けます。Kurahi は A2A 0.3.0 で応答します。
- **リモートMCPツールキット：** お使いのADKで `Authorization: Bearer` を送る接続の種類を選んでください。
- **watsonx.ai：** SaaSの東京リージョンではテキストチャットを使います。ソフトウェア版でトークンの発行方法が異なる場合は、`auth=bearer` でプラットフォームのベアラートークンを保存します。
- **トレース受付：** お使いのリージョンの Orchestrate のトレース受付URLを設定します。
- **watsonx.data と Db2：** エンジンの認証と Db2 LUW のRESTサービスについては[設定のメモ](/ja/integrations/ibm-watsonx-data-db2)を参照してください。

## 今後の予定

- **OpenShift：** Red Hat OpenShift 上で watsonx と並べて動かすためのHelmチャート、Red Hatの認定（chart-verifier）、その後にOperator
- ツールを使わないモデルAPI（watsonx.ai など）を使うオートパイロットの推論バックエンド（実行の証跡つき）
- watsonx.governance の外部プロンプトテンプレートによる Kurahi エージェントの評価登録
