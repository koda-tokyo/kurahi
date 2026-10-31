---
summary: "ベンダーのモダナイゼーションツールが出力した分析結果を Kurahi のプロジェクトに取り込む: 対応形式と検証状況、バンドルのマニフェスト、すべての取り込みが通る検査、取り込んだデータの意味（レビューまで未検証）"
read_when:
  - 他のモダナイゼーションツールの結果を Kurahi のプロジェクトに取り込むとき
  - Kurahi が読めるベンダー出力形式と、それぞれの検証の範囲を確認するとき
  - 取り込んだ依存関係やルールの意味を説明するとき
title: "ベンダー分析結果の取り込み"
---

# ベンダー分析結果の取り込み

English: [Vendor results import](/industrial/vendor-import)

モダナイゼーション案件には、すでに他のツールの結果があることがよくあります（アセスメントのグラフ、生成された要件、AI が生成したプログラム文書など）。Kurahi はそれらをプロジェクトに取り込み、Kurahi 自身の解析結果と並べて扱えます。取り込みはオフラインです。お客様がベンダーのツールから結果をエクスポートし、そのファイルを Kurahi に渡します。Kurahi がベンダーのサービスに接続することはありません。

2026年11月1日時点: 開発中で、リリースには未収録です。

## 対応形式

各形式の検証状況は次の2つのいずれかです。

