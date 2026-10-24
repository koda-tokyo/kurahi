export const industrialEn = {
  "projects.view.modernize": "Modernize",
  "industrial.role": "Industrial Edition",
  "industrial.roleName": "Industrial Modernization Engineer",
  "industrial.intro":
    "One project-scoped model operates an agent workforce across software, data, operations, equipment and security through a shared evidence-led lifecycle.",
  "industrial.lifecycle": "Modernization lifecycle",
  "industrial.packs": "Agent packs",
  "industrial.packs.description":
    "Enable the specialist workforce needed for this plant. Status describes current product readiness, not a future promise.",
  "industrial.pack.status.active": "Active",
  "industrial.pack.status.unverified": "Configured, not verified",
  "industrial.pack.status.disabled": "Disabled",
  "industrial.pack.status.planned": "Planned",
  "industrial.pack.open": "Open pack",
  "industrial.pack.agents": "{count} agent roles",
  "industrial.pack.capabilities": "{count} capabilities",
  "industrial.pack.analysis": "Analysis",
  "industrial.pack.analysis.description":
    "Built-in source analysis is available for the deterministic domains below. Project findings still require an analysis run.",
  "industrial.pack.analysis.prompt":
    "Inventory this Project, map the available evidence and dependencies, and clearly separate verified findings from inference.",
  "industrial.pack.modernisation": "Modernization",
  "industrial.pack.modernisation.description":
    "Target design and transformation workflows are configured; the Project toolchain is not yet verified.",
  "industrial.pack.modernisation.prompt":
    "Create an evidence-led modernization plan for this Project with migration waves, validation gates and rollback paths.",
  "industrial.pack.controls": "Controls",
  "industrial.pack.controls.description":
    "PLC review is disabled until an approved offline export and validation environment are connected.",
  "industrial.pack.controls.prompt":
    "Review the approved offline PLC evidence without proposing or performing a controller write.",
  "industrial.pack.maintenance": "Maintenance",
  "industrial.pack.maintenance.description":
    "The workflow is configured; work orders, manuals and condition-data connections are not verified.",
  "industrial.pack.maintenance.prompt":
    "Assess maintenance evidence for this Project and identify reliability risks, missing data and candidate work orders.",
  "industrial.pack.cybersecurity": "Cybersecurity",
  "industrial.pack.cybersecurity.description":
    "Authorized-scope inventory and remediation workflows are planned; no scanner connection is claimed.",
  "industrial.pack.cybersecurity.prompt":
    "Define an authorized cybersecurity assessment scope and the evidence required before any scan or remediation.",
  "industrial.autonomyTarget":
    "Target: agents execute 99.99% of eligible workflow actions. Current coverage must be measured from the run timeline.",
  "industrial.capabilities": "Domains and evidence",
  "industrial.capabilityTruth":
    "Deterministic means a built-in source analyser is available, not that this project has been analysed. Planned domains have no engine yet. Assessments require a gateway connection.",
  "industrial.col.domain": "Domain",
  "industrial.col.status": "Analysis status",
  "industrial.col.evidence": "Evidence used",
  "industrial.status.deterministic": "Deterministic",
  "industrial.status.evidence": "Evidence-led",
  "industrial.status.controlled": "Controlled validation",
  "industrial.start": "Start assessment",
  "industrial.approval":
    "Production changes require documented impact, validation, rollback and explicit on-screen approval.",
  "industrial.workbench.tabs": "Industrial workbench views",
  "industrial.tab.chat": "Chat",
  "industrial.tab.terminal": "Terminal",
  "industrial.tab.timeline": "Timeline",
  "industrial.tab.files": "Files",
  "industrial.tab.artifacts": "Artifacts",
  "industrial.tab.assets": "Assets",
  "industrial.planned": "Planned",
  "industrial.voice": "Push to talk",
  "industrial.voice.planned": "Push to talk is planned and is not active.",
  "industrial.context": "Project context",
  "industrial.context.project": "Project",
  "industrial.context.boundary": "Permission boundary",
  "industrial.context.mode": "Project mode",
  "industrial.context.approval": "Artifact approval required",
  "industrial.context.service": "Service health",
  "industrial.target.label": "Autonomous completion",
  "industrial.target.unmeasured": "Not yet measured",
  "industrial.target.measured": "Measured from signed timeline events",
} as const;

