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
const listRow: WorkitemsListResult["items"][number] = {
  ...item,
  source: { documents: item.source.documents.length, fields: Object.keys(item.source.fields) },
  overdue: false,
};
const list: WorkitemsListResult = {
  items: [
    listRow,
    { ...listRow, id: "fictional-item-043", title: "Cedar Print House · invoice 208" },
  ],
  nextCursor: "fictional-cursor",
  total: 7,
  counts: { awaiting_review: 7 },
};
const locale = new URLSearchParams(location.search).get("locale") === "ja" ? "ja" : "en";
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
setLocale(locale);
document.documentElement.lang = locale;
document.documentElement.dataset.theme = theme;
document.body.className = "business-visual-fixture";
const state = {
  locale,
  connected: true,
  business: {
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
  },
  refreshBusiness: async () => undefined,
  selectBusinessQueue: async () => undefined,
  selectBusinessItem: async () => undefined,
  loadMoreBusiness: async () => undefined,
} as unknown as AppViewState;
render(
  html`<p class="business-demo-banner">${t("business.demoLabel")}</p>${renderBusiness(state, project)}`,
  document.querySelector("#fixture")!,
);
