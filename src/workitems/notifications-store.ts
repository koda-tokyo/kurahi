// In-app work item notifications (contract Rule 3, phase 1): one file per principal,
// `<KOLO_HOME>/projects/<projectId>/notifications/<sha256(principal)>.json`, rewritten atomically
// under the folder's lock file. Records carry ids, a reason and the item revision only (no titles,
// no field values), like WorkItemChange. Whether a record may still be shown is the reader's
// check: the caller filters by current canRead, so a revoked principal sees nothing stale.
//
// Recording is idempotent per (item, revision, reason, child): replaying the same write adds
// nothing. Linked case records sit on the parent and name the child step that moved it. A case
// completes or blocks, and a step opens, once: those keys also go to `<sha256>.once.json`, which
// is never trimmed, so the inbox's retention cap cannot let the same notice be stored again.
// Channels (mail, Teams, LINE WORKS) are separate and not sent from here.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import type { NotificationReason, NotificationRecipient } from "./notify.js";
import type { WorkItem } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { projectDataDir } from "../projects/store.js";
import { WorkItemRefused } from "./errors.js";
import { linkedCaseProgressWith, linkedCasesWithChild } from "./links-store.js";
import { linkedCaseReason, notificationRecipients } from "./notify.js";
import { loadWorkQueuePolicy } from "./policy.js";
import { readWorkItem, withItemLock } from "./store.js";
import { TERMINAL_STATUSES } from "./types.js";

export type WorkItemNotification = {
  id: string;
  principal: string;
  itemId: string;
  reason: NotificationReason;
  revision: number;
  /** Linked case reasons: the child step whose status change caused the record. */
  childId?: string;
  /** linked_step_ready: the plan step that opened; one record per step of a case. */
  stepKey?: string;
  createdAt: string;
  readAt: string | null;
};

/** Records kept per principal; the oldest read ones go first, then the oldest unread. */
export const NOTIFICATIONS_KEPT = 500;

const NOTIFICATION_ID_RE = /^n[a-z0-9]{12}$/;

function newNotificationId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "n";
  for (const b of randomBytes(12)) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

function notificationsDir(projectId: string, home: string = resolveKoloHome()): string {
  return path.join(projectDataDir(projectId, home), "notifications");
}

function principalFile(dir: string, principal: string): string {
  return path.join(dir, `${createHash("sha256").update(principal).digest("hex")}.json`);
}

// Every reason, so a stored record with an unknown one is refused (Record keeps it exhaustive).
const REASONS: Record<NotificationReason, true> = {
  awaiting_you: true,
  delegated_to_you: true,
  escalated_to_you: true,
  delegation_withdrawn: true,
  decided: true,
  linked_step_ready: true,
  linked_case_complete: true,
  linked_case_blocked: true,
};

// A linked case completes or blocks at most once: children are never replaced or reopened.
const ONCE_PER_ITEM: ReadonlySet<NotificationReason> = new Set([
  "linked_case_complete",
  "linked_case_blocked",
]);

const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Every stored field, so a record that would silently drop out of an unread count is refused. */
function isRecord(r: unknown, principal: string): r is WorkItemNotification {
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    return false;
  }
  const v = r as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    NOTIFICATION_ID_RE.test(v.id) &&
    v.principal === principal &&
    typeof v.itemId === "string" &&
    v.itemId !== "" &&
    typeof v.reason === "string" &&
    Object.hasOwn(REASONS, v.reason) &&
    Number.isSafeInteger(v.revision) &&
    (v.revision as number) >= 0 &&
    (v.childId === undefined || (typeof v.childId === "string" && v.childId !== "")) &&
    (v.stepKey === undefined || (typeof v.stepKey === "string" && v.stepKey !== "")) &&
    isTime(v.createdAt) &&
    (v.readAt === null || isTime(v.readAt))
  );
}

/**
 * A missing file is an empty inbox; a file that does not parse, names another principal or holds
 * a record with a missing or malformed field throws.
 */
function readFile(file: string, principal: string): WorkItemNotification[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records) || !records.every((r) => isRecord(r, principal))) {
    throw new Error("notification file is corrupt");
  }
  return records;
}

