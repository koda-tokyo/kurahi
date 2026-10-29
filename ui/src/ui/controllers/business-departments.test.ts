import { describe, expect, it, vi } from "vitest";
import type {
  WorkitemsConfigResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import {
  emptyBusiness,
  filterBusiness,
  loadBusiness,
  loadBusinessItem,
  resetBusiness,
  selectBusinessDepartment,
  selectBusinessQueue,
  setBusinessOrganizationMode,
  type BusinessHost,
  type BusinessState,
} from "./business";
import { DEFAULT_PROJECTS_STATE } from "./projects";

const queues = [
  {
    id: "accounts",
    department: "finance" as const,
    name: { en: "Accounts" },
    types: ["invoice" as const],
    slaHours: null,
    defaultAgent: null,
  },
  {
    id: "people",
    department: "hr" as const,
    name: { en: "People" },
    types: ["leave" as const],
    slaHours: null,
    defaultAgent: null,
  },
];
const config: WorkitemsConfigResult = {
  departments: ["finance", "hr"],
  queues,
  rules: [],
  timezone: "Asia/Tokyo",
  separationOfDuties: true,
  source: { kind: "template", path: null },
  digest: "abc",
  error: null,
  routes: [],
  access: { fallback: "none", configured: false, roles: [], members: null },
  viewer: {
    principal: "requester",
    privileged: false,
    roles: ["requester"],
    departments: [],
    listed: false,
  },
};
const list: WorkitemsListResult = { items: [], total: 0, counts: {}, nextCursor: null };
function fixture() {
  const request = vi
    .fn()
    .mockImplementation(async (method: string) => (method === "workitems.config" ? config : list));
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
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function oldDetail(): Partial<BusinessState> {
  return {
    selectedId: "old",
    item: { id: "old", projectId: "p1", revision: 1 } as BusinessState["item"],
    draftPreview: {
      itemId: "old",
      revision: 1,
      status: "ready",
      content: "Previous department draft",
    },
    evidence: {
      itemId: "old",
      revision: 1,
      status: "verified",
      checkedAt: "2026-10-25",
      bundles: 1,
    },
  };
}

describe("department navigation and scoped reads", () => {
  it("selects all queues in a department and keeps the server's access context", async () => {
    const { h, request } = fixture();
    await selectBusinessDepartment(h, "finance");
    expect(h.business.department).toBe("finance");
    expect(h.business.queue).toBe("");
    expect(request.mock.calls).toEqual([
      ["workitems.notifications.list", { projectId: "p1" }],
      ["workitems.config", { projectId: "p1" }],
      ["workitems.list", { projectId: "p1", department: "finance", limit: 50 }],
    ]);
    expect(h.business.config?.viewer).toEqual(config.viewer);
  });

  it("never requests an unfiltered list for an unconfigured department", async () => {
    const { h, request } = fixture();
    await selectBusinessDepartment(h, "secretariat");
    expect(request.mock.calls).toEqual([
      ["workitems.notifications.list", { projectId: "p1" }],
      ["workitems.config", { projectId: "p1" }],
      ["workitems.list", { projectId: "p1", department: "secretariat", limit: 50 }],
    ]);
    expect(h.business.department).toBe("secretariat");
    expect(h.business.queue).toBe("");
    expect(h.business.list).toEqual(list);
  });

  it("clears prior detail, previews, evidence and filters immediately on department change", async () => {
    const { h, request } = fixture();
    h.business = { ...h.business, ...oldDetail(), search: "private", status: "approved" };
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method) =>
      method === "workitems.config" ? config : wait.promise,
    );
    const pending = selectBusinessDepartment(h, "hr");
    expect(h.business).toMatchObject({
      department: "hr",
      selectedId: null,
      item: null,
      draftPreview: null,
      evidence: null,
      search: "",
      status: "",
      list: null,
    });
    wait.resolve(list);
    await pending;
  });

  it("ignores an old department list arriving after a faster department switch", async () => {
    const { h, request } = fixture();
    const old = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method, params) =>
      method === "workitems.config"
        ? config
        : params.department === "finance"
          ? old.promise
          : { ...list, total: 2 },
    );
    const pending = selectBusinessDepartment(h, "finance");
    await selectBusinessDepartment(h, "hr");
    old.resolve({ ...list, total: 90 });
    await pending;
    expect(h.business).toMatchObject({ department: "hr", queue: "", loading: false });
    expect(h.business.list?.total).toBe(2);
  });

  it("clears removed queue data and rejects its delayed detail response on configuration refresh", async () => {
    const { h, request } = fixture();
    h.business = {
      ...h.business,
      ...oldDetail(),
      department: "finance",
      queue: "accounts",
      list: { ...list, total: 8 },
    };
    const detail = deferred<{ item: BusinessState["item"] }>();
    const withoutFinance = { ...config, queues: [queues[1]] };
    request.mockImplementation(async (method) =>
      method === "workitems.config"
        ? withoutFinance
        : method === "workitems.get"
          ? detail.promise
          : list,
    );
    const pending = loadBusiness(h);
    await vi.waitFor(() => expect(h.business.queue).toBe(""));
    detail.resolve({ item: oldDetail().item! });
    await pending;
    expect(h.business).toMatchObject({
      department: "finance",
      queue: "",
      list,
      selectedId: null,
      item: null,
      draftPreview: null,
      evidence: null,
      detailLoading: false,
    });
    const listCalls = request.mock.calls.filter(([method]) => method === "workitems.list");
    expect(listCalls.map(([, params]) => params)).toEqual([
      { projectId: "p1", department: "finance", queue: "accounts", limit: 50 },
      { projectId: "p1", department: "finance", limit: 50 },
    ]);
  });

  it("sends search and status to the server and retains them on cursor pagination", async () => {
    const { h, request } = fixture();
    await selectBusinessDepartment(h, "finance");
    request.mockClear();
    request.mockImplementation(async (method, params) =>
      method === "workitems.config"
        ? config
        : { ...list, nextCursor: params.cursor ? null : "page2" },
    );
    await filterBusiness(h, "  invoice 42  ", "awaiting_review");
    await loadBusiness(h, true);
    expect(request.mock.calls.filter(([method]) => method === "workitems.list")).toEqual([
      [
        "workitems.list",
        {
          projectId: "p1",
          department: "finance",
          limit: 50,
          q: "invoice 42",
          status: "awaiting_review",
        },
      ],
      [
        "workitems.list",
        {
          projectId: "p1",
          department: "finance",
          limit: 50,
          q: "invoice 42",
          status: "awaiting_review",
          cursor: "page2",
        },
      ],
    ]);
  });

  it("keeps multiple queues and exact server totals across department pages", async () => {
    const { h, request } = fixture();
    const multiConfig = { ...config, queues: [...queues, { ...queues[0], id: "invoices" }] };
    const first = { id: "expense-1", queue: "accounts" } as WorkitemsListResult["items"][number];
    const second = { id: "invoice-1", queue: "invoices" } as WorkitemsListResult["items"][number];
    request.mockImplementation(async (method, params) =>
      method === "workitems.config"
        ? multiConfig
        : {
            items: params.cursor ? [first, second] : [first],
            total: 117,
            counts: { awaiting_review: 91 },
            nextCursor: params.cursor ? null : "page2",
          },
    );
    await selectBusinessDepartment(h, "finance");
    await loadBusiness(h, true);
    expect(h.business.list).toEqual({
      items: [first, second],
      total: 117,
      counts: { awaiting_review: 91 },
      nextCursor: null,
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === "workitems.list")
        .map(([, params]) => params),
    ).toEqual([
      { projectId: "p1", department: "finance", limit: 50 },
      { projectId: "p1", department: "finance", limit: 50, cursor: "page2" },
    ]);
  });

  it("intersects an explicit queue with the department and can return to all its queues", async () => {
    const { h, request } = fixture();
    await selectBusinessDepartment(h, "finance");
    request.mockClear();
    await selectBusinessQueue(h, "accounts");
    expect(h.business.queue).toBe("accounts");
    await selectBusinessQueue(h, "");
    expect(h.business.queue).toBe("");
    expect(
      request.mock.calls
        .filter(([method]) => method === "workitems.list")
        .map(([, params]) => params),
    ).toEqual([
      { projectId: "p1", department: "finance", queue: "accounts", limit: 50 },
      { projectId: "p1", department: "finance", limit: 50 },
    ]);
  });

  it("treats absent metadata as unmapped even for a legacy template queue", async () => {
    const { h, request } = fixture();
    const { department: _department, ...unmapped } = queues[0];
    const legacyConfig = { ...config, queues: [{ ...unmapped, id: "ga-facilities" }] };
    h.business.config = legacyConfig;
    request.mockImplementation(async (method) =>
      method === "workitems.config" ? legacyConfig : list,
    );
    await selectBusinessDepartment(h, "unmapped");
    await selectBusinessQueue(h, "ga-facilities");
    expect(h.business.queue).toBe("ga-facilities");
    expect(request).toHaveBeenCalledWith("workitems.list", {
      projectId: "p1",
      department: "unmapped",
      queue: "ga-facilities",
      limit: 50,
    });
    await selectBusinessDepartment(h, "admin");
    request.mockClear();
    await selectBusinessQueue(h, "ga-facilities");
    expect(request).not.toHaveBeenCalled();
  });

  it("invalidates a pending detail when its queue leaves an aggregate department", async () => {
    const { h, request } = fixture();
    const row = { id: "old", queue: "accounts" } as WorkitemsListResult["items"][number];
    h.business = { ...h.business, department: "finance", list: { ...list, items: [row] } };
    const detail = deferred<{ item: BusinessState["item"] }>();
    let currentConfig = config;
    request.mockImplementation(async (method) =>
      method === "workitems.config"
        ? currentConfig
        : method === "workitems.get"
          ? detail.promise
          : list,
    );
    const pendingDetail = loadBusinessItem(h, "old");
    expect(h.business.item).toBeNull();
    currentConfig = { ...config, queues: [{ ...queues[0], department: "hr" }, queues[1]] };
    await loadBusiness(h, false, true, false);
    detail.resolve({ item: { ...oldDetail().item!, queue: "accounts" } });
    await pendingDetail;
    expect(h.business).toMatchObject({ selectedId: null, item: null, detailLoading: false });
  });

  it("restarts aggregate pagination when a queue is reassigned", async () => {
    const { h, request } = fixture();
    const removed = { id: "expense-1", queue: "accounts" } as WorkitemsListResult["items"][number];
    const retained = { id: "invoice-1", queue: "invoices" } as WorkitemsListResult["items"][number];
    h.business = {
      ...h.business,
      department: "finance",
      config: { ...config, queues: [...queues, { ...queues[0], id: "invoices" }] },
      list: { ...list, items: [removed], total: 99, nextCursor: "old-page2" },
    };
    const changedConfig = { ...config, queues: [queues[1], { ...queues[0], id: "invoices" }] };
    request.mockImplementation(async (method, params) =>
      method === "workitems.config"
        ? changedConfig
        : { ...list, items: params.cursor ? [] : [retained], total: 1 },
    );
    await loadBusiness(h, true);
    expect(h.business.list).toEqual({ ...list, items: [retained], total: 1 });
    expect(
      request.mock.calls
        .filter(([method]) => method === "workitems.list")
        .map(([, params]) => params),
    ).toEqual([
      { projectId: "p1", department: "finance", limit: 50, cursor: "old-page2" },
      { projectId: "p1", department: "finance", limit: 50 },
    ]);
  });

  it.each<Partial<BusinessState>>([
    { decisionPending: true },
    { expensePending: true },
    {
      decisionForm: {
        id: "old",
        revision: 1,
        decision: "approve",
        comment: "",
        override: false,
        overrideReason: "",
      },
    },
    {
      expenseForm: {
        queue: "accounts",
        title: "Travel",
        employeeId: "e1",
        amount: "100",
        expenseDate: "2026-10-25",
        category: "travel",
        purpose: "Meeting",
        documents: "",
      },
    },
  ])("keeps department and request context when a write or form is active (%j)", async (busy) => {
    const { h, request } = fixture();
    h.business = { ...h.business, ...busy };
    const before = h.business;
    await selectBusinessDepartment(h, "hr");
    expect(h.business).toBe(before);
    expect(request).not.toHaveBeenCalled();
  });

  it("reset removes department context and invalidates an outstanding response", async () => {
    const { h, request } = fixture();
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method) =>
      method === "workitems.config" ? config : wait.promise,
    );
    const pending = selectBusinessDepartment(h, "finance");
    setBusinessOrganizationMode(h, "sme");
    resetBusiness(h);
    wait.resolve({ ...list, total: 99 });
    await pending;
    expect(h.business).toEqual(emptyBusiness());
  });

  it("ignores unknown department IDs without changing state or making requests", async () => {
    const { h, request } = fixture();
    const before = h.business;
    await selectBusinessDepartment(h, "future-department");
    expect(h.business).toBe(before);
    expect(request).not.toHaveBeenCalled();
  });

  it("SME grouping changes only navigation and cannot select another department's queue", async () => {
    const { h, request } = fixture();
    await selectBusinessDepartment(h, "finance");
    request.mockClear();
    const before = h.business;
    setBusinessOrganizationMode(h, "sme");
    expect(h.business).toEqual({ ...before, organizationMode: "sme" });
    await selectBusinessQueue(h, "people");
    expect(h.business.queue).toBe("");
    expect(h.business.config?.access).toEqual(config.access);
    expect(h.business.config?.viewer).toEqual(config.viewer);
    expect(request).not.toHaveBeenCalled();
  });
});
