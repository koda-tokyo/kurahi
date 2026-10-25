import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { WorkItemRoute, WorkItemStage } from "../../../../packages/client/src/workitems.js";
import { setLocale } from "../i18n";
import { renderBusinessRoute } from "./business-route";

function route(overrides: Partial<WorkItemRoute> = {}): WorkItemRoute {
  return {
    id: "route-demo",
    kind: "staged",
    policyDigest: "digest",
    stages: [],
    skipped: [],
    current: null,
    ...overrides,
  };
}

function stage(overrides: Partial<WorkItemStage>): WorkItemStage {
  return {
    id: "stage",
    name: { en: "Stage" },
    approvers: { any: true, roles: [], principals: [], departmentField: null, department: null },
    minApprovals: 1,
    dueHours: null,
    onReturn: "requester",
    delegation: false,
    escalation: null,
    status: "pending",
    approvals: [],
    delegations: [],
    activatedAt: null,
    dueAt: null,
    completedAt: null,
    overdueAt: null,
    escalatedAt: null,
    ...overrides,
  };
}

function mount(value: WorkItemRoute | null, locale = "en") {
  setLocale(locale === "ja" ? "ja" : "en");
  const root = document.createElement("div");
  render(renderBusinessRoute(value, locale), root);
  return root;
}

describe("staged business approval route", () => {
  it("does not render absent or single-stage routes", () => {
    expect(mount(null).textContent).toBe("");
    expect(mount(route({ kind: "single" })).textContent).toBe("");
  });

  it("shows per-stage server status, approval counts, deadline, and active current stage", () => {
    const root = mount(
      route({
        current: 1,
        stages: [
          stage({ id: "s1", name: { en: "First" }, status: "pending", minApprovals: 2 }),
          stage({
            id: "s2",
            name: { en: "Second" },
            status: "active",
            minApprovals: 2,
            approvals: [{ by: "a", at: "now", comment: null }],
            dueAt: "2026-10-30T09:00:00Z",
          }),
          stage({
            id: "s3",
            name: { en: "Third" },
            status: "approved",
            minApprovals: 1,
            approvals: [{ by: "b", at: "now", comment: null }],
          }),
        ],
      }),
    );
    expect(root.textContent).toContain("First");
    expect(root.textContent).toContain("Pending");
    expect(root.textContent).toContain("0 / 2");
    expect(root.textContent).toContain("Second");
    expect(root.textContent).toContain("Active");
    expect(root.textContent).toContain("1 / 2");
    expect(root.textContent).toContain("Current stage");
    expect(root.querySelector("time")?.dateTime).toBe("2026-10-30T09:00:00Z");
    expect(root.textContent).toContain("Third");
    expect(root.textContent).toContain("Approved");
    expect(root.querySelectorAll(".business-route__current")).toHaveLength(1);
  });

  it("shows server overdue and escalated markers and skipped reasons", () => {
    const root = mount(
      route({
        stages: [
          stage({
            id: "late",
            name: { en: "Late" },
            status: "active",
            dueAt: "2026-10-20T00:00:00Z",
            overdueAt: "2026-10-21T00:00:00Z",
            escalatedAt: "2026-10-22T00:00:00Z",
          }),
        ],
        skipped: [{ id: "skip", name: { en: "Skipped" }, reason: "Not applicable" }],
      }),
    );
    expect(root.textContent).toContain("Overdue");
    expect(root.textContent).toContain("Escalated");
    expect(root.textContent).toContain("Skipped");
    expect(root.textContent).toContain("Not applicable");
  });

  it("localizes stage names and route labels in Japanese", () => {
    setLocale("ja");
    const root = mount(
      route({
        stages: [stage({ id: "ja", name: { en: "Review", ja: "確認" }, status: "pending" })],
      }),
      "ja",
    );
    expect(root.textContent).toContain("承認ルート");
    expect(root.textContent).toContain("確認");
    expect(root.textContent).toContain("保留中");
  });

  it("renders untrusted stage names as text", () => {
    const root = mount(
      route({
        stages: [
          stage({
            id: "bad",
            name: { en: '<img src=x onerror="window.pwned=true">' },
            status: "pending",
          }),
        ],
      }),
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="window.pwned=true">');
  });

  it("does not infer current or overdue markers from index or a past deadline", () => {
    const root = mount(
      route({
        current: 0,
        stages: [stage({ id: "stale", status: "approved", dueAt: "2000-01-01T00:00:00Z" })],
      }),
    );
    expect(root.querySelector(".business-route__current")).toBeNull();
    expect(root.textContent).not.toContain("Overdue");
  });
});
