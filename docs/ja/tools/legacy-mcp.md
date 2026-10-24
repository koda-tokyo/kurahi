---
summary: "kurahi-legacy：レガシー解析をMCPサーバーとしてVS Code、Eclipse系IDE、任意のMCPクライアントに提供。1サーバー1プロジェクト、読み取り専用、すべての事実にpath:line"
read_when:
  - エディタやIDEからレガシー解析を使う
  - COBOL / JCL プロジェクト向けにMCPクライアントを設定する
  - レガシーMCPサーバーが読み書きできる範囲を確認する
title: "エディタでレガシー解析（MCP）"
---

# エディタでレガシー解析（MCP）

English: [Legacy analyser in your editor (MCP)](/tools/legacy-mcp)

`kurahi legacy mcp` は、[レガシー解析](/tools/legacy-analyzer)をエンジニアが普段使っている
ツール（VS Code、Eclipse系のメインフレームIDE、Model Context Protocol（MCP）に対応した任意の
クライアント）に提供します。独立した製品用サーバーです。読むのは指定した1つのプロジェクト
フォルダだけで、ゲートウェイもKurahiの設定も不要、稼働中のKurahiサービスとは何も共有しません。

```bash
kurahi legacy mcp --root /path/to/project              # stdio（クライアントが起動）
kurahi legacy mcp --root /path/to/project --http 7465  # ループバックHTTP、http://127.0.0.1:7465/mcp
```

| オプション        | 意味                                                          |
| ----------------- | ------------------------------------------------------------- |
| `--root <dir>`    | プロジェクトフォルダ。必須。すべてのツールはこの中に限定。    |
| `--http <port>`   | stdioの代わりに `127.0.0.1:<port>` でストリーミングHTTPを提供 |
| `--max-bytes <n>` | 1回の応答の上限（バイト、既定65536、最小4096）                |

## ツール

すべて読み取り専用（`readOnlyHint`）で、共通の引数を3つ持ちます：`path`（ルートからの相対で
プロジェクト内のサブフォルダまたはファイル、既定はルート）、`offset` と `limit`（ページ送り）。

