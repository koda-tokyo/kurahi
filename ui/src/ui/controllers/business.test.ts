import { describe, expect, it, vi } from "vitest";
import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import {
  beginBusinessReport,
  editBusinessReport,
  cancelBusinessReport,
  submitBusinessReport,
  businessEvent,
  beginBusinessDecision,
  editBusinessDecision,
  emptyBusiness,
  loadBusiness,
  loadBusinessItem,
  resetBusiness,
  selectBusinessQueue,
  submitBusinessDecision,
  type BusinessHost,
} from "./business";
import { beginSupplier, editSupplier, submitSupplier } from "./business-supplier";
import { DEFAULT_PROJECTS_STATE } from "./projects";

const config: WorkitemsConfigResult = {
  departments: [],
  queues: [],
  rules: [],
  timezone: "Asia/Tokyo",
  separationOfDuties: true,
  source: { kind: "template", path: null },
  digest: "abc",
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
const list: WorkitemsListResult = { items: [], total: 0, counts: {}, nextCursor: null };
function host() {
  const request = vi
    .fn()
    .mockImplementation(async (method: string) => (method === "workitems.config" ? config : list));
  const h: BusinessHost = {
    business: emptyBusiness(),
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
function item(id: string, projectId = "p1") {
  return {
    item: {
      id,
      projectId,
      title: id,
      revision: 1,
      status: "awaiting_review",
      approvals: [],
      requiredApprovals: 1,
    },
  } as unknown as WorkitemsGetResult;
}
async function reviewHost() {
  const { h, request } = host();
  await loadBusiness(h);
  h.business.item = item("a").item;
  h.business.selectedId = "a";
  return { h, request };
}
function decided(
  id = "a",
  projectId = "p1",
  status: "awaiting_review" | "approved" = "awaiting_review",
) {
  return { item: { ...item(id, projectId).item, status } };
}
describe("Business read-only queue", () => {
  it("loads real project config and paged list without writing", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    expect(request.mock.calls).toEqual([
      ["workitems.notifications.list", { projectId: "p1" }],
      ["workitems.config", { projectId: "p1" }],
      ["workitems.list", { projectId: "p1", limit: 50 }],
    ]);
    expect(h.business.config).toEqual(config);
    expect(h.business.list).toEqual(list);
    expect(h.business.loading).toBe(false);
  });
  it("filters by configured queue and resets the old selection", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    h.business.selectedId = "old";
    await selectBusinessQueue(h, "fin-expense");
    expect(request).toHaveBeenLastCalledWith("workitems.list", {
      projectId: "p1",
      queue: "fin-expense",
      limit: 50,
    });
    expect(h.business.selectedId).toBeNull();
  });
  it("ignores responses after a Project switch", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method) =>
      method === "workitems.config" ? config : wait.promise,
    );
    const pending = loadBusiness(h);
    h.projects = { ...h.projects, selectedId: "p2" };
    resetBusiness(h);
    wait.resolve(list);
    await pending;
    expect(h.business).toEqual(emptyBusiness());
  });
  it("latest queue request wins even when the older one finishes later", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method, params) =>
      method === "workitems.config" ? config : params.queue === "old" ? wait.promise : list,
    );
    await loadBusiness(h);
    const pending = selectBusinessQueue(h, "old");
    await selectBusinessQueue(h, "new");
    wait.resolve({ ...list, total: 99 });
    await pending;
    expect(h.business.queue).toBe("new");
    expect(h.business.list?.total).toBe(0);
  });
  it("latest item selection wins and does not show the prior source while loading", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    const wait = deferred<WorkitemsGetResult>();
    request.mockImplementation(async (_method, params) =>
      params.id === "a" ? wait.promise : item("b"),
    );
    const pending = loadBusinessItem(h, "a");
    await loadBusinessItem(h, "b");
    wait.resolve(item("a"));
    await pending;
    expect(h.business.item?.id).toBe("b");
    expect(h.business.selectedId).toBe("b");
  });
  it("discards delayed failures after identity change", async () => {
    const { h, request } = host();
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method) =>
      method === "workitems.config" ? config : wait.promise,
    );
    const pending = loadBusiness(h);
    h.client = {} as GatewayBrowserClient;
    resetBusiness(h);
    wait.reject(new Error("private failure"));
    await pending;
    expect(h.business).toEqual(emptyBusiness());
  });
  it("clears data on load failure and never displays raw error details", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    request.mockRejectedValue(new Error("secret/private/path"));
    await loadBusiness(h);
    expect(h.business.list).toBeNull();
    expect(h.business.config).toBeNull();
    expect(h.business.error).toBeTruthy();
    expect(h.business.error).not.toContain("secret");
  });
  it("rejects an item outside the selected project", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    request.mockResolvedValue(item("a", "other"));
    await loadBusinessItem(h, "a");
    expect(h.business.item).toBeNull();
    expect(h.business.detailError).toBeTruthy();
  });
  it("refetches selected detail on a scoped event; ignores event content", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    h.business.selectedId = "a";
    request.mockImplementation(async (method) =>
      method === "workitems.get" ? item("a") : method === "workitems.config" ? config : list,
    );
    request.mockClear();
    businessEvent(h, { projectId: "other" });
    expect(request).not.toHaveBeenCalled();
    businessEvent(h, { projectId: "p1", id: "a", title: "not trusted" });
    await vi.waitFor(() => expect(h.business.item?.id).toBe("a"));
    expect(request).toHaveBeenCalledWith("workitems.get", { projectId: "p1", id: "a" });
    expect(h.business.item?.title).toBe("a");
  });
  it("deduplicates a repeated row across cursor pages", async () => {
    const { h, request } = host();
    const row = {
      ...item("a").item,
      source: { documents: 0, fields: [] },
      overdue: false,
      currentStage: null,
    } as WorkitemsListResult["items"][number];
    request.mockImplementation(async (method) =>
      method === "workitems.config"
        ? config
        : { ...list, items: [row], nextCursor: "page2", total: 2 },
    );
    await loadBusiness(h);
    request.mockImplementation(async (method) =>
      method === "workitems.config"
        ? config
        : {
            ...list,
            items: [
              { ...row, revision: 2 },
              { ...row, id: "b" },
            ],
            total: 2,
          },
    );
    await loadBusiness(h, true);
    expect(request).toHaveBeenLastCalledWith("workitems.list", {
      projectId: "p1",
      cursor: "page2",
      limit: 50,
    });
    expect(h.business.list?.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(h.business.list?.items[0].revision).toBe(2);
  });
  it("list failure does not erase a newer selected detail", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method) =>
      method === "workitems.config"
        ? config
        : method === "workitems.get"
          ? item("a")
          : wait.promise,
    );
    const pending = loadBusiness(h);
    await loadBusinessItem(h, "a");
    wait.reject(new Error("failed"));
    await pending;
    expect(h.business.item?.id).toBe("a");
  });
  it("coalesces in-flight events without blanking the list or reloading unrelated details", async () => {
    const { h, request } = host();
    await loadBusiness(h);
    h.business.selectedId = "a";
    h.business.item = item("a").item;
    const wait = deferred<WorkitemsListResult>();
    request.mockImplementation(async (method) =>
      method === "workitems.config" ? config : wait.promise,
    );
    request.mockClear();
    businessEvent(h, { projectId: "p1", id: "other" });
    businessEvent(h, { projectId: "p1", id: "other" });
    businessEvent(h, { projectId: "p1", id: "other" });
    expect(h.business.list).toEqual(list);
    expect(h.business.item?.id).toBe("a");
    expect(request).toHaveBeenCalledTimes(3);
    wait.resolve(list);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6));
    expect(request.mock.calls.some(([method]) => method === "workitems.get")).toBe(false);
  });
  it("does not read when disconnected or outside the work queue", async () => {
    const { h, request } = host();
    h.connected = false;
    await loadBusiness(h);
    await loadBusinessItem(h, "a");
    h.connected = true;
    h.projects.view = "chat";
    await loadBusiness(h);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Business person decisions", () => {
  it("pins the revision at form start and trims comments and override reasons", async () => {
    const { h, request } = await reviewHost();
    h.business.item = { ...h.business.item!, revision: 7 };
    beginBusinessDecision(h, "approve");
    editBusinessDecision(h, {
      comment: "  Looks good  ",
      override: true,
      overrideReason: "  exception approved  ",
    });
    request.mockImplementation(async (method: string) =>
      method === "workitems.decide"
        ? decided()
        : method === "workitems.config"
          ? config
          : method === "workitems.get"
            ? item("a")
            : list,
    );
    await submitBusinessDecision(h);
    expect(request.mock.calls.find(([method]) => method === "workitems.decide")).toEqual([
      "workitems.decide",
      {
        projectId: "p1",
        id: "a",
        expectedRevision: 7,
        decision: "approve",
        comment: "Looks good",
        override: { reason: "exception approved" },
      },
    ]);
  });
  it("requires a trimmed comment for send-back and cancel, and ten trimmed override characters", async () => {
    const { h, request } = await reviewHost();
    beginBusinessDecision(h, "send_back");
    editBusinessDecision(h, { comment: "   " });
    await submitBusinessDecision(h);
    expect(request.mock.calls.some(([method]) => method === "workitems.decide")).toBe(false);
    editBusinessDecision(h, { comment: "  Please revise  " });
    await submitBusinessDecision(h);
    expect(request).toHaveBeenCalledWith(
      "workitems.decide",
      expect.objectContaining({ comment: "Please revise" }),
    );

    h.business.item = item("a").item;
    beginBusinessDecision(h, "cancel");
    editBusinessDecision(h, { comment: "   " });
    await submitBusinessDecision(h);
    expect(request.mock.calls.filter(([method]) => method === "workitems.decide")).toHaveLength(1);

    const { h: h2, request: request2 } = await reviewHost();
    beginBusinessDecision(h2, "approve");
    editBusinessDecision(h2, { override: true, overrideReason: "  123456789  " });
    await submitBusinessDecision(h2);
    expect(request2.mock.calls.some(([method]) => method === "workitems.decide")).toBe(false);
    editBusinessDecision(h2, { overrideReason: "  1234567890  " });
    request2.mockImplementation(async (method: string) =>
      method === "workitems.decide"
        ? decided()
        : method === "workitems.config"
          ? config
          : method === "workitems.get"
            ? item("a")
            : list,
    );
    await submitBusinessDecision(h2);
    expect(
      request2.mock.calls.filter(([method]) => method === "workitems.decide").at(-1)?.[1],
    ).toEqual(expect.objectContaining({ override: { reason: "1234567890" } }));
  });
  it("prevents a second submit while pending and refreshes after success without assuming final approval", async () => {
    const { h, request } = await reviewHost();
    beginBusinessDecision(h, "approve");
    const wait = deferred<ReturnType<typeof decided>>();
    request.mockImplementation(async (method: string) =>
      method === "workitems.decide"
        ? wait.promise
        : method === "workitems.config"
          ? config
          : method === "workitems.get"
            ? item("a")
            : list,
    );
    const first = submitBusinessDecision(h);
    await submitBusinessDecision(h);
    expect(request.mock.calls.filter(([method]) => method === "workitems.decide")).toHaveLength(1);
    wait.resolve(decided("a", "p1", "awaiting_review") as never);
    await first;
    expect(request.mock.calls.filter(([method]) => method === "workitems.list")).toHaveLength(2);
    expect(h.business.item?.status).toBe("awaiting_review");
    expect(h.business.decisionNotice).toBeTruthy();
  });
  it("keeps the decision lock through same-item refresh and reselect, then preserves the outcome", async () => {
    const { h, request } = await reviewHost();
    beginBusinessDecision(h, "approve");
    const wait = deferred<ReturnType<typeof decided>>();
    request.mockImplementation(async (method: string) =>
      method === "workitems.decide"
        ? wait.promise
        : method === "workitems.config"
          ? config
          : method === "workitems.get"
            ? item("a")
            : list,
    );
    const pending = submitBusinessDecision(h);
    await loadBusiness(h);
    await loadBusinessItem(h, "a");
    expect(h.business.decisionPending).toBe(true);
    await submitBusinessDecision(h);
    expect(request.mock.calls.filter(([method]) => method === "workitems.decide")).toHaveLength(1);

    wait.resolve(decided() as never);
    await pending;
    expect(h.business.decisionNotice).toContain("Decision recorded");
    expect(request.mock.calls.filter(([method]) => method === "workitems.decide")).toHaveLength(1);
  });
  it("cannot resubmit after navigating away and back while the first RPC is unresolved", async () => {
    const { h, request } = await reviewHost();
    beginBusinessDecision(h, "approve");
    const wait = deferred<ReturnType<typeof decided>>();
    request.mockImplementation(async (method: string) =>
      method === "workitems.decide"
        ? wait.promise
        : method === "workitems.config"
          ? config
          : method === "workitems.get"
            ? item("a")
            : list,
    );
    const pending = submitBusinessDecision(h);
    h.tab = "chat";
    h.tab = "projects";
    await submitBusinessDecision(h);
    expect(request.mock.calls.filter(([method]) => method === "workitems.decide")).toHaveLength(1);
    expect(h.business.decisionPending).toBe(true);
    wait.resolve(decided() as never);
    await pending;
    expect(h.business.decisionNotice).toContain("Decision recorded");
  });
  it("localizes known refusals and unknown errors without exposing raw details or retrying", async () => {
    const { h, request } = await reviewHost();
    beginBusinessDecision(h, "send_back");
    editBusinessDecision(h, { comment: "Please revise" });
    request.mockImplementation(async (method: string) => {
      if (method === "workitems.decide") {
        throw { details: { code: "separation_of_duties", secret: "/private/token" } };
      }
      return method === "workitems.config" ? config : method === "workitems.get" ? item("a") : list;
    });
    await submitBusinessDecision(h);
    expect(h.business.decisionNotice).toContain("Separation of duties");
    expect(h.business.decisionNotice).not.toContain("private");
    expect(request.mock.calls.filter(([method]) => method === "workitems.decide")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "workitems.list")).toHaveLength(2);

    h.business.item = item("a").item;
    beginBusinessDecision(h, "send_back");
    editBusinessDecision(h, { comment: "Please revise" });
    request.mockImplementation(async (method: string) => {
      if (method === "workitems.decide") {
        throw new Error("secret/private/token");
      }
      return method === "workitems.config" ? config : method === "workitems.get" ? item("a") : list;
    });
    await submitBusinessDecision(h);
    expect(h.business.decisionNotice).not.toContain("secret");
  });
  it.each(["reset", "project", "client", "item", "queue"] as const)(
    "discards a pending decision response after %s changes",
    async (change) => {
      const { h, request } = await reviewHost();
      beginBusinessDecision(h, "approve");
      const wait = deferred<ReturnType<typeof decided>>();
      request.mockImplementation(async (method: string) =>
        method === "workitems.decide"
          ? wait.promise
          : method === "workitems.config"
            ? config
            : method === "workitems.get"
              ? item("a")
              : list,
      );
      const pending = submitBusinessDecision(h);
      if (change === "reset") {
        resetBusiness(h);
      }
      if (change === "project") {
        h.projects = { ...h.projects, selectedId: "p2" };
        resetBusiness(h);
      }
      if (change === "client") {
        h.client = {} as GatewayBrowserClient;
        resetBusiness(h);
      }
      if (change === "item") {
        h.business.selectedId = "b";
      }
      if (change === "queue") {
        h.business.queue = "new";
        h.business.selectedId = null;
      }
      expect(h.business.decisionPending).toBe(true);
      wait.resolve(decided() as never);
      await pending;
      if (change === "item" || change === "queue") {
        expect(request.mock.calls.filter(([method]) => method === "workitems.list")).toHaveLength(
          1,
        );
      } else {
        expect(h.business.decisionNotice).toBeNull();
      }
    },
  );
  it("invalidates an open form when a background read sees a newer revision", async () => {
    const { h, request } = await reviewHost();
    beginBusinessDecision(h, "approve");
    request.mockImplementation(async (method: string) =>
      method === "workitems.get"
        ? { item: { ...item("a").item, revision: 2 } }
        : method === "workitems.config"
          ? config
          : list,
    );
    await loadBusinessItem(h, "a", true);
    expect(h.business.decisionForm).toBeNull();
    expect(h.business.decisionNotice).toBeTruthy();
  });
  it("guards disconnected, loading, and unavailable policy states", async () => {
    const { h, request } = await reviewHost();
    h.connected = false;
    beginBusinessDecision(h, "approve");
    expect(h.business.decisionForm).toBeNull();
    h.connected = true;
    h.business.loading = true;
    beginBusinessDecision(h, "approve");
    expect(h.business.decisionForm).toBeNull();
    h.business.loading = false;
    h.business.config = { ...config, error: "unavailable" };
    beginBusinessDecision(h, "approve");
    expect(h.business.decisionForm).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "workitems.decide")).toBe(false);
  });
});

