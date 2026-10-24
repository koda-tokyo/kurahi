import type { LocalizedText, Project, ProjectTemplate } from "./projects";
import {
  LANGUAGES,
  type LanguageId,
} from "../../../../packages/legacy-analyzer/src/modernise/registry";

export const INDUSTRIAL_TEMPLATE_ID = "industry-legacy-modernisation";

export type IndustrialCapabilityStatus = "deterministic" | "planned";

export type IndustrialCapability = {
  id: string;
  name: LocalizedText;
  languageId: LanguageId;
  status: IndustrialCapabilityStatus;
  evidence: LocalizedText;
  prompt: LocalizedText;
};

export const INDUSTRIAL_LIFECYCLE: LocalizedText[] = [
  { ja: "発見", en: "Discover" },
  { ja: "依存関係", en: "Map dependencies" },
  { ja: "リスク評価", en: "Assess risk" },
  { ja: "目標設計", en: "Design target" },
  { ja: "変換", en: "Transform" },
  { ja: "検証", en: "Validate" },
  { ja: "承認", en: "Approve" },
];

const CAPABILITY_PRESETS: Omit<IndustrialCapability, "status">[] = [
  {
    id: "cobol-jcl",
    languageId: "cobol",
    name: { ja: "COBOL・コピーブック・JCL", en: "COBOL, copybooks and JCL" },
    evidence: {
      ja: "内蔵解析による構造、業務ルール、データ辞書、影響範囲と file:line",
      en: "Built-in structure, rule, dictionary and impact analysis with file:line",
    },
    prompt: {
      ja: "legacy_index から開始し、COBOL、コピーブック、JCL の構造、業務ルール、データ、ジョブ、変更影響を file:line の根拠付きで評価してください。",
      en: "Start with legacy_index and assess the COBOL, copybooks and JCL structure, business rules, data, jobs and change impact with file:line evidence.",
    },
  },
  {
    id: "fortran",
    languageId: "fortran",
    name: { ja: "FORTRAN", en: "FORTRAN" },
    evidence: {
      ja: "プログラム単位、CALL・USE、COMMON、ファイル入出力と path:line",
      en: "Program units, CALL/USE, COMMON blocks and file I/O with path:line",
    },
    prompt: {
      ja: "modernise_plan から開始し、解析範囲と未対応構文を報告してください。FORTRAN のプログラム、モジュール、共有データ、数値精度、ファイル形式、外部ライブラリを調査し、確認済みと未確認を分けてください。",
      en: "Start with modernise_plan and report engine coverage and unsupported constructs. Assess the FORTRAN programs, modules, shared data, numerical precision, file formats and external libraries, separating verified and unverified findings.",
    },
  },
  {
    id: "pli",
    languageId: "pli",
    name: { ja: "PL/I", en: "PL/I" },
    evidence: {
      ja: "手続き、宣言、CALL、入出力、EXEC SQL と path:line",
      en: "Procedures, declarations, calls, I/O and EXEC SQL with path:line",
    },
    prompt: {
      ja: "modernise_plan から開始し、解析範囲と未対応構文を報告してください。PL/I のモジュール、インクルード、共有データ、入出力、トランザクション境界を調査し、依存関係と移行リスクを根拠付きで整理してください。",
      en: "Start with modernise_plan and report engine coverage and unsupported constructs. Assess PL/I modules, includes, shared data, I/O and transaction boundaries, then map dependencies and migration risks with evidence.",
    },
  },
  {
    id: "java",
    languageId: "java",
    name: { ja: "Java", en: "Java" },
    evidence: {
      ja: "型、メソッド、静的呼出し、JPA・JDBC のテーブル参照と path:line",
      en: "Types, methods, static calls and JPA/JDBC table access with path:line",
    },
    prompt: {
      ja: "modernise_plan から開始し、解析範囲と未対応構文を報告してください。Java のパッケージ、ビルド、ランタイム、フレームワーク、サービス、キュー、データベース、トランザクションを調査してください。",
      en: "Start with modernise_plan and report engine coverage and unsupported constructs. Assess Java packages, builds, runtimes, frameworks, services, queues, databases and transaction boundaries.",
    },
  },
  {
    id: "databases",
    languageId: "sql-ddl",
    name: { ja: "SQL DDL（データベース構造）", en: "SQL DDL (database structure)" },
    evidence: {
      ja: "CREATE TABLE・VIEW・INDEX、列、制約、コメントと path:line",
      en: "CREATE TABLE/VIEW/INDEX, columns, constraints and comments with path:line",
    },
    prompt: {
      ja: "modernise_plan から開始し、解析範囲と未対応構文を報告してください。データベースのスキーマ、手続き、トリガー、データフロー、整合性制約、性能、照合と復旧方法を評価してください。",
      en: "Start with modernise_plan and report engine coverage and unsupported constructs. Assess database schemas, procedures, triggers, data flows, integrity constraints, performance, reconciliation and recovery.",
    },
  },
  {
    id: "batch",
    languageId: "batch-scheduler",
    name: { ja: "バッチスケジュール", en: "Batch scheduling" },
    evidence: {
      ja: "ジョブ定義、カレンダー、依存関係、実行履歴",
      en: "Job definitions, calendars, dependencies and run history",
    },
    prompt: {
      ja: "バッチの先行・後続、締切、再実行安全性、再開点、障害復旧、業務照合を評価し、安全な移行波を提案してください。",
      en: "Assess batch predecessors, successors, deadlines, rerun safety, restart points, recovery and business reconciliation; propose safe migration waves.",
    },
  },
  {
    id: "plc",
    languageId: "plc-iec61131",
    name: { ja: "PLC コード", en: "PLC code" },
    evidence: {
      ja: "承認済みエクスポート、タグ、アラーム、マニュアル",
      en: "Approved exports, tags, alarms and manuals",
    },
    prompt: {
      ja: "承認済みの PLC エクスポートと資料を読み取り専用で評価し、シーケンス、インターロック、安全機能、停止リスク、人手確認を整理してください。",
      en: "Assess approved PLC exports and documents in read-only mode; map sequences, interlocks, safety functions, downtime risk, independent validation and policy-required authority.",
    },
  },
  {
    id: "maintenance",
    languageId: "maintenance",
    name: { ja: "設備保全", en: "Maintenance" },
    evidence: {
      ja: "作業指示、履歴、マニュアル、状態データ",
      en: "Work orders, history, manuals and condition data",
    },
    prompt: {
      ja: "保全履歴、作業指示、故障モード、部品、点検周期、状態データを評価し、根拠付きの保全改善案を作成してください。",
      en: "Assess maintenance history, work orders, failure modes, parts, inspection intervals and condition data; propose evidence-led improvements.",
    },
  },
  {
    id: "cybersecurity",
    languageId: "cybersecurity",
    name: { ja: "産業サイバーセキュリティ", en: "Industrial cybersecurity" },
    evidence: {
      ja: "許可済み構成、資産、検出結果、復旧証跡",
      en: "Authorized configuration, inventory, findings and recovery evidence",
    },
    prompt: {
      ja: "許可された範囲で、ゾーン、通信経路、ID、遠隔アクセス、信頼関係、パッチ、バックアップ、復旧性を評価してください。",
      en: "Within the authorized scope, assess zones, conduits, identity, remote access, trust relationships, patch state, backups and recoverability.",
    },
  },
];

