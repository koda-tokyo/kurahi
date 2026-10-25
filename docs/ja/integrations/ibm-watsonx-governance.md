---
summary: "IBM watsonx.governance 向けのガバナンス証跡：エージェント実行とオートパイロット実行のスパンを、Langfuse互換の属性でOTLP/HTTP送信（LangfuseまたはArize連携向け）。watsonx OrchestrateのトレースへのIAM付き送信も任意で可能。プロンプトと応答の本文は管理者が明示的に有効にしない限り送らない"
read_when:
  - AIガバナンスの担当部門が watsonx.governance を使っており、Kurahi のエージェントの活動を取り込みたい
  - 監視のために Kurahi から外に出る実行データを決める
title: "watsonx.governance"
---

# IBM watsonx.governance

English: [watsonx.governance](/integrations/ibm-watsonx-governance)

watsonx.governance には外部エージェント向けのOpenTelemetryの受け口がありません。IBMはエージェントの監視を
LangfuseとArizeとの連携で提供しており、watsonx Orchestrate は外部エージェントからのOTLP/HTTPトレースを受け付けます。
そこで Kurahi は、既存の `diagnostics-otel` プラグインで実行をOpenTelemetryのスパンとして、Langfuseが対応づける属性名で送ります。

- ガバナンス連携が読むLangfuse（またはArize、その他のOTLP）のエンドポイントへ
- 任意で Orchestrate のトレース受付へ（Orchestrate自身のトレースと並べて見られます）

**状態：未検証。** 属性名はLangfuseのOpenTelemetryの資料とOrchestrateのトレース受付の資料に基づき、
メモリー上のエクスポーターでテストしています。実サービスでの確認はまだです。

## 送る内容

実行が終わるごとに1スパンです。

| スパン                 | 対象                                                    | Langfuseの種類 |
| ---------------------- | ------------------------------------------------------- | -------------- |
| `kurahi.agent.run`     | 組み込みのエージェント実行（チャネル、A2A、セッション） | `agent`        |
| `kurahi.autopilot.run` | オートパイロットのルーチン実行                          | `chain`        |

既定では **ID、時間、判断、件数だけ** を送ります。

- エージェント実行：プロバイダー、モデル、入出力トークン数、実行・エージェント・ジョブ・レーンのID、結果
  （`completed`、`error`、`aborted`、`timeout`）、エラーの種類、ステップ数、ツール呼び出し数、所要時間
- オートパイロット実行：プロジェクト、ルーチン、エディション、領域、自律レベル、起動方法、状態、推論のバックエンドと時間、
  収集の呼び出し数、作成した作業項目数、判断の件数、ウォッチドッグの判定、実行証跡のルートハッシュ（Kurahi内の署名付き証跡と結びつく）

送らないもの：プロンプト、応答、収集したデータ、ツールの引数と結果、エラーメッセージ、人の名前。
本文は管理者が `diagnostics.otel.captureContent: true` にした場合だけ、エージェント実行のスパンに
`maxContentChars`（既定4000文字）で切り詰めて付けます。オートパイロットのスパンには付けません。

## 設定（Langfuse）

```json5
{
  plugins: { entries: { "diagnostics-otel": { enabled: true } } },
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "https://langfuse.example.com/api/public/otel",
      headers: { Authorization: { $secret: "langfuse-otlp-basic" } }, // "Basic <base64 public:secret>"
      traces: true,
      metrics: false, // Langfuseはトレースのみ受け付ける
    },
  },
}
```

## watsonx Orchestrate のトレース受付への送信

```json5
{
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      orchestrate: {
        enabled: true,
        url: "https://<orchestrate-host>/instances/<instance-id>/v1/orchestrate/inject/traces",
        apiKey: { $secret: "orchestrate-api-key" }, // IBM Cloud APIキー
        tenantId: "<テナントID>",
        environment: "draft",
        agentId: "<OrchestrateのエージェントID>",
      },
    },
  },
}
```

- 送信専用のトレーサーを使うため、`kurahi.agent.run` と `kurahi.autopilot.run` 以外は届きません。
- APIキーはIBM Cloud IAMでベアラートークンに交換し、期限前に更新します（`auth: "api-key"` で従来の `x-api-key` 方式）。
- リソース属性 `tenant.id` と `deployment.environment`、スパン属性 `agent.id`、`langfuse.session.id`、`langfuse.user.id` を付けます。
- URLはhttpsで、資料どおりの形でなければ送信を無効にし、ゲートウェイのログに警告を出します。

全体の概要：[IBM watsonx 連携](/ja/integrations/ibm-watsonx)
