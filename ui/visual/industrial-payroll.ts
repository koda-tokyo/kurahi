import { html, render } from "lit";
import "../src/styles.css";
import "./industrial-payroll.css";
import type { AppViewState } from "../src/ui/app-view-state";
import type { Project } from "../src/ui/controllers/projects";
import documentEn from "../../packages/legacy-analyzer/examples/payroll-demo/design-doc.en.md?raw";
import documentJa from "../../packages/legacy-analyzer/examples/payroll-demo/design-doc.ja.md?raw";
import {
  DEFAULT_ARTIFACTS_STATE,
  type Artifact,
  type ArtifactVersion,
} from "../src/ui/controllers/artifacts";
import { emptyVoice } from "../src/ui/controllers/voice";
import { setLocale } from "../src/ui/i18n";
import { renderArtifactList, renderArtifactPanel } from "../src/ui/views/artifacts";
import { renderIndustrialModernisation } from "../src/ui/views/industrial-modernisation";
import source from "./industrial-payroll-source.cbl?raw";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "ja" ? "ja" : "en";
const view = params.get("view") ?? "workbench";
const copy = (en: string, ja: string) => (locale === "ja" ? ja : en);
setLocale(locale);
document.documentElement.lang = locale;
document.documentElement.dataset.theme = "dark";
document.body.className = "payroll-fixture";
const project = {
  id: "fictional-payroll",
  plugins: ["legacy-analyzer"],
  name: copy(
    "Kazanami Precision Works · Fictional payroll",
    "架空企業 Kazanami Precision Works · 給与計算",
  ),
  folder: "/demo/industry-legacy-cobol",
  mode: "plan",
  rules: {
    readOnly: ["/demo/industry-legacy-cobol/source"],
    writable: [],
    artifactApprovalRequired: true,
    instructions: [],
  },
  templateId: "industry-legacy-modernisation",
  allowedAgents: [],
  allowedModels: [],
  suggestedSkills: [],
  starterPrompts: [],
  archived: false,
  createdAt: "2026-10-25T00:00:00Z",
  updatedAt: "2026-10-25T00:00:00Z",
  createdBy: "fixture",
} satisfies Project;
const timestamp = "2026-10-25T00:00:00Z";
async function version(content: string, number: number): Promise<ArtifactVersion> {
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    version: number,
    sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
    size: bytes.length,
    createdAt: timestamp,
    createdByUser: "local-fixture",
    createdByAgent: null,
    sourceSession: null,
    note: "Local visual fixture; no persisted gateway artifact",
  };
}
const originalDocument = locale === "ja" ? documentJa : documentEn;
// Section 1 is unchanged; the full generated document exceeds the renderer's Markdown parse limit.
const fullDoc = originalDocument.slice(0, originalDocument.indexOf("\n## 2."));
const numberedSource = source
  .split("\n")
  .slice(129, 150)
  .map((line, i) => `${i + 130}  ${line}`)
  .join("\n");
