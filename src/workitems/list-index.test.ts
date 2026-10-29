import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItem } from "./types.js";
import { dueMarks } from "./escalation.js";
import { appendJournal, compactJournal, journalPath } from "./journal.js";
import { FULL_VERIFY_MS, VERIFY_MS, invalidateWorkItemIndex, nextMarkAt } from "./list-index.js";
import {
  insertWorkItem,
  listWorkItems,
  mutateWorkItem,
  readAllWorkItems,
  readWorkItemsDueForMarks,
  readWorkItemsInQueues,
  removeWorkItemFiles,
  workItemDir,
  workItemsRoot,
} from "./store.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-listindex-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  invalidateWorkItemIndex();
});

let seq = 0;
function seed(projectId: string, queues: string[]): WorkItem[] {
  return queues.map((queue, i) => {
    const id = `w${String(++seq).padStart(12, "0")}`;
    const item = {
      id,
      projectId,
      revision: 1,
      title: `Item ${i}`,
      type: "general",
      status: i % 3 === 0 ? "new" : "awaiting_review",
      priority: i % 2 === 0 ? "normal" : "high",
      queue,
      assignee: i % 4 === 0 ? { kind: "person", id: "u1" } : null,
      dueAt: i % 5 === 0 ? "2026-01-01T00:00:00.000Z" : null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      updatedAt: "2026-10-01T00:00:00.000Z",
      createdBy: "u1",
      requestedBy: "u1",
      route: null,
      source: { documents: [], fields: {} },
      history: [],
    } as unknown as WorkItem;
    insertWorkItem(item, home);
    return item;
  });
}

function ids(projectId: string, filter: Parameters<typeof listWorkItems>[1]): string[] {
  return listWorkItems(projectId, filter, { limit: 200 }, { home }).items.map((i) => i.id);
}

function itemReads(): { count: () => number } {
  const spy = vi.spyOn(fs, "readFileSync");
  return {
    count: () => spy.mock.calls.filter(([p]) => String(p).endsWith("item.json")).length,
  };
}

function writeOutOfBand(projectId: string, item: WorkItem, patch: Partial<WorkItem>): void {
  fs.writeFileSync(
    path.join(workItemDir(projectId, item.id, home), "item.json"),
    JSON.stringify({ ...item, ...patch }),
  );
}

