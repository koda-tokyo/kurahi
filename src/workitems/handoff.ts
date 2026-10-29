// Hand-off lifecycle: one record per intended downstream action of an approved case (for example
// "enter this approved invoice as a freee 会計 deal"). This is a hand-off lifecycle, not a payment
// lifecycle: an accounting record existing never establishes that an invoice was paid.
//
// Pure state machine. Each transition checks the evidence its target state requires, refuses with
// a stable code otherwise, and appends a history entry hash-chained to the previous one. Storage,
// signed evidence bundles and connectors are wired on top of this in later slices.
// Contract: koda-autonomy/proposals/KURAHI_HANDOFF_RECONCILIATION_CONTRACT_2026-10-25.md

import { createHash } from "node:crypto";
import type { Actor } from "./types.js";
import { WorkItemRefused } from "./errors.js";

export const HANDOFF_STATES = [
  "approved",
  "awaiting_external_entry",
  "submitted",
  "confirmed",
  "reconciled",
  "closed",
  // exceptions
  "rejected",
  "partial",
  "unknown",
  "retry_pending",
  "mismatch",
  "reopened",
] as const;
export type HandOffState = (typeof HANDOFF_STATES)[number];

/** Which objective a closure achieved. Hand-off completion says nothing about payment. */
export type HandOffObjective = "handoff_completed" | "payment_settled";

export const CLOSURE_TEXT: Record<HandOffObjective, { en: string; ja: string }> = {
  handoff_completed: {
    en: "Hand-off completed — payment not verified",
    ja: "受け渡し完了・支払いは未確認",
  },
  // A named person attests settlement; nothing here checks the bank evidence, so never say "verified".
  payment_settled: {
    en: "Payment settled — attested by a person, bank evidence not checked by the system",
    ja: "支払い完了・担当者の申告（銀行証跡はシステム未確認）",
  },
};

/** Settlement under `settlementSod: "warn"` when the attester also held another duty on the case. */
export const SELF_ATTESTED_SETTLEMENT_TEXT = {
  en: "Payment settled — self-attested by a person who also handled this case, bank evidence not checked by the system",
  ja: "支払い完了・本件の担当者による自己申告（銀行証跡はシステム未確認）",
};

/**
 * Separation of duties for settlement (SoD-1). "strict" (default) refuses an attester who was the
 * requester, approver or a resolver, and refuses when the requester is unknown. "warn" is an
 * explicit organisation choice for small offices: the closure is allowed but says self-attested.
 */
export type SettlementSod = "strict" | "warn";

/** Facts the caller looked up outside the record; never taken from the client's event. */
export type HandOffContext = {
  settlementSod?: SettlementSod;
  /** The case requester, used only when the hand-off predates `requestedBy`. */
  caseRequestedBy?: string | null;
};

/** Exact destination product, e.g. "freee 会計 / deals" — never just a vendor name. */
export type HandOffDestination = { product: string; object: string; writable: boolean };

export type HandOffDiff = {
  field: string;
  approved: unknown;
  submitted: unknown;
  destination: unknown;
  resolution?: { by: string; reason: string; kind: "resolved" | "accepted" };
};

export type HandOffEntry = {
  at: string;
  by: string;
  actorKind: Actor["kind"];
  event: HandOffEvent["type"] | "approve";
  from: HandOffState | null;
  to: HandOffState;
  detail: Record<string, unknown>;
  /** Hash of every record field except history, right after this entry; binds them to the chain. */
  snapshot: string;
  prev: string | null;
  hash: string;
};

export type HandOffRecord = {
  id: string;
  caseId: string;
  /** The case revision the person approved; any later material change invalidates it. */
  caseRevision: number;
  action: string;
  destination: HandOffDestination;
  state: HandOffState;
  correlationId: string;
  attempts: { at: string; payloadVersion: number; payloadSha256: string }[];
  externalId: string | null;
  externalStatus: string | null;
  /** The last destination lookup after an uncertain outcome; retry needs a "not_found". */
  lookup: { at: string; result: "found" | "not_found" } | null;
  diffs: HandOffDiff[];
  objective: HandOffObjective | null;
  /** The case requester when the hand-off was opened; absent on records written before this. */
  requestedBy?: string | null;
  history: HandOffEntry[];
};