const sourceContent = `# source/cobol/PAYCALC.cbl:130–150\n\n${copy("Numbered excerpt from the unchanged demo source.", "変更していないデモソースの行番号付き抜粋。")}\n\n\`\`\`cobol\n${numberedSource}\n\`\`\`\n`;
const originalExcerpt = source.split("\n").slice(129, 150).join("\n");
const proposedExcerpt = originalExcerpt.replace(
  "       3000-BASE-AND-RATE.",
  "      * ILLUSTRATIVE REVIEW COMMENT ONLY - NOT A PAYROLL RULE CHANGE\n       3000-BASE-AND-RATE.",
);
async function artifact(
  id: string,
  title: string,
  contents: string[],
  type: Artifact["type"],
): Promise<Artifact> {
  return {
    id,
    title,
    type,
    format: "md",
    projectId: project.id,
    status: "draft",
    versions: await Promise.all(contents.map((content, i) => version(content, i + 1))),
    history: contents.map((_, i) => ({
      at: timestamp,
      by: "local-fixture",
      action: i ? "version" : "created",
      version: i + 1,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
const design = await artifact(
  "design",
  copy("Generated design document · Section 1 excerpt", "生成済み設計書 · 第1章抜粋"),
  [fullDoc],
  "document",
);
const citation = await artifact("source", "PAYCALC.cbl · 130–150", [sourceContent], "code");
const change = await artifact(
  "change",
  copy("Illustrative source review · comment only", "ソースレビュー例 · コメントのみ"),
  [originalExcerpt, proposedExcerpt],
  "code",
);
const entries = [design, citation, change];
const contents: Record<string, string[]> = {
  design: [fullDoc],
  source: [sourceContent],
  change: [originalExcerpt, proposedExcerpt],
};
const noAction = () => {
  document.querySelector("#local-notice")!.textContent = copy(
    "Local preview only. No request sent or status changed.",
    "ローカルプレビューのみ。リクエスト送信・状態変更はありません。",
  );
};
function stateFor(item: Artifact, compare = false): AppViewState {
  const content = contents[item.id].at(-1)!;
  const state = {
    locale,
    connected: false,
    projects: { projects: [project], templates: [] },
    voice: emptyVoice(),
    voiceCapture: null,
    execApprovalQueue: [],
    setProjectView: noAction,
    startProjectChat: noAction,
    startProjectVoice: noAction,
    stopProjectVoice: noAction,
    cancelProjectVoice: noAction,
    patchVoiceText: noAction,
    useVoiceDraft: noAction,
    artifacts: {
      ...DEFAULT_ARTIFACTS_STATE,
      items: entries,
      panelOpen: true,
      current: item,
      currentVersion: item.versions.length,
      content,
      compareVersion: compare ? 1 : null,
      compareContent: compare ? contents[item.id][0] : null,
    },
    patchArtifacts: noAction,
    refreshArtifacts: noAction,
    setArtifactStatus: noAction,
    openArtifactPanel: noAction,
    compareArtifact: noAction,
    saveArtifactVersion: noAction,
    openChatSession: noAction,
  } as unknown as AppViewState;
  return state;
}
const designState = stateFor(design);
render(
  html`
  <header class="payroll-heading"><div class="payroll-eyebrow">KURAHI INDUSTRIAL · ${copy("LOCAL EVIDENCE FIXTURE", "ローカル証跡フィクスチャ")}</div>
    <h1>${copy("From payroll source to reviewable evidence", "給与計算ソースからレビュー可能な証跡へ")}</h1>
    <p>${copy("Fictional demo data · Simulated artifact state · No gateway, payroll execution or approval", "架空デモデータ · 成果物状態は模擬 · ゲートウェイ接続・給与計算実行・承認なし")}</p>
    <nav><a href="?locale=${locale}&view=workbench">${copy("Workbench", "ワークベンチ")}</a><a href="?locale=${locale}&view=document">${copy("Document + source", "設計書とソース")}</a><a href="?locale=${locale}&view=change">${copy("Change review", "変更レビュー")}</a></nav>
    <p id="local-notice" role="status">${copy("Production renderers composed for this screenshot; this is not a shipped split-view workflow.", "本番レンダラーを撮影用に並べて表示しています。製品の分割画面ワークフローではありません。")}</p>
  </header>
  ${
    view === "workbench"
      ? html`<section class="payroll-outputs"><h2>${copy("Loaded demo evidence", "読み込み済みのデモ証跡")}</h2>${renderArtifactList(designState, { projectId: project.id })}</section>${renderIndustrialModernisation(designState, project)}`
      : view === "change"
        ? html`<section class="payroll-composition"><p>${copy("Illustrative edit to source lines 130–150: one comment inserted. The production artifact diff compares local v1 and v2. No impact analysis or business-rule validation is claimed.", "ソース130〜150行の変更例：コメントを1行追加。本番の成果物差分表示でローカルv1とv2を比較。影響分析・業務ルール検証は行っていません。")}</p>${renderArtifactPanel(stateFor(change, true))}</section>`
        : html`<section class="payroll-pair"><div>${renderArtifactPanel(designState)}</div><div>${renderArtifactPanel(stateFor(citation))}</div></section>`
  }
`,
  document.querySelector("#fixture")!,
);
document.body.dataset.ready = "true";
