---
summary: "IBM watsonx Orchestrate と Kurahi の併用：Kurahi のエージェントを外部のA2A 0.3.0協力エージェントとして登録、Kurahi のMCPツールをリモートツールキットまたはOpenAPIツールとして取り込み、許可した Orchestrate のエージェントを Kurahi から呼び出す。Orchestrate は常に信頼できない呼び出し元として扱う"
read_when:
  - watsonx Orchestrate を運用しており、そのエージェントから Kurahi のエージェントやツールを呼びたい
  - Kurahi のエージェントから Orchestrate のエージェントを呼びたい
  - Orchestrate が Kurahi の何にアクセスでき、何にアクセスできないかを確認する
title: "watsonx Orchestrate"
---

# IBM watsonx Orchestrate

English: [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate)（設定例を含む完全版）

Kurahi は既存の watsonx Orchestrate と並べて使うもので、置き換えるものではありません。Orchestrate が対応する
オープンなプロトコルを使い、Kurahi にIBMのコードは加えていません。

| 方向                 | 方法                                                                          | Kurahi側                                          |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| Orchestrate → Kurahi | 外部エージェント、プロバイダー `external_chat/A2A/0.3.0`（JSON-RPC 2.0/HTTP） | [A2Aプラグイン](/ja/plugins/a2a)のサーバー        |
| Orchestrate → Kurahi | リモートMCPツールキット（ストリーミングHTTP）                                 | [レガシー解析のMCPサーバー](/ja/tools/legacy-mcp) |
| Orchestrate → Kurahi | OpenAPIツールの取り込み                                                       | A2Aプラグインのaskエンドポイント（`server.rest`） |
| Kurahi → Orchestrate | `POST /v1/orchestrate/{agent_id}/chat/completions`                            | `watsonx-orchestrate` プラグイン                  |

**状態：提供中。** このページの経路はすべてIBMが公開している Orchestrate の資料に沿って実装し、Kurahi の適合テストで確認しています。

## Orchestrate は信頼できない呼び出し元

どの経路でも、Orchestrate は専用のトークンを持つ外部クライアントとして Kurahi に届きます。

- 要求は分離されたセッション（`agent:<agentId>:a2a:<clientId>:<contextId>`）で実行し、エージェントのメインセッションは使いません。
  内容は信頼できない外部コンテンツとして囲みます。
- エージェントに `allowTools: true` を設定しない限りツールは使えません。有効にしても、すべての呼び出しは
  他のセッションと同じポリシーガードと承認を通ります。
- 人の権限は持ちません。作業項目の承認や判断、フラグの解除、自律レベルの受け入れ、設定の変更、運用者としての操作はできません。
- 監査ログにはID、件数、結果だけを残し、メッセージ本文は残しません。

## Kurahi のエージェントを Orchestrate に登録する（A2A 0.3.0）

Orchestrate は外部エージェントを、ネイティブのエージェントの協力エージェントとして呼び出します。
A2A 0.3.0（JSON-RPC 2.0 over HTTP）に対応しています。Kurahi のA2Aサーバーは0.3のメソッド名
（`message/send`、`message/stream`、`tasks/get`、`tasks/cancel`）に応答し、`A2A-Version` ヘッダーのない要求には0.3.0のAgent Cardを返します。

1. ゲートウェイをTLSのリバースプロキシの背後に置き、`gateway.trustedProxies` にプロキシを登録し、`publicUrl` に公開URLを設定します。
   A2Aサーバーで `allowNonLoopback: true`、Orchestrate 用のクライアント（32文字以上のトークンをシークレットストアに保存）を設定します。
2. `orchestrate agents discover -u https://agents.example.com/a2a/<slug>` でAgent Cardを読み込むか、
   `provider: external_chat/A2A/0.3.0`、`auth_scheme: BEARER_TOKEN`、`chat_params: { sendHistory: false, stream: true, pushNotifications: false }`
   の外部エージェント定義を `orchestrate agents import -f` で取り込みます。
3. ネイティブのエージェントの協力エージェントに追加します。