// The engine registry is the source of readiness; unknown or engine-less entries stay planned.
export const INDUSTRIAL_CAPABILITIES: IndustrialCapability[] = CAPABILITY_PRESETS.map((preset) => {
  const language = LANGUAGES.find((entry) => entry.id === preset.languageId);
  return {
    ...preset,
    status: language?.status === "active" && language.engine ? "deterministic" : "planned",
  };
});

export function isIndustrialProject(project: Pick<Project, "templateId">): boolean {
  return project.templateId === INDUSTRIAL_TEMPLATE_ID;
}

export const INDUSTRIAL_DOCUMENT_COPY = {
  title: { ja: "COBOL・JCL の設計資料", en: "COBOL / JCL documents" },
  description: {
    ja: "このプロジェクトのチャットに生成依頼の下書きを開きます。内容を確認して送信してください。生成結果は自動で成果物として保存されません。",
    en: "Open a generation request in this project's chat. Review and send it. Generated results are not automatically saved as artifacts.",
  },
  save: {
    ja: "生成後、回答の「成果物として保存」から確認用の下書きを保存できます。既存の成果物の更新は、その成果物を開いて新しいバージョンとして保存してください。",
    en: 'After generation, use "Save as output" on the response to save a draft for review. To update an existing artifact, open it and save a new version.',
  },
  analyzerUnavailable: {
    ja: "このプロジェクトでレガシー解析ツールが有効であることを確認できません。プロジェクト設定を確認してください。",
    en: "Legacy analysis is not confirmed enabled for this project. Check the project configuration.",
  },
  unavailable: {
    ja: "ゲートウェイへの接続とプロジェクトフォルダーが必要です。",
    en: "A gateway connection and a project folder are required.",
  },
};

export const INDUSTRIAL_DOCUMENT_ACTIONS = [
  {
    tool: "legacy_design_doc",
    label: { ja: "設計書の生成依頼を開く", en: "Prepare design document request" },
  },
  {
    tool: "legacy_wave_plan",
    label: { ja: "移行ウェーブ案の生成依頼を開く", en: "Prepare wave plan request" },
  },
] as const;

export type IndustrialDocumentTool = (typeof INDUSTRIAL_DOCUMENT_ACTIONS)[number]["tool"];

export function industrialDocumentPrompt(
  project: Pick<Project, "folder">,
  tool: IndustrialDocumentTool,
  locale: string,
): string {
  const lang = locale === "ja" ? "ja" : "en";
  const args = JSON.stringify({ path: project.folder, lang });
  return lang === "ja"
    ? `このプロジェクトの COBOL・コピーブック・JCL を対象に、${tool} を引数 ${args} で実行してください。ツールが利用できない場合は、その旨を報告してください。返された Markdown と path:line の根拠を保持し、未確認事項と解析範囲を明示してください。移行ウェーブは人による確認が必要な提案として扱い、ソースの変更や移行を実行しないでください。成果物の保存・承認が完了したとは報告しないでください。`
    : `For this project's COBOL, copybooks and JCL, run ${tool} with arguments ${args}. If the tool is unavailable, report that. Preserve the returned Markdown and path:line evidence, and state open questions and analysis coverage. Treat migration waves as proposals for human review; do not modify sources or execute a migration. Do not claim the result has been saved as an artifact or approved.`;
}

/** Mirror the gateway's explicit project override, then template fallback. */
export function industrialAnalyzerEnabled(
  project: Pick<Project, "plugins" | "templateId">,
  templates: Pick<ProjectTemplate, "id" | "plugins">[] = [],
): boolean {
  const plugins = Array.isArray(project.plugins)
    ? project.plugins
    : templates.find((template) => template.id === project.templateId)?.plugins;
  return Array.isArray(plugins) && plugins.includes("legacy-analyzer");
}
