import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { LinkedCasePlan } from "./links.js";
import type { Actor, DepartmentId, WorkItem } from "./types.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject } from "../projects/store.js";
import { attachLinkedStep, createLinkedCase } from "./links-store.js";
import { listNotifications, recordWriteNotifications } from "./notifications-store.js";
import { insertWorkItem, readWorkItem, workItemDir } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-notify-linked-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const owner: Actor = { id: "device:owner000001", kind: "person" };
const hrClerk = "device:hrclerk0001";
const itClerk = "device:itclerk0001";
const T0 = new Date("2026-11-02T00:00:00Z");
const queues: Record<string, DepartmentId> = { "hr-requests": "hr", "it-desk": "it" };
const departmentOf = (q: string) => queues[q];
let project: Project;
let seq = 0;

// Onboarding: HR prepares and IT sets up the account in parallel, then HR closes.
const plan: LinkedCasePlan = {
  steps: [
    { key: "prepare", department: "hr", title: { en: "Prepare" }, dependsOn: [] },
    { key: "account", department: "it", title: { en: "Account" }, dependsOn: [] },
    {
      key: "close",
      department: "hr",
      title: { en: "Close" },
      dependsOn: ["prepare", "account"],
    },
  ],
};

function makeItem(queue: string): WorkItem {
  const item = {
    id: `wlinkn${String(++seq).padStart(7, "0")}`,
    projectId: project.id,
    queue,
    status: "in_progress",
    revision: 1,
    createdBy: owner.id,
    requestedBy: owner.id,
    history: [],
  } as unknown as WorkItem;
  insertWorkItem(item);
  return item;
}

/** Store the child at `status` as `by` did it, then run the write boundary like applyTransition. */
function finish(child: WorkItem, status: WorkItem["status"], by: string): WorkItem {
  const before = readWorkItem(project.id, child.id)!;
  const after: WorkItem = {
    ...before,
    status,
    revision: before.revision + 1,
    history: [...before.history, { at: T0.toISOString(), by, action: "update" }],
  } as WorkItem;
  fs.writeFileSync(
    path.join(workItemDir(project.id, child.id), "item.json"),
    JSON.stringify(after),
  );
  recordWriteNotifications(project, before, after, T0);
  return after;
}

function linkedCase() {
  const parent = makeItem("hr-requests");
  createLinkedCase(project.id, parent.id, plan, owner, T0);
  const prepare = makeItem("hr-requests");
  const account = makeItem("it-desk");
  attachLinkedStep(project.id, parent.id, "prepare", prepare.id, departmentOf, owner, T0);
  attachLinkedStep(project.id, parent.id, "account", account.id, departmentOf, owner, T0);
  return { parent, prepare, account };
}

const mine = (itemId: string) =>
  listNotifications(project.id, owner.id).filter((r) => r.itemId === itemId);

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(folder, { recursive: true });
  project = createProject({ name: "Linked", folder }, { createdBy: owner.id, template: null });
});