export type HandOffEvent =
  | { type: "await_entry" }
  | { type: "submit"; payloadVersion: number; payloadSha256: string }
  | { type: "confirm"; externalId: string; externalStatus: string }
  | { type: "reject"; reason: string; notCreated: boolean }
  | { type: "partial"; externalId: string; missing: string[] }
  | { type: "timeout" }
  | { type: "lookup"; found: { externalId: string; externalStatus: string } | null }
  | { type: "retry"; reason: string }
  | { type: "reconcile"; diffs: HandOffDiff[] }
  | { type: "resolve"; field: string; kind: "resolved" | "accepted"; reason: string }
  | { type: "reopen"; reason: string }
  | { type: "reapprove"; caseRevision: number }
  | { type: "close"; objective: HandOffObjective; settlementRef?: string };

const EXCEPTIONS = new Set<HandOffState>([
  "rejected",
  "partial",
  "unknown",
  "retry_pending",
  "mismatch",
  "reopened",
]);

export function isException(state: HandOffState): boolean {
  return EXCEPTIONS.has(state);
}

function refuse(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new WorkItemRefused(code, message, details);
}

function needText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    refuse("handoff_evidence_missing", `${field} is required`, { field });
  }
  return value.trim();
}

function needPerson(actor: Actor, what: string): void {
  if (actor.kind !== "person") {
    refuse("handoff_person_required", `only a person can ${what}`, { actorKind: actor.kind });
  }
}

