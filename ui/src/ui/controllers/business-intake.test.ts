import { describe, expect, it, vi } from "vitest";
import type {
  WorkitemsConfigResult,
  WorkitemsCreateResult,
  WorkitemsGetResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import {
  beginBusinessDecision,
  emptyBusiness,
  loadBusiness,
  resetBusiness,
  type BusinessHost,
} from "./business";
import {
  acknowledgeExpenseOutcome,
  beginBusinessExpense,
  canBeginExpense,
  createBusinessExpense,
  editBusinessExpense,
  expenseFormValid,
} from "./business-intake";
import { DEFAULT_PROJECTS_STATE } from "./projects";

const config: WorkitemsConfigResult = {
  departments: [],
  queues: [
    {
      id: "general",
      name: { en: "General" },
      types: ["request"],
      slaHours: null,
      defaultAgent: null,
    },
    {
      id: "expense-q",
      name: { en: "Expenses" },
      types: ["expense"],
      slaHours: null,
      defaultAgent: null,
    },
    {
      id: "expense-q2",
      name: { en: "Other Expenses" },
      types: ["expense"],
      slaHours: null,
      defaultAgent: null,
    },
  ],
  rules: [],
  timezone: "Asia/Tokyo",
  separationOfDuties: true,
  source: { kind: "template", path: null },
  digest: "d",
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

function validForm() {
  return {
    queue: "expense-q",
    title: "Taxi to client",
    employeeId: "e-1",
    amount: "1250.50",
    expenseDate: "2026-10-20",
    category: "Travel",
    purpose: "Client meeting",
    documents: "receipts/taxi.pdf\nreceipts/train.pdf",
  };
}

function host() {
  const request = vi.fn(async (method: string) => {
    if (method === "workitems.config") {
      return config;
    }
    if (method === "workitems.create") {
      return {
        item: { id: "created", projectId: "p1", queue: "expense-q", type: "expense" },
      } as WorkitemsCreateResult;
    }
    if (method === "workitems.get") {
      return { item: { id: "created", projectId: "p1" } } as WorkitemsGetResult;
    }
    return { items: [], total: 0, counts: {}, nextCursor: null };
  });
  const h: BusinessHost = {
    business: { ...emptyBusiness(), projectId: "p1", config },
    connected: true,
    tab: "projects",
    client: { request } as unknown as GatewayBrowserClient,
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
  };
  return { h, request };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Business expense intake", () => {
  it("opens on the first configured expense queue and retains an existing form", () => {
    const { h } = host();
    expect(canBeginExpense(h)).toBe(true);
    beginBusinessExpense(h);
    expect(h.business.expenseForm?.queue).toBe("expense-q");
    const form = h.business.expenseForm;
    beginBusinessExpense(h);
    expect(h.business.expenseForm).toBe(form);
  });

  it("requires an expense-capable queue and a healthy settled queue", () => {
    const { h } = host();
    h.business.config = { ...config, queues: [config.queues[0]!] };
    expect(canBeginExpense(h)).toBe(false);
    h.business.config = config;
    h.business.loading = true;
    expect(canBeginExpense(h)).toBe(false);
  });

  it("rejects invalid dates, nonpositive amounts and unsafe or excessive references", () => {
    expect(expenseFormValid(validForm())).toBe(true);
    expect(expenseFormValid({ ...validForm(), expenseDate: "2026-02-30" })).toBe(false);
    expect(expenseFormValid({ ...validForm(), expenseDate: "2026-99-99" })).toBe(false);
    expect(expenseFormValid({ ...validForm(), amount: "Infinity" })).toBe(false);
    expect(expenseFormValid({ ...validForm(), amount: "0" })).toBe(false);
    expect(expenseFormValid({ ...validForm(), documents: "../secret.pdf" })).toBe(false);
    expect(expenseFormValid({ ...validForm(), documents: "C:/secret.pdf" })).toBe(false);
    expect(expenseFormValid({ ...validForm(), documents: "folder\\secret.pdf" })).toBe(false);
  });

  it("sends numeric source values and project-relative file references, then selects the result", async () => {
    const { h, request } = host();
    beginBusinessExpense(h);
    expect(h.business.queue).toBe("");
    editBusinessExpense(h, validForm());
    await createBusinessExpense(h);
    expect(request).toHaveBeenCalledWith("workitems.create", {
      projectId: "p1",
      queue: "expense-q",
      type: "expense",
      title: "Taxi to client",
      source: {
        fields: {
          employeeId: "e-1",
          amount: 1250.5,
          expenseDate: "2026-10-20",
          category: "Travel",
          purpose: "Client meeting",
        },
        documents: [
          { kind: "file", ref: "receipts/taxi.pdf", name: "taxi.pdf" },
          { kind: "file", ref: "receipts/train.pdf", name: "train.pdf" },
        ],
      },
    });
    expect(h.business.expenseForm).toBeNull();
    expect(h.business.selectedId).toBe("created");
  });

  it("keeps a duplicate create blocked after reset while the first write is unresolved", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsCreateResult>();
    request.mockImplementation(async (method: string) => {
      if (method === "workitems.create") {
        return wait.promise;
      }
      return method === "workitems.config"
        ? config
        : { items: [], total: 0, counts: {}, nextCursor: null };
    });
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    const first = createBusinessExpense(h);
    expect(request.mock.calls.filter(([method]) => method === "workitems.create")).toHaveLength(1);
    resetBusiness(h);
    beginBusinessExpense(h);
    expect(h.business.expenseForm).toBeNull();
    wait.reject(new Error("connection lost"));
    await first;
    expect(h.business.expenseUncertain).toBe(true);
    expect(h.business.expensePending).toBe(false);
    expect(canBeginExpense(h)).toBe(false);
    acknowledgeExpenseOutcome(h);
    expect(h.business.expenseUncertain).toBe(false);
  });

  it("does not write again after an uncertain outcome until explicit reconciliation", async () => {
    const { h, request } = host();
    request.mockRejectedValueOnce(new Error("unknown outcome"));
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    await createBusinessExpense(h);
    expect(h.business.expenseUncertain).toBe(true);
    await createBusinessExpense(h);
    expect(request.mock.calls.filter(([method]) => method === "workitems.create")).toHaveLength(1);
    resetBusiness(h);
    expect(h.business.expenseUncertain).toBe(true);
    h.business.projectId = null;
    acknowledgeExpenseOutcome(h);
    expect(h.business.expenseUncertain).toBe(false);
    resetBusiness(h);
    expect(h.business.expenseUncertain).toBe(false);
  });

  it("restores uncertainty when loadBusiness returns to its original project", async () => {
    const { h, request } = host();
    request.mockRejectedValueOnce(new Error("unknown outcome"));
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    await createBusinessExpense(h);
    expect(h.business.expenseUncertain).toBe(true);

    h.projects = { ...h.projects, selectedId: "p2" };
    resetBusiness(h);
    await loadBusiness(h);
    expect(h.business.projectId).toBe("p2");
    expect(h.business.expenseUncertain).toBe(false);

    h.projects = { ...h.projects, selectedId: "p1" };
    await loadBusiness(h);
    expect(h.business.projectId).toBe("p1");
    expect(h.business.expenseUncertain).toBe(true);
    acknowledgeExpenseOutcome(h);
    expect(h.business.expenseUncertain).toBe(false);
  });

  it("consumes a successful form after same-project selection changes without redirecting", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsCreateResult>();
    request.mockImplementation(async (method: string) => {
      if (method === "workitems.create") {
        return wait.promise;
      }
      if (method === "workitems.config") {
        return config;
      }
      return { items: [], total: 0, counts: {}, nextCursor: null };
    });
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    const pending = createBusinessExpense(h);
    h.business.selectedId = "someone-else";
    h.business.queue = "expense-q2";
    wait.resolve({
      item: { id: "created", projectId: "p1", queue: "expense-q", type: "expense" },
    } as WorkitemsCreateResult);
    await pending;
    expect(h.business.expenseForm).toBeNull();
    expect(h.business.expenseNotice).toBeTruthy();
    expect(h.business.selectedId).toBe("someone-else");
    expect(h.business.queue).toBe("expense-q2");
    expect(request.mock.calls.filter(([method]) => method === "workitems.create")).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method === "workitems.get")).toBe(false);
    expect(request.mock.calls).toContainEqual([
      "workitems.list",
      expect.objectContaining({ queue: "expense-q2" }),
    ]);
  });

  it("does not load stale detail after the same-project form was reset while pending", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsCreateResult>();
    request.mockImplementation(async (method: string) => {
      if (method === "workitems.create") {
        return wait.promise;
      }
      return method === "workitems.config"
        ? config
        : { items: [], total: 0, counts: {}, nextCursor: null };
    });
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    const pending = createBusinessExpense(h);
    resetBusiness(h);
    wait.resolve({
      item: { id: "created", projectId: "p1", queue: "expense-q", type: "expense" },
    } as WorkitemsCreateResult);
    await pending;
    expect(h.business.expenseForm).toBeNull();
    expect(h.business.selectedId).toBeNull();
    expect(h.business.item).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "workitems.get")).toBe(false);
  });

  it("does not leak a delayed outcome into another project", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsCreateResult>();
    request.mockImplementation(async (method: string) => {
      if (method === "workitems.create") {
        return wait.promise;
      }
      return method === "workitems.config"
        ? config
        : { items: [], total: 0, counts: {}, nextCursor: null };
    });
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    const pending = createBusinessExpense(h);
    h.projects = { ...h.projects, selectedId: "p2" };
    resetBusiness(h);
    wait.resolve({
      item: { id: "created", projectId: "p1", queue: "expense-q", type: "expense" },
    } as WorkitemsCreateResult);
    await pending;
    expect(h.business.expenseForm).toBeNull();
    expect(h.business.expensePending).toBe(false);
    expect(h.business.selectedId).toBeNull();
    expect(h.business.projectId).toBeNull();
  });

  it("does not create while detail is loading even if a form was already open", async () => {
    const { h, request } = host();
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    h.business.detailLoading = true;
    await createBusinessExpense(h);
    expect(request.mock.calls.some(([method]) => method === "workitems.create")).toBe(false);
  });

  it("treats a returned item outside the requested queue as uncertain", async () => {
    const { h, request } = host();
    request.mockResolvedValueOnce({
      item: { id: "wrong", projectId: "p1", queue: "other", type: "expense" },
    } as WorkitemsCreateResult);
    beginBusinessExpense(h);
    editBusinessExpense(h, validForm());
    await createBusinessExpense(h);
    expect(h.business.expenseUncertain).toBe(true);
    expect(h.business.selectedId).toBeNull();
  });
});