describe("work item list index", () => {
  it("reads only the candidates once the index is built", () => {
    const p = "plistidx001";
    seed(p, ["a", "b", "b", "a", "b", "b", "b", "b", "b", "b"]);
    expect(ids(p, { queue: "a" })).toHaveLength(2); // builds the index
    const reads = itemReads();
    expect(ids(p, { queue: "a" })).toHaveLength(2);
    expect(reads.count()).toBe(2);
  });

  it("applies the department view before reading items", () => {
    const p = "plistidx008";
    seed(p, ["a", "b", "b", "a", "b", "b", "b", "b", "b", "b"]);
    const inDepartment = (queue: string) => queue === "a";
    expect(ids(p, { inDepartment })).toHaveLength(2); // builds the index
    const reads = itemReads();
    expect(ids(p, { inDepartment })).toHaveLength(2);
    expect(reads.count()).toBe(2);
  });

  it("applies the requester filter before reading items", () => {
    const p = "plistidx009";
    const items = seed(p, ["a", "a", "a", "a", "a", "a"]);
    expect(ids(p, { requestedBy: "u2" })).toEqual([]); // builds the index
    mutateWorkItem(p, items[1].id, 1, (cur) => ({ ...cur, requestedBy: "u2" }), home);
    expect(ids(p, { requestedBy: "u2" })).toEqual([items[1].id]); // replays the commit
    const reads = itemReads();
    expect(ids(p, { requestedBy: "u2" })).toEqual([items[1].id]);
    expect(reads.count()).toBe(1);
    expect(ids(p, { requestedBy: "u1" })).toHaveLength(5);
  });

  it("applies the awaiting-review condition before reading items", () => {
    const p = "plistidx010";
    const items = seed(p, ["a", "a", "a", "a", "a", "a"]); // 0 and 3 are new
    expect(ids(p, { awaitingReview: true })).toHaveLength(4); // builds the index
    mutateWorkItem(p, items[1].id, 1, (cur) => ({ ...cur, status: "approved" }), home);
    expect(ids(p, { awaitingReview: true })).toHaveLength(3); // replays the commit
    const reads = itemReads();
    expect(ids(p, { awaitingReview: true })).toHaveLength(3);
    expect(reads.count()).toBe(3);
    expect(ids(p, { awaitingReview: true, status: ["new"] })).toEqual([]);
  });

  it("applies the stage filter before reading items", () => {
    const p = "plistidx011";
    const items = seed(p, ["a", "a", "a", "a", "a", "a"]); // 0 and 3 are new
    const route = (current: number | null) =>
      ({
        id: "r",
        kind: "staged",
        policyDigest: "d",
        stages: ["s1", "s2"].map((id) => ({
          id,
          name: id,
          approvals: [],
          minApprovals: 1,
          dueAt: null,
          escalatedAt: null,
        })),
        skipped: [],
        current,
      }) as unknown as WorkItem["route"];
    expect(ids(p, { stage: "s2" })).toEqual([]); // builds the index
    mutateWorkItem(p, items[1].id, 1, (cur) => ({ ...cur, route: route(1) }), home);
    mutateWorkItem(p, items[2].id, 1, (cur) => ({ ...cur, route: route(0) }), home);
    mutateWorkItem(p, items[3].id, 1, (cur) => ({ ...cur, route: route(1) }), home); // new
    expect(ids(p, { stage: "s2" })).toEqual([items[1].id]); // replays the commits
    const reads = itemReads();
    expect(ids(p, { stage: "s2" })).toEqual([items[1].id]);
    expect(reads.count()).toBe(1);
    expect(ids(p, { stage: "s1" })).toEqual([items[2].id]);
  });

  it("applies the possible-decider filter before reading items", () => {
    const p = "plistidx012";
    const items = seed(p, ["a", "a", "a", "a", "a", "a"]); // 0 and 3 are new; others have no route
    const route = (approvers: object, extra: object = {}) =>
      ({
        id: "r",
        kind: "staged",
        policyDigest: "d",
        stages: [
          {
            id: "s1",
            name: "s1",
            approvers: { any: false, roles: [], principals: [], ...approvers },
            approvals: [],
            delegations: [],
            escalation: null,
            minApprovals: 1,
            dueAt: null,
            escalatedAt: null,
            ...extra,
          },
        ],
        skipped: [],
        current: 0,
      }) as unknown as WorkItem["route"];
    const set = (i: number, r: WorkItem["route"]) =>
      mutateWorkItem(p, items[i].id, 1, (cur) => ({ ...cur, route: r }), home);
    expect(ids(p, { decider: "u9" })).toHaveLength(4); // legacy reviews stay open to any approver
    set(1, route({ principals: ["u2"] }));
    set(2, route({ roles: ["manager"] })); // role-based: the policy decides, so it stays
    set(4, route({ principals: ["u2"] }, { delegations: [{ to: "u9", from: "u2" }] }));
    set(
      5,
      route(
        { principals: ["u2"] },
        { escalation: { afterHours: 1, to: { roles: [], principals: ["u9"] } } },
      ),
    );
    const want = [items[2].id, items[4].id, items[5].id].toSorted();
    expect(ids(p, { decider: "u9" }).toSorted()).toEqual(want); // replays the commits
    const reads = itemReads();
    expect(ids(p, { decider: "u9" }).toSorted()).toEqual(want);
    expect(reads.count()).toBe(3);
    expect(ids(p, { decider: "u2" }).toSorted()).toEqual(
      [items[1].id, items[2].id, items[4].id, items[5].id].toSorted(),
    );
  });

  it("applies the possible-reader filter before reading items", () => {
    const p = "plistidx020";
    const items = seed(p, ["a", "a", "a", "a", "a", "a"]); // requester u1; 0 and 3 are new
    const stage = (extra: object) => ({
      id: "s1",
      name: "s1",
      approvers: { any: false, roles: [], principals: ["u2"] },
      approvals: [],
      delegations: [],
      escalation: null,
      minApprovals: 1,
      dueAt: null,
      escalatedAt: null,
      ...extra,
    });
    const route = (extra: object = {}, current: number | null = 0) =>
      ({
        id: "r",
        kind: "staged",
        policyDigest: "d",
        stages: [stage(extra)],
        skipped: [],
        current,
      }) as unknown as WorkItem["route"];
    const set = (i: number, patch: Partial<WorkItem>) =>
      mutateWorkItem(p, items[i].id, 1, (cur) => ({ ...cur, ...patch }), home);
    // Legacy reviews (1, 2, 4, 5) are open to any approver; 0 and 3 are only the requester's.
    expect(ids(p, { reader: "u9" })).toHaveLength(4);
    set(1, { route: route() });
    set(2, { route: route({ approvers: { any: false, roles: ["manager"], principals: [] } }) });
    set(3, {
      route: route({ approvals: [{ by: "u2", onBehalfOf: "u9" }], status: "approved" }, null),
    });
    set(4, { route: route({ delegations: [{ to: "u3", from: "u9" }] }) });
    set(5, { requestedBy: "u9", route: route() });
    const want = [items[2].id, items[3].id, items[4].id, items[5].id].toSorted();
    expect(ids(p, { reader: "u9" }).toSorted()).toEqual(want); // replays the commits
    const reads = itemReads();
    expect(ids(p, { reader: "u9" }).toSorted()).toEqual(want);
    expect(reads.count()).toBe(4);
    expect(ids(p, { reader: "u1" })).toHaveLength(5); // requester of all but 5; 2 is role-based
    // The stats path applies the same prefilter.
    const before = reads.count();
    const read = readWorkItemsInQueues(p, { reader: "u9" }, { home }).map((i) => i.id);
    expect(read.toSorted()).toEqual(want);
    expect(reads.count() - before).toBe(4);
  });

  it("replays journaled writes and deletes", () => {
    const p = "plistidx002";
    const [x, y] = seed(p, ["a", "b", "b"]);
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    mutateWorkItem(p, y.id, 1, (cur) => ({ ...cur, queue: "a" }), home);
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, y.id].toSorted());
    removeWorkItemFiles(p, x.id, new Set(), home);
    expect(ids(p, { queue: "a" })).toEqual([y.id]);
  });

  it("keeps re-reading an item whose intent has no commit", () => {
    const p = "plistidx003";
    const [, y] = seed(p, ["a", "b"]);
    expect(ids(p, { queue: "a" })).toHaveLength(1);
    // A writer that crashed after the rename, before its commit line.
    appendJournal(workItemsRoot(p, home), { op: "intent", id: y.id });
    writeOutOfBand(p, y, { queue: "a" });
    expect(ids(p, { queue: "a" })).toHaveLength(2);
    writeOutOfBand(p, y, { queue: "c" });
    expect(ids(p, { queue: "a" })).toHaveLength(1);
  });

  it("rebuilds when the journal is replaced, even by a longer one", () => {
    const p = "plistidx004";
    const [, y] = seed(p, ["a", "b"]);
    expect(ids(p, { queue: "a" })).toHaveLength(1);
    writeOutOfBand(p, y, { queue: "a" });
    const file = journalPath(workItemsRoot(p, home));
    const longer = `epoch ${"f".repeat(32)}\n${"commit wnone00000000 1\n".repeat(20)}`;
    fs.writeFileSync(`${file}.new`, longer);
    fs.renameSync(`${file}.new`, file);
    expect(ids(p, { queue: "a" })).toHaveLength(2);
  });

  it("sees every change across a compaction, including a write in flight", () => {
    const p = "plistidx013";
    const [, y, z] = seed(p, ["a", "b", "b"]);
    const root = workItemsRoot(p, home);
    expect(ids(p, { queue: "a" })).toHaveLength(1);
    // y's writer recorded its intent, then the journal rotated before item.json changed.
    appendJournal(root, { op: "intent", id: y.id });
    compactJournal(root);
    expect(ids(p, { queue: "a" })).toHaveLength(1);
    writeOutOfBand(p, y, { queue: "a", revision: 2 });
    appendJournal(root, { op: "commit", id: y.id, revision: 2 });
    expect(ids(p, { queue: "a" })).toContain(y.id);
    expect(ids(p, { queue: "a" })).toHaveLength(2);
    mutateWorkItem(p, z.id, 1, (cur) => ({ ...cur, queue: "a" }), home);
    expect(ids(p, { queue: "a" })).toHaveLength(3);
  });

  it("rebuilds when the epoch changes in place", () => {
    const p = "plistidx005";
    const [, y] = seed(p, ["a", "b"]);
    expect(ids(p, { queue: "a" })).toHaveLength(1);
    writeOutOfBand(p, y, { queue: "a" });
    const file = journalPath(workItemsRoot(p, home));
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(/^epoch [0-9a-f]{32}/, `epoch ${"e".repeat(32)}`));
    expect(ids(p, { queue: "a" })).toHaveLength(2);
  });

  it("picks up out-of-band edits at the periodic verify", () => {
    const p = "plistidx006";
    const [, y] = seed(p, ["a", "b"]);
    expect(ids(p, { queue: "a" })).toHaveLength(1);
    writeOutOfBand(p, y, { queue: "a" });
    expect(ids(p, { queue: "a" })).toHaveLength(1); // documented staleness window
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + VERIFY_MS);
    expect(ids(p, { queue: "a" })).toHaveLength(2);
  });

  it("re-reads only new and changed items at the periodic verify", () => {
    const p = "plistidx016";
    const [x, y, z] = seed(p, ["a", "b", "a"]);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, z.id]);
    clock.mockReturnValue(now + 10_000 + VERIFY_MS);
    let reads = itemReads();
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, z.id]);
    expect(reads.count()).toBe(2); // the candidates only: the verify read nothing
    vi.mocked(fs.readFileSync).mockRestore();

    // Out of band, no journal lines: a same-size in-place edit, a removal and a new item.
    const yFile = path.join(workItemDir(p, y.id, home), "item.json");
    const before = fs.readFileSync(yFile, "utf8");
    const edited = before.replace(/("queue":\s*)"b"/, '$1"a"');
    expect(edited.length).toBe(before.length);
    expect(edited).not.toBe(before);
    fs.writeFileSync(yFile, edited);
    // The mocked clock is 10s ahead of the filesystem: date the edit on it, or a write in the seed's
    // timestamp tick would keep y's stamp (that case is the full check's, tested below).
    const editedAt = new Date(now + 10_000 + VERIFY_MS);
    fs.utimesSync(yFile, editedAt, editedAt);
    fs.rmSync(workItemDir(p, z.id, home), { recursive: true });
    const w = { ...x, id: `w${String(++seq).padStart(12, "0")}` };
    fs.mkdirSync(workItemDir(p, w.id, home), { recursive: true });
    writeOutOfBand(p, w, {});
    clock.mockReturnValue(now + 10_000 + 2 * VERIFY_MS);
    reads = itemReads();
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, y.id, w.id]);
    expect(reads.count()).toBe(5); // y and w at the verify, then the three candidates
    vi.mocked(fs.readFileSync).mockRestore();

    clock.mockReturnValue(now + 10_000 + 3 * VERIFY_MS);
    reads = itemReads();
    expect(ids(p, { queue: "a" })).toHaveLength(3);
    expect(reads.count()).toBe(3);
  });

  it("re-reads every item at the full check, even when a stamp did not change", () => {
    const p = "plistidx018";
    const [x, y] = seed(p, ["a", "b"]);
    const yFile = path.join(workItemDir(p, y.id, home), "item.json");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    // A same-size edit whose stamp collides with the old one (skewed filesystem clock).
    const stale = fs.statSync(yFile);
    const before = fs.readFileSync(yFile, "utf8");
    fs.writeFileSync(yFile, before.replace(/("queue":\s*)"b"/, '$1"a"'));
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, opts?: fs.StatSyncOptions) =>
      String(file) === yFile ? stale : realStat(file, opts)) as typeof fs.statSync);
    clock.mockReturnValue(now + 10_000 + VERIFY_MS);
    expect(ids(p, { queue: "a" })).toEqual([x.id]); // the stamp check misses it
    clock.mockReturnValue(now + 10_000 + FULL_VERIFY_MS);
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, y.id].toSorted());
  });

  it("spreads the full re-read across checks instead of one call paying for it", () => {
    const p = "plistidx019";
    const items = seed(p, ["a", ...Array.from({ length: 119 }, () => "b")]);
    const [x] = items;
    const y = items[items.length - 1]; // last in id order: the sweep reaches it last
    const yFile = path.join(workItemDir(p, y.id, home), "item.json");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    // A same-size edit whose stamp collides with the old one (skewed filesystem clock).
    const stale = fs.statSync(yFile);
    const before = fs.readFileSync(yFile, "utf8");
    fs.writeFileSync(yFile, before.replace(/("queue":\s*)"b"/, '$1"a"'));
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, opts?: fs.StatSyncOptions) =>
      String(file) === yFile ? stale : realStat(file, opts)) as typeof fs.statSync);
    // A check every VERIFY_MS: 120 items over a 30-minute pass is 4 sweep re-reads per check.
    const passChecks = FULL_VERIFY_MS / 2 / VERIFY_MS;
    for (let k = 1; k <= passChecks; k++) {
      clock.mockReturnValue(now + 10_000 + k * VERIFY_MS);
      const reads = itemReads();
      const listed = ids(p, { queue: "a" });
      expect(listed.toSorted()).toEqual(k < passChecks ? [x.id] : [x.id, y.id].toSorted());
      expect(reads.count()).toBe(4 + listed.length);
      vi.mocked(fs.readFileSync).mockRestore();
    }
  });

  it("re-reads after an idle gap only the items near the deadline", () => {
    const p = "plistidx026";
    const [x] = seed(p, ["a", ...Array.from({ length: 119 }, () => "b")]);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    let t = now + 10_000;
    const check = (gap: number) => {
      t += gap;
      clock.mockReturnValue(t);
      const reads = itemReads();
      expect(ids(p, { queue: "a" })).toEqual([x.id]);
      const n = reads.count() - 1; // minus the returned item
      vi.mocked(fs.readFileSync).mockRestore();
      return n;
    };
    for (let k = 0; k < FULL_VERIFY_MS / 2 / VERIFY_MS; k++) {
      expect(check(VERIFY_MS)).toBe(4); // a busy index: 120 items over a 30-minute pass
    }
    expect(check(20 * 60_000)).toBe(4); // idle time earns no slice; nothing is near the deadline
    expect(check(70 * 60_000)).toBe(120); // every item now went ~59 minutes without a re-read
    expect(check(VERIFY_MS)).toBe(4);
  });

  it("keeps checking and sweeping after the clock is set back", () => {
    const p = "plistidx027";
    const [x] = seed(p, ["a", ...Array.from({ length: 119 }, () => "b")]);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    let t = now + 10_000;
    const check = (gap: number) => {
      t += gap;
      clock.mockReturnValue(t);
      const reads = itemReads();
      expect(ids(p, { queue: "a" })).toEqual([x.id]);
      const n = reads.count() - 1; // minus the returned item
      vi.mocked(fs.readFileSync).mockRestore();
      return n;
    };
    expect(check(VERIFY_MS)).toBe(4);
    // The real gap behind a step back is unknown, so it counts as the full deadline: every item.
    expect(check(-2 * FULL_VERIFY_MS)).toBe(120);
    // Checks resume a minute later. Every file now looks changed in the future, so no stamp is
    // trusted and each check re-reads every item until the wall clock passes the file times.
    for (let k = 0; k < 3; k++) {
      expect(check(VERIFY_MS)).toBe(120);
    }
  });

  it("counts idle time the wall clock hides by being set back", () => {
    const p = "plistidx028";
    const [x, y] = seed(p, ["a", "b"]);
    const yFile = path.join(workItemDir(p, y.id, home), "item.json");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    let mono = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    // A same-size edit whose stamp collides with the old one (skewed filesystem clock).
    const stale = fs.statSync(yFile);
    const before = fs.readFileSync(yFile, "utf8");
    fs.writeFileSync(yFile, before.replace(/("queue":\s*)"b"/, '$1"a"'));
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, opts?: fs.StatSyncOptions) =>
      String(file) === yFile ? stale : realStat(file, opts)) as typeof fs.statSync);
    // 2.5 real hours idle, with the wall clock set back 2 hours along the way: it shows 30 minutes.
    mono += 2.5 * FULL_VERIFY_MS;
    clock.mockReturnValue(now + 10_000 + FULL_VERIFY_MS / 2);
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, y.id].toSorted());
  });

  it("re-reads every item on the first call after the clock is set back while idle", () => {
    const p = "plistidx029";
    const [x, y] = seed(p, ["a", "b"]);
    const yFile = path.join(workItemDir(p, y.id, home), "item.json");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000); // stamps settled
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    const stale = fs.statSync(yFile);
    const before = fs.readFileSync(yFile, "utf8");
    fs.writeFileSync(yFile, before.replace(/("queue":\s*)"b"/, '$1"a"'));
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, opts?: fs.StatSyncOptions) =>
      String(file) === yFile ? stale : realStat(file, opts)) as typeof fs.statSync);
    // Suspended (no monotonic time), the wall clock net one hour behind: the first call re-reads.
    clock.mockReturnValue(now + 10_000 - FULL_VERIFY_MS);
    expect(ids(p, { queue: "a" }).toSorted()).toEqual([x.id, y.id].toSorted());
  });

  it("does not trust a stamp taken right after the file changed", () => {
    const p = "plistidx017";
    const [x] = seed(p, ["a", "b"]);
    expect(ids(p, { queue: "a" })).toEqual([x.id]); // real clock: both stamps are racy
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + VERIFY_MS);
    const reads = itemReads();
    expect(ids(p, { queue: "a" })).toEqual([x.id]);
    expect(reads.count()).toBe(3); // both re-read at the verify, then the candidate
  });

  it("lists the same pages with and without the index", () => {
    const p = "plistidx007";
    seed(
      p,
      Array.from({ length: 30 }, (_, i) => ["a", "b", "c"][i % 3]),
    );
    const filters: Parameters<typeof listWorkItems>[1][] = [
      {},
      { queue: "b" },
      { status: ["new"] },
      { priority: ["high"], queue: "a" },
      { assigneeKind: "none" },
      { assigneeKind: "person", assigneeId: "u1" },
      { overdue: true },
      { overdue: false, status: ["awaiting_review"] },
      { flagged: false },
      { q: "ITEM 1" },
    ];
    const allPages = (f: Parameters<typeof listWorkItems>[1]) => {
      const pages = [];
      let cursor: string | undefined;
      do {
        const page = listWorkItems(p, f, { cursor, limit: 7 }, { home });
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return pages;
    };
    const indexed = filters.map(allPages);
    // An opaque `where` forces the read-everything path even with the index.
    expect(filters.map((f) => allPages({ ...f, where: () => true }))).toEqual(indexed);
    const file = journalPath(workItemsRoot(p, home));
    fs.renameSync(file, `${file}.off`);
    try {
      const full = filters.map(allPages);
      expect(indexed).toEqual(full);
    } finally {
      fs.renameSync(`${file}.off`, file);
    }
  });

  it("reads and prepares only the page when no predicate is given", () => {
    const p = "plistidx021";
    seed(
      p,
      Array.from({ length: 30 }, () => "a"),
    );
    expect(ids(p, {})).toHaveLength(30); // builds the index
    const reads = itemReads();
    const prepare = vi.fn((item: WorkItem) => item);
    const page = listWorkItems(p, {}, { limit: 7 }, { home, prepare });
    expect(page.items).toHaveLength(7);
    expect(page.total).toBe(30);
    expect(page.counts.new + page.counts.awaiting_review).toBe(30);
    expect(reads.count()).toBe(7);
    expect(prepare).toHaveBeenCalledTimes(7);
    // A `where` still reads (and prepares) every candidate.
    prepare.mockClear();
    listWorkItems(p, { where: () => true }, { limit: 7 }, { home, prepare });
    expect(prepare).toHaveBeenCalledTimes(30);
  });

  it("shows a page item's prepared state", () => {
    const p = "plistidx022";
    seed(p, ["a", "a", "a"]);
    const page = listWorkItems(
      p,
      {},
      { limit: 2 },
      {
        home,
        prepare: (item) => ({ ...item, title: `${item.title} (prepared)` }),
      },
    );
    expect(page.items.map((i) => i.title)).toEqual(["Item 2 (prepared)", "Item 1 (prepared)"]);
  });

  it("rescans when a page item no longer matches its index entry", () => {
    const p = "plistidx023";
    const items = seed(p, ["a", "a", "a", "a"]);
    expect(ids(p, { queue: "a" })).toHaveLength(4); // builds the index
    writeOutOfBand(p, items[3], { queue: "b" }); // newest item, so on the first page
    const page = listWorkItems(p, { queue: "a" }, { limit: 2 }, { home });
    expect(page.items.map((i) => i.id)).toEqual([items[2].id, items[1].id]);
    expect(page.total).toBe(3);
  });

  it("rescans when a page item's indexed status changes but still matches", () => {
    const p = "plistidx024";
    const items = seed(p, ["a", "a", "a"]);
    const filter = { status: ["new", "awaiting_review"] } as Parameters<typeof listWorkItems>[1];
    expect(listWorkItems(p, filter, {}, { home }).counts.new).toBe(1); // builds the index
    writeOutOfBand(p, items[2], { status: "new" }); // newest, so on the page
    const page = listWorkItems(p, filter, { limit: 2 }, { home });
    expect(page.items[0].status).toBe("new");
    expect(page.counts.new).toBe(2);
    expect(page.counts.awaiting_review).toBe(1);
    expect(page.total).toBe(3);
  });

  it("rescans when a page item's createdAt changes, so order and cursor follow the item", () => {
    const p = "plistidx025";
    const items = seed(p, ["a", "a", "a"]);
    expect(ids(p, { queue: "a" })).toHaveLength(3); // builds the index
    writeOutOfBand(p, items[2], { createdAt: "2000-01-01T00:00:00.000Z" }); // newest -> oldest
    const first = listWorkItems(p, { queue: "a" }, { limit: 2 }, { home });
    expect(first.items.map((i) => i.id)).toEqual([items[1].id, items[0].id]);
    const second = listWorkItems(p, { queue: "a" }, { cursor: first.nextCursor! }, { home });
    expect(second.items.map((i) => i.id)).toEqual([items[2].id]);
  });
});

