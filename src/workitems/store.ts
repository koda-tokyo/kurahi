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
import { emitWorkItemChange } from "./events.js";
import { appendJournal } from "./journal.js";
import {
  indexEntry,
  invalidateWorkItemIndex,
  workItemIndex,
  type IndexEntry,
} from "./list-index.js";
import { stageSummary } from "./routes.js";

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
    return item.projectId === projectId && item.id === id ? normalize(item) : null;
  } catch {
    return null;
  }
}

/** Items written before requester tracking and routes: fill the new fields. */
function normalize(item: WorkItem): WorkItem {
  item.requestedBy ??= item.createdBy;
  item.route ??= null;
  return item;
}

export function writeWorkItem(item: WorkItem, home?: string): void {
  const root = workItemsRoot(item.projectId, home);
  // Journal first: if the intent cannot be recorded, item.json is not touched.
  appendJournal(root, { op: "intent", id: item.id });
  writeAtomic(
    path.join(workItemDir(item.projectId, item.id, home), "item.json"),
    `${JSON.stringify(item, null, 2)}\n`,
  );
  // A failure here leaves the intent pending; readers re-read the item until a later commit.
  appendJournal(root, { op: "commit", id: item.id, revision: item.revision });
  // In-process listeners (the autopilot's workitems trigger); they only schedule work.
  emitWorkItemChange(item);
}

/**
 * Delete an item's files except `keep` (call under the item lock). Journaled like a write, so
 * list indexes drop the item without a rescan.
 */
