import { html, render } from "lit";
import "../src/styles.css";
import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../packages/client/src/generated/types.js";
import type { BusinessWorkForm } from "../src/ui/controllers/business-work-intake";
import type { Project } from "../src/ui/controllers/projects";
import { BUSINESS_DEPARTMENTS, getBusinessDepartment } from "../src/ui/business-departments";
import { emptyBusiness, type BusinessState } from "../src/ui/controllers/business";
import { setLocale } from "../src/ui/i18n";
import { renderBusiness } from "../src/ui/views/business";
import { M365_TEST_CASES } from "./business-mail-cases";
const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "ja" ? "ja" : "en";
setLocale(locale);
document.documentElement.lang = locale;
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
document.body.className = "business-visual-fixture";
const project = {
  id: "fictional-company",
  name: "Northstar · Fictional visual fixture",
  folder: "/demo/northstar",
  mode: "read",
  rules: { artifactApprovalRequired: true },
  templateId: "business-company-operations",
} as Project;
const config: WorkitemsConfigResult & { departments: string[] } = {
  departments: BUSINESS_DEPARTMENTS.map((department) => department.id),
  queues: BUSINESS_DEPARTMENTS.map((d) => ({
    id: `${d.id}-work`,
    department: d.id,
    name: { en: `${d.name.en} requests`, ja: `${d.name.ja}の依頼` },
    types: ["invoice"],
    slaHours: 48,
    defaultAgent: null,
  })),
  rules: [],
  timezone: "Asia/Tokyo",
  separationOfDuties: true,
  source: { kind: "project", path: "business/queues.json" },
  digest: "71ca9d2f".repeat(8),
  error: null,
  routes: [],
  access: { fallback: "none", configured: false, roles: [], members: null },
  viewer: {
    principal: "owner",
    privileged: true,
    roles: ["requester"],
    departments: [],
    listed: false,
  },
};
const item: WorkitemsGetResult["item"] = {
  id: "fictional-item-042",
  projectId: project.id,
  queue: "invoice-review",
  type: "invoice",
  title: "Atlas Office Supply · invoice 1042",
  status: "awaiting_review",
  assignee: { kind: "person", id: "reviewer-demo" },
  priority: "high",
  dueAt: "2026-10-30T09:00:00+09:00",
  slaHours: 48,
  draft: {
    artifactId: "artifact-demo-1042",
    version: 3,
    sha256: "6f43ec8b".repeat(8),
    agentId: "finance-demo",
    runId: "run-demo-77",
    createdAt: "2026-10-22T12:42:00+09:00",
  },
  checks: [
    {
      policyId: "invoice.total-match",
      label: { en: "Invoice total matches source", ja: "請求書合計がソースと一致" },
      result: "pass",
      blocking: true,
      evidence: { sourceTotal: 18420, invoiceTotal: 18420, currency: "JPY" },
      checkedAt: "2026-10-22T12:43:00+09:00",
      draftVersion: 3,
      policyDigest: "2b8d4ad9".repeat(8),
    },
    {
      policyId: "invoice.vendor-review",
      label: { en: "Vendor needs review", ja: "取引先の確認が必要" },
      result: "warn",
      blocking: false,
      evidence: { note: "Fictional demo flag" },
      checkedAt: "2026-10-22T12:43:00+09:00",
      draftVersion: 3,
      policyDigest: "2b8d4ad9".repeat(8),
    },
  ],
  requiredApprovals: 2,
  approvals: [
    { by: "reviewer-demo", at: "2026-10-22T13:00:00+09:00", comment: "Source documents reviewed" },
  ],
  override: null,
  runIds: ["run-demo-77"],
  lastError: null,
  createdAt: "2026-10-22T12:40:00+09:00",
  createdBy: "finance-demo",
  requestedBy: "finance-demo",
  route: null,
  updatedAt: "2026-10-22T13:00:00+09:00",
  revision: 7,
  source: {
    fields: {
      vendor: "Atlas Office Supply",
      invoiceNumber: "1042",
      amount: 18420,
      currency: "JPY",
      costCenter: "OPS-14",
    },
    documents: [
      {
        kind: "file",
        ref: "demo/invoices/1042.pdf",
        name: "invoice-1042.pdf",
        sha256: "c49be316".repeat(8),
      },
      { kind: "attachment", ref: "demo/receipts/1042-receipt.pdf", name: "receipt-1042.pdf" },
    ],
  },
  history: [
    {
      at: "2026-10-22T12:40:00+09:00",
      by: "finance-demo",
      actorKind: "agent",
      action: "draft_created",
      from: "drafting",
      to: "awaiting_review",
      comment: "Prepared from the attached invoice.",
      evidence: { bundle: "invoice-review-042", root: "a6fa3db2".repeat(8) },
    },
    {
      at: "2026-10-22T13:00:00+09:00",
      by: "reviewer-demo",
      actorKind: "person",
      action: "approval_recorded",
      comment: "First of two required approvals",
    },
  ],
};

