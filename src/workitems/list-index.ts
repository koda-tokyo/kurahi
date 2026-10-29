// In-memory list index over the change journal (scale index phase 1b; design:
// koda-autonomy/proposals/WORKITEMS_SCALE_INDEX_2026-10-26.md, v2).
//
// Per store root, each process keeps the filter fields of every item plus the journal position it
// has read. A list call replays only the new journal lines and re-reads only the items they name,
// then uses the index as a superset prefilter: callers still read and match the full item.
//
// A full rebuild runs when there is no state yet, or the journal's (dev, ino, epoch) changed or it
// got shorter. Every VERIFY_MS the index is also checked against the directory, to pick up
// out-of-band edits of item.json that bypassed writeWorkItem: items appear and disappear with the
// listing, and an item is re-read only when its file stamp (ino, size, mtime, ctime) changed. A
// stamp taken within RACY_MS of the file's last change is not trusted (a same-size edit in the same
// timestamp tick would keep it), so that item is re-read at the next check too. That guard assumes
// file times and Date.now() share a clock; with a skewed (e.g. network) filesystem a same-size edit
// can keep its stamp, so a sweep also re-reads items regardless of stamp, oldest re-read first: a
// slice at each check paced to cover every item within PASS_MS, plus any item that would otherwise
// go FULL_VERIFY_MS without a re-read. Paced checks keep every item well inside the deadline, so a
// call after an idle gap shorter than about FULL_VERIFY_MS - PASS_MS re-reads only its slice. Sources
// without `stamp` re-read every item at each check. With no journal at all, callers fall back to a
// full read.

import fs from "node:fs";
import type { WorkItem, WorkItemAssignee } from "./types.js";
import { journalPath, parseJournal, type JournalLine } from "./journal.js";

export const VERIFY_MS = 60_000;
export const FULL_VERIFY_MS = 60 * 60_000;
const MAX_ROOTS = 64;
const EPOCH_BYTES = 39; // "epoch " + 32 hex + "\n"
const RACY_MS = 2_000;
// Checks every VERIFY_MS re-read every item within PASS_MS; the deadline catches the rest. An item
// past DUE_MS is re-read at the next check, and checks are at most VERIFY_MS apart while calls
// arrive, so no call is served from a read older than FULL_VERIFY_MS.
const PASS_MS = FULL_VERIFY_MS / 2;
const DUE_MS = FULL_VERIFY_MS - VERIFY_MS;

// The clock for check and re-read ages advances by the larger of the wall and monotonic steps, so a
// wall clock set back while idle cannot hide the idle time (and the FULL_VERIFY_MS bound). A step
// back also counts as FULL_VERIFY_MS: the monotonic clock stops during suspend, so the real gap is
// unknown, and every item is re-read once. Forward steps only make checks come sooner. File-stamp
// settling (RACY_MS) stays on Date.now().
let lastWall = Date.now();
let lastMono = performance.now();
let elapsed = lastWall;
function elapsedNow(): number {
  const wall = Date.now();
  const mono = performance.now();
  const step = wall < lastWall ? FULL_VERIFY_MS : wall - lastWall;
  elapsed += Math.max(step, mono - lastMono);
  lastWall = wall;
  lastMono = mono;
  return elapsed;
}

/** The fields list filters can decide without the full item. */
export type IndexEntry = Pick<
  WorkItem,
  "queue" | "status" | "type" | "priority" | "dueAt" | "title" | "createdAt" | "requestedBy"
> & {
  assignee: WorkItemAssignee;
  flagged: boolean;
  /** Id of the active route stage while awaiting review (`stageSummary(item).id`), else null. */
  stage: string | null;
  /** Superset of who could decide the active stage (`possibleDeciders`); null when unbounded. */
  deciders: string[] | null;
  /** Superset of who `canRead` admits besides privileged principals (`possibleReaders`); null when unbounded. */
  readers: string[] | null;
  /** When the active stage's next overdue or escalation mark falls due (`nextMarkAt`), epoch ms; null when none is pending. */
  nextMarkAt: number | null;
};

export function indexEntry(item: WorkItem): IndexEntry {
  return {
    queue: item.queue,
    status: item.status,
    type: item.type,
    priority: item.priority,
    dueAt: item.dueAt,
    title: item.title,
    createdAt: item.createdAt,
    requestedBy: item.requestedBy,
    assignee: item.assignee ? { kind: item.assignee.kind, id: item.assignee.id } : null,
    flagged: (item.flags?.length ?? 0) > 0,
    stage: activeStageId(item),
    deciders: possibleDeciders(item),
    readers: possibleReaders(item),
    nextMarkAt: nextMarkAt(item),
  };
}

/**
 * The earliest time `dueMarks` turns true for the active stage: its dueAt while not yet marked
 * overdue, and activatedAt + escalation.afterHours while not yet escalated. Null when the item is
 * not awaiting review or no mark is pending. Unparsable times never fall due, as in `dueMarks`.
 */
