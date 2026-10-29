// Legal holds (訴訟ホールド): while a hold is active, the retention sweeper, data subject request
// deletions and user deletions (sessions.delete, `kurahi evidence prune`) skip every record the
// hold covers. Holds are created and released by people only (gateway handler), each with a
// written reason and a matter id; both are audited and sealed as evidence.
//
// Scope: every dimension that is set must match (AND); within a dimension any value matches (OR).
//   projectIds   records of these Projects
//   workItemIds  these work items (and their history, evidence, documents)
//   persons      records that name one of these identities (requester, approver, actor, sender)
//   custodians   records owned or created by one of these identities
//   from / to    records whose time range overlaps [from, to]
// A record that cannot be attributed (no Project, no time) is held by any hold whose set
// dimensions it cannot be proven to fall outside of: holds fail closed.
import fs from "node:fs";
import path from "node:path";
import type { GovernanceDataClass } from "../config/types.governance.js";
import { loadProjects } from "../projects/store.js";
import { isWorkItemId, workItemDir } from "../workitems/store.js";
import { GovernanceRefused } from "./policy.js";
import { governanceDir, newGovernanceId, readJsonFile, writeJsonAtomic } from "./store.js";

export type HoldScope = {
  projectIds?: string[];
  workItemIds?: string[];
  persons?: string[];
  custodians?: string[];
  from?: string | null;
  to?: string | null;
};

export type LegalHold = {
  id: string;
  matterId: string;
  reason: string;
  scope: HoldScope;
  status: "active" | "released";
  createdAt: string;
  createdBy: string;
  releasedAt?: string;
  releasedBy?: string;
  releaseReason?: string;
  /**
   * Projects of the held work items, resolved when the hold was created: a record of one of these
   * Projects that cannot be tied to a work item (an attachment, a transcript) is held too.
   */
  itemProjectIds?: string[];
};

/** What a record says about itself for hold matching. Unknown fields are left undefined. */
export type DataRef = {
  class: GovernanceDataClass;
  id: string;
  projectId?: string | null;
  workItemId?: string | null;
  /** Identities named in the record. */
  persons?: string[];
  /** Identities that own or created the record. */
  custodians?: string[];
  /** Time range of the record (ISO). `to` defaults to `from`. */
  from?: string | null;
  to?: string | null;
};

type HoldsFile = { version: 1; holds: LegalHold[] };

const MAX_LIST = 200;
const MAX_REASON = 2000;

function holdsFile(home: string): string {
  return path.join(governanceDir(home), "holds.json");
}

export function listHolds(home: string): LegalHold[] {
  return readJsonFile<HoldsFile>(holdsFile(home), { version: 1, holds: [] }).holds ?? [];
}

export function activeHolds(home: string): LegalHold[] {
  return listHolds(home).filter((h) => h.status === "active");
}

function cleanList(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 300)) {
    throw new GovernanceRefused("bad_scope", `${name} must be a list of identifiers`);
  }
  const out = [...new Set(v.map((x: string) => x.trim()))].slice(0, MAX_LIST);
  return out.length > 0 ? out : undefined;
}

function cleanDate(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === "") {
    return null;
  }
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw new GovernanceRefused("bad_scope", `${name} must be an ISO date`);
  }
  return new Date(Date.parse(v)).toISOString();
}

export function cleanHoldScope(raw: unknown): HoldScope {
  const s = (raw ?? {}) as Record<string, unknown>;
  const scope: HoldScope = {
    projectIds: cleanList(s.projectIds, "projectIds"),
    workItemIds: cleanList(s.workItemIds, "workItemIds"),
    persons: cleanList(s.persons, "persons"),
    custodians: cleanList(s.custodians, "custodians"),
    from: cleanDate(s.from, "from"),
    to: cleanDate(s.to, "to"),
  };
  if (scope.from && scope.to && scope.from > scope.to) {
    throw new GovernanceRefused("bad_scope", "from must not be after to");
  }
  const any =
    scope.projectIds || scope.workItemIds || scope.persons || scope.custodians || scope.from;
  if (!any && !scope.to) {
    throw new GovernanceRefused(
      "bad_scope",
      "a hold needs a scope: projectIds, workItemIds, persons, custodians or a date range",
    );
  }
  return scope;
}