/** Keys of once-only records ever stored for a principal; a missing file is none. */
function readOnceFile(file: string): Set<string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw err;
  }
  const keys: unknown = JSON.parse(raw);
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string" && k !== "")) {
    throw new Error("notification once file is corrupt");
  }
  return new Set(keys);
}

/** The once-only key of a record, or null when it may repeat (another revision, another child). */
function onceKey(itemId: string, reason: NotificationReason, stepKey?: string): string | null {
  if (ONCE_PER_ITEM.has(reason)) {
    return JSON.stringify([itemId, reason]);
  }
  return stepKey !== undefined ? JSON.stringify([itemId, reason, stepKey]) : null;
}

function writeFile(file: string, records: WorkItemNotification[] | string[]): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function trim(records: WorkItemNotification[]): WorkItemNotification[] {
  let over = records.length - NOTIFICATIONS_KEPT;
  if (over <= 0) {
    return records;
  }
  const drop = new Set<WorkItemNotification>();
  for (const pass of [true, false]) {
    for (const r of records) {
      if (over > 0 && (r.readAt !== null) === pass && !drop.has(r)) {
        drop.add(r);
        over--;
      }
    }
  }
  return records.filter((r) => !drop.has(r));
}

/** Store one record per recipient of the write that produced `after`; returns the new records. */
export function recordNotifications(
  after: Pick<WorkItem, "projectId" | "id" | "revision">,
  recipients: NotificationRecipient[],
  now: Date,
  home?: string,
  childId?: string,
  stepKey?: string,
): WorkItemNotification[] {
  if (recipients.length === 0) {
    return [];
  }
  const dir = notificationsDir(after.projectId, home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withItemLock(dir, () => {
    const added: WorkItemNotification[] = [];
    for (const { principal, reason } of recipients) {
      const file = principalFile(dir, principal);
      const records = readFile(file, principal);
      const once = onceKey(after.id, reason, stepKey);
      const onceFile = file.replace(/\.json$/, ".once.json");
      const sent = once === null ? null : readOnceFile(onceFile);
      // Under the lock, so two children finishing at once store a case-level reason, or the
      // step they both opened, once. A step opens once: children are never detached. The inbox
      // check still covers records stored before the once file existed.
      if (
        (once !== null && sent?.has(once)) ||
        records.some(
          (r) =>
            r.itemId === after.id &&
            r.reason === reason &&
            (ONCE_PER_ITEM.has(reason) ||
              (stepKey !== undefined
                ? r.stepKey === stepKey
                : r.revision === after.revision && r.childId === childId)),
        )
      ) {
        continue;
      }
      const rec: WorkItemNotification = {
        id: newNotificationId(),
        principal,
        itemId: after.id,
        reason,
        revision: after.revision,
        ...(childId ? { childId } : {}),
        ...(stepKey ? { stepKey } : {}),
        createdAt: now.toISOString(),
        readAt: null,
      };
      const kept = trim([...records, rec]);
      // A once-only record leaves the inbox only with its key in the once file: records stored
      // before the once file existed, or whose once write failed, would otherwise repeat.
      const dropped = new Set(
        records
          .filter((r) => !kept.includes(r))
          .map((r) => onceKey(r.itemId, r.reason, r.stepKey))
          .filter((k): k is string => k !== null),
      );
      const ledger = sent ?? (dropped.size > 0 ? readOnceFile(onceFile) : null);
      const missing = [...dropped].filter((k) => !ledger?.has(k));
      if (ledger && missing.length > 0) {
        writeFile(onceFile, [...ledger, ...missing]);
        missing.forEach((k) => ledger.add(k));
      }
      writeFile(file, kept);
      // After the inbox: a failure here leaves the record shown, deduped by the inbox until trimmed.
      if (once !== null && ledger && !ledger.has(once)) {
        writeFile(onceFile, [...ledger, once]);
      }
      added.push(rec);
    }
    return added;
  });
}

/**
 * The write boundary (applyTransition, after the item lock is released): diff the two revisions
 * against the project's policy and store the records. A failure here never fails the write that
 * already happened; it is audited as `workitem.notify` with outcome `error` instead, and one
 * recipient's failure does not skip the others.
 */
export function recordWriteNotifications(
  project: Pick<Project, "id" | "folder" | "templateId">,
  before: WorkItem | null,
  after: WorkItem,
  now: Date,
  home?: string,
): WorkItemNotification[] {
  const failed = (error: unknown, failedRecipients?: number) => {
    void auditSafe({
      identity: "system",
      scope: project.id,
      action: "workitem.notify",
      outcome: "error",
      source: "gateway.workitems",
      detail: { id: after.id, revision: after.revision, failedRecipients, error: String(error) },
    });
  };
  // One recipient's unreadable file does not cost the others their record, and a policy that
  // cannot be read does not cost a linked parent's requester theirs.
  const added: WorkItemNotification[] = [];
  let lastError: unknown = null;
  let failures = 0;
  let recipients: NotificationRecipient[] = [];
  try {
    recipients = notificationRecipients(before, after, loadWorkQueuePolicy(project, home), now);
  } catch (err) {
    lastError = err;
    failures++;
  }
  for (const r of recipients) {
    try {
      added.push(...recordNotifications(after, [r], now, home));
    } catch (err) {
      lastError = err;
      failures++;
    }
  }
  // A child is attached only once it exists, so a create never moves a linked case.
  if (before && before.status !== after.status && TERMINAL_STATUSES.has(after.status)) {
    try {
      added.push(...recordLinkedCaseNotifications(before, after, now, home));
    } catch (err) {
      lastError = err;
      failures++;
    }
  }
  if (failures > 0) {
    failed(lastError, failures);
  }
  return added;
}

/**
 * A child reaching done or cancelled: tell each linked parent's requester when that opened a
 * step, completed the case or blocked it. The record is on the parent (which the requester can
 * read) and names the child. Throws only after trying every parent.
 */
function recordLinkedCaseNotifications(
  before: WorkItem,
  after: WorkItem,
  now: Date,
  home?: string,
): WorkItemNotification[] {
  const actor = after.history.at(-1)?.by ?? after.createdBy;
  const added: WorkItemNotification[] = [];
  let firstError: unknown = null;
  const parents = linkedCasesWithChild(after.projectId, after.id, {
    home,
    onUnreadable: (_id, err) => {
      firstError ??= err;
    },
  });
  for (const rec of parents) {
    try {
      const parent = readWorkItem(after.projectId, rec.parentId, home);
      const key = Object.keys(rec.children).find((k) => rec.children[k] === after.id);
      // A closed parent has nothing left to open or complete.
      if (!parent || !key || TERMINAL_STATUSES.has(parent.status)) {
        continue;
      }
      const progress = (status: WorkItem["status"]) =>
        linkedCaseProgressWith(after.projectId, rec, { [key]: status }, home);
      const r = linkedCaseReason(parent, progress(before.status), progress(after.status), actor);
      if (r) {
        for (const stepKey of r.stepKeys ?? [undefined]) {
          added.push(...recordNotifications(parent, [r], now, home, after.id, stepKey));
        }
      }
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError) {
    throw firstError;
  }
  return added;
}

/** A principal's records, newest first. `visible` is the caller's current canRead per item. */
export function listNotifications(
  projectId: string,
  principal: string,
  opts: { unreadOnly?: boolean; visible?: (itemId: string) => boolean } = {},
  home?: string,
): WorkItemNotification[] {
  const records = readFile(principalFile(notificationsDir(projectId, home), principal), principal);
  return records
    .filter((r) => !opts.unreadOnly || r.readAt === null)
    .filter((r) => !opts.visible || opts.visible(r.itemId))
    .toReversed();
}

/** Mark one of the principal's own records read (an explicit action, not opening the item). */
export function markNotificationRead(
  projectId: string,
  principal: string,
  id: string,
  now: Date,
  home?: string,
): WorkItemNotification {
  const notFound = (): never => {
    throw new WorkItemRefused("notification_not_found", "no such notification");
  };
  if (!NOTIFICATION_ID_RE.test(id)) {
    return notFound();
  }
  const dir = notificationsDir(projectId, home);
  if (!fs.existsSync(dir)) {
    return notFound();
  }
  return withItemLock(dir, () => {
    const file = principalFile(dir, principal);
    const records = readFile(file, principal);
    const rec = records.find((r) => r.id === id);
    if (!rec) {
      return notFound();
    }
    if (rec.readAt === null) {
      rec.readAt = now.toISOString();
      writeFile(file, records);
    }
    return rec;
  });
}