export const industrialJa = {
  "projects.view.modernize": "刷新",
  "industrial.role": "産業版",
  "industrial.roleName": "産業システム刷新エンジニア",
  "industrial.intro":
    "1 つのプロジェクト専属モデルが、共通の証跡付き工程でソフトウェア、データ、運用、設備、セキュリティのエージェント群を運用します。",
  "industrial.lifecycle": "刷新工程",
  "industrial.packs": "エージェントパック",
  "industrial.packs.description":
    "この工場に必要な専門エージェント群を選択します。状態表示は将来の予定ではなく、現在の製品準備状況を示します。",
  "industrial.pack.status.active": "稼働中",
  "industrial.pack.status.unverified": "設定済み・未検証",
  "industrial.pack.status.disabled": "無効",
  "industrial.pack.status.planned": "計画中",
  "industrial.pack.open": "パックを開く",
  "industrial.pack.agents": "エージェント役割 {count} 件",
  "industrial.pack.capabilities": "機能 {count} 件",
  "industrial.pack.analysis": "分析",
  "industrial.pack.analysis.description":
    "下記の決定論的領域では内蔵ソース解析を利用できます。プロジェクトの所見を得るには解析の実行が必要です。",
  "industrial.pack.analysis.prompt":
    "このプロジェクトを棚卸しし、利用可能な証跡と依存関係を整理して、検証済みの所見と推論を明確に分けてください。",
  "industrial.pack.modernisation": "刷新",
  "industrial.pack.modernisation.description":
    "目標設計と変換工程は設定済みですが、プロジェクトのツールチェーンは未検証です。",
  "industrial.pack.modernisation.prompt":
    "移行ウェーブ、検証ゲート、ロールバック経路を含む証跡ベースの刷新計画を作成してください。",
  "industrial.pack.controls": "制御",
  "industrial.pack.controls.description":
    "承認済みのオフライン出力と検証環境が接続されるまで、PLC レビューは無効です。",
  "industrial.pack.controls.prompt":
    "コントローラーへの書き込みを提案・実行せず、承認済みのオフライン PLC 証跡をレビューしてください。",
  "industrial.pack.maintenance": "保全",
  "industrial.pack.maintenance.description":
    "工程は設定済みですが、作業指示、マニュアル、状態データの接続は未検証です。",
  "industrial.pack.maintenance.prompt":
    "このプロジェクトの保全証跡を評価し、信頼性リスク、不足データ、作業指示候補を特定してください。",
  "industrial.pack.cybersecurity": "サイバーセキュリティ",
  "industrial.pack.cybersecurity.description":
    "承認範囲内の棚卸しと是正工程は計画中です。スキャナー接続済みとは表示しません。",
  "industrial.pack.cybersecurity.prompt":
    "スキャンや是正の前に、承認されたサイバーセキュリティ評価範囲と必要な証跡を定義してください。",
  "industrial.autonomyTarget":
    "目標：対象となる工程の 99.99% をエージェントが実行します。現在の達成率は実行履歴から測定します。",
  "industrial.capabilities": "対象領域と証跡",
  "industrial.capabilityTruth":
    "「決定論的」は内蔵ソース解析が利用可能であることを示し、このプロジェクトの解析済みを意味しません。「計画中」の領域には解析エンジンがありません。評価にはゲートウェイ接続が必要です。",
  "industrial.col.domain": "領域",
  "industrial.col.status": "解析状態",
  "industrial.col.evidence": "使用する証跡",
  "industrial.status.deterministic": "決定論的",
  "industrial.status.evidence": "証跡ベース",
  "industrial.status.controlled": "統制付き検証",
  "industrial.start": "評価を開始",
  "industrial.approval":
    "本番変更には、影響、検証、ロールバックの記録と、画面上の明示的な承認が必要です。",
  "industrial.workbench.tabs": "産業ワークベンチの表示",
  "industrial.tab.chat": "チャット",
  "industrial.tab.terminal": "端末",
  "industrial.tab.timeline": "タイムライン",
  "industrial.tab.files": "ファイル",
  "industrial.tab.artifacts": "成果物",
  "industrial.tab.assets": "資産",
  "industrial.planned": "計画中",
  "industrial.voice": "押して話す",
  "industrial.voice.planned": "押して話す機能は計画中で、現在は利用できません。",
  "industrial.context": "プロジェクト・コンテキスト",
  "industrial.context.project": "プロジェクト",
  "industrial.context.boundary": "権限境界",
  "industrial.context.mode": "プロジェクト・モード",
  "industrial.context.approval": "成果物の承認必須",
  "industrial.context.service": "サービス状態",
  "industrial.target.label": "自律完了率",
  "industrial.target.unmeasured": "未計測",
  "industrial.target.measured": "署名付きタイムラインから計測",
} as const;
