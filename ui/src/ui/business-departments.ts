// SPDX-License-Identifier: MIT
import type { WorkQueueDef } from "../../../packages/client/src/workitems.js";

export type DepartmentId =
  | "secretariat"
  | "finance"
  | "admin"
  | "hr"
  | "planning"
  | "it"
  | "procurement"
  | "sales"
  | "marketing"
  | "service"
  | "operations"
  | "legal"
  | "product"
  | "facilities"
  | "quality";
export type DepartmentLayout =
  | "agenda"
  | "register"
  | "requests"
  | "milestones"
  | "comparison"
  | "pipeline"
  | "calendar"
  | "cases"
  | "delivery"
  | "review"
  | "roadmap"
  | "assets"
  | "verification";
export type BusinessDepartment = {
  id: DepartmentId;
  name: { en: string; ja: string };
  description: { en: string; ja: string };
  workflows: { en: string[]; ja: string[] };
  layout: DepartmentLayout;
};

export const BUSINESS_DEPARTMENTS: BusinessDepartment[] = [
  {
    id: "secretariat",
    name: { en: "Executive office / Secretariat", ja: "秘書・役員室" },
    description: {
      en: "Coordinate schedules, correspondence and executive follow-up.",
      ja: "予定、連絡文書、役員のフォローアップを調整します。",
    },
    workflows: {
      en: ["Meeting preparation", "Correspondence review", "Travel arrangements"],
      ja: ["会議資料の準備", "連絡文書の確認", "出張手配"],
    },
    layout: "agenda",
  },
  {
    id: "finance",
    name: { en: "Finance & Accounting", ja: "財務・経理" },
    description: {
      en: "Review expenses and invoices, reconcile records and prepare closing.",
      ja: "経費と請求書を確認し、照合と決算準備を行います。",
    },
    workflows: {
      en: ["Expense review", "Invoice matching", "Period close"],
      ja: ["経費精算の確認", "請求書の照合", "月次決算"],
    },
    layout: "register",
  },
  {
    id: "admin",
    name: { en: "Administration / General Affairs", ja: "総務" },
    description: {
      en: "Handle office requests, shared services and company records.",
      ja: "社内依頼、共通サービス、社内文書を管理します。",
    },
    workflows: {
      en: ["Office requests", "Document registration", "Renewal tracking"],
      ja: ["総務依頼", "文書登録", "更新期限の管理"],
    },
    layout: "requests",
  },
  {
    id: "hr",
    name: { en: "Human Resources", ja: "人事・労務" },
    description: {
      en: "Coordinate employee requests, onboarding and attendance review.",
      ja: "従業員の申請、入社手続き、勤怠確認を進めます。",
    },
    workflows: {
      en: ["Leave requests", "Overtime review", "Employee onboarding"],
      ja: ["休暇申請", "残業申請の確認", "入社手続き"],
    },
    layout: "milestones",
  },
  {
    id: "planning",
    name: { en: "Planning / PMO", ja: "経営企画・PMO" },
    description: {
      en: "Track initiatives, dependencies, risks and management decisions.",
      ja: "施策、依存関係、リスク、経営判断を記録します。",
    },
    workflows: {
      en: ["Initiative tracking", "Risk review", "Progress reporting"],
      ja: ["施策の進捗管理", "リスク確認", "進捗報告"],
    },
    layout: "milestones",
  },
  {
    id: "it",
    name: { en: "IT & Security", ja: "情報システム" },
    description: {
      en: "Manage service requests, access reviews, incidents and changes.",
      ja: "問い合わせ、アクセス権の確認、障害、変更を管理します。",
    },
    workflows: {
      en: ["Service requests", "Access review", "Change preparation"],
      ja: ["サービス依頼", "アクセス権の確認", "変更準備"],
    },
    layout: "requests",
  },
  {
    id: "procurement",
    name: { en: "Procurement", ja: "購買・調達" },
    description: {
      en: "Compare suppliers and quotations and prepare purchasing decisions.",
      ja: "仕入先と見積を比較し、購買判断に必要な資料を準備します。",
    },
    workflows: {
      en: ["Purchase requests", "Quote comparison", "Supplier review"],
      ja: ["購買申請", "見積比較", "仕入先の確認"],
    },
    layout: "comparison",
  },
  {
    id: "sales",
    name: { en: "Sales", ja: "営業" },
    description: {
      en: "Track opportunities, customer follow-up, quotations and renewals.",
      ja: "商談、顧客フォロー、見積、契約更新を管理します。",
    },
    workflows: {
      en: ["Opportunity follow-up", "Quote preparation", "Renewal review"],
      ja: ["商談フォロー", "見積作成", "更新確認"],
    },
    layout: "pipeline",
  },
  {
    id: "marketing",
    name: { en: "Marketing & Communications", ja: "マーケティング・広報" },
    description: {
      en: "Plan campaigns and coordinate content reviews and publication dates.",
      ja: "キャンペーンを計画し、コンテンツ確認と公開日を調整します。",
    },
    workflows: {
      en: ["Campaign planning", "Content review", "Publication scheduling"],
      ja: ["キャンペーン計画", "コンテンツ確認", "公開予定の管理"],
    },
    layout: "calendar",
  },
  {
    id: "service",
    name: { en: "Customer Service", ja: "顧客サポート" },
    description: {
      en: "Resolve customer cases with conversation context and escalation history.",
      ja: "対応履歴とエスカレーション記録を参照し、顧客の問題を解決します。",
    },
    workflows: {
      en: ["Case triage", "Response preparation", "Resolution follow-up"],
      ja: ["案件の振り分け", "回答案の作成", "解決後のフォロー"],
    },
    layout: "cases",
  },
  {
    id: "operations",
    name: { en: "Operations & Logistics", ja: "業務・物流" },
    description: {
      en: "Coordinate delivery, order exceptions and available resources.",
      ja: "納品、受注の例外対応、利用可能なリソースを調整します。",
    },
    workflows: {
      en: ["Delivery planning", "Order exceptions", "Resource scheduling"],
      ja: ["納品計画", "受注の例外対応", "リソース配置"],
    },
    layout: "delivery",
  },
  {
    id: "legal",
    name: { en: "Legal, Risk & Governance", ja: "法務・リスク管理" },
    description: {
      en: "Review agreements and track obligations, risks and governance records.",
      ja: "契約を確認し、義務、リスク、ガバナンス記録を管理します。",
    },
    workflows: {
      en: ["Contract review", "Obligation tracking", "Risk assessment"],
      ja: ["契約確認", "義務と期限の管理", "リスク評価"],
    },
    layout: "review",
  },
  {
    id: "product",
    name: { en: "Product, Engineering & R&D", ja: "製品開発・研究開発" },
    description: {
      en: "Organize requirements, experiments and evidence for product releases.",
      ja: "要件、実験、製品リリースの判断資料を整理します。",
    },
    workflows: {
      en: ["Requirements review", "Experiment tracking", "Release preparation"],
      ja: ["要件確認", "実験管理", "リリース準備"],
    },
    layout: "roadmap",
  },
  {
    id: "facilities",
    name: { en: "Facilities & Assets", ja: "施設・資産管理" },
    description: {
      en: "Maintain workplace assets, maintenance schedules and service requests.",
      ja: "職場の資産、保守予定、設備の依頼を管理します。",
    },
    workflows: {
      en: ["Maintenance requests", "Asset registration", "Inspection scheduling"],
      ja: ["保守依頼", "資産登録", "点検予定"],
    },
    layout: "assets",
  },
  {
    id: "quality",
    name: { en: "Quality & Assurance", ja: "品質保証" },
    description: {
      en: "Track nonconformities, corrective actions and verification evidence.",
      ja: "不適合、是正措置、検証資料を管理します。",
    },
    workflows: {
      en: ["Issue assessment", "Corrective actions", "Closure verification"],
      ja: ["問題の評価", "是正措置", "完了検証"],
    },
    layout: "verification",
  },
];