function savedExpense(h: BusinessHost) {
  h.business.selectedId = "saved";
  h.business.item = {
    id: "saved",
    projectId: "p1",
    queue: "expense-q",
    type: "expense",
    status: "new",
    revision: 7,
    assignee: null,
    priority: "normal",
    dueAt: null,
    slaHours: null,
    draft: null,
    checks: [],
    requiredApprovals: 1,
    approvals: [],
    override: null,
    runIds: [],
    lastError: null,
    createdAt: "2026-10-24T00:00:00Z",
    createdBy: "operator",
    requestedBy: "operator",
    route: null,
    updatedAt: "2026-10-24T00:00:00Z",
    history: [],
    title: "Taxi",
    source: {
      fields: {
        employeeId: "e-1",
        amount: 50,
        expenseDate: "2026-10-20",
        category: "Travel",
        purpose: "Meeting",
        customField: true,
      },
      documents: [{ kind: "artifact", ref: "receipt", name: "Receipt", sha256: "retained" }],
    },
  };
}

describe("saved expense edits and submission", () => {
  it("pins revision and identity, preserves extra fields and leaves receipt metadata untouched", async () => {
    const { h, request } = host();
    savedExpense(h);
    beginBusinessExpense(h, "edit");
    editBusinessExpense(h, {
      amount: "125",
      queue: "expense-q2",
      documents: "replacement.pdf",
      target: { id: "other", revision: 99, action: "submit" },
    });
    expect(h.business.expenseForm?.target).toEqual({ id: "saved", revision: 7, action: "edit" });
    request.mockResolvedValueOnce({ item: { ...h.business.item!, revision: 8 } });
    await createBusinessExpense(h);
    expect(request).toHaveBeenCalledWith("workitems.update", {
      projectId: "p1",
      id: "saved",
      expectedRevision: 7,
      patch: {
        title: "Taxi",
        source: {
          fields: {
            ...h.business.item?.source?.fields,
            employeeId: "e-1",
            amount: 125,
            expenseDate: "2026-10-20",
            category: "Travel",
            purpose: "Meeting",
            customField: true,
          },
        },
      },
    });
  });

  it("requires an explicit submit and sends only the revision-pinned status patch", async () => {
    const { h, request } = host();
    savedExpense(h);
    beginBusinessExpense(h, "submit");
    editBusinessExpense(h, { amount: "999" });
    expect(h.business.expenseForm?.amount).toBe("50");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({
      item: { ...h.business.item!, revision: 8, status: "awaiting_review" },
    });
    await createBusinessExpense(h);
    expect(request).toHaveBeenCalledWith("workitems.update", {
      projectId: "p1",
      id: "saved",
      expectedRevision: 7,
      patch: { status: "awaiting_review" },
    });
  });

  it.each(["revision", "selection", "status"])(
    "refuses a stale %s without a write",
    async (change) => {
      const { h, request } = host();
      savedExpense(h);
      beginBusinessExpense(h, "edit");
      if (change === "revision") {
        h.business.item!.revision++;
      }
      if (change === "selection") {
        h.business.selectedId = "other";
      }
      if (change === "status") {
        h.business.item!.status = "awaiting_review";
      }
      await createBusinessExpense(h);
      expect(request).not.toHaveBeenCalled();
      expect(h.business.expenseForm).toBeNull();
      expect(h.business.expenseNotice).toContain("changed");
    },
  );

  it.each(["drafting", "awaiting_review", "approved", "done", "cancelled"] as const)(
    "cannot start an edit or submit for %s",
    (status) => {
      const { h } = host();
      savedExpense(h);
      h.business.item!.status = status;
      beginBusinessExpense(h, "edit");
      expect(h.business.expenseForm).toBeNull();
      beginBusinessExpense(h, "submit");
      expect(h.business.expenseForm).toBeNull();
    },
  );

  it("blocks duplicate and competing decisions through reset and preserves uncertain update outcome", async () => {
    const { h, request } = host();
    savedExpense(h);
    beginBusinessExpense(h, "submit");
    beginBusinessDecision(h, "cancel");
    expect(h.business.decisionForm).toBeNull();
    const wait = deferred<WorkitemsCreateResult>();
    request.mockImplementationOnce(() => wait.promise);
    const first = createBusinessExpense(h);
    await createBusinessExpense(h);
    resetBusiness(h);
    expect(h.business.expensePending).toBe(true);
    beginBusinessExpense(h);
    expect(h.business.expenseForm).toBeNull();
    wait.reject(new Error("lost connection"));
    await first;
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.business.expenseUncertain).toBe(true);
    resetBusiness(h);
    expect(h.business.expenseNotice).toContain("update outcome");
  });
});