const H = 3_600_000;
const T = Date.UTC(2026, 9, 1);
const iso = (h: number) => new Date(T + h * H).toISOString();

/** Every combination of stage timers the escalation check looks at, as awaiting-review items. */
function timerVariants(): WorkItem[] {
  const out: WorkItem[] = [];
  for (const dueAt of [null, iso(5), "not a date"]) {
    for (const overdueAt of [null, iso(6)]) {
      for (const activatedAt of [null, iso(0), "garbage"]) {
        // Infinite afterHours are malformed stored values: -Infinity is due at once, +Infinity never.
        for (const escalation of [null, 3, -Infinity, Infinity, "-Infinity"].map((afterHours) =>
          afterHours === null ? null : { afterHours, to: { principals: ["d1"], roles: [] } },
        )) {
          for (const escalatedAt of [null, iso(4)]) {
            for (const status of ["awaiting_review", "approved"]) {
              out.push({
                status,
                route: {
                  current: 0,
                  stages: [{ id: "s", dueAt, overdueAt, activatedAt, escalation, escalatedAt }],
                },
              } as unknown as WorkItem);
            }
          }
        }
      }
    }
  }
  out.push({ status: "awaiting_review", route: null } as unknown as WorkItem);
  out.push({
    status: "awaiting_review",
    route: { current: null, stages: [] },
  } as unknown as WorkItem);
  return out;
}