export const SME_DEPARTMENT_GROUPS: {
  id: string;
  name: { en: string; ja: string };
  departments: DepartmentId[];
}[] = [
  {
    id: "leadership",
    name: { en: "Leadership & Office", ja: "経営・オフィス" },
    departments: ["secretariat", "admin", "planning"],
  },
  { id: "money", name: { en: "Money", ja: "財務・購買" }, departments: ["finance", "procurement"] },
  { id: "people", name: { en: "People", ja: "人事" }, departments: ["hr"] },
  {
    id: "customers",
    name: { en: "Customers", ja: "顧客" },
    departments: ["sales", "marketing", "service"],
  },
  {
    id: "delivery",
    name: { en: "Delivery", ja: "提供・開発" },
    departments: ["operations", "product", "quality"],
  },
  {
    id: "systems",
    name: { en: "Systems & Controls", ja: "システム・管理" },
    departments: ["it", "legal", "facilities"],
  },
];

export function getBusinessDepartment(id: string): BusinessDepartment | undefined {
  return BUSINESS_DEPARTMENTS.find((department) => department.id === id);
}

// Exact pairs from the shipped template packs. Custom queues remain unassigned.
const LEGACY_TEMPLATE_QUEUES: ReadonlyMap<string, ReadonlyMap<string, DepartmentId>> = new Map([
  [
    "business-general-affairs",
    new Map<string, DepartmentId>([
      ["ga-requests", "admin"],
      ["ga-facilities", "admin"],
    ]),
  ],
  [
    "business-finance-expense-invoice",
    new Map<string, DepartmentId>([
      ["fin-expense", "finance"],
      ["fin-invoice", "finance"],
      ["fin-ringi", "finance"],
    ]),
  ],
  [
    "business-hr-leave-overtime",
    new Map<string, DepartmentId>([
      ["hr-leave", "hr"],
      ["hr-overtime", "hr"],
    ]),
  ],
  ["business-procurement", new Map<string, DepartmentId>([["proc-requests", "procurement"]])],
]);

/** Presentation grouping only; queue mapping never grants record access. */
export function departmentForQueue(queue: WorkQueueDef, templateId?: string): DepartmentId | null {
  if ("department" in queue) {
    return typeof queue.department === "string"
      ? (getBusinessDepartment(queue.department)?.id ?? null)
      : null;
  }
  return templateId ? (LEGACY_TEMPLATE_QUEUES.get(templateId)?.get(queue.id) ?? null) : null;
}