function anyIn(list: string[] | undefined, values: string[] | undefined): boolean | null {
  if (!values) {
    return null; // unknown
  }
  return values.some((v) => list!.includes(v));
}

/** True when `hold` covers `ref`. Unknown attributes count as covered (fail closed). */
export function holdCovers(hold: LegalHold, ref: DataRef): boolean {
  const s = hold.scope;
  if (s.projectIds) {
    // null = known to belong to no Project; undefined = unknown (covered).
    if (ref.projectId === null || (ref.projectId && !s.projectIds.includes(ref.projectId))) {
      return false;
    }
  }
  if (s.workItemIds) {
    if (ref.workItemId && !s.workItemIds.includes(ref.workItemId)) {
      return false;
    }
    // A record known to belong to no work item (a transcript, an audit month) is outside.
    if (ref.workItemId === null) {
      return false;
    }
    // Unattributed records are held only within the held items' Projects.
    if (
      ref.workItemId === undefined &&
      hold.itemProjectIds &&
      ref.projectId !== undefined &&
      !(ref.projectId && hold.itemProjectIds.includes(ref.projectId))
    ) {
      return false;
    }
  }
  if (s.persons) {
    if (anyIn(s.persons, ref.persons) === false) {
      return false;
    }
  }
  if (s.custodians) {
    if (anyIn(s.custodians, ref.custodians) === false) {
      return false;
    }
  }
  if (s.from || s.to) {
    const from = ref.from ?? null;
    const to = ref.to ?? ref.from ?? null;
    if (from && to) {
      if (s.from && to < s.from) {
        return false;
      }
      if (s.to && from > s.to) {
        return false;
      }
    }
  }
  return true;
}

export function holdsCovering(holds: LegalHold[], ref: DataRef): LegalHold[] {
  return holds.filter((h) => h.status === "active" && holdCovers(h, ref));
}

/**
 * For user-initiated deletions (sessions.delete, `kurahi evidence prune`): the active holds that
 * keep `ref`, or [] when it may be deleted. Never throws; an unreadable holds file keeps nothing
 * back only when it does not exist.
 */
export function holdsBlockingDeletion(home: string, ref: DataRef): LegalHold[] {
  return holdsCovering(activeHolds(home), ref);
}

function projectsOfItems(home: string, itemIds: string[]): string[] {
  const out: string[] = [];
  for (const p of loadProjects(home)) {
    if (itemIds.some((id) => isWorkItemId(id) && fs.existsSync(workItemDir(p.id, id, home)))) {
      out.push(p.id);
    }
  }
  return out;
}

export function createHold(
  home: string,
  input: { matterId: unknown; reason: unknown; scope: unknown },
  by: string,
  now: Date = new Date(),
): LegalHold {
  const matterId = typeof input.matterId === "string" ? input.matterId.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!matterId || matterId.length > 120) {
    throw new GovernanceRefused("matter_required", "a matter id (1-120 characters) is required");
  }
  if (reason.length < 2 || reason.length > MAX_REASON) {
    throw new GovernanceRefused("reason_required", "a written reason is required");
  }
  const scope = cleanHoldScope(input.scope);
  const hold: LegalHold = {
    id: newGovernanceId("hold"),
    matterId,
    reason,
    scope,
    status: "active",
    createdAt: now.toISOString(),
    createdBy: by,
    ...(scope.workItemIds ? { itemProjectIds: projectsOfItems(home, scope.workItemIds) } : {}),
  };
  const file = { version: 1 as const, holds: [...listHolds(home), hold] };
  writeJsonAtomic(holdsFile(home), file);
  return hold;
}

export function releaseHold(
  home: string,
  id: unknown,
  reason: unknown,
  by: string,
  now: Date = new Date(),
): LegalHold {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 2 || why.length > MAX_REASON) {
    throw new GovernanceRefused("reason_required", "a written reason is required");
  }
  const holds = listHolds(home);
  const hold = holds.find((h) => h.id === id);
  if (!hold) {
    throw new GovernanceRefused("hold_not_found", "hold not found");
  }
  if (hold.status !== "active") {
    throw new GovernanceRefused("hold_released", "hold is already released");
  }
  hold.status = "released";
  hold.releasedAt = now.toISOString();
  hold.releasedBy = by;
  hold.releaseReason = why;
  writeJsonAtomic(holdsFile(home), { version: 1, holds });
  return hold;
}