export function removeWorkItemFiles(
  projectId: string,
  id: string,
  keep: ReadonlySet<string>,
  home?: string,
): void {
  const root = workItemsRoot(projectId, home);
  const dir = workItemDir(projectId, id, home);
  appendJournal(root, { op: "intent", id });
  for (const name of fs.readdirSync(dir)) {
    if (!keep.has(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
  appendJournal(root, { op: "delete", id });
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
  /** true: only items with an active flag; false: only items without. */
  flagged?: boolean;
  /** Case-insensitive substring of the title. */
  q?: string;
  /** Only items requested by this principal (the "mine" view). */
  requestedBy?: string;
  /** Only items awaiting review (necessary for awaitingMe, so the list index can apply it unread). */
  awaitingReview?: boolean;
  /** Id of the active route stage (items awaiting review in that stage; carried by the list index). */
  stage?: string;
  /** Only items this principal could possibly decide (a superset for awaitingMe; see `possibleDeciders`). */
  decider?: string;
  /** Only items this principal could read without a privileged role (a superset; see `possibleReaders`). */
  reader?: string;
  /** Extra predicate (viewer visibility, mine, awaitingMe), applied after the fields above. */
  where?: (item: WorkItem) => boolean;
  /** Department view (a pure queue predicate, so the list index can apply it before any read). */
  inDepartment?: (queueId: string) => boolean;
};

export function isOverdue(item: Pick<WorkItem, "dueAt" | "status">, now: Date): boolean {
  return (
    item.dueAt !== null &&
    item.status !== "done" &&
    item.status !== "cancelled" &&
    Date.parse(item.dueAt) < now.getTime()
  );
}

/** The filter fields the list index carries (a superset prefilter; `matches` re-checks them). */
function matchesIndexed(item: IndexEntry, f: WorkItemFilter, now: Date): boolean {
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
  if (f.flagged !== undefined && item.flagged !== f.flagged) {
    return false;
  }
  if (f.requestedBy !== undefined && item.requestedBy !== f.requestedBy) {
    return false;
  }
  if (f.awaitingReview && item.status !== "awaiting_review") {
    return false;
  }
  if (f.stage !== undefined && item.stage !== f.stage) {
    return false;
  }
  if (f.decider !== undefined && item.deciders !== null && !item.deciders.includes(f.decider)) {
    return false;
  }
  if (f.reader !== undefined && item.readers !== null && !item.readers.includes(f.reader)) {
    return false;
  }
  if (f.inDepartment && !f.inDepartment(item.queue)) {
    return false;
  }
  return !f.q || item.title.toLowerCase().includes(f.q.toLowerCase());
}

function matches(item: WorkItem, f: WorkItemFilter, now: Date): boolean {
  if (!matchesIndexed(indexEntry(item), f, now)) {
    return false;
  }
  return !f.where || f.where(item);
}

export function summarize(item: WorkItem, now: Date = new Date()): WorkItemSummary {
  // The recorded quotes stay on the item; list rows only carry the (small) selection.
  const { history: _history, source, procurement: _procurement, ...rest } = item;
  return {
    ...rest,
    source: {
      documents: source.documents.length,
      fields: Object.keys(source.fields),
      ...(source.origin ? { origin: source.origin } : {}),
    },
    overdue: isOverdue(item, now),
    currentStage: stageSummary(item, now),
  };
}

/** Order: newest first by createdAt, then id (stable, so the cursor never skips or repeats). */
function compare(
  a: Pick<WorkItem, "createdAt" | "id">,
  b: Pick<WorkItem, "createdAt" | "id">,
): number {
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

/** Every item of the Project (unordered). `prepare` may replace an item as it is read. */
/**
 * Every readable item in the Project. Tolerant by default: a store that cannot be listed reads as
 * empty and unreadable items are skipped. `strict` throws when the store exists but cannot be
 * listed (only a missing store is empty); `onUnreadable` hears each item id that failed to read.
 */
export function readAllWorkItems(
  projectId: string,
  opts: {
    home?: string;
    prepare?: (item: WorkItem) => WorkItem;
    strict?: boolean;
    onUnreadable?: (id: string) => void;
  } = {},
): WorkItem[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(workItemsRoot(projectId, opts.home)).filter((n) => ITEM_ID_RE.test(n));
  } catch (err) {
    if (opts.strict && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    names = [];
  }
  const out: WorkItem[] = [];
  for (const id of names) {
    const item = readWorkItem(projectId, id, opts.home);
    if (item) {
      out.push(opts.prepare ? opts.prepare(item) : item);
    } else {
      opts.onUnreadable?.(id);
    }
  }
  return out;
}

/**
 * The items that may match `filter`: through the list index when the store has a journal (only
 * items whose indexed fields match are read), otherwise every item. Callers still apply `matches`.
 */
function listIndex(projectId: string, home?: string): ReadonlyMap<string, IndexEntry> | null {
  const root = workItemsRoot(projectId, home);
  return workItemIndex(root, {
    listIds: () => {
      try {
        return fs.readdirSync(root).filter((n) => ITEM_ID_RE.test(n));
      } catch {
        return [];
      }
    },
    read: (id) => readWorkItem(projectId, id, home),
    stamp: (id) => {
      try {
        return fs.statSync(path.join(workItemDir(projectId, id, home), "item.json"));
      } catch {
        return null;
      }
    },
  });
}

function candidates(
  projectId: string,
  filter: WorkItemFilter,
  now: Date,
  opts: { home?: string; prepare?: (item: WorkItem) => WorkItem },
): WorkItem[] {
  const index = listIndex(projectId, opts.home);
  if (!index) {
    return readAllWorkItems(projectId, opts);
  }
  const ids = [...index].filter(([, e]) => matchesIndexed(e, filter, now)).map(([id]) => id);
  const out: WorkItem[] = [];
  for (const id of ids) {
    const item = readWorkItem(projectId, id, opts.home);
    if (item) {
      out.push(opts.prepare ? opts.prepare(item) : item);
    }
  }
  return out;
}

/**
 * The items whose stage timers may call for a mark at `now` (index `nextMarkAt <= now`) when the
 * store has a journal, otherwise every item. A superset; callers still check with `dueMarks`.
 */
export function readWorkItemsDueForMarks(
  projectId: string,
  now: Date,
  opts: { home?: string } = {},
): WorkItem[] {
  const index = listIndex(projectId, opts.home);
  if (!index) {
    return readAllWorkItems(projectId, opts);
  }
  const t = now.getTime();
  const out: WorkItem[] = [];
  for (const [id, e] of index) {
    if (e.nextMarkAt !== null && e.nextMarkAt <= t) {
      const item = readWorkItem(projectId, id, opts.home);
      if (item) {
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * The items of a queue or department slice (`queue`, `inDepartment`) that `reader` could possibly
 * read: through the list index when the store has a journal, otherwise every item. A superset;
 * callers still filter by queue and access.
 */
export function readWorkItemsInQueues(
  projectId: string,
  filter: Pick<WorkItemFilter, "queue" | "inDepartment" | "reader">,
  opts: { home?: string; prepare?: (item: WorkItem) => WorkItem } = {},
): WorkItem[] {
  return candidates(
    projectId,
    { queue: filter.queue, inDepartment: filter.inDepartment, reader: filter.reader },
    new Date(),
    opts,
  );
}

/** Entries are built by `indexEntry` alone, so key order and array order are stable. */
function sameEntry(a: IndexEntry, b: IndexEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyCounts(): Record<WorkItemStatus, number> {
  return Object.fromEntries(
    ["new", "drafting", "awaiting_review", "approved", "sent_back", "done", "cancelled"].map(
      (s) => [s, 0],
    ),
  ) as Record<WorkItemStatus, number>;
}

/**
 * A page decided by the list index alone (no `where`): matching, counts, order and cursor use
 * indexed fields, so only the page's items are read and prepared. `prepare` must not change an
 * indexed field (escalation only marks the stage). Null when the store has no journal, or when a
 * page item's indexed fields differ from its entry (a concurrent or out-of-band writer): counts,
 * order and cursor came from the entry, so the index is dropped and the caller rescans.
 */
function pageFromIndex(
  projectId: string,
  filter: WorkItemFilter,
  limit: number,
  after: { createdAt: string; id: string } | null,
  now: Date,
  opts: { home?: string; prepare?: (item: WorkItem) => WorkItem },
): WorkItemPage | null {
  const index = listIndex(projectId, opts.home);
  if (!index) {
    return null;
  }
  const counts = emptyCounts();
  const hits: { id: string; createdAt: string; entry: IndexEntry }[] = [];
  for (const [id, e] of index) {
    if (matchesIndexed(e, filter, now)) {
      hits.push({ id, createdAt: e.createdAt, entry: e });
      counts[e.status] += 1;
    }
  }
  hits.sort(compare);
  let start = 0;
  if (after) {
    start = hits.findIndex((it) => compare(after, it) < 0);
    if (start < 0) {
      start = hits.length;
    }
  }
  const items: WorkItem[] = [];
  for (const hit of hits.slice(start, start + limit)) {
    const item = readWorkItem(projectId, hit.id, opts.home);
    if (!item || !sameEntry(indexEntry(item), hit.entry)) {
      invalidateWorkItemIndex(workItemsRoot(projectId, opts.home));
      return null;
    }
    items.push(opts.prepare ? opts.prepare(item) : item);
  }
  const last = items.at(-1);
  return {
    items: items.map((it) => summarize(it, now)),
    nextCursor: last && start + limit < hits.length ? encodeCursor(last) : null,
    total: hits.length,
    counts,
  };
}

/**
 * One page of the items matching `filter`, with `total` and per-status `counts`.
 *
 * Staleness contract when the list index serves the call (no `where`; see list-index.ts):
 * - Writes through writeWorkItem are journaled, so the next call sees them.
 * - Every returned item is re-read from disk. An item whose indexed fields no longer match its
 *   entry discards the index and the call falls back to a full read.
 * - An out-of-band edit of item.json that would add an item to the page, or change `total` or
 *   `counts`, shows up only at the next directory check. That check runs during a list call once
 *   VERIFY_MS (60s) has passed since the last one. If the edit keeps its file stamp (a same-size
 *   edit on a filesystem whose clock is skewed from Date.now()), it waits for the sweep, which
 *   re-reads the least recently read items at each check, so that no call is served from an item
 *   read more than FULL_VERIFY_MS (1h) ago. Ages count wall-clock time forward only: setting the
 *   clock back does not delay checks.
 * Checks happen only when something lists, never in the background. A call after an idle gap
 * re-reads only the items last read over ~59 minutes ago: none after a gap under ~30 minutes of a
 * busy index, every item after a gap of ~1.5h or more.
 */
export function listWorkItems(
  projectId: string,
  filter: WorkItemFilter,
  page: { cursor?: string; limit?: number } = {},
  opts: { home?: string; now?: Date; prepare?: (item: WorkItem) => WorkItem } = {},
): WorkItemPage {
  const now = opts.now ?? new Date();
  const limit = Math.min(LIST_MAX, Math.max(1, page.limit ?? LIST_DEFAULT));
  const after = page.cursor ? decodeCursor(page.cursor) : null;
  if (!filter.where) {
    const paged = pageFromIndex(projectId, filter, limit, after, now, opts);
    if (paged) {
      return paged;
    }
  }
  const all: WorkItem[] = [];
  const counts = emptyCounts();
  for (const item of candidates(projectId, filter, now, opts)) {
    if (matches(item, filter, now)) {
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
