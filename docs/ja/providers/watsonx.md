---
summary: "IBM watsonx.ai をモデルプロバイダーとして使う：IAM APIキーを更新付きのベアラートークンに交換、リージョン別のベースURL（既定は東京）、versionの日付、プロジェクトまたはスペースのID、ツール呼び出し付きのストリーミングチャット、ソフトウェア版向けのOpenAI互換モデルゲートウェイ"
read_when:
  - 社内で watsonx.ai のモデルを運用しており、Kurahi のエージェントから使いたい
  - watsonx.ai のプロジェクト、リージョン、バージョンの設定を確認する
title: "IBM watsonx.ai"
---

# IBM watsonx.ai

English: [IBM watsonx.ai](/providers/watsonx)

Kurahi は watsonx.ai のモデルを専用のアダプター（モデルAPI `watsonx-chat`）で呼び出します。
watsonx.ai はOpenAI互換ではありません。呼び出しごとに `version` の日付、プロジェクトまたはスペースのID、
`model` ではなく `model_id`、ストリーミング用の別のパス、有効期限のあるIAMベアラートークンが必要です。
これらはアダプターが処理し、エージェントからは通常のプロバイダーとして見えます。

**状態：未検証。** IBMのAPIリファレンスと watsonx.ai の Node SDK をもとに作成し、記録した応答の形でテストしています。
実際のアカウントでの動作確認はまだです。

## 使うもの

| 項目                       | 値                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ベースURL                  | リージョン別。既定は `https://jp-tok.ml.cloud.ibm.com`（東京）                                                  |
| チャット（ストリーミング） | `POST /ml/v1/text/chat_stream?version=<日付>`（`event: message` のSSE）                                         |
| 本文                       | `model_id`、`project_id` または `space_id`、`messages`、`tools`、`max_tokens`、`temperature`                    |
| バージョン                 | 既定 `2024-03-14`（IBMが `/ml/v1` の有効な日付として示すもの）。設置ごとに変更可                                |
| 認証                       | IBM Cloud APIキーを `https://iam.cloud.ibm.com/identity/token` で交換。期限前に更新                             |
| ツール呼び出し             | OpenAIの関数形式で `tools` を送信。`tool_choice_option` は送らない（IBMは `auto` を未対応と記載）。モデルに依存 |
| モデル一覧                 | `GET /ml/v1/foundation_model_specs?version=2024-03-14&filters=function_text_chat`                               |
| モデルゲートウェイ         | `mode=gateway` で `POST /ml/gateway/v1/chat/completions`（OpenAI形式）                                          |

## 設定

エンドポイントの設定はプロバイダーのベースURLのクエリーパラメーターで指定するため、新しい設定キーはありません。

```bash
kurahi providers add watsonx \
  --base-url "https://jp-tok.ml.cloud.ibm.com?project_id=<プロジェクトID>" \
  --model ibm/granite-3-8b-instruct --api-key-stdin   # IBM Cloud APIキーを貼り付け
kurahi providers test watsonx                          # キーを交換し、チャット対応モデルを一覧
kurahi providers default watsonx --model ibm/granite-3-8b-instruct
```

APIキーは認証プロファイルストア（`watsonx:default`、`KOLO_HOME` 配下、権限0600）に保存し、`kolo.json` には書きません。
環境変数 `WATSONX_AI_APIKEY` も使えます。トークンはキーごとにメモリー上だけに保持し、残り5分を切ると更新します。
使えるモデルはリージョンごとに異なるため、モデルIDは `kurahi providers test watsonx` の結果から選んでください。

| パラメーター              | 意味                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `project_id` / `space_id` | 推論の課金と管理の単位。チャットモードではどちらか一方が必須（両方は不可） |
| `version`                 | APIのバージョン日付（`YYYY-MM-DD`）。既定 `2024-03-14`                     |
| `mode=gateway`            | テキストチャットの代わりにOpenAI互換のモデルゲートウェイを使う             |
| `auth=bearer`             | 保存した値がすでにベアラートークン。IAM交換をせずそのまま送る              |
| `iam_url`                 | 別のIAMトークンエンドポイント（httpsのみ）                                 |

## ソフトウェア版（Cloud Pak for Data、Software Hub）

IBMはソフトウェア版向けに `/ml/gateway/v1` のOpenAI互換モデルゲートウェイを案内しています。
ベースURLをクラスターに向けて `mode=gateway` を指定し、`iam_url` でプラットフォームのトークンエンドポイントを使うか、
`auth=bearer` でプラットフォームのベアラートークンを保存します。トークンの発行方法は設置ごとに異なり、この経路は未検証です。
SaaSの東京リージョンでゲートウェイが使えるかも未検証のため、そちらではテキストチャットを使ってください。

## 制限

- トークンの有効期限より長い実行でも、モデルを呼ぶたびにキャッシュから更新済みのトークンを使うため継続できます。
- オートパイロットの推論にはまだ使えません。現在の設計では、ツールなしのモードが検証済みのCLIバックエンドだけを認めています。
  ツールを送らないHTTPバックエンドは、実行の証跡とあわせて今後の予定です。
- デプロイメント（`/ml/v1/deployments/{id}/text/chat`）とAIサービスは未対応です。

全体の概要：[IBM watsonx 連携](/ja/integrations/ibm-watsonx)
