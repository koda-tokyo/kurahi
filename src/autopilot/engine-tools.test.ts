import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LinkedCasePlan } from "../workitems/links.js";
import type { Actor, DepartmentId, WorkItem } from "../workitems/types.js";
import { attachLinkedStep, createLinkedCase } from "../workitems/links-store.js";
import { insertWorkItem, mutateWorkItem, workItemDir } from "../workitems/store.js";
import { runEngineTool } from "./engine-tools.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-engine-linked-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const clerk: Actor = { id: "device:clerk0000001", kind: "person" };
const now = new Date("2026-10-26T01:00:00Z");
const queues: Record<string, DepartmentId> = { "hr-requests": "hr", "it-desk": "it" };
const departmentOf = (q: string) => queues[q];
let seq = 0;

const plan: LinkedCasePlan = {
  steps: [
    { key: "prepare", department: "hr", title: { en: "Prepare" }, dependsOn: [] },
    { key: "account", department: "it", title: { en: "Account" }, dependsOn: ["prepare"] },
  ],
};

function makeItem(projectId: string, opts: { queue?: string; owned?: boolean } = {}): string {
  const id = `weng${String(++seq).padStart(9, "0")}`;
  insertWorkItem(
    {
      id,
      projectId,
      queue: opts.queue ?? "hr-requests",
      status: "new",
      revision: 1,
      createdBy: clerk.id,
      assignee: opts.owned ? { kind: "person", id: clerk.id } : null,
      history: [],
    } as unknown as WorkItem,
    home,
  );
  return id;
}

function setStatus(projectId: string, id: string, status: WorkItem["status"]): void {
  mutateWorkItem(projectId, id, undefined, (cur) => ({ ...cur, status }), home);
}

/** A linked case whose first step's child is attached. */
function caseWithChild(projectId: string, owned: boolean): { parent: string; child: string } {
  const parent = makeItem(projectId, { owned });
  createLinkedCase(projectId, parent, plan, clerk, now, home);
  const child = makeItem(projectId);
  attachLinkedStep(projectId, parent, "prepare", child, departmentOf, clerk, now, home);
  return { parent, child };
}

function facts(projectId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of runEngineTool("workitems_linked", {}, { projectId, home }).split("\n")) {
    const m = /^fact ([^=]+)=(.*)$/.exec(line);
    if (m) {
      out[m[1]] = m[2];
    } else {
      out.verdict = line;
    }
  }
  return out;
}

describe("workitems_linked engine check", () => {
  it("is OK when open linked cases are only progressing", () => {
    const p = "pengok00001";
    const parent = makeItem(p);
    createLinkedCase(p, parent, plan, clerk, now, home);
    caseWithChild(p, true);
    makeItem(p); // an item with no linked case is not counted
    const f = facts(p);
    expect(f.verdict).toMatch(/^verdict OK /);
    expect(f.linkedCases).toBe("2");
    expect(f.readySteps).toBe("1");
    expect(f.stuck).toBe("0");
  });

  it("escalates blocked, missing and unreadable cases, counting the ones nobody owns", () => {
    const p = "pengbad0001";
    const cancelled = caseWithChild(p, false);
    setStatus(p, cancelled.child, "cancelled");
    const vanished = caseWithChild(p, true);
    fs.rmSync(workItemDir(p, vanished.child, home), { recursive: true, force: true });
    const corrupt = caseWithChild(p, false);
    fs.writeFileSync(path.join(workItemDir(p, corrupt.parent, home), "linked-case.json"), "{");

    const f = facts(p);
    expect(f.verdict).toBe("verdict ESCALATE 3 open linked case(s) stuck (2 with no assignee)");
    expect(f.linkedCases).toBe("3");
    expect(f.blocked).toBe("2");
    expect(f.missing).toBe("1");
    expect(f.unreadable).toBe("1");
    expect(f.unowned).toBe("2");
    expect(f.stuckIds.split(",").toSorted()).toEqual(
      [cancelled.parent, vanished.parent, corrupt.parent].toSorted(),
    );
  });

  it("skips closed parents and reads only the run's own Project", () => {
    const p = "pengdone001";
    const closed = caseWithChild(p, false);
    setStatus(p, closed.child, "cancelled");
    setStatus(p, closed.parent, "done");
    const f = facts(p);
    expect(f.verdict).toMatch(/^verdict OK /);
    expect(f.linkedCases).toBe("0");
    // The stuck cases of the other tests' Projects are not seen here.
    expect(facts("pengempty01").linkedCases).toBe("0");
  });

  it("reports a store it cannot list as unavailable, never as an empty OK", () => {
    const p = "pengnodir01";
    const root = path.dirname(workItemDir(p, "weng000000001", home));
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, "not a directory");
    const f = facts(p);
    expect(f.verdict).toBe("verdict ESCALATE work items unavailable (ENOTDIR)");
    expect(f.available).toBe("false");
    expect(f.linkedCases).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)("reports an unreadable store as unavailable", () => {
    const p = "pengnoperm1";
    caseWithChild(p, true);
    const root = path.dirname(workItemDir(p, "weng000000001", home));
    fs.chmodSync(root, 0o000);
    try {
      expect(facts(p).verdict).toBe("verdict ESCALATE work items unavailable (EACCES)");
    } finally {
      fs.chmodSync(root, 0o755);
    }
  });

  it("escalates when a work item cannot be read, since it may hide a stuck case", () => {
    const p = "pengitem001";
    caseWithChild(p, true);
    const broken = makeItem(p);
    fs.writeFileSync(path.join(workItemDir(p, broken, home), "item.json"), "{");
    const f = facts(p);
    expect(f.verdict).toBe("verdict ESCALATE 1 work item(s) unreadable; linked cases unknown");
    expect(f.stuck).toBe("0");
    expect(f.unreadableItems).toBe("1");
    expect(f.unreadableItemIds).toBe(broken);
  });

  it("lists no titles or content, only ids", () => {
    const p = "pengpriv001";
    const c = caseWithChild(p, false);
    setStatus(p, c.child, "cancelled");
    const text = runEngineTool("workitems_linked", {}, { projectId: p, home });
    expect(text).not.toMatch(/Prepare|Account/);
  });
});