afterAll(async () => {
  await flushAudit();
  for (const [k, v] of [
    ["KOLO_HOME", saved.home],
    ["KOLO_STATE_DIR", saved.state],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("linked case notifications", () => {
  it("tells the parent's requester only when the last dependency opens the next step", () => {
    const { parent, prepare, account } = linkedCase();
    finish(prepare, "done", hrClerk);
    expect(mine(parent.id)).toEqual([]);
    finish(account, "done", itClerk);
    expect(mine(parent.id)).toMatchObject([
      {
        reason: "linked_step_ready",
        itemId: parent.id,
        childId: account.id,
        stepKey: "close",
        readAt: null,
      },
    ]);
  });

  it("keeps one record per child when two children each open a step on the same parent", () => {
    const parent = makeItem("hr-requests");
    const twoTracks: LinkedCasePlan = {
      steps: [
        { key: "hr-a", department: "hr", title: { en: "HR A" }, dependsOn: [] },
        { key: "it-a", department: "it", title: { en: "IT A" }, dependsOn: [] },
        { key: "hr-b", department: "hr", title: { en: "HR B" }, dependsOn: ["hr-a"] },
        { key: "it-b", department: "it", title: { en: "IT B" }, dependsOn: ["it-a"] },
      ],
    };
    createLinkedCase(project.id, parent.id, twoTracks, owner, T0);
    const hr = makeItem("hr-requests");
    const it_ = makeItem("it-desk");
    attachLinkedStep(project.id, parent.id, "hr-a", hr.id, departmentOf, owner, T0);
    attachLinkedStep(project.id, parent.id, "it-a", it_.id, departmentOf, owner, T0);
    finish(hr, "done", hrClerk);
    finish(it_, "done", itClerk);
    expect(mine(parent.id).map((r) => r.childId)).toEqual([it_.id, hr.id]);
  });

  it("tells the requester when the case completes and when a cancelled step blocks it", () => {
    const { parent, prepare, account } = linkedCase();
    finish(prepare, "done", hrClerk);
    finish(account, "done", itClerk);
    const close = makeItem("hr-requests");
    attachLinkedStep(project.id, parent.id, "close", close.id, departmentOf, owner, T0);
    finish(close, "done", hrClerk);
    expect(mine(parent.id).map((r) => [r.reason, r.childId])).toEqual([
      ["linked_case_complete", close.id],
      ["linked_step_ready", account.id],
    ]);

    const other = linkedCase();
    finish(other.account, "cancelled", itClerk);
    expect(mine(other.parent.id)).toMatchObject([
      { reason: "linked_case_blocked", childId: other.account.id },
    ]);
  });

  it("does not tell the requester about their own change, and ignores unlinked items", () => {
    const { parent, prepare, account } = linkedCase();
    finish(prepare, "done", hrClerk);
    finish(account, "done", owner.id);
    expect(mine(parent.id)).toEqual([]);
    const closed = linkedCase();
    const parentFile = path.join(workItemDir(project.id, closed.parent.id), "item.json");
    fs.writeFileSync(parentFile, JSON.stringify({ ...closed.parent, status: "cancelled" }));
    finish(closed.prepare, "done", hrClerk);
    finish(closed.account, "done", itClerk);
    expect(mine(closed.parent.id)).toEqual([]);
    const loose = makeItem("it-desk");
    finish(loose, "done", itClerk);
    expect(mine(loose.id).map((r) => r.reason)).toEqual(["decided"]);
  });

  it("two children finishing at the same moment block or complete the case once", () => {
    // Both writes land before either write boundary runs, so each sees the other as finished.
    const both = (a: WorkItem, b: WorkItem, status: WorkItem["status"]) => {
      const write = (child: WorkItem) => {
        const before = readWorkItem(project.id, child.id)!;
        const after = { ...before, status, revision: before.revision + 1 } as WorkItem;
        after.history = [
          ...before.history,
          { at: T0.toISOString(), by: hrClerk, action: "update" },
        ];
        fs.writeFileSync(
          path.join(workItemDir(project.id, child.id), "item.json"),
          JSON.stringify(after),
        );
        return [before, after] as const;
      };
      for (const [before, after] of [write(a), write(b)]) {
        recordWriteNotifications(project, before, after, T0);
      }
    };
    const cancelled = linkedCase();
    both(cancelled.prepare, cancelled.account, "cancelled");
    expect(mine(cancelled.parent.id)).toMatchObject([
      { reason: "linked_case_blocked", childId: cancelled.prepare.id },
    ]);

    const parent = makeItem("hr-requests");
    const pair: LinkedCasePlan = { steps: plan.steps.slice(0, 2) };
    createLinkedCase(project.id, parent.id, pair, owner, T0);
    const hr = makeItem("hr-requests");
    const it_ = makeItem("it-desk");
    attachLinkedStep(project.id, parent.id, "prepare", hr.id, departmentOf, owner, T0);
    attachLinkedStep(project.id, parent.id, "account", it_.id, departmentOf, owner, T0);
    both(hr, it_, "done");
    expect(mine(parent.id).map((r) => r.reason)).toEqual(["linked_case_complete"]);

    // Both dependencies of "close" finish together: each sees it newly ready, stored once.
    const opened = linkedCase();
    both(opened.prepare, opened.account, "done");
    expect(mine(opened.parent.id)).toMatchObject([
      { reason: "linked_step_ready", childId: opened.prepare.id, stepKey: "close" },
    ]);
  });

  it("an unreadable linked case record does not fail the write or skip the other parent", () => {
    const broken = linkedCase();
    const { parent, prepare, account } = linkedCase();
    // A second case shares no child, so corrupt the first one's record and finish the second's.
    fs.writeFileSync(path.join(workItemDir(project.id, broken.parent.id), "linked-case.json"), "{");
    finish(prepare, "done", hrClerk);
    expect(() => finish(account, "done", itClerk)).not.toThrow();
    expect(mine(parent.id)).toMatchObject([{ reason: "linked_step_ready" }]);
  });
});