describe("escalation marks through the list index", () => {
  it("nextMarkAt <= now exactly when dueMarks calls for a mark", () => {
    for (const item of timerVariants()) {
      const at = nextMarkAt(item);
      // Entries are compared as JSON, where every non-finite number reads as null.
      expect(at === null || Number.isFinite(at), JSON.stringify(item)).toBe(true);
      const stage =
        item.status === "awaiting_review"
          ? item.route?.stages[item.route.current ?? -1]
          : undefined;
      for (const h of [-1, 2.99, 3, 4, 5, 6, 100]) {
        const now = new Date(T + h * H);
        const m = stage ? dueMarks(stage, now) : { overdue: false, escalate: false };
        expect(at !== null && at <= now.getTime(), JSON.stringify({ item, h })).toBe(
          m.overdue || m.escalate,
        );
      }
    }
  });

  it("reads only the items whose marks are due once the index is built", () => {
    const p = "plistidx901";
    const items = seed(p, ["a", "a", "a", "a", "a", "a"]);
    const stage = (h: number | null) => ({
      route: {
        current: 0,
        stages: [
          {
            id: "s",
            dueAt: h === null ? null : iso(h),
            overdueAt: null,
            activatedAt: iso(0),
            escalation: null,
            escalatedAt: null,
          },
        ],
      },
      status: "awaiting_review",
    });
    const hours = [1, 10, null, 2, 50, 1];
    items.forEach((it, i) =>
      mutateWorkItem(p, it.id, undefined, (cur) => Object.assign(cur, stage(hours[i])), home),
    );
    const now = new Date(T + 5 * H);
    const full = readAllWorkItems(p, { home })
      .filter((it) => {
        const m = dueMarks(it.route!.stages[0], now);
        return m.overdue || m.escalate;
      })
      .map((it) => it.id)
      .toSorted();
    expect(
      readWorkItemsDueForMarks(p, now, { home })
        .map((it) => it.id)
        .toSorted(),
    ).toEqual(full);
    // A mark due exactly now is due (dueMarks uses <=).
    const atTwo = readWorkItemsDueForMarks(p, new Date(T + 2 * H), { home }).map((it) => it.id);
    expect(atTwo.toSorted()).toEqual([items[0].id, items[3].id, items[5].id].toSorted());
    const reads = itemReads();
    expect(readWorkItemsDueForMarks(p, now, { home })).toHaveLength(3);
    expect(reads.count()).toBe(3);
    mutateWorkItem(
      p,
      items[0].id,
      undefined,
      (cur) => {
        cur.route!.stages[0].overdueAt = now.toISOString();
        return cur;
      },
      home,
    );
    expect(readWorkItemsDueForMarks(p, now, { home }).map((it) => it.id)).not.toContain(
      items[0].id,
    );
  });
});
