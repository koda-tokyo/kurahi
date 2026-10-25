---
summary: "Kurahi Scholars の学術情報源プラグイン：arXiv・OpenAlex・Crossref・PubMed（無料の公開 API、キー不要）での論文検索と取得、引用チェック、オープンアクセス PDF の検疫・マルウェア検査付き取り込み、研究費の締切リマインダー。各提供元のレート制限を内蔵"
read_when:
  - 研究・学術テンプレートやそのオートパイロットのルーティンを設定するとき
  - Kurahi がどの文献 API を、どの頻度・どの識別情報で呼ぶかを知りたいとき
  - PDF を取得する条件と拒否する条件を知りたいとき
title: "学術情報源"
---

# 学術情報源（Scholar sources）

English: [Scholar sources](/connectors/scholar-sources)

| 項目          | 内容                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| プラグイン ID | `scholar-sources`（同梱、**既定は無効**。**研究・学術**テンプレートがそのプロジェクトに限って有効化）                                  |
| アクセス      | すべての提供元に対して読み取りのみ。アカウント、API キー、認証情報は不要                                                               |
| 書き込み      | 1 つだけ：オープンアクセス PDF をプロジェクトの `corpus-inbox/` へ。必ず[添付ファイルの受け入れ](/ja/security/attachment-intake)を経由 |
| 提供元        | arXiv API、OpenAlex、Crossref REST API、NCBI E-utilities（PubMed）、doi.org のコンテントネゴシエーション                               |
| 状況          | 提供中                                                                                                                                 |

## ツール

| ツール                    | 内容                                                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scholar_search`          | `query` または最大 5 件の `queries`、`sources`（arxiv、openalex、crossref、pubmed。既定はすべて）、`since`（YYYY-MM-DD）、`limit`（25 以下）。正規化したレコードを DOI・arXiv ID・PMID・OpenAlex ID で統合                       |
| `scholar_get`             | DOI・arXiv ID・PMID・OpenAlex ID で 1 本の論文を取得。抄録（最大 4,000 文字）を含む完全なレコード                                                                                                                                |
| `scholar_cite_check`      | 最大 50 件の `citations`、またはプロジェクト内の原稿の `path`（ファイル、またはフォルダー：その最新の文書）。参考文献ごとに `verified`・`mismatch`・`not_found` と理由。`list: true` で原稿の版を一覧、`draft` で 1 つの版を確認 |
| `scholar_fetch_pdf`       | 1 本の論文のオープンアクセス PDF を `corpus-inbox/` へ（下記）。返すのは保存先のパスのみで、内容は返さない                                                                                                                       |
| `scholar_grant_deadlines` | 研究者本人の締切一覧（例：`knowledge/grants.md`）から、締切の 30・14・7・3・1 日前と当日のうち今日が該当するリマインダーを返す。各リマインダーの ID は固定                                                                       |

レコードには、`id`（DOI があれば DOI、なければ `arxiv:`・`pmid:`・`openalex:`）、タイトル、著者（最大 10 名と総数）、
掲載誌・会議、日付、提供元が示すすべての年、DOI・arXiv ID・PMID・OpenAlex ID、URL、オープンアクセスの状況、
分かる場合はオープンアクセス PDF とライセンス、抄録の抜粋（検索では最大 800 文字）が入ります。提供元のテキストは
すべて信頼できないコンテンツの境界の中でモデルに渡され、タイトルや抄録に含まれる境界マーカーは無効化されます。
監査ログ（`connector.scholar-sources.<op>`）には ID・件数・バイト数のみを記録し、検索語・タイトル・抄録は記録しません。

ツールはプロジェクトのチャットと[オートパイロット](/ja/autopilot)のルーティンで使えます。5 つすべてがこのプラグインの
読み取りツールとして登録されており、`gather` から呼び出せます。

## 提供元とその利用ルール

2026年10月25日に各提供元の文書で確認しました。Kurahi は提供元ごとに一度に 1 リクエストだけを送り、
提供元ごとのレート制限はゲートウェイのプロセス全体で 1 つです（並行するチャットやルーティンも同じ枠を共有）。

| 提供元           | エンドポイント                                                             | 提供元の求めること                                                                                                                                                                                      | Kurahi                                          |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| arXiv            | `export.arxiv.org/api/query`（Atom）                                       | 3 秒に 1 リクエストまで、接続は 1 本、利用者の全マシン合計で（[利用規約](https://info.arxiv.org/help/api/tou.html)）                                                                                    | 3 秒に 1 回。説明的な User-Agent                |
| OpenAlex         | `api.openalex.org/works`                                                   | キーなしで毎秒 10 リクエスト。キーなしの呼び出しは IP アドレスごとに小さな 1 日の予算を共有（[制限](https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication)）                      | 毎秒 5 回。キーなし                             |
| Crossref         | `api.crossref.org/works`                                                   | 公開プールは間隔あたり 5・同時 1、polite プール（`mailto` 付き）は 10・同時 3。429 なら待つ（[アクセス](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)） | 毎秒 3 回、同時 1。設定があれば `mailto`        |
| NCBI E-utilities | `eutils.ncbi.nlm.nih.gov/entrez/eutils`（`esearch`、`efetch`）             | API キーなしでは毎秒 3 リクエストまで。すべての呼び出しに `tool` と `email`（[利用方法](https://www.ncbi.nlm.nih.gov/books/NBK25497/)）                                                                 | 毎秒 3 回。すべての呼び出しに `tool` と `email` |
| doi.org          | `https://doi.org/<doi>`、`Accept: application/vnd.citationstyles.csl+json` | Crossref、DataCite、mEDRA などのコンテントネゴシエーション（[文書](https://citation.doi.org/docs.html)）                                                                                                | 毎秒 3 回。Crossref と OpenAlex にない DOI のみ |

