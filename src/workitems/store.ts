// Work item persistence: one folder per item under the project's data area,
// `<KOLO_HOME>/projects/<projectId>/workitems/<itemId>/item.json`, written atomically
// (tmp + rename). Every read-modify-write runs under a per-item lock file taken with O_EXCL, so
// two gateways or a gateway and the CLI never interleave; within one process the writes are
// synchronous and therefore already serialized. `revision` gives callers optimistic concurrency.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
  WorkItemSummary,
  WorkItemType,
} from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { projectDataDir } from "../projects/store.js";

const ITEM_ID_RE = /^w[a-z0-9]{12}$/;
const LOCK_FILE = ".lock";
const LOCK_STALE_MS = 30_000;
const LOCK_DEADLINE_MS = 5_000;
export const LIST_MAX = 200;
export const LIST_DEFAULT = 50;

export function isWorkItemId(id: unknown): id is string {
  return typeof id === "string" && ITEM_ID_RE.test(id);
}

export function newWorkItemId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "w";
  for (const b of randomBytes(12)) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

export function workItemsRoot(projectId: string, home: string = resolveKoloHome()): string {
  return path.join(projectDataDir(projectId, home), "workitems");
}

export function workItemDir(projectId: string, id: string, home?: string): string {
  if (!isWorkItemId(id)) {
    throw new Error("invalid work item id");
  }
  return path.join(workItemsRoot(projectId, home), id);
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/** Run `fn` holding the item's lock file (cross-process). Stale locks (>30 s) are broken. */
export function withItemLock<T>(dir: string, fn: () => T): T {
  const lock = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  let fd: number | null = null;
  for (let attempt = 0; fd === null; attempt++) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("work item not found", { cause: err });
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("work item is busy; try again", { cause: err });
      }
      sleepSync(Math.min(50, 5 * (attempt + 1)));
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

export function readWorkItem(projectId: string, id: string, home?: string): WorkItem | null {
  if (!isWorkItemId(id)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(path.join(workItemDir(projectId, id, home), "item.json"), "utf8");
    const item = JSON.parse(raw) as WorkItem;
    return item.projectId === projectId && item.id === id ? item : null;
  } catch {
    return null;
  }
}

export function writeWorkItem(item: WorkItem, home?: string): void {
  writeAtomic(
    path.join(workItemDir(item.projectId, item.id, home), "item.json"),
    `${JSON.stringify(item, null, 2)}\n`,
  );
}

/** Insert a new item (its folder must not exist yet). */
export function insertWorkItem(item: WorkItem, home?: string): void {
  const dir = workItemDir(item.projectId, item.id, home);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { mode: 0o700 });
  writeWorkItem(item, home);
}

/**
 * Read-modify-write one item under its lock. `mutate` returns the next item (or throws);
 * the revision is checked against `expectedRevision` and bumped.
 */
export function mutateWorkItem(
  projectId: string,
  id: string,
  expectedRevision: number | undefined,
  mutate: (cur: WorkItem) => WorkItem,
  home?: string,
): WorkItem {
  const dir = workItemDir(projectId, id, home);
  if (!fs.existsSync(path.join(dir, "item.json"))) {
    throw new Error("work item not found");
  }
  return withItemLock(dir, () => {
    const cur = readWorkItem(projectId, id, home);
    if (!cur) {
      throw new Error("work item not found");
    }
    if (expectedRevision !== undefined && expectedRevision !== cur.revision) {
      throw new Error(
        `work item changed (revision ${cur.revision}, expected ${expectedRevision}); reload it`,
      );
    }
    const next = mutate(structuredClone(cur));
    next.revision = cur.revision + 1;
    writeWorkItem(next, home);
    return next;
  });
}

export type WorkItemFilter = {
  queue?: string;
  status?: WorkItemStatus[];
  type?: WorkItemType[];
  priority?: WorkItemPriority[];
  assigneeKind?: "agent" | "person" | "none";
  assigneeId?: string;
  overdue?: boolean;
  /** Case-insensitive substring of the title. */
  q?: string;
};

