import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkitemsListResult } from "../../../../packages/client/src/generated/types.js";
import { BUSINESS_DEPARTMENTS, SME_DEPARTMENT_GROUPS } from "../business-departments";
import { renderDepartmentNavigation, renderDepartmentWorkspace } from "./business-departments";

function root() {
  const node = document.createElement("div");
  document.body.append(node);
  return node;
}
afterEach(() => document.body.replaceChildren());
const queue = {
  id: "office",
  name: { en: "Office work", ja: "事務業務" },
  types: ["request" as const],
  slaHours: null,
  defaultAgent: null,
};
function props() {
  return {
    locale: "en",
    department: BUSINESS_DEPARTMENTS[0],
    queues: [queue],
    selectedQueue: "office",
    list: null as WorkitemsListResult | null,
    loading: false,
    unavailable: false,
    onQueueSelect: vi.fn(),
    onItemSelect: vi.fn(),
  };
}
const list: WorkitemsListResult = {
  items: [
    {
      id: "record-1",
      projectId: "project",
      queue: "office",
      type: "request",
      title: '<img src=x onerror="alert(1)">',
      status: "new",
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
      createdAt: "2026-01-01",
      createdBy: "person",
      requestedBy: "person",
      route: null,
      updatedAt: "2026-01-01",
      revision: 1,
      source: { documents: 2, fields: [] },
      overdue: false,
      currentStage: null,
    },
  ],
  nextCursor: null,
  total: 1,
  counts: { new: 1 },
};