export function nextMarkAt(item: Pick<WorkItem, "route" | "status">): number | null {
  const r = item.route;
  const stage =
    r && r.current !== null && item.status === "awaiting_review"
      ? (r.stages[r.current] ?? null)
      : null;
  if (!stage) {
    return null;
  }
  const times: number[] = [];
  if (stage.dueAt !== null && stage.overdueAt === null) {
    times.push(Date.parse(stage.dueAt));
  }
  // A malformed stage must not break listing: missing fields give NaN, which never falls due.
  if (stage.escalation !== null && stage.escalatedAt === null && stage.activatedAt !== null) {
    times.push(Date.parse(stage.activatedAt) + Number(stage.escalation?.afterHours) * 3_600_000);
  }
  // Infinite times come only from a malformed afterHours; match `dueMarks`, where -Infinity is
  // due at once (as 0, so the store's JSON entry comparison can tell it from null) and +Infinity
  // never.
  const due = times.filter((t) => t < Infinity).map((t) => (t === -Infinity ? 0 : t));
  return due.length > 0 ? Math.min(...due) : null;
}

/**
 * Everyone `canRead` could admit without a privileged role, as a superset: the requester, every
 * principal who acted or delegated in any stage, legacy approvers, and the possible deciders.
 * Null when the deciders are unbounded (roles, `any`, or a legacy review open to any approver).
 */
export function possibleReaders(
  item: Pick<WorkItem, "route" | "status" | "requestedBy" | "approvals">,
): string[] | null {
  const deciders = possibleDeciders(item);
  if (deciders === null) {
    return null;
  }
  const out = new Set<string>([item.requestedBy, ...deciders]);
  for (const s of item.route?.stages ?? []) {
    for (const a of s.approvals ?? []) {
      out.add(a.by);
      if (a.onBehalfOf) {
        out.add(a.onBehalfOf);
      }
    }
    for (const d of s.delegations ?? []) {
      out.add(d.to);
      out.add(d.from);
    }
  }
  for (const a of item.approvals ?? []) {
    out.add(a.by);
  }
  return [...out];
}

/**
 * Everyone `deciderVia` could name for the active stage, as a superset: stage principals, every
 * delegate (expired or not) and every escalation principal (escalated or not, since escalation
 * happens at read time). Null when roles or an open review decide, which depend on the policy.
 */
export function possibleDeciders(item: Pick<WorkItem, "route" | "status">): string[] | null {
  if (item.status !== "awaiting_review") {
    return [];
  }
  const r = item.route;
  const stage = r && r.current !== null ? (r.stages[r.current] ?? null) : null;
  if (!stage) {
    // Legacy items without a route are open to any approver; a route past its stages has none.
    return r ? [] : null;
  }
  const { approvers, escalation } = stage;
  // A malformed stage must not break listing: leave it unbounded and let the full match decide.
  if (
    !approvers ||
    approvers.any ||
    approvers.roles?.length !== 0 ||
    (escalation && escalation.to?.roles?.length !== 0)
  ) {
    return null;
  }
  return [
    ...new Set([
      ...(approvers.principals ?? []),
      ...(stage.delegations ?? []).map((d) => d.to),
      ...(escalation?.to.principals ?? []),
    ]),
  ];
}

/** The active stage id, as `stageSummary` reports it; it depends only on status and route. */
export function activeStageId(item: Pick<WorkItem, "route" | "status">): string | null {
  const r = item.route;
  if (!r || r.current === null || item.status !== "awaiting_review") {
    return null;
  }
  return r.stages[r.current]?.id ?? null;
}

type State = {
  dev: number;
  ino: number;
  epoch: string;
  offset: number;
  builtAt: number;
  /** When each item was last re-read, oldest first (an id moves to the end on every re-read). */
  readAt: Map<string, number>;
  /** Items the sweep has earned but not yet re-read (fractional carry between checks). */
  credit: number;
  entries: Map<string, IndexEntry>;
  /** File stamp of each entry when it was read; a missing stamp means re-read at the next check. */
  stamps: Map<string, string>;
  /** Ids with an intent and no commit/delete yet: re-read on every call. */
  pending: Set<string>;
};

export type IndexSource = {
  /** Every item id in the store (directory listing). */
  listIds: () => string[];
  /** One item, or null when missing/unreadable. */
  read: (id: string) => WorkItem | null;
  /** Stat of the item's file, taken before `read`; null when missing. */
  stamp?: (id: string) => fs.Stats | null;
};

const states = new Map<string, State>();

/** Forget the index of one root (or all): the next call rebuilds. Tests that write item.json directly use this. */
export function invalidateWorkItemIndex(root?: string): void {
  if (root === undefined) {
    states.clear();
  } else {
    states.delete(root);
  }
}

