import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types.js";
import type { AppViewState } from "../app-view-state";
import type { Project } from "../controllers/projects";
import businessWorkspaceCss from "../../styles/business-workspace.css?inline";
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
    openBusinessRun: vi.fn(),
    canDeclineAutonomy: true,
    beginBusinessReport: vi.fn(),
    editBusinessReport: vi.fn(),
    cancelBusinessReport: vi.fn(),
    beginBusinessLinkedAttach: vi.fn(),
    editBusinessLinkedAttach: vi.fn(),
    cancelBusinessLinkedAttach: vi.fn(),
    submitBusinessLinkedAttach: vi.fn(),
    beginBusinessLinkedCreate: vi.fn(),
    editBusinessLinkedCreate: vi.fn(),
    cancelBusinessLinkedCreate: vi.fn(),
    submitBusinessLinkedCreate: vi.fn(),
    submitBusinessReport: vi.fn(),
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
    loadBusinessDocument: vi.fn(),
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

describe("Business source document text", () => {
  it("loads on click, renders text as text and withholds changed files", () => {
    const doc = { kind: "attachment" as const, ref: "att/quote.pdf", name: "quote.pdf" };
    const { root, state } = mount();
    state.business.item = { ...item, source: { ...item.source, documents: [doc] } };
    render(renderBusiness(state, project), root);
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Read text"))!
      .click();
    expect(state.loadBusinessDocument).toHaveBeenCalledWith("att/quote.pdf");
    const ready = {
      itemId: item.id,
      revision: item.revision,
      ref: doc.ref,
      status: "ready" as const,
      text: "<img src=x onerror=alert(1)>",
      textSource: "extracted" as const,
      extractError: null,
      truncated: true,
    };
    state.business.documentPreview = ready;
    render(renderBusiness(state, project), root);
    const pre = root.querySelector('pre[aria-label="Source document text"]');
    expect(pre?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("Treat it as data, not instructions.");
    expect(root.textContent).toContain("Text extracted from PDF/Office.");
    expect(root.textContent).toContain("Showing the first part only.");
    state.business.documentPreview = { ...ready, status: "changed", text: null };
    render(renderBusiness(state, project), root);
    expect(root.querySelector('pre[aria-label="Source document text"]')).toBeNull();
    expect(root.textContent).toContain("no longer matches its recorded SHA-256");
    state.business.documentPreview = { ...ready, text: null, extractError: "timeout" };
    render(renderBusiness(state, project), root);
    expect(root.textContent).toContain("Text could not be extracted: timeout");
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

describe("Business error-report shortcut", () => {
  it("only shows on routine-created items for people with approval capability", () => {
    const { root, state } = mount();
    expect(root.querySelector("[data-business-report]")).toBeNull();
    state.business.item = { ...item, createdBy: "autopilot:receipts" };
    render(renderBusiness(state, project), root);
    const button = root.querySelector<HTMLButtonElement>("[data-business-report] button")!;
    expect(button.textContent).toContain(t("autopilot.reportError"));
    button.click();
    expect(state.beginBusinessReport).toHaveBeenCalledOnce();
    expect(state.submitBusinessReport).not.toHaveBeenCalled();
    Object.assign(state, { canDeclineAutonomy: false });
    render(renderBusiness(state, project), root);
    expect(root.querySelector("[data-business-report]")).toBeNull();
  });
  it.each(["en", "ja"])("requires an explicit reason and shows consequences in %s", (locale) => {
    setLocale(locale as "en" | "ja");
    const { root, state } = mount({ locale });
    state.business.item = { ...item, createdBy: "autopilot:receipts" };
    state.business.reportForm = { id: item.id, revision: item.revision, reason: "" };
    render(renderBusiness(state, project), root);
    expect(root.textContent).toContain(t("autopilot.reportGuidance"));
    const textarea = root.querySelector<HTMLTextAreaElement>("[data-business-report] textarea")!;
    const submit = root.querySelector<HTMLButtonElement>("[data-business-report] [type=submit]")!;
    expect(textarea.required).toBe(true);
    expect(textarea.minLength).toBe(4);
    expect(textarea.maxLength).toBe(1000);
    expect(submit.disabled).toBe(true);
    textarea.value = "Incorrect amount";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.editBusinessReport).toHaveBeenCalledWith("Incorrect amount");
    state.business.reportForm.reason = "Incorrect amount";
    render(renderBusiness(state, project), root);
    submit.click();
    expect(state.submitBusinessReport).toHaveBeenCalledOnce();
    state.business.decisionPending = true;
    render(renderBusiness(state, project), root);
    expect(submit.disabled).toBe(true);
    expect(textarea.disabled).toBe(true);
    expect(root.textContent).toContain(t("autopilot.reporting"));
  });
});

it("disables reports when a background refresh fails with retained item data", () => {
  const { root, state } = mount();
  state.business.item = { ...item, createdBy: "autopilot:receipts" };
  state.business.error = "failed";
  render(renderBusiness(state, project), root);
  expect(root.querySelector<HTMLButtonElement>("[data-business-report] button")?.disabled).toBe(
    true,
  );
});

describe("Business run and retention evidence", () => {
  it.each(["en", "ja"])(
    "offers accessible originating-run navigation and retention detail in %s",
    (locale) => {
      setLocale(locale);
      const { root, state } = mount({ locale });
      state.business = {
        ...state.business,
        item: {
          ...item,
          createdBy: "autopilot:receipts",
          source: { ...item.source, fields: { autopilotRun: "r1" } },
        },
        evidence: {
          itemId: item.id,
          revision: item.revision,
          status: "verified",
          bundles: 2,
          retainedTombstones: 1,
          checkedAt: null,
        },
      };
      render(renderBusiness(state, project), root);
      const button = [...root.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === t("business.run.open"),
      );
      expect(button).toBeDefined();
      button!.click();
      expect(state.openBusinessRun).toHaveBeenCalledOnce();
      expect(root.textContent).toContain(t("business.evidence.retained", { count: 1 }));
    },
  );
  it("does not infer a run link from drafting run IDs or retention from missing evidence", () => {
    const { root } = mount();
    expect(root.textContent).not.toContain(t("business.run.open"));
    expect(root.textContent).not.toContain(t("business.evidence.retained", { count: 1 }));
  });
});

describe("Business per-event evidence view", () => {
  it.each(["en", "ja"])(
    "labels individual events and clears badges across revisions in %s",
    (locale) => {
      setLocale(locale);
      const { root, state } = mount({ locale });
      const reference = item.history[0].evidence!;
      for (const status of ["verified", "retained", "failed", "unavailable"] as const) {
        state.business.evidence = {
          itemId: item.id,
          revision: item.revision,
          status: status === "retained" ? "verified" : status,
          checkedAt: null,
          bundles: 1,
          historyChecks: [{ ...reference, status }],
        };
        render(renderBusiness(state, project), root);
        expect(root.querySelector("[data-business-history-evidence]")?.textContent).toBe(
          t(`business.evidence.history.${status}`),
        );
      }
      state.business.evidence!.revision -= 1;
      render(renderBusiness(state, project), root);
      expect(root.querySelector("[data-business-history-evidence]")?.textContent).toBe(
        t("business.evidence.history.unchecked"),
      );
    },
  );
  it("requires a matching root and verified aggregate before showing retention", () => {
    const { root, state } = mount();
    state.business.evidence = {
      itemId: item.id,
      revision: item.revision,
      status: "verified",
      checkedAt: null,
      bundles: 1,
      historyChecks: [{ ...item.history[0].evidence!, root: "wrong", status: "retained" }],
    };
    render(renderBusiness(state, project), root);
    expect(root.querySelector("[data-business-history-evidence]")?.textContent).toBe(
      t("business.evidence.history.unavailable"),
    );
    state.business.evidence.historyChecks![0].root = item.history[0].evidence!.root;
    state.business.evidence.status = "failed";
    render(renderBusiness(state, project), root);
    expect(root.querySelector("[data-business-history-evidence]")?.textContent).toBe(
      t("business.evidence.history.unavailable"),
    );
  });

  it("shows a linked case for the current revision only, localized and read-only", () => {
    const linkedCase = {
      parentId: item.id,
      plan: {
        steps: [
          {
            key: "accounts",
            department: "it",
            title: { en: "Accounts", ja: "アカウント" },
            dependsOn: [],
          },
          {
            key: "payroll",
            department: "hr",
            title: { en: "Payroll", ja: "給与" },
            dependsOn: ["accounts"],
          },
        ],
      },
      steps: [
        { key: "accounts", department: "it", state: "done" },
        { key: "payroll", department: "hr", state: "stuck" },
      ],
      ready: [],
      done: 1,
      total: 2,
      complete: false,
      blocked: true,
      children: { accounts: "<b>child-1</b>" },
      missing: [],
    };
    const linked = {
      itemId: item.id,
      revision: item.revision,
      status: "ready",
      linkedCase,
      refusal: null,
    };
    const base = { projectId: project.id, queue: "", config, list, item, selectedId: item.id };
    const { root } = mount({ business: { ...base, linked } });
    expect(root.querySelector("[data-business-linked-progress]")?.textContent).toBe(
      t("business.linked.progress", { done: 1, total: 2 }),
    );
    expect(root.textContent).toContain(t("business.linked.blocked"));
    const payroll = root.querySelector('[data-business-linked-step="payroll"]');
    expect(payroll?.textContent).toContain(t("business.linked.state.stuck"));
    expect(payroll?.textContent).toContain(t("business.linked.after", { steps: "accounts" }));
    expect(root.querySelector('[data-business-linked-step="accounts"] b')).toBeNull();
    expect(root.textContent).toContain("<b>child-1</b>");
    expect(root.textContent).not.toContain(t("business.linked.refusal.linked_case_corrupt"));

    document.body.replaceChildren();
    const stale = mount({
      business: { ...base, linked: { ...linked, revision: item.revision - 1 } },
    });
    expect(stale.root.textContent).not.toContain(t("business.linked"));

    document.body.replaceChildren();
    setLocale("ja");
    const refused = mount({
      locale: "ja",
      business: {
        ...base,
        linked: { ...linked, status: "refused", linkedCase: null, refusal: "linked_case_corrupt" },
      },
    });
    expect(refused.root.textContent).toContain("連携案件");
    expect(refused.root.textContent).toContain(t("business.linked.refusal.linked_case_corrupt"));
    setLocale("en");
  });

  it("offers attach only on a ready step without a work item", () => {
    const linkedCase = {
      parentId: item.id,
      plan: {
        steps: [
          { key: "accounts", department: "it", title: { en: "Accounts" }, dependsOn: [] },
          { key: "laptop", department: "it", title: { en: "Laptop" }, dependsOn: [] },
          { key: "payroll", department: "hr", title: { en: "Payroll" }, dependsOn: ["accounts"] },
        ],
      },
      steps: [
        { key: "accounts", department: "it", state: "ready" },
        { key: "laptop", department: "it", state: "open" },
        { key: "payroll", department: "hr", state: "waiting" },
      ],
      ready: ["accounts"],
      done: 0,
      total: 3,
      complete: false,
      blocked: false,
      children: { laptop: "c-laptop" },
      missing: [],
    };
    const linked = {
      itemId: item.id,
      revision: item.revision,
      status: "ready",
      linkedCase,
      refusal: null,
    };
    const base = { projectId: project.id, queue: "", config, list, item, selectedId: item.id };
    const { root, state } = mount({ business: { ...base, linked, linkedAttach: null } });
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-business-linked-attach]")];
    expect(buttons.map((b) => b.dataset.businessLinkedAttach)).toEqual(["accounts"]);
    buttons[0].click();
    expect(state.beginBusinessLinkedAttach).toHaveBeenCalledWith("accounts");

    document.body.replaceChildren();
    const form = {
      itemId: item.id,
      revision: item.revision,
      stepKey: "accounts",
      childId: "c1",
      pending: false,
      notice: t("business.linked.refusal.linked_child_wrong_department"),
    };
    const open = mount({ business: { ...base, linked, linkedAttach: form } });
    const el = open.root.querySelector('[data-business-linked-attach-form="accounts"]');
    expect(el?.textContent).toContain(t("business.linked.refusal.linked_child_wrong_department"));
    (
      open.root.querySelector('[data-business-linked-attach-form="accounts"]') as HTMLFormElement
    ).requestSubmit();
    expect(open.state.submitBusinessLinkedAttach).toHaveBeenCalledTimes(1);

    document.body.replaceChildren();
    const saved = mount({
      business: {
        ...base,
        linked: {
          ...linked,
          linkedCase: {
            ...linkedCase,
            children: { ...linkedCase.children, accounts: "c1" },
            steps: [{ ...linkedCase.steps[0], state: "open" }, ...linkedCase.steps.slice(1)],
          },
        },
        linkedAttach: { ...form, notice: t("business.linked.attach.saved") },
      },
    });
    expect(saved.root.querySelector("[data-business-linked-attach-form]")).toBeNull();
    expect(saved.root.querySelector("[data-business-linked-notice]")?.textContent).toBe(
      t("business.linked.attach.saved"),
    );
  });

  it("offers to start a linked case only on an open item without one", () => {
    const base = { projectId: project.id, queue: "", config, list, item, selectedId: item.id };
    const none = {
      itemId: item.id,
      revision: item.revision,
      status: "none",
      linkedCase: null,
      refusal: null,
    };
    const { root, state } = mount({ business: { ...base, linked: none, linkedCreate: null } });
    const start = root.querySelector<HTMLButtonElement>("[data-business-linked-create]");
    expect(root.textContent).toContain(t("business.linked.none"));
    start?.click();
    expect(state.beginBusinessLinkedCreate).toHaveBeenCalledTimes(1);

    document.body.replaceChildren();
    const closed = mount({
      business: { ...base, item: { ...item, status: "done" }, linked: none, linkedCreate: null },
    });
    expect(closed.root.querySelector("[data-business-linked-create]")).toBeNull();

    document.body.replaceChildren();
    const stale = mount({
      business: { ...base, linked: { ...none, revision: item.revision - 1 }, linkedCreate: null },
    });
    expect(stale.root.querySelector("[data-business-linked-create]")).toBeNull();
  });

  it("builds steps in order and submits only a complete plan", () => {
    const base = { projectId: project.id, queue: "", config, list, item, selectedId: item.id };
    const none = {
      itemId: item.id,
      revision: item.revision,
      status: "none",
      linkedCase: null,
      refusal: null,
    };
    const form = {
      itemId: item.id,
      revision: item.revision,
      steps: [
        { department: "it", title: "Accounts", after: [] },
        { department: "admin", title: "Desk", after: [] },
        { department: "", title: "Payroll", after: [0] },
      ],
      pending: false,
      notice: null,
    };
    const { root, state } = mount({ business: { ...base, linked: none, linkedCreate: form } });
    const rows = root.querySelectorAll("[data-business-linked-create-step]");
    expect(rows).toHaveLength(3);
    expect(root.querySelector("[data-business-linked-create-source]")).toBeNull();
    // A step can wait only for steps above it, any number of them.
    const boxes = (row: Element) => [
      ...row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(boxes(rows[0])).toEqual([]);
    expect(boxes(rows[1]).map((b) => [b.value, b.checked])).toEqual([["1", false]]);
    expect(boxes(rows[2]).map((b) => [b.value, b.checked])).toEqual([
      ["1", true],
      ["2", false],
    ]);
    const desk = boxes(rows[2])[1];
    desk.checked = true;
    desk.dispatchEvent(new Event("change"));
    expect(state.editBusinessLinkedCreate).toHaveBeenCalledWith(2, { after: [0, 1] });
    const accounts = boxes(rows[2])[0];
    accounts.checked = false;
    accounts.dispatchEvent(new Event("change"));
    expect(state.editBusinessLinkedCreate).toHaveBeenCalledWith(2, { after: [] });
    const submit = root.querySelector<HTMLButtonElement>(
      '[data-business-linked-create-form] button[type="submit"]',
    );
    expect(submit?.disabled).toBe(true);
    const select = rows[2].querySelector<HTMLSelectElement>("select")!;
    select.value = "hr";
    select.dispatchEvent(new Event("change"));
    expect(state.editBusinessLinkedCreate).toHaveBeenCalledWith(2, { department: "hr" });
    root.querySelector<HTMLButtonElement>("[data-business-linked-create-add]")?.click();
    expect(state.editBusinessLinkedCreate).toHaveBeenCalledWith(3, {});

    document.body.replaceChildren();
    const complete = {
      ...form,
      steps: [form.steps[0], form.steps[1], { ...form.steps[2], department: "hr" }],
    };
    const ready = mount({ business: { ...base, linked: none, linkedCreate: complete } });
    const button = ready.root.querySelector<HTMLButtonElement>(
      '[data-business-linked-create-form] button[type="submit"]',
    );
    expect(button?.disabled).toBe(false);
    (
      ready.root.querySelector("[data-business-linked-create-form]") as HTMLFormElement
    ).requestSubmit();
    expect(ready.state.submitBusinessLinkedCreate).toHaveBeenCalledTimes(1);

    document.body.replaceChildren();
    const prefilled = {
      ...complete,
      steps: [{ ...complete.steps[0], source: "it.account" }, complete.steps[1], complete.steps[2]],
    };
    const sourced = mount({ business: { ...base, linked: none, linkedCreate: prefilled } });
    const sources = [...sourced.root.querySelectorAll("[data-business-linked-create-step]")].map(
      (row) => row.querySelector("[data-business-linked-create-source]")?.textContent,
    );
    expect(sources).toEqual([
      "Worksheet task it.account is created as step-1.",
      undefined,
      undefined,
    ]);
    expect(sourced.root.querySelector("[data-business-linked-omitted]")).toBeNull();

    document.body.replaceChildren();
    const omitted = mount({
      business: {
        ...base,
        linked: none,
        linkedCreate: {
          ...form,
          omitted: [
            {
              file: "requests/a.md",
              reason: "problems",
              problems: ["no_manifest", "bad_row", "future_code"],
            },
            { file: "requests/b.md", reason: "order", problems: [] },
            { file: "requests/c.md", reason: "size", problems: [] },
            { file: "requests/d.md", reason: "problems", problems: ["untrusted_file"] },
          ],
        },
      },
    });
    expect(
      [...omitted.root.querySelectorAll("[data-business-linked-omitted-file]")].map((li) =>
        li.textContent?.trim(),
      ),
    ).toEqual([
      "requests/a.md is not offered: the gateway reported problems (the task table is missing; a table row cannot be read; future_code). Check the pack file and the reported problems.",
      "requests/b.md is not offered: a step waits for itself, for a missing task or in a loop.",
      "requests/c.md is not offered: it has more than 32 steps.",
      "requests/d.md is not offered: the gateway reported problems (the file is in a folder agents can write to, so it is not trusted). Check the pack file and the reported problems.",
    ]);
    expect(omitted.root.querySelector("[data-business-linked-plan]")).toBeNull();

    document.body.replaceChildren();
    setLocale("ja");
    const omittedJa = mount({
      locale: "ja",
      business: {
        ...base,
        linked: none,
        linkedCreate: {
          ...form,
          omitted: [
            { file: "requests/a.md", reason: "problems", problems: ["cycle", "bad_title"] },
          ],
        },
      },
    });
    expect(
      omittedJa.root.querySelector("[data-business-linked-omitted-file]")?.textContent,
    ).toContain("（ステップが循環して依存しています、使えるタイトルのないタスクがあります）");
    setLocale("en");
  });

  it.each(["en", "ja"])("keeps not-offered plans inside a 360px screen (%s)", (locale) => {
    const style = document.createElement("style");
    style.textContent = businessWorkspaceCss;
    document.head.append(style);
    setLocale(locale);
    try {
      const base = { projectId: project.id, queue: "", config, list, item, selectedId: item.id };
      const path = `requests/${"onboarding_worksheet_".repeat(6)}final.md`;
      const { root } = mount({
        locale,
        business: {
          ...base,
          linked: { itemId: item.id, revision: item.revision, status: "none", linkedCase: null },
          linkedCreate: {
            itemId: item.id,
            revision: item.revision,
            steps: [{ department: "it", title: "Accounts", after: [] }],
            pending: false,
            notice: null,
            omitted: [
              { file: path, reason: "problems", problems: ["untrusted_file", "no_manifest"] },
              { file: path.replace("final", "loop"), reason: "order", problems: [] },
            ],
          },
        },
      });
      const omitted = root.querySelector<HTMLElement>("[data-business-linked-omitted]")!;
      omitted.style.boxSizing = "border-box";
      omitted.style.width = "360px";
      expect(omitted.querySelectorAll("li")).toHaveLength(2);
      expect(omitted.textContent).toContain(path);
      expect(omitted.scrollWidth).toBeLessThanOrEqual(omitted.clientWidth);
    } finally {
      style.remove();
      setLocale("en");
    }
  });
});