export function isOverdue(item: Pick<WorkItem, "dueAt" | "status">, now: Date): boolean {
  return (
    item.dueAt !== null &&
    item.status !== "done" &&
    item.status !== "cancelled" &&
    Date.parse(item.dueAt) < now.getTime()
  );
}

function matches(item: WorkItem, f: WorkItemFilter, now: Date): boolean {
  if (f.queue && item.queue !== f.queue) {
    return false;
  }
  if (f.status?.length && !f.status.includes(item.status)) {
    return false;
  }
  if (f.type?.length && !f.type.includes(item.type)) {
    return false;
  }
  if (f.priority?.length && !f.priority.includes(item.priority)) {
    return false;
  }
  if (f.assigneeKind === "none" && item.assignee) {
    return false;
  }
  if (f.assigneeKind && f.assigneeKind !== "none" && item.assignee?.kind !== f.assigneeKind) {
    return false;
  }
  if (f.assigneeId && item.assignee?.id !== f.assigneeId) {
    return false;
  }
  if (f.overdue !== undefined && isOverdue(item, now) !== f.overdue) {
    return false;
  }
  if (f.q && !item.title.toLowerCase().includes(f.q.toLowerCase())) {
    return false;
  }
  return true;
}

export function summarize(item: WorkItem, now: Date = new Date()): WorkItemSummary {
  const { history: _history, source, ...rest } = item;
  return {
    ...rest,
    source: { documents: source.documents.length, fields: Object.keys(source.fields) },
    overdue: isOverdue(item, now),
  };
}

/** Order: newest first by createdAt, then id (stable, so the cursor never skips or repeats). */
function compare(a: WorkItem, b: WorkItem): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function encodeCursor(item: Pick<WorkItem, "createdAt" | "id">): string {
  return Buffer.from(`${item.createdAt}|${item.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!createdAt || !isWorkItemId(id) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("invalid cursor");
  }
  return { createdAt, id };
}

export type WorkItemPage = {
  items: WorkItemSummary[];
  nextCursor: string | null;
  /** Items matching the filter across all pages. */
  total: number;
  counts: Record<WorkItemStatus, number>;
};

export function listWorkItems(
  projectId: string,
  filter: WorkItemFilter,
  page: { cursor?: string; limit?: number } = {},
  opts: { home?: string; now?: Date } = {},
): WorkItemPage {
  const now = opts.now ?? new Date();
  const limit = Math.min(LIST_MAX, Math.max(1, page.limit ?? LIST_DEFAULT));
  const after = page.cursor ? decodeCursor(page.cursor) : null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(workItemsRoot(projectId, opts.home)).filter((n) => ITEM_ID_RE.test(n));
  } catch {
    names = [];
  }
  const all: WorkItem[] = [];
  const counts = Object.fromEntries(
    ["new", "drafting", "awaiting_review", "approved", "sent_back", "done", "cancelled"].map(
      (s) => [s, 0],
    ),
  ) as Record<WorkItemStatus, number>;
  for (const id of names) {
    const item = readWorkItem(projectId, id, opts.home);
    if (item && matches(item, filter, now)) {
      all.push(item);
      counts[item.status] += 1;
    }
  }
  all.sort(compare);
  let start = 0;
  if (after) {
    const pivot = { createdAt: after.createdAt, id: after.id } as WorkItem;
    start = all.findIndex((it) => compare(pivot, it) < 0);
    if (start < 0) {
      start = all.length;
    }
  }
  const slice = all.slice(start, start + limit);
  const last = slice.at(-1);
  return {
    items: slice.map((it) => summarize(it, now)),
    nextCursor: last && start + limit < all.length ? encodeCursor(last) : null,
    total: all.length,
    counts,
  };
}