function stampOf(src: IndexSource, id: string): string | null {
  const st = src.stamp?.(id);
  if (!st || Date.now() - Math.max(st.mtimeMs, st.ctimeMs) < RACY_MS) {
    return null;
  }
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function refreshEntry(state: State, src: IndexSource, id: string): void {
  // Stamp before read: a change landing in between leaves an old stamp, so the next check re-reads.
  const stamp = stampOf(src, id);
  const item = src.read(id);
  state.readAt.delete(id);
  if (item) {
    state.entries.set(id, indexEntry(item));
    state.readAt.set(id, elapsedNow());
  } else {
    state.entries.delete(id);
  }
  if (item && stamp !== null) {
    state.stamps.set(id, stamp);
  } else {
    state.stamps.delete(id);
  }
}

function forget(state: State, id: string): void {
  state.entries.delete(id);
  state.stamps.delete(id);
  state.readAt.delete(id);
}

/**
 * The periodic check against the directory: re-read new items and items whose stamp changed, plus
 * the sweep: the least recently re-read items, whatever their stamp. Each check earns a slice that
 * covers every item within PASS_MS at one check per VERIFY_MS (idle time earns nothing), and every
 * item last re-read DUE_MS ago or more is re-read too, so a call after a long idle gap pays only
 * for the items that would otherwise go past FULL_VERIFY_MS.
 */
function verify(state: State, src: IndexSource): void {
  const now = elapsedNow();
  const listed = new Set(src.listIds());
  for (const id of state.entries.keys()) {
    if (!listed.has(id)) {
      forget(state, id);
    }
  }
  state.credit += (listed.size * VERIFY_MS) / PASS_MS;
  const sweep = new Set<string>();
  for (const [id, at] of state.readAt) {
    if (sweep.size >= Math.floor(state.credit) && now - at < DUE_MS) {
      break;
    }
    sweep.add(id);
  }
  state.credit = Math.max(0, state.credit - sweep.size);
  for (const id of listed) {
    const known = state.stamps.get(id);
    if (sweep.has(id) || known === undefined || stampOf(src, id) !== known) {
      refreshEntry(state, src, id);
    }
  }
  state.builtAt = now;
}

function apply(state: State, lines: JournalLine[], src: IndexSource): void {
  for (const line of lines) {
    if (line.op === "intent") {
      state.pending.add(line.id);
    } else if (line.op === "commit") {
      state.pending.delete(line.id);
      refreshEntry(state, src, line.id);
    } else {
      state.pending.delete(line.id);
      forget(state, line.id);
    }
  }
}

/** Bytes up to and including the last newline (a line still being appended waits for the next call). */
function completeLines(buf: Buffer): Buffer {
  const end = buf.lastIndexOf(0x0a);
  return end < 0 ? buf.subarray(0, 0) : buf.subarray(0, end + 1);
}

function readFrom(fd: number, offset: number, size: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, size - offset));
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, offset + got);
    if (n === 0) {
      break;
    }
    got += n;
  }
  return buf.subarray(0, got);
}

function rebuild(root: string, fd: number, st: fs.Stats, src: IndexSource): State | null {
  // Journal first, items second: a change that lands in between is replayed again next call.
  const text = completeLines(readFrom(fd, 0, st.size));
  const { epoch, lines } = parseJournal(text.toString("utf8"));
  if (!epoch) {
    return null;
  }
  const state: State = {
    dev: st.dev,
    ino: st.ino,
    epoch,
    offset: text.length,
    builtAt: elapsedNow(),
    readAt: new Map(),
    credit: 0,
    entries: new Map(),
    stamps: new Map(),
    pending: new Set(),
  };
  for (const id of src.listIds()) {
    refreshEntry(state, src, id);
  }
  // From history only the pending set matters (the directory read is the truth): an intent whose
  // commit or delete never came may still be renaming in, so keep re-reading it.
  for (const line of lines) {
    if (line.op === "intent") {
      state.pending.add(line.id);
    } else {
      state.pending.delete(line.id);
    }
  }
  return state;
}

/**
 * The current index of one store root, or null when the store has no journal (callers then read
 * every item). The returned map is live state: read it, never keep or modify it.
 */
export function workItemIndex(
  root: string,
  src: IndexSource,
): ReadonlyMap<string, IndexEntry> | null {
  let fd: number;
  try {
    fd = fs.openSync(journalPath(root), "r");
  } catch {
    states.delete(root);
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    let state = states.get(root) ?? null;
    if (
      state &&
      (state.dev !== st.dev ||
        state.ino !== st.ino ||
        st.size < state.offset ||
        readFrom(fd, 0, EPOCH_BYTES).toString("utf8") !== `epoch ${state.epoch}\n`)
    ) {
      state = null;
    }
    if (!state) {
      state = rebuild(root, fd, st, src);
      states.delete(root);
      if (!state) {
        return null;
      }
      if (states.size >= MAX_ROOTS) {
        states.delete(states.keys().next().value!);
      }
      states.set(root, state);
    } else {
      const chunk = completeLines(readFrom(fd, state.offset, st.size));
      state.offset += chunk.length;
      apply(state, parseJournal(chunk.toString("utf8")).lines, src);
      if (elapsedNow() - state.builtAt >= VERIFY_MS) {
        verify(state, src);
      }
    }
    for (const id of state.pending) {
      refreshEntry(state, src, id);
    }
    return state.entries;
  } finally {
    fs.closeSync(fd);
  }
}