describe("Business serious-error reports", () => {
  async function reportHost() {
    const { h, request } = await reviewHost();
    h.hello = {
      auth: { role: "operator", scopes: ["operator.approvals"] },
    } as BusinessHost["hello"];
    h.business.item!.createdBy = "autopilot:receipts";
    request.mockImplementation(async (method, params) => {
      if (method === "workitems.config") {
        return config;
      }
      if (method === "workitems.get") {
        return { item: { ...item(params.id).item, createdBy: "autopilot:receipts" } };
      }
      return list;
    });
    beginBusinessReport(h);
    editBusinessReport(h, "  Incorrect amount  ");
    request.mockClear();
    return { h, request };
  }
  it("reports only after explicit submit, pins the item and refreshes queue and detail", async () => {
    const { h, request } = await reportHost();
    expect(request).not.toHaveBeenCalled();
    await submitBusinessReport(h);
    expect(request).toHaveBeenCalledWith("autopilot.reportError", {
      projectId: "p1",
      itemId: "a",
      reason: "Incorrect amount",
    });
    expect(
      request.mock.calls.filter(([method]) => method === "autopilot.reportError"),
    ).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("workitems.get", { projectId: "p1", id: "a" });
    expect(request).toHaveBeenCalledWith("workitems.list", { projectId: "p1", limit: 50 });
    expect(h.business.reportForm).toBeNull();
    expect(h.business.reportNotice).toContain("Error reported");
    expect(h.business.decisionPending).toBe(false);
  });
  it.each(["", "abc", "x".repeat(1001)])("rejects invalid reason length %s", async (reason) => {
    const { h, request } = await reportHost();
    editBusinessReport(h, reason);
    await submitBusinessReport(h);
    expect(request).not.toHaveBeenCalled();
    expect(h.business.reportNotice).toContain("4–1000");
  });
  it.each([
    "identity",
    "node",
    "scope",
    "origin",
    "selection",
    "project",
    "disconnected",
    "view",
    "loading",
    "detail-error",
    "expense",
    "work",
    "decision",
  ])("refuses %s at submission", async (gate) => {
    const { h, request } = await reportHost();
    if (gate === "identity") {
      h.hello = null;
    }
    if (gate === "node") {
      h.hello = { auth: { role: "node", scopes: ["operator.approvals"] } } as BusinessHost["hello"];
    }
    if (gate === "scope") {
      h.hello = { auth: { role: "operator", scopes: ["operator.read"] } } as BusinessHost["hello"];
    }
    if (gate === "origin") {
      h.business.item!.createdBy = "person:owner";
    }
    if (gate === "selection") {
      h.business.selectedId = "other";
    }
    if (gate === "project") {
      h.business.item!.projectId = "p2";
    }
    if (gate === "disconnected") {
      h.connected = false;
    }
    if (gate === "view") {
      h.projects.view = "autopilot";
    }
    if (gate === "loading") {
      h.business.detailLoading = true;
    }
    if (gate === "detail-error") {
      h.business.detailError = "failed";
    }
    if (gate === "expense") {
      h.business.expensePending = true;
    }
    if (gate === "work") {
      h.business.workPending = true;
    }
    if (gate === "decision") {
      h.business.decisionPending = true;
    }
    await submitBusinessReport(h);
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a changed revision", async () => {
    const { h, request } = await reportHost();
    h.business.item!.revision++;
    await submitBusinessReport(h);
    expect(request).not.toHaveBeenCalled();
    expect(h.business.reportForm).toBeNull();
  });
  it("shares the decision lock across refresh, duplicate submit and reset", async () => {
    const { h, request } = await reportHost();
    const wait = deferred<unknown>();
    request.mockImplementation(async (method, params) => {
      if (method === "autopilot.reportError") {
        return wait.promise;
      }
      if (method === "workitems.get") {
        return { item: { ...item(params.id).item, createdBy: "autopilot:receipts" } };
      }
      return method === "workitems.config" ? config : list;
    });
    const pending = submitBusinessReport(h);
    await submitBusinessReport(h);
    editBusinessReport(h, "Must not replace submitted reason");
    cancelBusinessReport(h);
    beginBusinessDecision(h, "approve");
    expect(h.business.decisionForm).toBeNull();
    expect(h.business.reportForm?.reason).toBe("  Incorrect amount  ");
    businessEvent(h, { projectId: "p1", id: "a" });
    await vi.waitFor(() => expect(h.business.loading).toBe(false));
    expect(h.business.decisionPending).toBe(true);
    resetBusiness(h);
    expect(h.business.decisionPending).toBe(true);
    wait.resolve({});
    await pending;
    expect(h.business.decisionPending).toBe(false);
    expect(h.business.reportNotice).toBeNull();
    expect(
      request.mock.calls.filter(([method]) => method === "autopilot.reportError"),
    ).toHaveLength(1);
  });
  it.each(["project", "client", "selection"])(
    "ignores late report response after %s changes",
    async (change) => {
      const { h, request } = await reportHost();
      const wait = deferred<unknown>();
      request.mockReturnValue(wait.promise);
      const pending = submitBusinessReport(h);
      if (change === "project") {
        h.projects.selectedId = "p2";
      }
      if (change === "client") {
        h.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      }
      if (change === "selection") {
        h.business.selectedId = "b";
      }
      wait.resolve({});
      await pending;
      expect(h.business.reportNotice).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "already_reported",
    "routines_invalid",
    "item_not_found",
    "not_autopilot_item",
    "routine_not_found",
    "archived",
    "transport",
  ])("refreshes safely after %s without replay or raw diagnostics", async (code) => {
    const { h, request } = await reportHost();
    request.mockImplementation(async (method, params) => {
      if (method === "autopilot.reportError") {
        throw { details: { code }, message: "secret diagnostic" };
      }
      if (method === "workitems.get") {
        return { item: { ...item(params.id).item, createdBy: "autopilot:receipts" } };
      }
      return method === "workitems.config" ? config : list;
    });
    await submitBusinessReport(h);
    expect(h.business.reportNotice).not.toContain("secret diagnostic");
    expect(h.business.reportNotice).toContain(
      code === "transport"
        ? "could not be confirmed"
        : code === "already_reported"
          ? "already been reported"
          : "can no longer be reported",
    );
    expect(h.business.reportForm?.reason).toBe("  Incorrect amount  ");
    expect(
      request.mock.calls.filter(([method]) => method === "autopilot.reportError"),
    ).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("workitems.get", { projectId: "p1", id: "a" });
  });
});

