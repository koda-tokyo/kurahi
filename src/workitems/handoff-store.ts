// Hand-off persistence: one file per hand-off next to its case,
// `<item dir>/handoffs/<handOffId>.json`, written atomically under the case's own lock file, so a
// hand-off transition and a case edit never interleave. Every read re-verifies the hash chain and
// refuses a record that was edited on disk.
//
// The case revision is the approval binding: the hand-off is opened at the approved case's
// current revision, and any later write to the case (revision bump) reopens it on the next
// transition. That is deliberately conservative — a re-approval is cheaper than handing off a
// case nobody approved in that form.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HandOffDestination, HandOffEvent, HandOffRecord, SettlementSod } from "./handoff.js";
import type { Actor } from "./types.js";
import { WorkItemRefused } from "./errors.js";
import {
  approveHandOff,
  invalidateOnCaseChange,
  transitionHandOff,
  verifyHandOffHistory,
} from "./handoff.js";
import { readWorkItem, withItemLock, workItemDir } from "./store.js";

const HANDOFF_ID_RE = /^h[a-z0-9]{12}$/;

export function isHandOffId(id: unknown): id is string {
  return typeof id === "string" && HANDOFF_ID_RE.test(id);
}

function newHandOffId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "h";
  for (const b of randomBytes(12)) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new WorkItemRefused(code, message, details);
}

function handOffFile(projectId: string, itemId: string, id: string, home?: string): string {
  if (!isHandOffId(id)) {
    refuse("handoff_not_found", "invalid hand-off id");
  }
  return path.join(workItemDir(projectId, itemId, home), "handoffs", `${id}.json`);
}

function writeAtomic(file: string, rec: HandOffRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Only a missing file is "not found". A file that exists but does not parse, belongs to another
 * case or id, or fails the hash chain refuses: hiding it would also hide it from the duplicate
 * check in openHandOff.
 */
function readFile(file: string, itemId: string): HandOffRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const handOffId = path.basename(file, ".json");
  const tampered = (): never =>
    refuse("handoff_tampered", "the hand-off history does not verify; it was changed on disk", {
      handOffId,
    });
  let rec: HandOffRecord;
  try {
    rec = JSON.parse(raw) as HandOffRecord;
  } catch {
    return tampered();
  }
  if (
    !rec ||
    typeof rec !== "object" ||
    !Array.isArray(rec.history) ||
    rec.caseId !== itemId ||
    rec.id !== handOffId ||
    !verifyHandOffHistory(rec)
  ) {
    return tampered();
  }
  return rec;
}

export function readHandOff(
  projectId: string,
  itemId: string,
  id: string,
  home?: string,
): HandOffRecord | null {
  return readFile(handOffFile(projectId, itemId, id, home), itemId);
}

/** Every hand-off of one case, oldest first. A tampered record refuses the whole list. */
export function listHandOffs(projectId: string, itemId: string, home?: string): HandOffRecord[] {
  const dir = path.join(workItemDir(projectId, itemId, home), "handoffs");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => isHandOffId(n.replace(/\.json$/, "")));
  } catch {
    return [];
  }
  return names
    .map((n) => readFile(path.join(dir, n), itemId))
    .filter((r): r is HandOffRecord => r !== null)
    .toSorted((a, b) => a.history[0].at.localeCompare(b.history[0].at));
}

/**
 * A person opens a hand-off for an approved case. One open hand-off per action and destination:
 * a second one for the same target could create the downstream record twice.
 */
export function openHandOff(
  projectId: string,
  itemId: string,
  input: { action: string; destination: HandOffDestination },
  approver: Actor,
  now: Date,
  home?: string,
): HandOffRecord {
  const dir = workItemDir(projectId, itemId, home);
  if (!fs.existsSync(path.join(dir, "item.json"))) {
    refuse("handoff_case_not_found", "work item not found");
  }
  return withItemLock(dir, () => {
    const item = readWorkItem(projectId, itemId, home);
    if (!item) {
      refuse("handoff_case_not_found", "work item not found");
    }
    if (item.status !== "approved") {
      refuse("handoff_case_not_approved", "only an approved case can be handed off", {
        status: item.status,
      });
    }
    const same = (r: HandOffRecord) =>
      r.action === input.action?.trim() &&
      r.destination.product === input.destination?.product?.trim() &&
      r.destination.object === input.destination?.object?.trim();
    const open = listHandOffs(projectId, itemId, home).find((r) => r.state !== "closed" && same(r));
    if (open) {
      refuse("handoff_duplicate", "this case already has an open hand-off for that action", {
        handOffId: open.id,
      });
    }
    const id = newHandOffId();
    const rec = approveHandOff(
      {
        id,
        caseId: itemId,
        caseRevision: item.revision,
        action: input.action,
        destination: input.destination,
        // Stable per hand-off and case revision; a destination that supports idempotency keys gets this.
        correlationId: `kurahi-${itemId}-${id}-r${item.revision}`,
        requestedBy: item.requestedBy,
      },
      approver,
      now,
    );
    writeAtomic(handOffFile(projectId, itemId, id, home), rec);
    return rec;
  });
}

/**
 * Apply one event under the case lock. A case written since approval reopens the hand-off first
 * (persisted even when the event is then refused). Re-approval binds to the case's current
 * revision; the caller cannot choose it.
 */
export function applyHandOffEvent(
  projectId: string,
  itemId: string,
  id: string,
  event: HandOffEvent,
  actor: Actor,
  now: Date,
  home?: string,
  opts: { settlementSod?: SettlementSod } = {},
): HandOffRecord {
  const dir = workItemDir(projectId, itemId, home);
  const file = handOffFile(projectId, itemId, id, home);
  if (!fs.existsSync(file)) {
    refuse("handoff_not_found", "hand-off not found");
  }
  return withItemLock(dir, () => {
    const item = readWorkItem(projectId, itemId, home);
    const cur = readFile(file, itemId);
    if (!item || !cur) {
      refuse("handoff_not_found", "hand-off not found");
    }
    const rec = invalidateOnCaseChange(cur, item.revision, actor, now);
    if (rec !== cur) {
      writeAtomic(file, rec);
    }
    if (event.type === "reapprove" && item.status !== "approved") {
      refuse("handoff_case_not_approved", "the corrected case must be approved again first", {
        status: item.status,
      });
    }
    const next = transitionHandOff(
      rec,
      event.type === "reapprove" ? { type: "reapprove", caseRevision: item.revision } : event,
      actor,
      now,
      // The requester lookup covers hand-offs opened before requestedBy was recorded.
      { settlementSod: opts.settlementSod, caseRequestedBy: item.requestedBy },
    );
    writeAtomic(file, next);
    return next;
  });
}
