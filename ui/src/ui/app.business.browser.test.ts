import { describe, expect, it, vi } from "vitest";
import type { WorkitemsConfigResult } from "../../../packages/client/src/generated/types";
import { KoLoApp } from "./app";
import { emptyBusiness } from "./controllers/business";
import { DEFAULT_PROJECTS_STATE } from "./controllers/projects";

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
function setup() {
  let finishUpdate!: () => void;
  const updateComplete = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  const textarea = { focus: vi.fn() };
  const button = { focus: vi.fn() };
  const querySelector = vi.fn((selector: string) =>
    selector.includes("textarea") ? textarea : button,
  );
  const host = {
    connected: true,
    tab: "projects",
    client: { request: vi.fn() },
    projects: { ...DEFAULT_PROJECTS_STATE, selectedId: "p1", view: "business" },
    business: {
      ...emptyBusiness(),
      projectId: "p1",
      config,
      selectedId: "item-1",
      item: {
        id: "item-1",
        projectId: "p1",
        revision: 4,
        status: "awaiting_review",
        approvals: [],
        requiredApprovals: 1,
      },
    },
    updateComplete,
    renderRoot: { querySelector },
  } as unknown as KoLoApp;
  return { host, finishUpdate, textarea, button, querySelector };
}

describe("business decision focus handoff", () => {
  it("moves focus into the comment after the form update", async () => {
    const s = setup();
    const action = KoLoApp.prototype.beginBusinessDecision.call(s.host, "approve");
    expect(s.textarea.focus).not.toHaveBeenCalled();
    s.finishUpdate();
    await action;
    expect(s.querySelector).toHaveBeenCalledWith(".business-decision__form textarea");
    expect(s.textarea.focus).toHaveBeenCalledOnce();
  });

  it("returns focus to the matching decision action after Back", async () => {
    const s = setup();
    const opening = KoLoApp.prototype.beginBusinessDecision.call(s.host, "send_back");
    s.finishUpdate();
    await opening;
    const back = KoLoApp.prototype.cancelBusinessDecision.call(s.host);
    await back;
    expect(s.querySelector).toHaveBeenCalledWith('[data-business-decision="send_back"]');
    expect(s.button.focus).toHaveBeenCalledOnce();
  });

  it.each(["begin", "back"] as const)(
    "does not steal focus when navigation or form removal occurs during the %s update",
    async (operation) => {
      const s = setup();
      if (operation === "begin") {
        const pending = KoLoApp.prototype.beginBusinessDecision.call(s.host, "approve");
        s.host.business.decisionForm = null;
        s.finishUpdate();
        await pending;
      } else {
        const opening = KoLoApp.prototype.beginBusinessDecision.call(s.host, "cancel");
        s.finishUpdate();
        await opening;
        s.textarea.focus.mockClear();
        const pending = KoLoApp.prototype.cancelBusinessDecision.call(s.host);
        s.host.business.selectedId = "other-item";
        await pending;
      }
      expect(s.textarea.focus).not.toHaveBeenCalled();
      expect(s.button.focus).not.toHaveBeenCalled();
    },
  );
});

describe("expense submit focus handoff", () => {
  it("focuses the enabled confirmation after rendering and restores the submit origin on close", async () => {
    const s = setup();
    s.host.business.config = {
      ...config,
      queues: [
        {
          id: "expenses",
          types: ["expense"],
          name: { en: "Expenses" },
          slaHours: null,
          defaultAgent: null,
        },
      ],
    };
    s.host.business.item = {
      ...s.host.business.item!,
      status: "new",
      type: "expense",
      queue: "expenses",
      title: "Supplies",
      source: { fields: {}, documents: [] },
    };
    const opening = KoLoApp.prototype.beginBusinessExpense.call(s.host, "submit");
    expect(s.button.focus).not.toHaveBeenCalled();
    s.finishUpdate();
    await opening;
    expect(s.querySelector).toHaveBeenCalledWith('.business-intake button[type="submit"]');
    expect(s.button.focus).toHaveBeenCalledOnce();
    s.button.focus.mockClear();
    await KoLoApp.prototype.cancelBusinessExpense.call(s.host);
    expect(s.querySelector).toHaveBeenCalledWith("[data-business-expense-submit]");
    expect(s.button.focus).toHaveBeenCalledOnce();
  });
});