it.each(["project", "client", "selection"])(
  "does not restore report state after %s changes during post-write refresh",
  async (change) => {
    const { h, request } = await reviewHost();
    h.hello = {
      auth: { role: "operator", scopes: ["operator.approvals"] },
    } as BusinessHost["hello"];
    h.business.item!.createdBy = "autopilot:receipts";
    beginBusinessReport(h);
    editBusinessReport(h, "Incorrect amount");
    const read = deferred<WorkitemsGetResult>();
    request.mockImplementation(async (method, params) => {
      if (method === "workitems.get") {
        return params.id === "a" ? read.promise : item(params.id);
      }
      return method === "workitems.config" ? config : list;
    });
    const pending = submitBusinessReport(h);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("workitems.get", { projectId: "p1", id: "a" }),
    );
    if (change === "selection") {
      await loadBusinessItem(h, "b");
    } else {
      if (change === "project") {
        h.projects.selectedId = "p2";
      } else {
        h.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      }
      resetBusiness(h);
    }
    read.resolve(item("a"));
    await pending;
    expect(h.business.reportNotice).toBeNull();
    expect(h.business.reportForm).toBeNull();
    expect(h.business.item?.id ?? null).toBe(change === "selection" ? "b" : null);
    expect(h.business.decisionPending).toBe(false);
    expect(
      request.mock.calls.filter(([method]) => method === "autopilot.reportError"),
    ).toHaveLength(1);
  },
);