429 と 5xx には最大 2 回まで再試行し（`Retry-After` は 30 秒まで従う）、その後 `rate_limited` または
`provider_unavailable` を返します。検索で応答しない提供元は名前を示し（`Not available this time: arxiv (rate_limited)`）、
他の提供元の結果は返します。

記録時の注記：arXiv は数分間隔の検索クエリにも `429 Rate exceeded.`（`Retry-After` なし）を返し、`id_list` での取得は
成功しました。OpenAlex はキーなしの応答ごとに、そのアドレスが 1 日 US$0.10（一覧リクエスト約 100 回分）の予算を
共有していると通知します。週 1 回の新着文献ウォッチはどちらの範囲にも十分収まります。

## 設定

```json5
{
  plugins: {
    entries: {
      "scholar-sources": {
        config: {
          contactEmail: "lab@example.ac.jp", // Crossref の mailto、NCBI の email、User-Agent
          ncbiTool: "kurahi-scholar-sources", // tool と email を NCBI に登録
          sources: ["arxiv", "openalex", "crossref", "pubmed"], // scholar_search の既定
          timeoutSeconds: 30,
        },
      },
    },
  },
}
```

必須の設定はありません。`contactEmail` がなくても動作します（Crossref の公開プール、`email` なしの NCBI）。
設定する場合は研究者本人または研究室のアドレスを使ってください。

## 引用チェック

`scholar_cite_check` は参考文献を識別子で解決します。DOI は Crossref（`/works/{doi}`）、次に doi.org の
コンテントネゴシエーション（DataCite など）、arXiv ID は arXiv API、PMID は PubMed です。そのうえで参考文献の
記載とレコードを比べます。参考文献に識別子以外の文字があれば、レコードのタイトルの単語の 60% 以上が含まれている
こと、参考文献に書かれた年がレコードのいずれかの年（発行・オンライン・印刷・初版）と一致することを確認します。
識別子のない参考文献は Crossref（`query.bibliographic`）で検索し、近い一致（タイトルの単語の 80% と年）の場合だけ
`verified` とします。提供元のエラーは「確認できなかった」と報告し、誤った参考文献とはしません。

原稿からは、最後の参考文献の見出し（`References`、`Bibliography`、`参考文献`、`引用文献`、`文献`）より後を読み、
番号付きまたは箇条書きの 1 行を 1 件とします。

## オープンアクセスの PDF のみ

`scholar_fetch_pdf` が PDF を保存するのは、オープンアクセスの場合だけです。

- arXiv の e-print（arXiv の規約は研究目的での取得を認めています。コピーは研究者自身のプロジェクトにとどまり、再配布しません）
- 最良のオープンアクセス版（OpenAlex）または Crossref のライセンスが**オープンライセンス**（クリエイティブ・コモンズまたはパブリックドメイン）で、PDF への直接のリンクがある論文

それ以外は 1 バイトもダウンロードする前に拒否します。ライセンスのない無料公開版も拒否します。ダウンロードは
SSRF ガード（公開ホストのみ、リダイレクトは 5 回まで）を通り、20 MB までで、先頭が `%PDF-` でなければ
（ランディングページなど）拒否します。その後バイト列は[添付ファイルの受け入れ](/ja/security/attachment-intake)を通ります。
検疫、静的ポリシー、マルウェア検査（失敗時は拒否）を経て、問題がない場合だけ `corpus-inbox/`（書き込み可能な
フォルダー、実行モード）にコピーされます。受け入れで拒否された場合は、他の添付ファイルの拒否と同じく監査・封印され、
オートパイロットの実行では項目に `malicious_attachment` が付きます。

## 研究費の締切

`scholar_grant_deadlines` は締切 1 件につき `- YYYY-MM-DD | 名称 | メモ` の 1 行を読み（HTML コメント内の行は無視）、
指定したタイムゾーン（既定は `Asia/Tokyo`）で今日が該当するリマインダーを計算します。締切まで `n` 日なら、`n` 以上の
最小の間隔（30・14・7・3・1、当日は 0。`remindDays` で変更可）に入ります。各リマインダーの ID
（`grant:<名称>:<日付>:d<間隔>`）は固定なので、ID ごとに展開するルーティンは各リマインダーを 1 回だけ起票します。
何も申請しません。

## 行わないこと

論文や申請書を提出しません。誰にも連絡しません。有料の論文を取得しません。認証情報を送りません。
[オートパイロット](/ja/autopilot#scholars)の Scholars の禁止事項も参照してください。
