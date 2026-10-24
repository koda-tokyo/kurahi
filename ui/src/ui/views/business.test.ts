import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types.js";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { setLocale } from "../i18n";
import { renderBusiness } from "./business";

const project = {
  id: "fictional-office",
  name: "Fictional Office",
  folder: "/demo/office",
} as Project;
const item: WorkitemsGetResult["item"] = {
  id: "fictional-item-1",
  projectId: project.id,
  queue: "expense-review",
  type: "expense",
  title: '<img src=x onerror="window.pwned=true"> Expense review',
  status: "awaiting_review",
  assignee: null,
  priority: "high",
  dueAt: "2026-10-30T09:00:00Z",
  slaHours: 24,
  draft: {
    artifactId: "fictional-artifact",
    version: 4,
    sha256: "a".repeat(64),
    agentId: "agent-demo",
    runId: "run-demo",
    createdAt: "2026-10-22T12:00:00Z",
  },
  checks: [
    {
      policyId: "receipt-present",
      label: { en: "Receipt attached", ja: "領収書あり" },
      result: "pass",
      blocking: true,
      evidence: { filename: "receipt.pdf", detail: "Fictional evidence" },
      checkedAt: "2026-10-22T12:01:00Z",
      draftVersion: 4,
      policyDigest: "b".repeat(64),
    },
  ],
  requiredApprovals: 2,
  approvals: [{ by: "person-demo", at: "2026-10-22T12:05:00Z", comment: null }],
  override: {
    by: "reviewer-demo",
    at: "2026-10-22T12:06:00Z",
    reason: "Fictional documented exception",
    policyIds: ["receipt-present"],
  },
  runIds: ["run-demo"],
  lastError: null,
  createdAt: "2026-10-22T12:00:00Z",
  createdBy: "person-demo",
  updatedAt: "2026-10-22T12:06:00Z",
  revision: 5,
  source: {
    fields: { merchant: "Example Supplies", amount: 128.5, note: "Fictional source" },
    documents: [
      { kind: "file", ref: "demo/receipt.pdf", name: "receipt.pdf", sha256: "c".repeat(64) },
    ],
  },
  history: [
    {
      at: "2026-10-22T12:06:00Z",
      by: "reviewer-demo",
      actorKind: "person",
      action: "override_recorded",
      from: "awaiting_review",
      to: "awaiting_review",
      comment: "Recorded for demo",
      evidence: { bundle: "bundle-demo", root: "d".repeat(64) },
    },
  ],
};
const summary: WorkitemsListResult["items"][number] = {
  ...item,
  source: { documents: 1, fields: Object.keys(item.source.fields) },
  overdue: false,
};
const config: WorkitemsConfigResult = {
  queues: [
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
  digest: "e".repeat(64),
  error: null,
};
const list: WorkitemsListResult = {
  items: [summary],
  nextCursor: "next-demo",
  total: 2,
  counts: { awaiting_review: 2 },
};

function mount(overrides: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const state = {
    locale: "en",
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
    refreshBusiness: vi.fn(),
    selectBusinessQueue: vi.fn(),
    selectBusinessItem: vi.fn(),
    loadMoreBusiness: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
  render(renderBusiness(state, project), root);
  return { root, state };
}

afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
});

describe("Business queue review", () => {
  it("restores the selected queue after async options disappear and return", () => {
    const { root, state } = mount();
    state.business = { ...state.business, queue: "expense-review", config: null };
    render(renderBusiness(state, project), root);
    state.business = { ...state.business, config };
    render(renderBusiness(state, project), root);
    expect(root.querySelector("select")!.value).toBe("expense-review");
  });

  it("shows source, pinned draft metadata, checks, approvals, override, history, and policies", () => {
    const { root } = mount();
    expect(root.textContent).toContain("Example Supplies");
    expect(root.textContent).toContain("fictional-artifact");
    expect(root.textContent).toContain("Receipt attached");
    expect(root.textContent).toContain("1 / 2");
    expect(root.textContent).toContain("Fictional documented exception");
    expect(root.textContent).toContain("override_recorded");
    expect(root.textContent).toContain("Separation of duties");
    expect(root.textContent).toContain("business/queues.json");
    expect(root.textContent).toContain("Showing 1 of 2");
    expect(root.textContent).toContain("Draft content is not loaded");
    expect(root.textContent).toContain("signatures have not been verified");
    expect(root.textContent).toContain("a".repeat(64));
    expect(root.querySelector("script, img")).toBeNull();
  });

  it("routes queue, item, refresh and pagination interactions", () => {
    const { root, state } = mount();
    const select = root.querySelector("select")!;
    select.value = "expense-review";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(".business-item")!.click();
    root.querySelector<HTMLButtonElement>(".business-load-more")!.click();
    root.querySelector<HTMLButtonElement>(".business-refresh")!.click();
    expect(state.selectBusinessQueue).toHaveBeenCalledWith("expense-review");
    expect(state.selectBusinessItem).toHaveBeenCalledWith(item.id);
    expect(state.loadMoreBusiness).toHaveBeenCalledOnce();
    expect(state.refreshBusiness).toHaveBeenCalledOnce();
  });

  it("keeps the selected detail visible during a background refresh", () => {
    const { root } = mount({
      business: {
        projectId: project.id,
        queue: "",
        config,
        list,
        item,
        selectedId: item.id,
        loading: true,
        detailLoading: true,
        error: null,
        detailError: null,
      },
    });
    expect(root.textContent).toContain("fictional-artifact");
    expect(root.textContent).toContain("Updating");
  });

  it("localizes controls and displays localized service errors, empty and disconnected states", () => {
    setLocale("ja");
    const { root: localizedRoot } = mount({ locale: "ja" });
    expect(localizedRoot.textContent).toContain("業務キュー");
    expect(localizedRoot.textContent).toContain("領収書あり");

    setLocale("en");
    const { root: errorRoot } = mount({
      business: {
        projectId: project.id,
        queue: "",
        config: null,
        list: null,
        item: null,
        selectedId: null,
        loading: false,
        detailLoading: false,
        error: "private backend error",
        detailError: "private detail error",
      },
    });
    expect(errorRoot.textContent).toContain("The work queue could not be loaded");
    expect(errorRoot.textContent).not.toContain("private backend error");

    const empty = {
      projectId: project.id,
      queue: "",
      config,
      list: { ...list, items: [], nextCursor: null },
      item: null,
      selectedId: null,
      loading: false,
      detailLoading: false,
      error: null,
      detailError: null,
    };
    const { root: emptyRoot } = mount({ business: empty });
    expect(emptyRoot.textContent).toContain("No work items in this queue");
    const { root: disconnectedRoot } = mount({ connected: false });
    expect(disconnectedRoot.textContent).toContain("The service is disconnected");
    expect(disconnectedRoot.querySelector(".business-item")).toBeNull();
    expect(disconnectedRoot.querySelector(".business-policy-strip")).toBeNull();

    const { root: policyErrorRoot } = mount({
      business: {
        projectId: project.id,
        queue: "",
        config: { ...config, error: "private policy error" },
        list,
        item,
        selectedId: item.id,
        loading: false,
        detailLoading: false,
        error: null,
        detailError: null,
      },
    });
    expect(policyErrorRoot.textContent).toContain("Queue policy configuration could not be loaded");
    expect(policyErrorRoot.textContent).not.toContain("private policy error");
  });
});