- **ドキュメントで検証済み**: ベンダーが公開している出力形式の説明に従って実装し、テスト用データもその構造に従っています。ドキュメントが定めていない部分は、ベンダーの値をそのまま保持し、解釈しません。
- **スキーマ未検証**: エクスポートの存在は公開されていますが、項目レベルのスキーマは公開されていません。お客様がバンドルに添付する項目対応ファイル（[マッピング取り込み](#マッピング取り込み)）を通してのみ読みます。推測したスキーマは同梱していません。

| プロバイダー（`--provider`） | 形式（`format`）        | 内容                                                                            | 検証状況                                 | ドキュメント                                                                                                       |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `google-mat`                 | `neo4j-jsonl`           | Mainframe Assessment Tool の Neo4j グラフ出力（JSON Lines）                     | ドキュメントで検証済み（レコードの外枠） | [Export assessment results](https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results)           |
| `google-mat`                 | `json-report`           | Mainframe Assessment Tool の JSON レポート（プログラムごとに1ファイル）         | スキーマ未検証（マッピング取り込み）     | [Export assessment results](https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results)           |
| `aws-transform`              | `requirements-md`       | AWS Transform for mainframe の業務機能ごとの `requirements.md`                  | ドキュメントで検証済み（文書の構成）     | [Mainframe workflow](https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html) |
| `aws-transform`              | `analysis-json`         | AWS Transform for mainframe のビジネスロジック JSON、依存関係 JSON など         | スキーマ未検証（マッピング取り込み）     | [Mainframe workflow](https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html) |
| `ibm-z`                      | `understand-docgen-md`  | watsonx Code Assistant for Z の Z Understand 文書生成（Markdown）               | ドキュメントで検証済み（配置と章名）     | [Generating documentation](https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/Docgen_create.html)           |
| `ibm-z`                      | `business-rules-export` | watsonx Code Assistant for Z の Z Understand ビジネスルール出力（.json / .csv） | スキーマ未検証（マッピング取り込み）     | [Identifying business rules](https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/rules_intro.html)           |

「ドキュメントで検証済み」の範囲:

- **`neo4j-jsonl`**: 1行ごとの外枠。ノードは `{"type":"node","id":…,"labels":[…],"properties":{…}}`、リレーションシップは `{"type":"relationship","start":{"id":…},"end":{"id":…},"label":…,"properties":{…}}` で、エクスポートのページにあるインポート用クエリのとおりです。ラベルの値とプロパティ名は公開されていないため、そのまま保存します。表示名は `properties.name` が文字列ならそれ、なければ `id` で、どちらを使ったかを記録します。ラベルが Kurahi の辺の名前（`CALLS`、`READS`、`WRITES`、`QUERIES` など）と一致する場合のみその名前を付け、それ以外（例: `EXECUTES`）はベンダーの表記のまま残します。ファイルにないノードへのリレーションシップは取り込まず報告します（ドキュメントのインポート手順でも作成されません）。
- **`requirements-md`**: 各 `requirements.md` の公開された構成（業務機能名のタイトル、グローバル前提条件、番号付きワークフロー節、各節のユーザーストーリーと一意の識別子を持つ EARS 形式の要件）。Markdown の書式は公開されていないため、見出しのレベルは問わず、数字で始まる見出しをワークフロー節、識別子（数字を含むトークン、例 `REQ-1.1`）と "shall" を含む行を要件として読みます。EARS のパターン（イベント駆動、状態駆動、望ましくない振る舞い、オプション機能、常時）は EARS のキーワードで分類します。識別子のない要件や重複した識別子は、取り込んだうえで報告します。
- **`understand-docgen-md`**: 公開された `Documentation` フォルダー（`application_document.md`、プログラムごとの `programs/<program_name>.md`、`logs/`（読みません））。章は公開された章名（Purpose、Inputs、Outputs、Business Rules、Business Variables、Processing Logic、Paragraphs、Dependencies、Constraints、Error Handling、Examples、アプリケーションでは Overview、Processing Flow、Components）でのみ認識します。Business Rules の各項目はルール候補になります。Dependencies の項目は、単一の名前で始まる場合（例 `TAXCALC - computes the tax`）のみ `DEPENDS_ON` の辺にし、文章の項目は辺にせず報告します。HTML 出力は読みません。

対応していないもの: Mainframe Assessment Tool の HTML レポート、AWS Transform の `traceability.yaml`、PDF 文書、SMF 分析出力（表としてマッピングする場合を除く）、上の表にないすべての形式。

### ベンダーサービスの直接実行は利用できません

Kurahi はベンダーのサービスを呼び出しません。プロバイダー一覧では次のモードを理由付きで無効として表示し、通信を行う前に拒否します。

| プロバイダー ID        | モード     | 状態 | 理由                                                                                           |
| ---------------------- | ---------- | ---- | ---------------------------------------------------------------------------------------------- |
| `ibm-z-remote`         | REMOTE_MCP | 無効 | 第三者クライアントからの接続、エンドポイント、認証、制限、ライセンス条件が承認済み環境で未検証 |
| `ibm-watsonx-ai`       | REMOTE_API | 無効 | 未設定。別契約のモデルエンドポイントであり、Code Assistant for Z ではありません                |
| `aws-transform-remote` | REMOTE_API | 無効 | 計画中、未提供                                                                                 |
| `google-mat-remote`    | REMOTE_MCP | 無効 | 計画中、未提供（ベンダーの MCP サーバーは Preview と記載）                                     |

`kurahi industrial providers` で一覧を表示します。

## 取り込んだデータの意味

取り込んだデータはベンダーのツールの主張であり、Kurahi が確認した事実ではありません。取り込んだ項目、辺、ルール、所見にはすべて次が付きます。

- 出所 `IMPORTED_VENDOR_ARTEFACT`
- 確度 `UNVERIFIED`（担当者がレビューするまで）
- 元になったバンドル内のファイル、その SHA-256、行番号またはレコード番号

モダナイゼーションのツールは、これを解析器の事実と分けて扱います。`modernise_inventory` の `kind: imported` は取り込んだ項目を一覧し、名前を指定するとそのルールも返します。`modernise_impact` は解析結果の横に `imported` ブロックを加え、対象に対するベンダーの上流・下流の辺とルールを示します。エージェントにはこれらをベンダーの主張として引用するよう指示しています。

## 取り込み方

1. ベンダーのツールから結果をエクスポートし、ファイルは変更しないでください。
2. フォルダーにまとめ、ルートに `kurahi-import.json` というマニフェストを置きます（下記）。フォルダーは zip にしても構いません。
3. 取り込みます。エージェントから（プロジェクトのチャットで、計画 Plan または 実行 Act モード。バンドルはプロジェクトのフォルダー内に置きます）:

   ```text
   modernise_import  path: imports/assessment.zip  provider: google-mat
   ```

   またはコマンドラインから:

   ```bash
   kurahi industrial import --project <project-id> --provider google-mat --bundle ./assessment.zip
   kurahi industrial imports --project <project-id>
   ```

   終了コード: 0 取り込み済み（または既に取り込み済み）、1 拒否、2 使い方の誤り。

### マニフェスト

```json
{
  "schema": "kurahi.vendor-import/1",
  "provider": "google-mat",
  "format": "neo4j-jsonl",
  "origin": {
    "product": "Mainframe Assessment Tool",
    "productVersion": null,
    "exportedAt": "2026-10-30T09:00:00Z",
    "exportedBy": "alice",
    "authorisedBy": "ops-lead",
    "sourceSystem": "payroll"
  },
  "files": [
    {
      "path": "graph/assessment.jsonl",
      "sha256": "<16進64文字>",
      "bytes": 1234,
      "role": "data"
    }
  ]
}
```

`files` にはバンドル内のすべてのファイルを、サイズと SHA-256 付きで列挙します。`role` は `data`（既定）、`mapping`（マッピング取り込みの項目対応ファイル）、`ignored`（保存するが読まない。ログなど）のいずれかです。`authorisedBy` はエクスポートを Kurahi に渡すことを許可した人で、記録はしますが検証はしません。

## すべての取り込みが通る検査

いずれかの検査に失敗すると、固定のコード、理由、対処方法とともに取り込みを拒否します。

| 検査                                                                                                                                                                                                                       | 失敗時のコード              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| プロバイダーと形式が一覧にあり、オフライン取り込みが許可されている                                                                                                                                                         | `CAPABILITY_UNAVAILABLE`    |
| アーカイブの安全性: 絶対パスや `..` がない、シンボリックリンクがない、暗号化エントリーがない、ZIP64 でない、5,000 ファイル以内、アーカイブ 200 MB・展開後 512 MB・1ファイル 128 MB 以内、圧縮率 100 倍以内（zip 爆弾対策） | `ARTEFACT_INTEGRITY_FAILED` |
| マニフェストのとおりのファイルがあり、サイズと SHA-256 が一致し、記載のないファイルがない                                                                                                                                  | `ARTEFACT_INTEGRITY_FAILED` |
| 添付ファイル用スキャナーとその設定（`security.attachments`）によるマルウェア検査。`requireScan` が有効でスキャナーがない場合も拒否                                                                                         | `POLICY_DENIED`             |
| ファイルが UTF-8 テキストで、その形式の構造を持つ                                                                                                                                                                          | `SCHEMA_REJECTED`           |

構造が不明なものは未対応として拒否し、スキーマを推測することはありません。取り込みと拒否はすべて監査ログに記録し、署名付きの証跡バンドルとして封印します（`kurahi evidence verify` で確認できます）。ファイルはプロジェクトのフォルダーではなく、プロジェクトの状態ディレクトリーに内容ハッシュで保存します。同じバンドルを再度取り込むと（zip でもフォルダーでも）既存の取り込みを返します。取り込み ID はプロバイダー、形式、ファイルのハッシュから決まります。

## マッピング取り込み

スキーマが公開されていない出力には、項目対応ファイルをバンドルに加えます（マニフェストで `role` を `mapping`）。データファイルごとに、どの列・項目がどの値を持つかを指定します。

```json
{
  "schema": "kurahi.vendor-import-mapping/1",
  "tables": [
    {
      "file": "business-rules.csv",
      "format": "csv",
      "produces": "rules",
      "fields": { "title": "Rule Name", "text": "Description", "subject": "Program" }
    },
    {
      "file": "dependencies.json",
      "format": "json",
      "records": "dependencies",
      "produces": "edges",
      "fields": { "from": "source", "to": "target", "relation": "type" }
    }
  ]
}
```

- `format`: `csv`（`delimiter` は `,` `;` `|` またはタブ）、`json`（`records` に一覧へのドット区切りパス）、`jsonl`。
- `produces` と項目: `items`（name、任意で kind、id）、`edges`（from、to、任意で relation）、`rules`（text、任意で vendorId、subject、title、ruleType）、`findings`（title、任意で detail、severity、subject）。`=` で始まる値は定数です（`"relation": "=CALLS"`）。
- `file` には、1階層内の `*` と、任意の階層の `**/` が使えます。

指定した列がない、必須の値が空、マッピングされていないデータファイルがある（マッピングするか `ignored` にします）、どのファイルにも一致しない表がある場合は拒否します。例の列名は説明用です。お手元のエクスポートの列名を使ってください。