describe("notification item navigation", () => {
  function notificationSetup() {
    const s = setup();
    s.host.business.notifications = {
      ...s.host.business.notifications,
      open: true,
      records: [
        {
          id: "n1",
          itemId: "item-2",
          principal: "alice",
          reason: "linked_case_complete",
          revision: 2,
          childId: "child-1",
          createdAt: "2026-10-26T06:00:00Z",
          readAt: null,
        },
      ],
    };
    const item = {
      ...s.host.business.item!,
      id: "item-2",
      type: "expense" as const,
      source: { fields: {}, documents: [] },
    };
    const request = vi.fn().mockResolvedValue({ item });
    s.host.client = { request } as unknown as KoLoApp["client"];
    return { ...s, request, item };
  }
  it.each(["all", "finance"])(
    "opens the parent with fresh access checks and focuses it in %s",
    async (department) => {
      const s = notificationSetup();
      s.host.business.department = department;
      s.host.business.queue = "filtered-queue";
      const action = KoLoApp.prototype.openBusinessNotification.call(s.host, "n1");
      s.finishUpdate();
      await action;
      expect(s.request.mock.calls).toEqual([
        ["workitems.get", { projectId: "p1", id: "item-2" }],
        ["workitems.linked.get", { projectId: "p1", id: "item-2" }],
      ]);
      expect(s.host.business.item?.id).toBe("item-2");
      expect(s.host.business.department).toBe(department);
      expect(s.host.business.queue).toBe("filtered-queue");
      expect(s.host.business.notifications.records![0].readAt).toBeNull();
      expect(s.button.focus).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "unknown",
    "closed",
    "loading",
    "error",
    "project",
    "client",
    "tab",
    "view",
    "offline",
    "decisionPending",
    "expensePending",
    "workPending",
    "decisionForm",
    "reportForm",
    "expenseForm",
    "workForm",
    "expenseUncertain",
    "workUncertain",
    "pendingId",
  ])("refuses %s navigation", async (kind) => {
    const s = notificationSetup();
    if (kind === "closed") {
      s.host.business.notifications.open = false;
    }
    if (kind === "loading") {
      s.host.business.notifications.loading = true;
    }
    if (kind === "error") {
      s.host.business.notifications.error = true;
    }
    if (kind === "project") {
      s.host.projects.selectedId = "p2";
    }
    if (kind === "client") {
      s.host.client = null;
    }
    if (kind === "tab") {
      s.host.tab = "chat";
    }
    if (kind === "view") {
      s.host.projects.view = "chat";
    }
    if (kind === "offline") {
      s.host.connected = false;
    }
    if (kind === "pendingId") {
      s.host.business.notifications.pendingId = "n1";
    }
    if (
      [
        "decisionPending",
        "expensePending",
        "workPending",
        "decisionForm",
        "reportForm",
        "expenseForm",
        "workForm",
        "expenseUncertain",
        "workUncertain",
      ].includes(kind)
    ) {
      Object.assign(s.host.business, { [kind]: true });
    }
    s.finishUpdate();
    await KoLoApp.prototype.openBusinessNotification.call(
      s.host,
      kind === "unknown" ? "missing" : "n1",
    );
    expect(s.request).not.toHaveBeenCalled();
    expect(s.button.focus).not.toHaveBeenCalled();
  });
  it.each(["project", "client", "tab", "view", "offline", "reset", "selection"])(
    "does not steal focus after %s changes",
    async (kind) => {
      const s = notificationSetup();
      const action = KoLoApp.prototype.openBusinessNotification.call(s.host, "n1");
      await vi.waitFor(() => expect(s.host.business.item?.id).toBe("item-2"));
      if (kind === "project") {
        s.host.projects.selectedId = "p2";
      }
      if (kind === "client") {
        s.host.client = null;
      }
      if (kind === "tab") {
        s.host.tab = "chat";
      }
      if (kind === "view") {
        s.host.projects.view = "chat";
      }
      if (kind === "offline") {
        s.host.connected = false;
      }
      if (kind === "reset") {
        s.host.business = emptyBusiness();
      }
      if (kind === "selection") {
        s.host.business.selectedId = "newer";
      }
      s.finishUpdate();
      await action;
      expect(s.button.focus).not.toHaveBeenCalled();
    },
  );
  it("shows safe detail failure when the item is no longer accessible", async () => {
    const s = notificationSetup();
    s.request.mockRejectedValue(new Error("private path"));
    s.finishUpdate();
    await KoLoApp.prototype.openBusinessNotification.call(s.host, "n1");
    expect(s.host.business.item).toBeNull();
    expect(s.host.business.detailError).toBeTruthy();
    expect(s.host.business.detailError).not.toContain("private path");
    expect(s.host.business.notifications.records![0].readAt).toBeNull();
    expect(s.button.focus).not.toHaveBeenCalled();
  });
});