const records: Array<WorkitemsGetResult["item"]> = BUSINESS_DEPARTMENTS.flatMap((d) =>
  [0, 1].map((index) => ({
    ...structuredClone(item),
    id: `fictional-${d.id}-${index}`,
    queue: `${d.id}-work`,
    title: `${d.workflows[locale][index]} · ${locale === "ja" ? "架空の案件" : "Fictional request"} ${index + 1}`,
    status: index === 0 ? ("awaiting_review" as const) : ("new" as const),
    source: {
      fields: { department: d.name[locale], description: d.description[locale] },
      documents: [
        { kind: "file" as const, ref: `demo/${d.id}/brief.pdf`, name: "Fictional brief.pdf" },
      ],
    },
  })),
);
const initial = getBusinessDepartment(params.get("department") ?? "finance")?.id ?? "finance";
records.splice(
  0,
  records.length,
  ...records.filter((record) => !["secretariat-work", "finance-work"].includes(record.queue)),
);
for (const mail of M365_TEST_CASES) {
  for (const department of [
    "secretariat",
    ...([1, 3, 7, 10].includes(mail.id) ? ["finance"] : []),
  ]) {
    const record = structuredClone(item);
    record.id = `fictional-mail-${department}-${mail.id}`;
    record.queue = `${department}-work`;
    record.title = `${mail.sender} · ${mail.subject}`;
    record.priority = mail.priority;
    record.approvals = [];
    record.runIds = [];
    record.dueAt = null;
    record.assignee = null;
    record.createdAt = "2026-10-25T02:00:00+09:00";
    record.updatedAt = record.createdAt;
    record.draft = null;
    record.history = [];
    record.checks =
      mail.id === 10
        ? [
            {
              policyId: "finance.bank-change-verification",
              label: {
                en: "Independent supplier callback required",
                ja: "登録済み連絡先への電話確認が必要",
              },
              result: "fail",
              blocking: true,
              evidence: { reason: mail.nextAction[locale], verified: false },
              checkedAt: "2026-10-25T02:00:00+09:00",
              draftVersion: null,
              policyDigest: "2b8d4ad9".repeat(8),
            },
          ]
        : [];
    record.source = { fields: { description: mail.nextAction[locale] }, documents: [] };
    records.push(record);
  }
}
const business: BusinessState = {
  ...emptyBusiness(),
  config,
  projectId: project.id,
  department: initial,
  organizationMode: params.get("mode") === "sme" ? "sme" : "enterprise",
  queue: `${initial}-work`,
};
function refresh() {
  const visible = records.filter(
    (r) =>
      (!business.queue || r.queue === business.queue) &&
      (!business.status || r.status === business.status) &&
      r.title.toLowerCase().includes(business.search.toLowerCase()),
  );
  const rows: WorkitemsListResult["items"] = visible.map((r) => ({
    ...r,
    source: { fields: Object.keys(r.source.fields), documents: r.source.documents.length },
    overdue: false,
    currentStage: null,
  }));
  business.list = {
    items: rows,
    total: rows.length,
    counts: Object.fromEntries(
      ["new", "awaiting_review"].map((s) => [s, rows.filter((r) => r.status === s).length]),
    ),
    nextCursor: null,
  };
  paint();
}
const fixtureNotice = () => {
  business.workNotice =
    locale === "ja"
      ? "架空の表示用データです。サーバー操作は実行していません。"
      : "Fictional visual fixture: no server action was performed.";
  paint();
};
const state: Parameters<typeof renderBusiness>[0] = {
  business,
  locale,
  connected: true,
  businessChatDraft: "",
  editBusinessChatDraft: (draft) => {
    state.businessChatDraft = draft;
    paint();
  },
  startBusinessChat: async () => {
    state.businessChatError =
      locale === "ja"
        ? "表示確認用です。実際の会話は開始していません。"
        : "Visual fixture only. No live conversation was started.";
    paint();
  },
  selectBusinessDepartment: async (id) => {
    business.department = id;
    business.queue = id === "all" ? "" : `${id}-work`;
    business.item = null;
    business.selectedId = null;
    business.search = "";
    business.status = "";
    refresh();
  },
  setBusinessOrganizationMode: (mode) => {
    business.organizationMode = mode;
    paint();
  },
  selectBusinessQueue: async (queue) => {
    business.queue = queue;
    business.item = null;
    business.selectedId = null;
    refresh();
  },
  filterBusiness: async (search, status) => {
    business.search = search;
    business.status = status;
    refresh();
  },
  selectBusinessItem: async (id) => {
    business.item = records.find((r) => r.id === id) ?? null;
    business.selectedId = id;
    paint();
  },
  refreshBusiness: async () => refresh(),
  loadMoreBusiness: async () => refresh(),
  beginBusinessWork: async () => {
    business.workForm = {
      queue: business.queue,
      type: "invoice",
      title: "",
      description: "",
      requester: "owner",
    };
    paint();
  },
  editBusinessWork: (update: Partial<BusinessWorkForm>) => {
    if (business.workForm) {
      business.workForm = { ...business.workForm, ...update };
    }
    paint();
  },
  cancelBusinessWork: async () => {
    business.workForm = null;
    paint();
  },
  createBusinessWork: async () => fixtureNotice(),
  acknowledgeBusinessWorkOutcome: fixtureNotice,
  beginBusinessExpense: async () => fixtureNotice(),
  editBusinessExpense: fixtureNotice,
  cancelBusinessExpense: async () => fixtureNotice(),
  createBusinessExpense: async () => fixtureNotice(),
  acknowledgeExpenseOutcome: fixtureNotice,
  verifyBusinessEvidence: async () => fixtureNotice(),
  loadBusinessDraft: async () => fixtureNotice(),
  beginBusinessDecision: async () => fixtureNotice(),
  editBusinessDecision: fixtureNotice,
  cancelBusinessDecision: async () => fixtureNotice(),
  submitBusinessDecision: async () => fixtureNotice(),
};
function paint() {
  render(
    html`<header class="business-demo-banner"><strong>Kurahi · Business Edition</strong></header><p class="business-demo-banner">Fictional visual fixture · ${locale === "ja" ? "架空のデータ・サーバー接続なし" : "No server connection or live actions"}</p>${renderBusiness(state, project)}`,
    document.querySelector<HTMLElement>("#fixture")!,
  );
}
refresh();
