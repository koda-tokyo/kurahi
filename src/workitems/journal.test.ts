import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkItem } from "./types.js";
import { COMPACT_BYTES, appendJournal, journalPath, parseJournal } from "./journal.js";
import {
  insertWorkItem,
  mutateWorkItem,
  readWorkItem,
  removeWorkItemFiles,
  workItemDir,
  workItemsRoot,
} from "./store.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-journal-"));
const projectId = "pjournal001";
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function item(id: string): WorkItem {
  return { id, projectId, revision: 1, title: "t", status: "open" } as unknown as WorkItem;
}

function journal() {
  return parseJournal(fs.readFileSync(journalPath(workItemsRoot(projectId, home)), "utf8"));
}

describe("work item journal", () => {
  it("records intent before and commit after every write, under one epoch", () => {
    insertWorkItem(item("wjournal00001"), home);
    mutateWorkItem(projectId, "wjournal00001", 1, (cur) => cur, home);
    const j = journal();
    expect(j.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(j.lines).toEqual([
      { op: "intent", id: "wjournal00001" },
      { op: "commit", id: "wjournal00001", revision: 1 },
      { op: "intent", id: "wjournal00001" },
      { op: "commit", id: "wjournal00001", revision: 2 },
    ]);
  });

  it("leaves item.json untouched when the intent cannot be recorded", () => {
    insertWorkItem(item("wjournal00002"), home);
    const file = journalPath(workItemsRoot(projectId, home));
    const saved = fs.readFileSync(file);
    fs.rmSync(file);
    fs.mkdirSync(file); // the journal path is now unappendable
    try {
      expect(() =>
        mutateWorkItem(
          projectId,
          "wjournal00002",
          1,
          (cur) => ({ ...cur, title: "changed" }),
          home,
        ),
      ).toThrow();
      expect(readWorkItem(projectId, "wjournal00002", home)?.title).toBe("t");
    } finally {
      fs.rmdirSync(file);
      fs.writeFileSync(file, saved, { mode: 0o600 });
    }
  });

  it("journals a retention delete", () => {
    insertWorkItem(item("wjournal00003"), home);
    const dir = workItemDir(projectId, "wjournal00003", home);
    fs.mkdirSync(path.join(dir, "evidence"));
    removeWorkItemFiles(projectId, "wjournal00003", new Set(["evidence"]), home);
    expect(fs.readdirSync(dir)).toEqual(["evidence"]);
    expect(journal().lines.slice(-2)).toEqual([
      { op: "intent", id: "wjournal00003" },
      { op: "delete", id: "wjournal00003" },
    ]);
  });

  it("re-appends to the live journal when it is replaced mid-append", () => {
    const root = workItemsRoot(projectId, home);
    const file = journalPath(root);
    const replacement = `epoch ${"a".repeat(32)}\n`;
    const realWrite = fs.writeSync;
    let swapped = false;
    // Simulate compaction renaming a new epoch over the journal right after our first write.
    const spy = (fd: number, data: Buffer) => {
      const n = realWrite(fd, data);
      if (!swapped) {
        swapped = true;
        fs.writeFileSync(`${file}.new`, replacement);
        fs.renameSync(`${file}.new`, file);
      }
      return n;
    };
    (fs as { writeSync: unknown }).writeSync = spy;
    try {
      appendJournal(root, { op: "commit", id: "wjournal00009", revision: 7 });
    } finally {
      (fs as { writeSync: unknown }).writeSync = realWrite;
    }
    const j = journal();
    expect(j.epoch).toBe("a".repeat(32));
    expect(j.lines).toEqual([{ op: "commit", id: "wjournal00009", revision: 7 }]);
  });

  it("recreates the journal with an epoch when it is removed before the append opens it", () => {
    const root = path.join(home, "unlinked");
    appendJournal(root, { op: "intent", id: "wjournal00012" });
    const file = journalPath(root);
    const realOpen = fs.openSync;
    let removed = false;
    // Simulate the journal being unlinked between ensureJournal and the open for append.
    (fs as { openSync: unknown }).openSync = (p: fs.PathLike, ...rest: unknown[]) => {
      if (!removed && p === file) {
        removed = true;
        fs.unlinkSync(file);
      }
      return (realOpen as (...args: unknown[]) => number)(p, ...rest);
    };
    try {
      appendJournal(root, { op: "commit", id: "wjournal00012", revision: 1 });
    } finally {
      (fs as { openSync: unknown }).openSync = realOpen;
    }
    expect(removed).toBe(true);
    const j = parseJournal(fs.readFileSync(file, "utf8"));
    expect(j.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(j.lines).toEqual([{ op: "commit", id: "wjournal00012", revision: 1 }]);
  });

  it("compacts to an empty new epoch after a record past the threshold, never after an intent", () => {
    const root = path.join(home, "compact");
    appendJournal(root, { op: "intent", id: "wjournal00020" });
    const file = journalPath(root);
    const before = parseJournal(fs.readFileSync(file, "utf8")).epoch;
    // Blank lines parse as nothing; they only push the file past the threshold.
    fs.appendFileSync(file, "\n".repeat(COMPACT_BYTES));
    appendJournal(root, { op: "intent", id: "wjournal00021" });
    expect(fs.statSync(file).size).toBeGreaterThan(COMPACT_BYTES);
    appendJournal(root, { op: "commit", id: "wjournal00021", revision: 1 });
    const after = parseJournal(fs.readFileSync(file, "utf8"));
    expect(after.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(after.epoch).not.toBe(before);
    expect(after.lines).toEqual([]);
    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    appendJournal(root, { op: "delete", id: "wjournal00021" });
    expect(parseJournal(fs.readFileSync(file, "utf8"))).toEqual({
      epoch: after.epoch,
      lines: [{ op: "delete", id: "wjournal00021" }],
    });
  });

  it("keeps a landed record when compaction fails", () => {
    const root = path.join(home, "compact-fail");
    appendJournal(root, { op: "intent", id: "wjournal00022" });
    const file = journalPath(root);
    fs.appendFileSync(file, "\n".repeat(COMPACT_BYTES));
    const realRename = fs.renameSync;
    (fs as { renameSync: unknown }).renameSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    try {
      appendJournal(root, { op: "commit", id: "wjournal00022", revision: 1 });
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }
    expect(parseJournal(fs.readFileSync(file, "utf8")).lines).toEqual([
      { op: "intent", id: "wjournal00022" },
      { op: "commit", id: "wjournal00022", revision: 1 },
    ]);
    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a short intent write and keeps the next record whole", () => {
    insertWorkItem(item("wjournal00011"), home);
    const realWrite = fs.writeSync;
    // Simulate a write that stops after 5 bytes (ENOSPC or EIO mid-record).
    (fs as { writeSync: unknown }).writeSync = (fd: number, data: string | Buffer) =>
      Buffer.isBuffer(data) && data.includes("intent ")
        ? realWrite(fd, data.subarray(0, 5))
        : realWrite(fd, data);
    try {
      expect(() =>
        mutateWorkItem(
          projectId,
          "wjournal00011",
          1,
          (cur) => ({ ...cur, title: "changed" }),
          home,
        ),
      ).toThrow(/short write/);
    } finally {
      (fs as { writeSync: unknown }).writeSync = realWrite;
    }
    expect(readWorkItem(projectId, "wjournal00011", home)?.title).toBe("t");
    mutateWorkItem(projectId, "wjournal00011", 1, (cur) => ({ ...cur, title: "after" }), home);
    expect(journal().lines.slice(-2)).toEqual([
      { op: "intent", id: "wjournal00011" },
      { op: "commit", id: "wjournal00011", revision: 2 },
    ]);
  });

  it("creates the journal with its epoch already in place", () => {
    const root = path.join(home, "fresh");
    appendJournal(root, { op: "intent", id: "wjournal00010" });
    const text = fs.readFileSync(journalPath(root), "utf8");
    expect(text).toMatch(/^epoch [0-9a-f]{32}\n\nintent wjournal00010\n$/);
    expect(fs.readdirSync(root)).toEqual([".journal"]);
  });

  it("skips malformed lines", () => {
    expect(
      parseJournal("epoch x\ncommit w1 2\nintent\ncommit w2 z\ndelete w3 4\nfoo w4\n"),
    ).toEqual({
      epoch: null,
      lines: [{ op: "commit", id: "w1", revision: 2 }],
    });
  });
});