describe("Supplier selection", () => {
  async function supplierHost() {
    const context = await reviewHost();
    const { h, request } = context;
    h.hello = {
      auth: { role: "operator", scopes: ["operator.approvals"] },
    } as BusinessHost["hello"];
    Object.assign(h.business.item!, {
      procurement: {
        request: [{ code: "A", quantity: 1 }],
        quotes: [10, 20].map((price, i) => ({
          supplier: `Supplier ${i}`,
          lines: [{ code: "A", description: "A", quantity: 1, unitPrice: price, taxRate: 10 }],
        })),
        comparisonDigest: "digest",
        recordedBy: "agent",
        at: "2026-10-26",
      },
    });
    request.mockImplementation(async (method) =>
      method === "workitems.config"
        ? config
        : method === "workitems.get" || method === "workitems.selectSupplier"
          ? { item: h.business.item }
          : list,
    );
    request.mockClear();
    return context;
  }
  it("requires explicit confirmation, revision and substantive deviation reason", async () => {
    const { h, request } = await supplierHost();
    beginSupplier(h, "Supplier 1");
    expect(request).not.toHaveBeenCalled();
    editSupplier(h, "short");
    await submitSupplier(h);
    expect(request).not.toHaveBeenCalled();
    editSupplier(h, "Reliable delivery date");
    await submitSupplier(h);
    expect(request).toHaveBeenCalledWith("workitems.selectSupplier", {
      projectId: "p1",
      id: "a",
      expectedRevision: 1,
      supplier: "Supplier 1",
      reason: "Reliable delivery date",
    });
    expect(h.business.supplierForm).toBeNull();
    expect(h.business.decisionPending).toBe(false);
  });
  it("refuses stale revision and readonly sessions without a write", async () => {
    const { h, request } = await supplierHost();
    beginSupplier(h, "Supplier 0");
    h.business.item = { ...h.business.item!, revision: 2 };
    await submitSupplier(h);
    expect(h.business.supplierNotice).toContain("changed");
    expect(request).not.toHaveBeenCalled();
    h.hello = null;
    beginSupplier(h, "Supplier 0");
    expect(h.business.supplierForm).toBeNull();
  });
  it("holds the write lock across project reset and drops a late outcome", async () => {
    const { h, request } = await supplierHost();
    const pending = deferred<WorkitemsGetResult>();
    request.mockReturnValue(pending.promise);
    beginSupplier(h, "Supplier 0");
    const action = submitSupplier(h);
    await submitSupplier(h);
    expect(request).toHaveBeenCalledTimes(1);
    h.projects = { ...h.projects, selectedId: "p2" };
    resetBusiness(h);
    expect(h.business.decisionPending).toBe(true);
    pending.resolve(item("a"));
    await action;
    expect(h.business.supplierNotice).toBeNull();
    expect(h.business.item).toBeNull();
    expect(h.business.decisionPending).toBe(false);
  });
  it("refreshes after refusal without automatically replaying the choice", async () => {
    const { h, request } = await supplierHost();
    const implementation = request.getMockImplementation()!;
    request.mockImplementation((method, params) =>
      method === "workitems.selectSupplier"
        ? Promise.reject(new Error("stale"))
        : implementation(method, params),
    );
    beginSupplier(h, "Supplier 0");
    await submitSupplier(h);
    expect(
      request.mock.calls.filter(([method]) => method === "workitems.selectSupplier"),
    ).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("workitems.get", { projectId: "p1", id: "a" });
    expect(h.business.supplierForm).toBeNull();
    expect(h.business.supplierNotice).toContain("Could not confirm");
  });
  it("never retries an uncertain write when readback also fails", async () => {
    const { h, request } = await supplierHost();
    request.mockRejectedValue(new Error("connection lost"));
    beginSupplier(h, "Supplier 0");
    await submitSupplier(h);
    expect(h.business.error).toBeTruthy();
    expect(h.business.supplierForm).toBeNull();
    beginSupplier(h, "Supplier 0");
    await submitSupplier(h);
    expect(
      request.mock.calls.filter(([method]) => method === "workitems.selectSupplier"),
    ).toHaveLength(1);
  });
  it("blocks other editing forms and refuses a changed project before submission", async () => {
    const { h, request } = await supplierHost();
    h.business.reportForm = { id: "a", revision: 1, reason: "issue" };
    beginSupplier(h, "Supplier 0");
    expect(h.business.supplierForm).toBeNull();
    h.business.reportForm = null;
    beginSupplier(h, "Supplier 0");
    beginBusinessDecision(h, "approve");
    expect(h.business.decisionForm).toBeNull();
    h.projects = { ...h.projects, selectedId: "p2" };
    await submitSupplier(h);
    expect(request).not.toHaveBeenCalled();
  });
});