function entryHash(entry: Omit<HandOffEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** JSON with object keys sorted, so a snapshot hash survives a store's key reordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .toSorted()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hashes the fields as they will be persisted (a Date becomes its ISO string, as on disk). */
function snapshotHash(rec: HandOffRecord): string {
  const { history: _history, ...fields } = rec;
  return createHash("sha256")
    .update(canonical(JSON.parse(JSON.stringify(fields))))
    .digest("hex");
}

/** A copy in the form JSON storage will give back, so the returned record matches a re-read. */
function jsonClone(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function append(
  rec: HandOffRecord,
  actor: Actor,
  event: HandOffEntry["event"],
  to: HandOffState,
  detail: Record<string, unknown>,
  now: Date,
): HandOffRecord {
  const from = rec.history.length ? rec.state : null;
  rec.state = to;
  const base: Omit<HandOffEntry, "hash"> = {
    at: now.toISOString(),
    by: actor.id,
    actorKind: actor.kind,
    event,
    from,
    to,
    detail,
    snapshot: snapshotHash(rec),
    prev: rec.history.at(-1)?.hash ?? null,
  };
  rec.history.push({ ...base, hash: entryHash(base) });
  return rec;
}

/**
 * Recompute the hash chain; false when any entry was edited, dropped or reordered, or when a
 * record field (destination, revision, attempts, diffs…) no longer matches the last entry's
 * snapshot. Unkeyed: this catches accidental or naive edits, not someone who rewrites the chain.
 */
export function verifyHandOffHistory(rec: HandOffRecord): boolean {
  let prev: string | null = null;
  for (const entry of rec.history) {
    const { hash, ...base } = entry;
    if (base.prev !== prev || entryHash(base) !== hash) {
      return false;
    }
    prev = hash;
  }
  const last = rec.history.at(-1);
  return last !== undefined && last.to === rec.state && last.snapshot === snapshotHash(rec);
}

export type NewHandOff = {
  id: string;
  caseId: string;
  caseRevision: number;
  action: string;
  destination: HandOffDestination;
  correlationId: string;
  requestedBy?: string;
};

/** A person approved one specific case version for one specific downstream action. */
export function approveHandOff(input: NewHandOff, approver: Actor, now: Date): HandOffRecord {
  needPerson(approver, "approve a hand-off");
  if (!Number.isInteger(input.caseRevision) || input.caseRevision < 1) {
    refuse("handoff_evidence_missing", "caseRevision is required", { field: "caseRevision" });
  }
  const rec: HandOffRecord = {
    id: needText(input.id, "id"),
    caseId: needText(input.caseId, "caseId"),
    caseRevision: input.caseRevision,
    action: needText(input.action, "action"),
    destination: {
      product: needText(input.destination?.product, "destination.product"),
      object: needText(input.destination?.object, "destination.object"),
      writable: input.destination?.writable,
    },
    state: "approved",
    correlationId: needText(input.correlationId, "correlationId"),
    attempts: [],
    externalId: null,
    externalStatus: null,
    lookup: null,
    diffs: [],
    objective: null,
    requestedBy: input.requestedBy?.trim() || null,
    history: [],
  };
  return append(
    rec,
    approver,
    "approve",
    "approved",
    {
      caseRevision: rec.caseRevision,
      action: rec.action,
    },
    now,
  );
}

/** Allowed source states per event. Anything else is refused as handoff_bad_transition. */
const FROM: Record<HandOffEvent["type"], readonly HandOffState[]> = {
  await_entry: ["approved"],
  submit: ["approved", "retry_pending"],
  confirm: ["submitted", "awaiting_external_entry", "partial"],
  reject: ["submitted"],
  partial: ["submitted"],
  timeout: ["submitted"],
  // From rejected only when the rejection did not prove nothing was created.
  lookup: ["unknown", "reopened", "rejected"],
  // Not after a partial: part of the record exists, so a resubmission could duplicate it.
  retry: ["rejected", "unknown"],
  reconcile: ["confirmed"],
  resolve: ["mismatch"],
  reopen: [
    "rejected",
    "partial",
    "mismatch",
    "unknown",
    "retry_pending",
    "confirmed",
    "reconciled",
  ],
  reapprove: ["reopened"],
  close: ["reconciled"],
};

/** Apply one event. Returns a new record; the input is not modified. */
export function transitionHandOff(
  current: HandOffRecord,
  event: HandOffEvent,
  actor: Actor,
  now: Date,
  ctx: HandOffContext = {},
): HandOffRecord {
  if (!FROM[event.type]?.includes(current.state)) {
    refuse("handoff_bad_transition", `cannot ${event.type} a hand-off that is ${current.state}`, {
      state: current.state,
      event: event.type,
    });
  }
  const rec: HandOffRecord = structuredClone(current);
  switch (event.type) {
    case "await_entry":
      if (rec.destination.writable) {
        refuse("handoff_bad_transition", "a writable destination is submitted, not awaited");
      }
      return append(rec, actor, event.type, "awaiting_external_entry", {}, now);

    case "submit": {
      if (!rec.destination.writable) {
        refuse("handoff_not_writable", "this destination is read-only: a person enters it", {
          destination: rec.destination.product,
        });
      }
      // An earlier attempt with no known outcome may already exist in the destination.
      const uncertain =
        rec.attempts.length > 0 && rec.externalId === null && !lastExceptionWasRefusal(rec);
      if (uncertain && rec.lookup?.result !== "not_found") {
        refuse("handoff_lookup_required", "query the destination before resubmitting");
      }
      if (!Number.isInteger(event.payloadVersion) || event.payloadVersion < 1) {
        refuse("handoff_evidence_missing", "payloadVersion is required", {
          field: "payloadVersion",
        });
      }
      if (!/^[0-9a-f]{64}$/.test(event.payloadSha256 ?? "")) {
        refuse("handoff_evidence_missing", "payloadSha256 is required", { field: "payloadSha256" });
      }
      rec.attempts.push({
        at: now.toISOString(),
        payloadVersion: event.payloadVersion,
        payloadSha256: event.payloadSha256,
      });
      rec.lookup = null;
      return append(
        rec,
        actor,
        event.type,
        "submitted",
        {
          destination: rec.destination.product,
          correlationId: rec.correlationId,
          attempt: rec.attempts.length,
          payloadVersion: event.payloadVersion,
          payloadSha256: event.payloadSha256,
        },
        now,
      );
    }

    case "confirm":
      if (rec.state !== "submitted") {
        // Entered by hand (read-only destination) or completed by hand after a partial.
        needPerson(actor, "confirm an entry made outside Kurahi");
      }
      rec.externalId = needText(event.externalId, "externalId");
      rec.externalStatus = needText(event.externalStatus, "externalStatus");
      return append(
        rec,
        actor,
        event.type,
        "confirmed",
        {
          externalId: rec.externalId,
          externalStatus: rec.externalStatus,
        },
        now,
      );

    case "reject":
      return append(
        rec,
        actor,
        event.type,
        "rejected",
        {
          reason: needText(event.reason, "reason"),
          notCreated: event.notCreated,
        },
        now,
      );

    case "partial":
      rec.externalId = needText(event.externalId, "externalId");
      return append(
        rec,
        actor,
        event.type,
        "partial",
        {
          externalId: rec.externalId,
          missing: event.missing,
        },
        now,
      );

    case "timeout":
      return append(rec, actor, event.type, "unknown", {}, now);

    case "lookup":
      // Never blindly resubmit after a timeout: the destination may already hold the record.
      if (rec.state === "rejected" && lastExceptionWasRefusal(rec)) {
        refuse("handoff_bad_transition", "the destination confirmed it created nothing");
      }
      rec.lookup = { at: now.toISOString(), result: event.found ? "found" : "not_found" };
      if (rec.state === "reopened") {
        // Reopened while an attempt was in flight: record what the destination holds, stay put.
        if (event.found) {
          rec.externalId = needText(event.found.externalId, "externalId");
          rec.externalStatus = needText(event.found.externalStatus, "externalStatus");
        }
        return append(
          rec,
          actor,
          event.type,
          "reopened",
          {
            found: Boolean(event.found),
            ...(event.found ? { externalId: rec.externalId } : {}),
          },
          now,
        );
      }
      if (event.found) {
        rec.externalId = needText(event.found.externalId, "externalId");
        rec.externalStatus = needText(event.found.externalStatus, "externalStatus");
        return append(
          rec,
          actor,
          event.type,
          "confirmed",
          {
            found: true,
            externalId: rec.externalId,
            externalStatus: rec.externalStatus,
          },
          now,
        );
      }
      return append(rec, actor, event.type, "unknown", { found: false }, now);

    case "retry":
      // A person decides to retry. After a timeout only once a lookup found nothing.
      needPerson(actor, "decide to retry a hand-off");
      if (
        (rec.state === "unknown" || !lastExceptionWasRefusal(rec)) &&
        rec.lookup?.result !== "not_found"
      ) {
        // A rejection that does not say nothing was created is as uncertain as a timeout.
        refuse("handoff_lookup_required", "query the destination before retrying");
      }
      return append(
        rec,
        actor,
        event.type,
        "retry_pending",
        {
          reason: needText(event.reason, "reason"),
        },
        now,
      );

    case "reconcile": {
      // Every difference arrives open: only a person's resolve event can resolve or accept one.
      rec.diffs = (event.diffs ?? []).map((d) => ({
        field: d.field,
        approved: jsonClone(d.approved),
        submitted: jsonClone(d.submitted),
        destination: jsonClone(d.destination),
      }));
      return append(
        rec,
        actor,
        event.type,
        rec.diffs.length ? "mismatch" : "reconciled",
        {
          compared: true,
          differences: rec.diffs.map((d) => d.field),
        },
        now,
      );
    }

    case "resolve": {
      needPerson(actor, "resolve or accept a reconciliation difference");
      const diff = rec.diffs.find((d) => d.field === event.field && !d.resolution);
      if (!diff) {
        refuse("handoff_unknown_difference", `no open difference on ${event.field}`, {
          field: event.field,
        });
      }
      diff.resolution = {
        by: actor.id,
        reason: needText(event.reason, "reason"),
        kind: event.kind,
      };
      const left = rec.diffs.some((d) => !d.resolution);
      return append(
        rec,
        actor,
        event.type,
        left ? "mismatch" : "reconciled",
        {
          field: event.field,
          kind: event.kind,
        },
        now,
      );
    }

    case "reopen":
      return append(
        rec,
        actor,
        event.type,
        "reopened",
        {
          reason: needText(event.reason, "reason"),
        },
        now,
      );

    case "reapprove":
      needPerson(actor, "approve a corrected case for hand-off");
      if (!Number.isInteger(event.caseRevision) || event.caseRevision <= rec.caseRevision) {
        refuse("handoff_stale_revision", "re-approval needs the corrected, newer case revision", {
          approved: rec.caseRevision,
          given: event.caseRevision,
        });
      }
      rec.caseRevision = event.caseRevision;
      rec.diffs = [];
      // Keep the lookup and externalId: a correction updates the existing destination record, never a duplicate.
      return append(rec, actor, event.type, "approved", { caseRevision: rec.caseRevision }, now);

    case "close":
      if (rec.diffs.some((d) => !d.resolution)) {
        refuse("handoff_open_exceptions", "close needs every difference resolved or accepted");
      }
      if (event.objective === "payment_settled") {
        // Nothing here can look up bank evidence, so settlement is a named person's attestation, never an agent's.
        needPerson(actor, "attest that payment settled");
      }
      if (event.objective === "payment_settled" && !event.settlementRef?.trim()) {
        refuse("handoff_evidence_missing", "payment settled needs the settlement evidence", {
          field: "settlementRef",
        });
      }
      if (event.objective !== "payment_settled" && event.objective !== "handoff_completed") {
        refuse("handoff_evidence_missing", "objective is required", { field: "objective" });
      }
      if (event.objective === "handoff_completed") {
        rec.objective = event.objective;
        return append(
          rec,
          actor,
          event.type,
          "closed",
          { objective: event.objective, text: CLOSURE_TEXT.handoff_completed },
          now,
        );
      }
      const mode: SettlementSod = ctx.settlementSod === "warn" ? "warn" : "strict";
      // A missing requester is unknown, not independent: null never counts as "no overlap".
      const requester = rec.requestedBy?.trim() || ctx.caseRequestedBy?.trim() || null;
      const overlap = sodOverlap(rec, requester, actor);
      if (mode === "strict" && requester === null) {
        refuse(
          "handoff_requester_unknown",
          "the case requester is not known, so independent settlement cannot be shown",
        );
      }
      if (mode === "strict" && overlap.length > 0) {
        refuse("handoff_sod_conflict", "the settlement attester must not have handled this case", {
          roles: overlap,
        });
      }
      const self = overlap.length > 0;
      rec.objective = event.objective;
      return append(
        rec,
        actor,
        event.type,
        "closed",
        {
          objective: event.objective,
          text: self ? SELF_ATTESTED_SETTLEMENT_TEXT : CLOSURE_TEXT.payment_settled,
          settlementRef: event.settlementRef?.trim(),
          attestedBy: actor.id,
          settlementSod: mode,
          sodOverlap: overlap,
          selfAttested: self,
          ...(requester === null ? { requesterUnknown: true } : {}),
        },
        now,
      );
  }
  return refuse("handoff_bad_transition", "unknown event");
}

/** Which other duties on this hand-off the settlement attester also performed. */
function sodOverlap(
  rec: HandOffRecord,
  requester: string | null,
  attester: Actor,
): ("requester" | "approver" | "resolver")[] {
  const roles: ("requester" | "approver" | "resolver")[] = [];
  if (requester !== null && requester === attester.id) {
    roles.push("requester");
  }
  if (
    rec.history.some(
      (e) => (e.event === "approve" || e.event === "reapprove") && e.by === attester.id,
    )
  ) {
    roles.push("approver");
  }
  // History, not current diffs: re-approval clears diffs, but an earlier resolver still handled the case.
  if (rec.history.some((e) => e.event === "resolve" && e.by === attester.id)) {
    roles.push("resolver");
  }
  return roles;
}

/** The last attempt was refused by the destination and it stated it created nothing. */
function lastExceptionWasRefusal(rec: HandOffRecord): boolean {
  const last = rec.history.findLast(
    (e) => e.event === "reject" || e.event === "timeout" || e.event === "submit",
  );
  return last?.event === "reject" && last.detail.notCreated === true;
}

/**
 * A material case change after approval invalidates the approval: an open hand-off is reopened.
 * A closed hand-off is left as history; the caller opens a new one for the corrected case.
 */
export function invalidateOnCaseChange(
  rec: HandOffRecord,
  caseRevision: number,
  actor: Actor,
  now: Date,
): HandOffRecord {
  if (caseRevision <= rec.caseRevision || rec.state === "closed" || rec.state === "reopened") {
    return rec;
  }
  const next = structuredClone(rec);
  return append(
    next,
    actor,
    "reopen",
    "reopened",
    {
      reason: "case changed after approval",
      caseRevision,
    },
    now,
  );
}

/** Field-by-field comparison: approved source ↔ submitted representation ↔ destination read-back. */
export function compareHandOff(
  fields: readonly string[],
  approved: Record<string, unknown>,
  submitted: Record<string, unknown>,
  destination: Record<string, unknown>,
): HandOffDiff[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return fields
    .filter((f) => !same(approved[f], submitted[f]) || !same(approved[f], destination[f]))
    .map((f) => ({
      field: f,
      approved: approved[f],
      submitted: submitted[f],
      destination: destination[f],
    }));
}

/** What "Reconciled" compares for an invoice hand-off (payment details are out of scope here). */
export const INVOICE_RECONCILE_FIELDS = [
  "legalEntity",
  "supplierId",
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "currency",
  "netAmount",
  "taxByCategory",
  "grossAmount",
  "taxCategories",
  "account",
  "department",
  "costCentre",
  "project",
  "attachments",
  "destinationStatus",
] as const;
