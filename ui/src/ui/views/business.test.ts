import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types.js";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import { setLocale, t } from "../i18n";
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
  requestedBy: "person-demo",
  route: null,
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
  currentStage: null,
};
const config: WorkitemsConfigResult = {
  departments: ["finance", "hr"],
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
      decisionForm: null,
      decisionPending: false,
      decisionNotice: null,
    },
    beginBusinessExpense: vi.fn(),
    editBusinessExpense: vi.fn(),
    cancelBusinessExpense: vi.fn(),
    createBusinessExpense: vi.fn(),
    acknowledgeExpenseOutcome: vi.fn(),
    refreshBusiness: vi.fn(),
    selectBusinessQueue: vi.fn(),
    selectBusinessDepartment: vi.fn(),
    setBusinessOrganizationMode: vi.fn(),
    filterBusiness: vi.fn(),
    beginBusinessWork: vi.fn(),
    editBusinessWork: vi.fn(),
    cancelBusinessWork: vi.fn(),
    createBusinessWork: vi.fn(),
    acknowledgeBusinessWorkOutcome: vi.fn(),
    selectBusinessItem: vi.fn(),
    loadMoreBusiness: vi.fn(),
    loadBusinessDraft: vi.fn(),
    verifyBusinessEvidence: vi.fn(),
    beginBusinessDecision: vi.fn(),
    editBusinessDecision: vi.fn(),
    cancelBusinessDecision: vi.fn(),
    submitBusinessDecision: vi.fn(),
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
  it("shows unmapped queues and server totals without chat or legacy department inference", () => {
    const { root, state } = mount();
    state.business = {
      ...state.business,
      department: "unmapped",
      config: {
        ...config,
        queues: [
          { ...config.queues[0], id: "fin-expense" },
          { ...config.queues[0], id: "mapped", department: "finance" },
        ],
      },
      list: { ...list, total: 73 },
    };
    render(
      renderBusiness(state, { ...project, templateId: "business-finance-expense-invoice" }),
      root,
    );
    const queueOptions = [
      ...root.querySelectorAll<HTMLSelectElement>("[data-business-queue] option"),
    ].map((option) => option.value);
    expect(queueOptions).toEqual(["", "fin-expense"]);
    expect(root.textContent).toContain("Unmapped queues");
    expect(root.querySelector(".business-count")!.textContent).toContain("73");
    expect(root.querySelector('[data-department="unmapped"]')!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(root.querySelector(".business-chat-entry")).toBeNull();
    state.business = { ...state.business, department: "finance" };
    render(
      renderBusiness(state, { ...project, templateId: "business-finance-expense-invoice" }),
      root,
    );
    expect(
      [...root.querySelectorAll("[data-department-queue]")].map((button) =>
        button.getAttribute("data-department-queue"),
      ),
    ).toEqual(["", "mapped"]);
  });
  it("connects department and organization navigation to the application", () => {
    const { root, state } = mount();
    root.querySelector<HTMLButtonElement>('[data-department="finance"]')!.click();
    expect(state.selectBusinessDepartment).toHaveBeenCalledWith("finance");
    root.querySelector<HTMLButtonElement>('[data-department-mode="sme"]')!.click();
    expect(state.setBusinessOrganizationMode).toHaveBeenCalledWith("sme");
  });
  it("submits search and status together without filtering a loaded subset", () => {
    const { root, state } = mount();
    const form = root.querySelector<HTMLFormElement>(".business-departments__filters")!;
    form.querySelector<HTMLInputElement>('[name="search"]')!.value = "Receipt";
    form.querySelector<HTMLSelectElement>('[name="status"]')!.value = "awaiting_review";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(state.filterBusiness).toHaveBeenCalledWith("Receipt", "awaiting_review");
    expect(root.textContent).toContain("Showing 1 of 2");
  });
  it("shows one department work list, real creation and cursor pagination", () => {
    const { root, state } = mount();
    state.business = {
      ...state.business,
      department: "finance",
      queue: "expense-review",
      config: { ...config, queues: [{ ...config.queues[0], department: "finance" }] },
    };
    render(renderBusiness(state, project), root);
    expect(root.querySelector(".business-departments__workspace")).not.toBeNull();
    expect(root.querySelector(".business-items-panel")).toBeNull();
    root.querySelector<HTMLButtonElement>("[data-business-work-new]")!.click();
    expect(state.beginBusinessWork).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>(".business-load-more")!.click();
    expect(state.loadMoreBusiness).toHaveBeenCalledOnce();
    state.business.workPending = true;
    render(renderBusiness(state, project), root);
    expect(root.querySelector<HTMLButtonElement>('[data-department="hr"]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("[data-business-work-new]")!.disabled).toBe(true);
  });
  it("opens intake only for a healthy configured expense queue", () => {
    const { root, state } = mount();
    root.querySelector<HTMLButtonElement>("[data-business-expense]")!.click();
    expect(state.beginBusinessExpense).toHaveBeenCalledOnce();
    state.business.expensePending = true;
    render(renderBusiness(state, project), root);
    expect(root.querySelector<HTMLButtonElement>("[data-business-expense]")!.disabled).toBe(true);
    state.business = { ...state.business, config: { ...config, queues: [] } };
    render(renderBusiness(state, project), root);
    expect(root.querySelector("[data-business-expense]")).toBeNull();
  });

  it("restores the selected queue after async options disappear and return", () => {
    const { root, state } = mount();
    state.business = { ...state.business, queue: "expense-review", config: null };
    render(renderBusiness(state, project), root);
    state.business = { ...state.business, config };
    render(renderBusiness(state, project), root);
    expect(root.querySelector<HTMLSelectElement>("[data-business-queue]")!.value).toBe(
      "expense-review",
    );
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
    const select = root.querySelector<HTMLSelectElement>("[data-business-queue]")!;
    select.value = "expense-review";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(".business-item")!.click();
    root.querySelector<HTMLButtonElement>(".business-load-more")!.click();
    root.querySelector<HTMLButtonElement>("[data-business-refresh]")!.click();
    expect(state.selectBusinessQueue).toHaveBeenCalledWith("expense-review");
    expect(state.selectBusinessItem).toHaveBeenCalledWith(item.id);
    expect(state.loadMoreBusiness).toHaveBeenCalledOnce();
    expect(state.refreshBusiness).toHaveBeenCalledOnce();
  });

  it("offers person decisions and validates comments, overrides, revision, and busy states", () => {
    const { root, state } = mount();
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>(".business-decision__actions button"),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Approve",
      "Send back",
      "Cancel item",
    ]);
    buttons[0].click();
    expect(state.beginBusinessDecision).toHaveBeenCalledWith("approve");

    const formState = {
      id: item.id,
      revision: item.revision,
      decision: "approve" as const,
      comment: "",
      overrideReason: "",
      override: false,
    };
    state.business = { ...state.business, decisionForm: formState };
    render(renderBusiness(state, project), root);
    const approvalSubmit = root.querySelector<HTMLButtonElement>(
      '.business-decision__form button[type="submit"]',
    )!;
    expect(approvalSubmit.disabled).toBe(false);
    const override = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    override.checked = true;
    override.dispatchEvent(new Event("change", { bubbles: true }));
    expect(state.editBusinessDecision).toHaveBeenCalledWith({ override: true });
    state.business = {
      ...state.business,
      decisionForm: { ...formState, override: true, overrideReason: "short" },
    };
    render(renderBusiness(state, project), root);
    expect(
      root.querySelector<HTMLButtonElement>('.business-decision__form button[type="submit"]')!
        .disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLTextAreaElement>(".business-decision__form textarea:last-of-type")!
        .maxLength,
    ).toBe(2000);
    state.business = {
      ...state.business,
      decisionForm: { ...formState, override: true, overrideReason: "x".repeat(2001) },
    };
    render(renderBusiness(state, project), root);
    expect(
      root.querySelector<HTMLButtonElement>('.business-decision__form button[type="submit"]')!
        .disabled,
    ).toBe(true);
    state.business = {
      ...state.business,
      decisionForm: { ...formState, revision: item.revision - 1 },
    };
    render(renderBusiness(state, project), root);
    expect(
      root.querySelector<HTMLButtonElement>('.business-decision__form button[type="submit"]')!
        .disabled,
    ).toBe(true);

    state.business = {
      ...state.business,
      decisionForm: { ...formState, decision: "send_back", comment: "  " },
    };
    render(renderBusiness(state, project), root);
    expect(
      root.querySelector<HTMLButtonElement>('.business-decision__form button[type="submit"]')!
        .disabled,
    ).toBe(true);
    expect(root.textContent).toContain("A comment is required");
    expect(
      root
        .querySelector('[aria-describedby="business-comment-validation"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(root.querySelector("#business-comment-validation")?.textContent).toContain(
      "A comment is required",
    );

    const cancelForm = { ...formState, decision: "cancel" as const, comment: "x".repeat(2001) };
    state.business = { ...state.business, decisionForm: cancelForm };
    render(renderBusiness(state, project), root);
    expect(
      root.querySelector<HTMLTextAreaElement>(".business-decision__form textarea")!.maxLength,
    ).toBe(2000);
    expect(
      root.querySelector<HTMLButtonElement>('.business-decision__form button[type="submit"]')!
        .disabled,
    ).toBe(true);

    const keyboardForm = {
      ...formState,
      decision: "send_back" as const,
      comment: "Please revise this item.",
    };
    state.business = { ...state.business, decisionForm: keyboardForm };
    render(renderBusiness(state, project), root);
    const form = root.querySelector<HTMLFormElement>(".business-decision__form")!;
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(state.submitBusinessDecision).toHaveBeenCalledOnce();

    state.business = {
      ...state.business,
      item: { ...item, status: "done" },
      decisionForm: cancelForm,
    };
    render(renderBusiness(state, project), root);
    expect(
      root.querySelector<HTMLButtonElement>('.business-decision__form button[type="submit"]')!
        .disabled,
    ).toBe(true);

    state.business = { ...state.business, decisionForm: formState, decisionPending: true, item };
    render(renderBusiness(state, project), root);
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".business-decision__actions button")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(
      [
        ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          ".business-decision__form input, .business-decision__form textarea",
        ),
      ].every((input) => input.disabled),
    ).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(".business-refresh")!.disabled).toBe(true);

    state.business = {
      ...state.business,
      decisionForm: null,
      decisionPending: false,
      loading: true,
    };
    render(renderBusiness(state, project), root);
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".business-decision__actions button")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  });

  it("localizes decision controls and displays safe decision notices", () => {
    setLocale("ja");
    const { root, state } = mount({ locale: "ja" });
    expect(root.textContent).toContain("電子承認");
    expect(root.textContent).toContain("承認する");
    state.business = {
      ...state.business,
      decisionNotice: t("business.decision.refusal.separation_of_duties"),
    };
    render(renderBusiness(state, project), root);
    expect(root.textContent).toContain("職務分掌の要件により、この判断はできません。");
  });

  it("does not present separation of duties as disabled when policy data is absent", () => {
    const { root, state } = mount();
    state.business = { ...state.business, config: null };
    render(renderBusiness(state, project), root);
    const controls = root.querySelector(".business-decision__controls")!.textContent;
    expect(controls).toContain("Approvals");
    expect(controls).not.toContain("Separation of duties");
    expect(controls).not.toContain("Disabled");
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

describe("Business draft content", () => {
  it("loads explicitly and escapes draft text", () => {
    const { root, state } = mount();
    const button = Array.from(root.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Load pinned draft"),
    )!;
    button.click();
    expect(state.loadBusinessDraft).toHaveBeenCalledOnce();
    state.business.draftPreview = {
      itemId: item.id,
      revision: item.revision,
      status: "ready",
      content: "<img src=x onerror=alert(1)>",
    };
    render(renderBusiness(state, project), root);
    expect(root.querySelector(".business-draft-content")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("Content matches the pinned version");
    expect(root.textContent).not.toContain("Draft content is not loaded");
    state.business.item = { ...item, revision: item.revision + 1 };
    render(renderBusiness(state, project), root);
    expect(root.querySelector(".business-draft-content")).toBeNull();
  });
  it("localizes preview failure and empty content", () => {
    setLocale("ja");
    const { root, state } = mount({ locale: "ja" });
    state.business.draftPreview = {
      itemId: item.id,
      revision: item.revision,
      status: "error",
      content: null,
    };
    render(renderBusiness(state, project), root);
    expect(root.textContent).toContain("固定ドラフトを検証または読み込みできませんでした");
    state.business.draftPreview = { ...state.business.draftPreview, status: "ready", content: "" };
    render(renderBusiness(state, project), root);
    expect(root.querySelector("pre")?.textContent).toBe("このドラフトは空です。");
  });
});

describe("Business evidence verification view", () => {
  it("requests verification only after an explicit click", () => {
    const { root, state } = mount();
    expect(state.verifyBusinessEvidence).not.toHaveBeenCalled();
    const button = Array.from(root.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Verify evidence"),
    )!;
    button.click();
    expect(state.verifyBusinessEvidence).toHaveBeenCalledTimes(1);
  });
  it.each(["verified", "failed", "unavailable", "loading"] as const)(
    "renders %s with honest scope",
    (status) => {
      const { root, state } = mount();
      state.business.evidence = {
        itemId: item.id,
        revision: item.revision,
        status,
        checkedAt: status === "loading" ? null : "2026-10-24T08:00:00Z",
        bundles: 1,
      };
      render(renderBusiness(state, project), root);
      expect(root.textContent).toContain(t(`business.evidence.${status}`));
      expect(root.textContent).toContain("does not certify the current item contents");
      expect(root.textContent).not.toContain("signatures have not been verified");
      if (status !== "loading") {
        expect(root.querySelector("time")?.dateTime).toBe("2026-10-24T08:00:00Z");
      }
      if (status === "loading") {
        expect(
          Array.from(root.querySelectorAll("button")).find((node) =>
            node.textContent?.includes("Verifying evidence"),
          )?.disabled,
        ).toBe(true);
      }
    },
  );
  it("does not show a verification from a different revision", () => {
    const { root, state } = mount();
    state.business.evidence = {
      itemId: item.id,
      revision: item.revision - 1,
      status: "verified",
      checkedAt: "2026-10-24T08:00:00Z",
      bundles: 1,
    };
    render(renderBusiness(state, project), root);
    expect(root.textContent).not.toContain(t("business.evidence.verified"));
    expect(root.textContent).toContain("signatures have not been verified");
  });
});