| Orchestrate の設定               | 使い方                      | 理由                                                                                                    |
| -------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `auth_scheme: BEARER_TOKEN`      | 推奨                        | `Authorization: Bearer` で送られる                                                                      |
| `auth_scheme: API_KEY`           | `apiKeyHeader: true` と併用 | `X-API-Key` で受け付ける。テナントがA2Aエージェントにこのヘッダーを送らない場合は `BEARER_TOKEN` を使う |
| `auth_scheme: NONE`              | 非対応                      | Kurahi のA2Aは常にクライアントトークンが必要                                                            |
| `app_id`（ユーザー代理トークン） | 非対応                      | Kurahi はA2AでIdPのJWTを検証しない。Orchestrate は固定のクライアントトークンで識別する                  |
| `chat_params.stream`             | `true` / `false`            | `true` は `message/stream`（SSE）、`false` は `message/send`。どちらにも対応                            |
| `chat_params.pushNotifications`  | `false`                     | Kurahi はプッシュ通知を送らない                                                                         |
| `chat_params.sendHistory`        | `false`                     | Kurahi は `contextId` ごとのセッションで会話を保持する                                                  |

`metadata` で送られるコンテキスト変数や相関IDは受け付けますが、モデルには渡しません。

## リモートMCPツールキット

Orchestrate はリモートMCPサーバーをストリーミングHTTPまたはSSEで取り込み、ツール一覧を最大30秒待ちます。4xxの応答は取り込み失敗になります。
[レガシー解析のMCPサーバー](/ja/tools/legacy-mcp)はステートレスのストリーミングHTTPでJSONを返し、プロジェクトの索引を作る前にツール一覧に応答します。
待ち受けは `127.0.0.1` だけなので、同じホストにTLSのリバースプロキシを置き、公開ホスト名を `--allow-host` で指定します。

```bash
KURAHI_LEGACY_MCP_TOKEN='<トークン>' \
  kurahi legacy mcp --root /srv/project --http 7465 --allow-host mcp.example.com
orchestrate toolkits add --kind mcp --name kurahi_legacy \
  --description "Read-only legacy code analysis" \
  --url "https://mcp.example.com/mcp" --transport "streamable_http" \
  --tools "*" --app-id kurahi_legacy
```

IBMの資料は `--app-id` の接続種別に `key_value` を挙げる一方、リモートMCPの認証方式にベアラートークンも挙げています。
お使いのADKで、リモートサーバーに `Authorization: Bearer` を送る接続の種類を選んでください。

## OpenAPIツールの取り込み

`server.rest: true` にすると、エージェントごとに `POST /a2a/<slug>/ask` と、OpenAPI 3.0の記述 `GET /a2a/<slug>/openapi.json` を提供します。
記述は資料にある取り込みの条件（OpenAPI 3.0、変数のないサーバーURLが1つ、operationIdと説明、JSONの入出力）を満たします。
`orchestrate tools import -k openapi -f <ファイル> -a <接続>` で取り込みます。

ゲートウェイ自身のOpenAPI記述（`openapi/kolo-gateway.openapi.json`）は取り込まないでください。運用者向けのAPIであり、Orchestrate に運用者の権限を渡すことになります。

## Kurahi から Orchestrate のエージェントを呼ぶ

`watsonx-orchestrate` プラグイン（既定は無効）は、任意のツール `orchestrate_agent_chat` を1つ追加します。

- モデルが指定できるのは設定済みのエージェント名だけで、URLやエージェントIDは指定できません。
- APIキーはIBM Cloud IAMでベアラートークンに交換し、期限前に更新します。401のときは1回だけ再交換して再試行します。
- 応答の `threadId` を渡すと同じスレッド（`X-IBM-THREAD-ID`）で続けられます。
- 応答とエラー本文は信頼できないコンテンツとしてモデルに渡します。応答の大きさと時間に上限があり、リダイレクトは拒否します。
- 監査ログ `orchestrate.chat` はエージェント名とID、スレッドID、結果、文字数だけを残します。
- Orchestrate のエージェントは他のシステムを操作できるため、オートパイロットの読み取りツールには含めていません。
  受信したA2A要求を処理するセッションにも提供しません。

全体の概要：[IBM watsonx 連携](/ja/integrations/ibm-watsonx)
