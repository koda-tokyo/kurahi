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
  "industrial.pack.status.active": "Available",
  "industrial.pack.status.unverified": "Setup check needed",
  "industrial.pack.status.disabled": "Requires offline setup",
  "industrial.pack.status.planned": "Not available yet",
  "industrial.pack.open": "Open pack",
  "industrial.pack.agents": "{count} agent roles",
  "industrial.pack.capabilities": "{count} capabilities",
  "industrial.pack.analysis": "Analysis",
  "industrial.pack.analysis.description":
    "Built-in source analysis is available for the domains below. Run an assessment to see findings for your project.",
  "industrial.pack.analysis.prompt":
    "Inventory this Project, map the available evidence and dependencies, and clearly separate verified findings from inference.",
  "industrial.pack.modernisation": "Modernization",
  "industrial.pack.modernisation.description":
    "Target design and transformation workflows are included. Check your project toolchain before using them.",
  "industrial.pack.modernisation.prompt":
    "Create an evidence-led modernization plan for this Project with migration waves, validation gates and rollback paths.",
  "industrial.pack.controls": "Controls",
  "industrial.pack.controls.description":
    "PLC review requires an approved offline export and a connected validation environment. It is not available until setup is complete.",
  "industrial.pack.controls.prompt":
    "Review the approved offline PLC evidence without proposing or performing a controller write.",
  "industrial.pack.maintenance": "Maintenance",
  "industrial.pack.maintenance.description":
    "The workflow is included. Check the connections to your work orders, manuals and condition data before using it.",
  "industrial.pack.maintenance.prompt":
    "Assess maintenance evidence for this Project and identify reliability risks, missing data and candidate work orders.",
  "industrial.pack.cybersecurity": "Cybersecurity",
  "industrial.pack.cybersecurity.description":
    "Inventory and remediation workflows are not available yet. No scanner is connected by this pack.",
  "industrial.pack.cybersecurity.prompt":
    "Define an authorized cybersecurity assessment scope and the evidence required before any scan or remediation.",
  "industrial.autonomyTarget":
    "Target: agents execute 99.99% of eligible workflow actions. Current coverage must be measured from the run timeline.",
  "industrial.capabilities": "Domains and evidence",
  "industrial.capabilityTruth":
    "Built-in analysis reads your source files and reports findings. Run an assessment for this project before relying on results. Other domains are not available yet. Connect to the service to start.",
  "industrial.col.domain": "Domain",
  "industrial.col.status": "Analysis status",
  "industrial.col.evidence": "Evidence used",
  "industrial.status.deterministic": "Built-in analysis",
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
  "industrial.planned": "Not available yet",
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
  "industrial.pack.status.active": "利用可能",
  "industrial.pack.status.unverified": "設定確認が必要",
  "industrial.pack.status.disabled": "オフライン環境の準備が必要",
  "industrial.pack.status.planned": "現在は利用できません",
  "industrial.pack.open": "パックを開く",
  "industrial.pack.agents": "エージェント役割 {count} 件",
  "industrial.pack.capabilities": "機能 {count} 件",
  "industrial.pack.analysis": "分析",
  "industrial.pack.analysis.description":
    "下記の領域では内蔵ソース解析を利用できます。評価を実行すると、このプロジェクトの解析結果を確認できます。",
  "industrial.pack.analysis.prompt":
    "このプロジェクトを棚卸しし、利用可能な証跡と依存関係を整理して、検証済みの所見と推論を明確に分けてください。",
  "industrial.pack.modernisation": "刷新",
  "industrial.pack.modernisation.description":
    "目標設計と変換のワークフローを用意しています。開始前に、プロジェクトのツール環境を確認してください。",
  "industrial.pack.modernisation.prompt":
    "移行ウェーブ、検証ゲート、ロールバック経路を含む証跡ベースの刷新計画を作成してください。",
  "industrial.pack.controls": "制御",
  "industrial.pack.controls.description":
    "PLC レビューには、承認済みのオフライン出力と検証環境の接続が必要です。準備が完了するまでは利用できません。",
  "industrial.pack.controls.prompt":
    "コントローラーへの書き込みを提案・実行せず、承認済みのオフライン PLC 証跡をレビューしてください。",
  "industrial.pack.maintenance": "保全",
  "industrial.pack.maintenance.description":
    "ワークフローを用意しています。利用前に、作業指示、マニュアル、状態データへの接続を確認してください。",
  "industrial.pack.maintenance.prompt":
    "このプロジェクトの保全証跡を評価し、信頼性リスク、不足データ、作業指示候補を特定してください。",
  "industrial.pack.cybersecurity": "サイバーセキュリティ",
  "industrial.pack.cybersecurity.description":
    "棚卸しと是正のワークフローは現在利用できません。このパックによるスキャナー接続はありません。",
  "industrial.pack.cybersecurity.prompt":
    "スキャンや是正の前に、承認されたサイバーセキュリティ評価範囲と必要な証跡を定義してください。",
  "industrial.autonomyTarget":
    "目標：対象となる工程の 99.99% をエージェントが実行します。現在の達成率は実行履歴から測定します。",
  "industrial.capabilities": "対象領域と証跡",
  "industrial.capabilityTruth":
    "内蔵解析はソースファイルを読み取り、結果を報告します。このプロジェクトの評価を実行してから結果をご利用ください。その他の領域は現在利用できません。開始にはサービスへの接続が必要です。",
  "industrial.col.domain": "領域",
  "industrial.col.status": "解析状態",
  "industrial.col.evidence": "使用する証跡",
  "industrial.status.deterministic": "内蔵解析",
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
  "industrial.planned": "現在は利用できません",
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