describe("Department navigation", () => {
  it("exposes all departments and mode and selection callbacks", () => {
    const node = root();
    const onSelect = vi.fn();
    const onModeChange = vi.fn();
    render(
      renderDepartmentNavigation({
        locale: "en",
        mode: "enterprise",
        selected: "finance",
        disabled: false,
        onSelect,
        onModeChange,
      }),
      node,
    );
    expect(node.querySelectorAll("[data-department]").length).toBe(17);
    node.querySelector<HTMLButtonElement>('[data-department="hr"]')!.click();
    expect(onSelect).toHaveBeenCalledWith("hr");
    node.querySelector<HTMLButtonElement>('[data-department-mode="sme"]')!.click();
    expect(onModeChange).toHaveBeenCalledWith("sme");
    expect(node.querySelector('[data-department="finance"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
  it("groups all functions in six SME desks and localizes Japanese", () => {
    const node = root();
    render(
      renderDepartmentNavigation({
        locale: "ja",
        mode: "sme",
        selected: "all",
        disabled: false,
        onSelect: vi.fn(),
        onModeChange: vi.fn(),
      }),
      node,
    );
    expect(node.querySelectorAll(".business-departments__group").length).toBe(6);
    expect(node.querySelectorAll("[data-department]").length).toBe(17);
    for (const group of SME_DEPARTMENT_GROUPS) {
      expect(node.textContent).toContain(group.name.ja);
    }
    for (const department of BUSINESS_DEPARTMENTS) {
      expect(node.textContent).toContain(department.name.ja);
    }
  });
  it.each(["enterprise", "sme"] as const)(
    "limits %s navigation to the server catalogue and preserves unmapped",
    (mode) => {
      const node = root();
      const onSelect = vi.fn();
      render(
        renderDepartmentNavigation({
          locale: "en",
          mode,
          selected: "unmapped",
          departments: ["finance"],
          disabled: false,
          onSelect,
          onModeChange: vi.fn(),
        }),
        node,
      );
      expect(
        [...node.querySelectorAll("[data-department]")].map((button) =>
          button.getAttribute("data-department"),
        ),
      ).toEqual(["all", "unmapped", "finance"]);
      node.querySelector<HTMLButtonElement>('[data-department="unmapped"]')!.click();
      expect(onSelect).toHaveBeenCalledWith("unmapped");
      expect(node.querySelector('[data-department="unmapped"]')!.getAttribute("aria-pressed")).toBe(
        "true",
      );
    },
  );
});

describe("Department workspace", () => {
  it("renders aggregate records from multiple queues with the server total", () => {
    const node = root();
    const state = {
      ...props(),
      selectedQueue: "",
      queues: [queue, { ...queue, id: "other" }],
      list: {
        ...list,
        total: 51,
        items: [
          ...list.items,
          { ...list.items[0], id: "record-2", queue: "other", title: "Second queue record" },
        ],
      },
    };
    render(renderDepartmentWorkspace(state), node);
    expect(node.querySelectorAll("[data-department-item]").length).toBe(2);
    expect(node.textContent).toContain("2 loaded / 51 total");
    const all = node.querySelector<HTMLButtonElement>('[data-department-queue=""]')!;
    expect(all.getAttribute("aria-pressed")).toBe("true");
    all.click();
    expect(state.onQueueSelect).toHaveBeenCalledWith("");
  });
  it("flags an unresolved bank-change check in Finance and clears it only when passed", () => {
    const node = root();
    const department = BUSINESS_DEPARTMENTS.find((entry) => entry.id === "finance")!;
    const data = structuredClone(list);
    data.items[0].checks = [
      {
        policyId: "finance.bank-change-verification",
        label: { en: "Callback" },
        result: "fail",
        blocking: true,
        evidence: {},
        checkedAt: "2026-10-25",
        draftVersion: null,
        policyDigest: "demo",
      },
    ];
    render(renderDepartmentWorkspace({ ...props(), department, list: data, locale: "ja" }), node);
    expect(node.textContent).toContain("要確認");
    expect(node.textContent).toContain("電話");
    expect(node.textContent).toContain("支払保留");
    data.items[0].checks[0].result = "pass";
    render(renderDepartmentWorkspace({ ...props(), department, list: data, locale: "ja" }), node);
    expect(node.textContent).not.toContain("支払保留");
  });
  it("disables queue and item controls while a parent operation is pending", () => {
    const node = root();
    const state = { ...props(), list, disabled: true };
    render(renderDepartmentWorkspace(state), node);
    for (const button of node.querySelectorAll<HTMLButtonElement>(
      "[data-department-item], [data-department-queue]",
    )) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    expect(state.onItemSelect).not.toHaveBeenCalled();
    expect(state.onQueueSelect).not.toHaveBeenCalled();
  });

  it.each(BUSINESS_DEPARTMENTS.map((department) => [department.id, department] as const))(
    "shows honest unconfigured state for %s",
    (_id, department) => {
      const node = root();
      render(renderDepartmentWorkspace({ ...props(), department, queues: [] }), node);
      expect(node.textContent).toContain("No queues configured");
      expect(node.querySelectorAll("[data-department-item], [data-department-queue]").length).toBe(
        0,
      );
      expect(node.textContent).toContain(department.name.en);
    },
  );
  it.each(BUSINESS_DEPARTMENTS.map((department) => [department.id, department] as const))(
    "renders supplied records safely in %s",
    (_id, department) => {
      const node = root();
      const state = { ...props(), department, list };
      render(renderDepartmentWorkspace(state), node);
      expect(node.querySelector("img")).toBeNull();
      expect(node.textContent).toContain(list.items[0].title);
      expect(node.querySelectorAll("[data-department-item]").length).toBe(1);
      node.querySelector<HTMLButtonElement>("[data-department-item]")!.click();
      expect(state.onItemSelect).toHaveBeenCalledWith("record-1");
      node.querySelector<HTMLButtonElement>('[data-department-queue="office"]')!.click();
      expect(state.onQueueSelect).toHaveBeenCalledWith("office");
      expect(node.textContent).toContain("Selected queue");
      expect(node.textContent).toContain("1 loaded / 1 total");
    },
  );
  it("never displays old queue data when unavailable, loading or without a selected configured queue", () => {
    const node = root();
    for (const overrides of [
      { unavailable: true },
      { loading: true },
      { selectedQueue: "missing" },
    ]) {
      render(renderDepartmentWorkspace({ ...props(), list, ...overrides }), node);
      expect(node.querySelector("[data-department-item]")).toBeNull();
    }
  });
  it("localizes empty states and does not invent metrics", () => {
    const node = root();
    render(
      renderDepartmentWorkspace({
        ...props(),
        locale: "ja",
        list: { ...list, items: [], total: 0, counts: {} },
      }),
      node,
    );
    expect(node.textContent).toContain("このキューに業務はありません");
    expect(node.textContent).toContain("0 件取得済み / 0 件合計");
    expect(node.textContent).not.toContain("%");
  });
});
