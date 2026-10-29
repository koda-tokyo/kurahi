import { html, render } from "lit";
import "../src/styles.css";
import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../packages/client/src/generated/types.js";
import type { AppViewState } from "../src/ui/app-view-state";
import type { Project } from "../src/ui/controllers/projects";
import { setLocale, t } from "../src/ui/i18n";
import { renderBusiness } from "../src/ui/views/business";

const project = {
  id: "fictional-northstar",
  name: "Northstar Services (Fictional demo)",
  folder: "/demo/northstar",
  mode: "read",
  rules: { artifactApprovalRequired: true },
  templateId: null,
} as Project;
const config: WorkitemsConfigResult = {
  queues: [
    {
      id: "invoice-review",
      name: { en: "Invoice review", ja: "請求書レビュー" },
      types: ["invoice"],
      slaHours: 48,
      defaultAgent: "finance-demo",
    },
    {
      id: "expense-review",
      name: { en: "Expense review", ja: "経費レビュー" },
      types: ["expense"],
      slaHours: 24,
      defaultAgent: null,
    },
  ],
  rules: [],
  timezone: "Asia/Tokyo",
  separationOfDuties: true,
  source: { kind: "project", path: "business/queues.json" },
  digest: "71ca9d2f0a67be5ca177a56ea43c8c477005f2e35b7e1557a9828d40a8fb2194",
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
// A fictional staged route; all progress and warning markers come from the fixture contract.
if (new URLSearchParams(location.search).get("route") === "staged") {
  const baseStage = {
    approvers: {
      any: false,
      roles: ["finance"],
      principals: [],
      departmentField: null,
      department: null,
    },
    minApprovals: 1,
    dueHours: 24,
    onReturn: "requester" as const,
    delegation: true,
    escalation: null,
    approvals: [],
    delegations: [],
    activatedAt: null,
    dueAt: null,
    completedAt: null,
    overdueAt: null,
    escalatedAt: null,
  };
  item.route = {
    id: "fictional-invoice-route",
    kind: "staged",
    policyDigest: config.digest,
    current: 1,
    stages: [
      {
        ...baseStage,
        id: "manager",
        name: { en: "Department review", ja: "部門確認" },
        status: "approved",
        approvals: [
          {
            by: "reviewer-demo",
            at: "2026-10-22T13:00:00+09:00",
            comment: "Source reviewed",
            stageId: "manager",
          },
        ],
        completedAt: "2026-10-22T13:00:00+09:00",
      },
      {
        ...baseStage,
        id: "finance",
        name: { en: "Finance review", ja: "経理確認" },
        status: "active",
        minApprovals: 2,
        activatedAt: "2026-10-22T13:00:00+09:00",
        dueAt: "2026-10-23T13:00:00+09:00",
        overdueAt: "2026-10-23T13:05:00+09:00",
        escalatedAt: "2026-10-23T14:05:00+09:00",
        escalation: { afterHours: 1, to: { roles: ["finance-lead"], principals: [] } },
      },
      {
        ...baseStage,
        id: "final",
        name: { en: "Final review", ja: "最終確認" },
        status: "pending",
      },
    ],
    skipped: [
      {
        id: "additional",
        name: { en: "Additional review", ja: "追加確認" },
        reason: "Fictional invoice is below the configured threshold.",
      },
    ],
  };
  item.requiredApprovals = item.route.stages.reduce(
    (total, stage) => total + stage.minApprovals,
    0,
  );
  item.approvals = item.route.stages.flatMap((stage) => stage.approvals);
  item.history[1].comment = "Department review approved; finance review is current";
}
const expenseAction = new URLSearchParams(location.search).get("expenseAction");
if (expenseAction === "edit" || expenseAction === "submit") {
  Object.assign(item, {
    id: "fictional-expense-042",
    queue: "expense-review",
    type: "expense",
    title: "Stationery for the training room (fictional)",
    status: "new",
    draft: null,
    approvals: [],
    checks: [],
    history: [],
    source: {
      fields: {
        employeeId: "DEMO-042",
        amount: 1840,
        expenseDate: "2026-10-22",
        category: "Office supplies",
        purpose: "Materials for the fictional workshop.",
      },
      documents: [{ kind: "file", ref: "demo/receipts/stationery.pdf", name: "stationery.pdf" }],
    },
  });
}
const listRow: WorkitemsListResult["items"][number] = {
  ...item,
  source: { documents: item.source.documents.length, fields: Object.keys(item.source.fields) },
  overdue: false,
  currentStage: null,
};
const list: WorkitemsListResult = {
  items: [
    listRow,
    {
      ...listRow,
      id: "fictional-item-043",
      title: expenseAction
        ? "Workshop travel supplies (fictional)"
        : "Cedar Print House · invoice 208",
    },
  ],
  nextCursor: "fictional-cursor",
  total: 7,
  counts: { [item.status]: 7 },
};
const locale = new URLSearchParams(location.search).get("locale") === "ja" ? "ja" : "en";
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
setLocale(locale);
document.documentElement.lang = locale;
document.documentElement.dataset.theme = theme;
document.body.className = "business-visual-fixture";
// Not-offered worksheet plans with an unbreakable pack path, for the narrow-screen check.
const omittedPath = `requests/${"onboarding_worksheet_".repeat(6)}final.md`;
const linkedOmitted = new URLSearchParams(location.search).get("linked") === "omitted";
const state = {
  locale,
  connected: true,
  business: {
    linked: linkedOmitted
      ? { itemId: item.id, revision: item.revision, status: "none", linkedCase: null }
      : null,
    linkedCreate: linkedOmitted
      ? {
          itemId: item.id,
          revision: item.revision,
          steps: [{ department: "it", title: "Accounts", after: [] }],
          pending: false,
          notice: null,
          omitted: [
            { file: omittedPath, reason: "problems", problems: ["untrusted_file", "no_manifest"] },
            { file: omittedPath.replace("final", "loop"), reason: "order", problems: [] },
          ],
        }
      : null,
    expensePending: false,
    expenseUncertain: false,
    expenseNotice: null,
    expenseForm:
      new URLSearchParams(location.search).get("intake") === "expense" ||
      expenseAction === "edit" ||
      expenseAction === "submit"
        ? {
            ...(expenseAction === "edit" || expenseAction === "submit"
              ? { target: { id: item.id, revision: item.revision, action: expenseAction } }
              : {}),
            queue: "expense-review",
            title: "Stationery for the training room (fictional)",
            employeeId: "DEMO-042",
            amount: "1840",
            expenseDate: "2026-10-22",
            category: "Office supplies",
            purpose: "Materials for the fictional workshop.",
            documents: "demo/receipts/stationery.pdf",
          }
        : null,
    evidence: null,
    projectId: project.id,
    queue: "",
    config,
    list,
    item,
    selectedId: item.id,
    loading: false,
    detailLoading: false,
    error: null,
    detailError: null,
    decisionForm:
      new URLSearchParams(location.search).get("decision") === "approve"
        ? {
            id: item.id,
            revision: item.revision,
            decision: "approve",
            comment: "",
            override: true,
            overrideReason: "",
          }
        : null,
    draftPreview: {
      itemId: item.id,
      revision: item.revision,
      status: "ready",
      content:
        "Invoice review · Fictional demo\n\nAtlas Office Supply / invoice 1042\nTotal: JPY 18,420\nCost centre: OPS-14\n\nThe recorded total matches the source fields. Vendor review remains open.\n\nRecommendation: request the second reviewer’s confirmation before processing. No payment has been made.",
    },
    decisionPending: false,
    decisionNotice: null,
  },
  beginBusinessExpense: async () => undefined,
  editBusinessExpense: () => undefined,
  cancelBusinessExpense: async () => undefined,
  createBusinessExpense: async () => undefined,
  acknowledgeExpenseOutcome: () => undefined,
  refreshBusiness: async () => undefined,
  selectBusinessQueue: async () => undefined,
  selectBusinessItem: async () => undefined,
  loadMoreBusiness: async () => undefined,
  verifyBusinessEvidence: async () => undefined,
  loadBusinessDraft: async () => undefined,
  beginBusinessDecision: () => undefined,
  editBusinessDecision: () => undefined,
  cancelBusinessDecision: () => undefined,
  submitBusinessDecision: async () => undefined,
} as unknown as AppViewState;
render(
  html`<p class="business-demo-banner">${t("business.demoLabel")}</p>${renderBusiness(state, project)}`,
  document.querySelector("#fixture")!,
);
