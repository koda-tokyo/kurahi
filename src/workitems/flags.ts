// Risk flags on work items (suspected fraud, phishing, prompt injection, unverified sender).
// Agents may raise flags when they take an item in; ONLY a person clears one, with a written
// reason, through workitems.clearFlag (attach + operator.approvals, person-only like decide).
// While `suspected_fraud` or `malicious_attachment` is set the item cannot be approved or
// completed. Clearing lives in clear-flag.ts.

import type { WorkItem, WorkItemFlag } from "./types.js";
import { WorkItemRefused } from "./errors.js";
import { WORK_ITEM_FLAGS } from "./types.js";

export const FLAG_REASON_MAX = 500;

export function isWorkItemFlag(v: unknown): v is WorkItemFlag {
  return typeof v === "string" && (WORK_ITEM_FLAGS as readonly string[]).includes(v);
}

/** Distinct known flags, in catalogue order. */
export function cleanFlags(raw: unknown): WorkItemFlag[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("flags must be an array");
  }
  for (const f of raw) {
    if (!isWorkItemFlag(f)) {
      throw new Error(`flags: each flag must be one of ${WORK_ITEM_FLAGS.join(", ")}`);
    }
  }
  return WORK_ITEM_FLAGS.filter((f) => raw.includes(f));
}

export function cleanFlagReason(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error("flagReason must be a string");
  }
  // oxlint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (v.length > FLAG_REASON_MAX) {
    throw new Error(`flagReason is longer than ${FLAG_REASON_MAX} characters`);
  }
  return v || undefined;
}

/** Flags that block approve and done until a person clears them. */
const BLOCKING_FLAGS: readonly WorkItemFlag[] = ["suspected_fraud", "malicious_attachment"];

export function hasFraudFlag(item: Pick<WorkItem, "flags">): boolean {
  return item.flags?.some((f) => BLOCKING_FLAGS.includes(f)) ?? false;
}

/** Refuse `action` (approve, done) while a person has not cleared a blocking flag. */
export function assertNoFraudFlag(item: Pick<WorkItem, "flags">, action: string): void {
  if (hasFraudFlag(item)) {
    const set = (item.flags ?? []).filter((f) => BLOCKING_FLAGS.includes(f)).join(", ");
    throw new WorkItemRefused(
      "fraud_flag_uncleared",
      `this item is flagged ${set}; a person must clear the flag with workitems.clearFlag before it can be ${action}`,
      { flags: item.flags ?? [] },
    );
  }
}
