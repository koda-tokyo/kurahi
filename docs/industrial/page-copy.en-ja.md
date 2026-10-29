# Industrial edition page copy

Draft for the website owner. The screenshots use fictional payroll data and production UI components in a local visual fixture. They demonstrate the interface; they are not evidence of a live deployment or an approved production change.

## English

### Understand the system before you change it

Kurahi Industrial brings source analysis, design documents and review into one project workspace. Start with your existing code, trace findings to their source lines, and prepare a modernization plan your team can check.

### Read the evidence alongside the design

Generate a design document from COBOL, copybooks and JCL. Follow file and line references to the program structure, data definitions and job flow. The document identifies questions that static analysis cannot answer so your team can resolve them before making changes.

### Review changes before approval

Keep document versions together, compare their contents and send the result for human review. A visible difference is a reason to inspect the change; it does not prove that the changed system is correct.

### Start with a fictional payroll system

Explore four COBOL programs, two copybooks and a four-step JCL job for fictional Kazanami Precision Works. Open the generated design document, inspect its source references and review an illustrative source revision. The sample contains no customer or employee records from a real organization.

Primary action: Explore the payroll sample

Secondary action: Read the design document

### What is available

Built-in source analysis and design-document generation support the sample shown here. Other analysis domains display their current availability in the workbench. Transformation and maintenance workflows require project setup checks; offline controls review requires an approved export and validation environment. Production changes require impact and validation evidence, a rollback plan and explicit approval.

### Screenshot captions

- Workbench: Industrial project workspace with fictional payroll documents. Connection and artifact state are simulated.
- Design document: Generated payroll design document and numbered source excerpt, arranged as adjacent production artifact panels for this demonstration.
- Change review: Production version comparison showing an illustrative edit to the fictional source. This is a review example, not an automatic monitoring or correctness claim.

## 日本語

### 変更の前に、システムを理解する

Kurahi Industrial は、ソース解析、設計書、レビューをプロジェクト単位でまとめます。既存コードから始め、解析結果の根拠行を確認しながら、チームで検討できる刷新計画を作成できます。

### 設計書と根拠を照らし合わせる

COBOL、コピーブック、JCL から設計書を生成します。ファイル名と行番号をたどり、プログラム構造、データ定義、ジョブフローを確認できます。静的解析だけでは判断できない事項は要確認として示されるため、変更前に担当者が確認できます。

### 差分を確認してから承認する

文書の版を管理し、内容を比較して、人によるレビューにつなげます。差分の表示は変更を確認するための手掛かりであり、変更後のシステムの正しさを保証するものではありません。

### 架空の給与計算システムで試す

架空の風波精工を題材に、4 本の COBOL プログラム、2 本のコピーブック、4 ステップの JCL ジョブを確認できます。生成された設計書を開き、ソースの根拠行を調べ、例示用の変更差分をレビューできます。サンプルには、実在する組織の顧客情報や従業員情報は含まれていません。

主な操作：給与計算サンプルを見る

補助操作：設計書を読む

### 利用できる機能

掲載サンプルでは、内蔵ソース解析と設計書生成を利用できます。他の解析領域の利用状況はワークベンチに表示されます。変換・保全ワークフローにはプロジェクトの設定確認が必要です。制御システムのオフラインレビューには、承認済みの出力と検証環境が必要です。本番変更には、影響と検証の証跡、ロールバック計画、明示的な承認が必要です。

### 画面の説明

- ワークベンチ：架空の給与計算文書を配置した産業プロジェクト画面です。接続状態と成果物の状態はデモ用です。
- 設計書：生成済みの給与計算設計書と行番号付きソース抜粋を、製品の成果物パネルを使って並べたデモです。
- 変更レビュー：架空のソースに加えた例示用の変更を、製品の版比較機能で表示しています。自動監視や変更の正しさを示すものではありません。

## Claim references for integration

- `docs/tools/legacy-design-docs.md`: generation, source references, static-analysis limits.
- `packages/legacy-analyzer/examples/payroll-demo/design-doc.en.md` and `.ja.md`: generated inventory and job steps.
- `ui/src/ui/views/artifacts.ts`: version selection, comparison and human review controls.
- `ui/src/ui/i18n/industrial.ts`: current availability and setup descriptions.
- `ui/visual/README-industrial.md`: capture provenance and reproducibility. Keep the simulation labels visible when publishing captures.

Website integration belongs to the website owner. No website or deployment files are changed by this handoff.
