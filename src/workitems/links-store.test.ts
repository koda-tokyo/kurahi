import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LinkedCasePlan } from "./links.js";
import type { Actor, DepartmentId, WorkItem } from "./types.js";
import {
  attachLinkedStep,
  createLinkedCase,
  linkedCaseStatus,
  readLinkedCase,
} from "./links-store.js";
import { insertWorkItem, mutateWorkItem, workItemDir } from "./store.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-links-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const clerk: Actor = { id: "device:clerk0000001", kind: "person" };
const now = new Date("2026-10-26T01:00:00Z");
const projectId = "plinks00001";
const queues: Record<string, DepartmentId> = { "hr-requests": "hr", "it-desk": "it" };
const departmentOf = (q: string) => queues[q];
let seq = 0;

function makeItem(queue = "hr-requests", status: WorkItem["status"] = "new"): string {
  const id = `wlink${String(++seq).padStart(8, "0")}`;
  insertWorkItem(
    {
      id,
      projectId,
      queue,
      status,
      revision: 1,
      createdBy: clerk.id,
      history: [],
    } as unknown as WorkItem,
    home,
  );
  return id;
}

function setStatus(id: string, status: WorkItem["status"]): void {
  mutateWorkItem(projectId, id, undefined, (cur) => ({ ...cur, status }), home);
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

// Onboarding: HR prepares, then IT sets up the account.
const plan: LinkedCasePlan = {
  steps: [
    { key: "prepare", department: "hr", title: { en: "Prepare" }, dependsOn: [] },
    { key: "account", department: "it", title: { en: "Account" }, dependsOn: ["prepare"] },
  ],
};

function attach(parent: string, step: string, child: string) {
  return attachLinkedStep(projectId, parent, step, child, departmentOf, clerk, now, home);
}

describe("linked case store", () => {
  it("creates a plan, attaches ready steps in order and completes when all children are done", () => {
    const parent = makeItem();
    createLinkedCase(projectId, parent, plan, clerk, now, home);
    expect(linkedCaseStatus(projectId, parent, home)?.ready).toEqual(["prepare"]);

    const hr = makeItem("hr-requests");
    attach(parent, "prepare", hr);
    const it1 = makeItem("it-desk");
    expect(code(() => attach(parent, "account", it1))).toBe("linked_step_not_ready");

    setStatus(hr, "done");
    expect(linkedCaseStatus(projectId, parent, home)?.ready).toEqual(["account"]);
    attach(parent, "account", it1);
    expect(linkedCaseStatus(projectId, parent, home)?.complete).toBe(false);
    setStatus(it1, "done");
    const status = linkedCaseStatus(projectId, parent, home)!;
    expect(status.complete).toBe(true);
    expect(status.children).toEqual({ prepare: hr, account: it1 });
    expect(readLinkedCase(projectId, parent, home)?.history.map((h) => h.event)).toEqual([
      "created",
      "attached",
      "attached",
    ]);
  });

  it("refuses an invalid plan, a second plan and a closed parent", () => {
    const parent = makeItem();
    expect(
      code(() =>
        createLinkedCase(projectId, parent, { steps: [] } as LinkedCasePlan, clerk, now, home),
      ),
    ).toBe("linked_plan_invalid");
    createLinkedCase(projectId, parent, plan, clerk, now, home);
    expect(code(() => createLinkedCase(projectId, parent, plan, clerk, now, home))).toBe(
      "linked_case_exists",
    );
    const closed = makeItem("hr-requests", "done");
    expect(code(() => createLinkedCase(projectId, closed, plan, clerk, now, home))).toBe(
      "linked_case_closed",
    );
  });

  it("refuses a child in another department, already used, closed or missing", () => {
    const parent = makeItem();
    createLinkedCase(projectId, parent, plan, clerk, now, home);
    expect(code(() => attach(parent, "prepare", makeItem("it-desk")))).toBe(
      "linked_child_wrong_department",
    );
    expect(code(() => attach(parent, "prepare", makeItem("unknown-queue")))).toBe(
      "linked_child_wrong_department",
    );
    expect(code(() => attach(parent, "prepare", makeItem("hr-requests", "done")))).toBe(
      "linked_child_closed",
    );
    expect(code(() => attach(parent, "prepare", "wlink99999999"))).toBe("linked_child_not_found");
    expect(code(() => attach(parent, "prepare", parent))).toBe("linked_child_in_use");
    expect(code(() => attach(parent, "nope", makeItem()))).toBe("linked_step_unknown");
    const hr = makeItem();
    attach(parent, "prepare", hr);
    expect(code(() => attach(parent, "prepare", makeItem()))).toBe("linked_step_attached");
  });

  it("drops unknown plan fields and refuses a record edited into another parent", () => {
    const parent = makeItem();
    const extra = {
      steps: plan.steps.map((s) => ({ ...s, secret: "x" })),
      note: "y",
    } as unknown as LinkedCasePlan;
    const rec = createLinkedCase(projectId, parent, extra, clerk, now, home);
    expect(JSON.stringify(rec)).not.toContain("secret");
    expect(JSON.stringify(rec)).not.toContain('"note"');

    const file = path.join(workItemDir(projectId, parent, home), "linked-case.json");
    fs.writeFileSync(file, JSON.stringify({ ...rec, parentId: "wlink00000001" }));
    expect(code(() => readLinkedCase(projectId, parent, home))).toBe("linked_case_corrupt");
    expect(code(() => createLinkedCase(projectId, parent, plan, clerk, now, home))).toBe(
      "linked_case_corrupt",
    );
  });

  it("refuses a malformed dependency list rather than opening the step early", () => {
    const parent = makeItem();
    const bad = {
      steps: [plan.steps[0], { ...plan.steps[1], dependsOn: "prepare" }],
    } as unknown as LinkedCasePlan;
    expect(code(() => createLinkedCase(projectId, parent, bad, clerk, now, home))).toBe(
      "linked_plan_invalid",
    );
    expect(readLinkedCase(projectId, parent, home)).toBeNull();
  });

  it("refuses a record edited so one child fills two steps, the parent, or a null or untitled step", () => {
    const parent = makeItem();
    const rec = createLinkedCase(projectId, parent, plan, clerk, now, home);
    const hr = makeItem();
    attach(parent, "prepare", hr);
    setStatus(hr, "done");
    const file = path.join(workItemDir(projectId, parent, home), "linked-case.json");
    const edits = [
      { ...rec, children: { prepare: hr, account: hr } },
      { ...rec, children: { prepare: parent } },
      { ...rec, plan: { steps: [null, plan.steps[1]] } },
      { ...rec, plan: { steps: [plan.steps[0], { ...plan.steps[1], dependsOn: "prepare" }] } },
      { ...rec, plan: { steps: [plan.steps[0], { ...plan.steps[1], title: undefined }] } },
    ];
    for (const edited of edits) {
      fs.writeFileSync(file, JSON.stringify(edited));
      expect(code(() => linkedCaseStatus(projectId, parent, home))).toBe("linked_case_corrupt");
      expect(code(() => attach(parent, "account", makeItem("it-desk")))).toBe(
        "linked_case_corrupt",
      );
    }
  });

  it("counts a vanished child as cancelled, so the parent is blocked and never complete", () => {
    const parent = makeItem();
    createLinkedCase(projectId, parent, plan, clerk, now, home);
    const hr = makeItem();
    attach(parent, "prepare", hr);
    fs.rmSync(workItemDir(projectId, hr, home), { recursive: true, force: true });
    const status = linkedCaseStatus(projectId, parent, home)!;
    expect(status.missing).toEqual(["prepare"]);
    expect(status.blocked).toBe(true);
    expect(status.complete).toBe(false);
    expect(status.steps.find((s) => s.key === "account")?.state).toBe("stuck");
  });

  it("reports no linked case for a plain item", () => {
    expect(linkedCaseStatus(projectId, makeItem(), home)).toBeNull();
  });
});