| ツール                | 返す内容                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy_index_status` | 対象範囲に最新のインデックスがあるか、件数。解析は行わない                                                                               |
| `legacy_index_build`  | COBOL、コピーブック、JCLを解析してインデックスを作成。プログラム、コピーブック、ジョブ、診断                                             |
| `legacy_query`        | 構造：呼び出し元・先、CALL/PERFORMグラフ、ファイルアクセス、データ項目と参照、ジョブステップ、データセット、未解決の参照                 |
| `legacy_rules`        | ルール候補：条件、定数を含む演算、丸め、88レベル値、定数                                                                                 |
| `legacy_dictionary`   | コピーブックのデータ辞書：レベル、PIC、USAGE、長さ、オフセット、位置、OCCURS、REDEFINES、値                                              |
| `legacy_impact`       | データ項目の変更が及ぶ範囲と、各項目を結ぶ根拠の事実                                                                                     |
| `legacy_design_doc`   | コードから生成する設計書（日本語／英語）。セクションごとに返却し、すべての事実に path:line を付記                                        |
| `legacy_wave_plan`    | 依存関係とリスクに基づく移行ウェーブの提案（人による確認が前提）                                                                         |
| `modernise_plan`      | 検出した言語、COBOL/JCL・Java・SQL DDL・FORTRAN・PL/I の棚卸し、言語をまたぐテーブル、カバレッジ、予定中のアシスタント（解析は行わない） |
| `modernise_crud`      | COBOL・PL/I・Java・JCL ユーティリティをまたぐ SQL テーブルの CRUD、およびファイル（COBOL・FORTRAN・PL/I）の CRUD と根拠                  |
| `modernise_impact`    | テーブル・列・ファイル・FORTRAN の COMMON ブロック・Java クラス・プログラムの変更が言語をまたいで及ぶ範囲                                |
| `modernise_inventory` | Java の型、SQL テーブル、FORTRAN の単位と COMMON ブロック、PL/I の手続きの一覧、または 1 件の詳細                                        |

ほかのツールは初回利用時にインデックスを作成します。`legacy_index_build` は再作成を強制します。
対象範囲のファイルが1つでも変わると、インデックスは自動的に作り直されます。

## 応答

各結果は短いテキスト要約（1つ目のコンテンツ）、完全なJSON（2つ目のコンテンツ）、同じJSONの
`structuredContent` を持ちます。形式は[英語版](/tools/legacy-mcp#responses)の例と同じです。

- **すべての事実に `at: "path:line"`** が付きます（プロジェクトルートからの相対パス）。解析器
  自身の `file` と `line` も残ります。引用し、エディタで開いてください。
- **ページ送り。** 結果の最上位のリストはすべて `offset` と `limit`（既定100、最大1000）で区切られ
  ます。`page.total` は最も長いリストの件数、`page.nextOffset` は次の位置（最後のページでは
  `null`）。
- **サイズ上限。** 1ページが `--max-bytes` を超える場合、まずページを小さくし（`reduced.reason`
  に記載、`nextOffset` も小さいページに合わせる）、次に長いテキスト（DOTグラフなど）を2,000文字で
  切り詰めます。1件でも収まらない場合は、範囲を絞るよう（`path`、`program`、小さい `limit`）
  求めるエラーになります。

## クライアント設定

### VS Code（`.vscode/mcp.json`）

```json
{
  "servers": {
    "kurahi-legacy": {
      "type": "stdio",
      "command": "kurahi",
      "args": ["legacy", "mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

ループバックHTTPの場合（先に `kurahi legacy mcp --root … --http 7465` を自分で起動）：

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "kurahi-legacy-token",
      "description": "kurahi-legacy token",
      "password": true
    }
  ],
  "servers": {
    "kurahi-legacy": {
      "type": "http",
      "url": "http://127.0.0.1:7465/mcp",
      "headers": { "Authorization": "Bearer ${input:kurahi-legacy-token}" }
    }
  }
}
```

### 任意のMCPクライアント（Eclipse系IDEを含む）

多くのクライアントは一般的な `mcpServers` 形式を受け付けます。プロジェクトフォルダは絶対パスで
指定します：

```json
{
  "mcpServers": {
    "kurahi-legacy": {
      "command": "kurahi",
      "args": ["legacy", "mcp", "--root", "/path/to/project"]
    }
  }
}
```

URLでしか接続できないクライアントはHTTP形式を使います：URL `http://127.0.0.1:<port>/mcp`、
ヘッダー `Authorization: Bearer <token>`。クライアントの `PATH` に `kurahi` がない場合は、
`command` に実行ファイルのフルパスを指定してください。

## セキュリティ

- **ルートは1つ、外には出ない。** 起動時にルートを実パスに解決します。`path` 引数はそれに対して
  解決し、外に出るものは拒否します：`../`、別の場所の絶対パス、ルート外を指すシンボリックリンク
  （実パスで確認）。解析器が読まないフォルダ（`_answer-keys`、`.git`、`node_modules`、`.kurahi`）
  も拒否します。インデクサはツリー内のシンボリックリンクをたどりません。
- **読み取り専用。** ツールはソースのテキストを解析するだけです。リポジトリ内のコード、
  スクリプト、JCLを実行せず、ネットワークに接続せず、ソースに書き込みません。
- **書き込み先はプロジェクトのKurahiフォルダだけ**：`.kurahi/legacy-mcp/cache/`（インデックス）
  と `.kurahi/legacy-mcp/audit.jsonl`。これらのフォルダはサーバー自身が作成し（モード0700）、
  `.kurahi` やその下のフォルダがシンボリックリンクの場合は起動しません。ファイルはリンクを
  たどらずに開きます。`.kurahi/` を `.gitignore` に追加してください。
- **監査ログ。** 1回の呼び出しにつきJSON 1行：時刻、ツール、引数のSHA-256（引数そのものは
  保存しない）、`ok`、結果のバイト数、所要時間、失敗時は `error`（`path-refused`、`error`、
  `overflow`）。
- **HTTPはループバックのみ**（`127.0.0.1`）。ベアラートークンが必須です（`KURAHI_LEGACY_MCP_TOKEN`、
  16文字以上。未設定なら起動時に生成して標準エラーに表示）。`Host` と `Origin` をループバック
  アドレスと照合し（DNSリバインディング対策）、`POST` のみ、`Content-Length` で1 MiBまでを受け
  付けます。TLSはありません。ポートを転送しないでください。

## 制限事項

- **事実であって意味ではない。** 解析器は構造と正確なソーステキストを報告します。業務上の意味は
  推測しません。解釈と引用は読み手が行います。
- **解析器の対応範囲。** 方言の対応、5,000ファイル・1ファイル4 MiBの上限、解析の診断は
  [レガシー解析](/tools/legacy-analyzer)と同じです。部分的なインデックスは診断にその旨が出ます。
- **鮮度の判定は保守的。** 呼び出しごとに対象範囲をたどり、全ファイル（ソース以外も）のサイズと
  更新時刻を比較します。何か変わればインデックスを作り直します。非常に大きなツリーでは `path`
  で範囲を絞ってください。インデックス作成は同期処理で、その間ほかの呼び出しは待ちます。
- **監査ログはサーバーが追記するだけで、改ざん検知はありません。** プロジェクトフォルダに書き込める
  人は編集できます。ゲートウェイのハッシュチェーン監査ログとは別物で、ローテーションもしません。
- **キャッシュは、フィンガープリントがツリーと一致すれば信頼されます。** プロジェクトに書き込める
  人は偽のキャッシュを置けます。`legacy_index_build` はソースから作り直し、
  `.kurahi/legacy-mcp/cache/` はいつ削除しても安全です。
- **ページ送りは1階層のみ。** 結果の最上位のリストを区切ります。入れ子のリストはそのまま返り、
  サイズ上限の対象になります。
- **HTTPはステートレス。** サーバーからの通知やセッションはなく、各リクエストは独立しています。
- クライアントとの互換性は、プロトコルのリファレンスクライアント（stdio、インメモリ、HTTP）で
  確認しました。すべてのエディタやIDEで確認したわけではありません。
