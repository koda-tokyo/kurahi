// The autopilot's only door into the work queue, as the agent `autopilot:<routineId>`:
//   - an item that came from an email (the plan item's ref is a message the routine read with a
//     mail connector) goes through EMAIL INTAKE (src/workitems/intake.ts): a reference to the
//     message (connector + message id + bounded headers), idempotent per message in the Project,
//     risk flags on the item itself, cleared only by a person (workitems.clearFlag);
//   - anything else is created through the queue's public lifecycle API (createWorkItem).
// Both paths put the engine's blocking flags on the item (`flags`/`flagReason`), so the queue's
// fraud block (fraud_flag_uncleared: no approval, no completion until a person clears it)
// applies to autopilot escalations exactly as to an agent's intake. Run and routine attribution
// stay in source.fields.

import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import type { WorkItem, WorkItemFlag } from "../workitems/types.js";
import type { PlanItem, Routine } from "./types.js";
import { fileSha256 } from "../workitems/documents.js";
import { findByEmailOrigin, intakeEmail, SUMMARY_MAX } from "../workitems/intake.js";
import { createWorkItem } from "../workitems/lifecycle.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { recordPurchaseOrderDraft, type DraftQuoteSource } from "../workitems/procurement.js";
import { readAllWorkItems, readWorkItem } from "../workitems/store.js";
import {
  DEPARTMENT_IDS,
  WORK_ITEM_FLAGS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type EmailConnector,
} from "../workitems/types.js";
import { departmentOf } from "./types.js";

/** Where an email-origin plan item came from (from the routine's gather, never the model). */
export type EmailOriginRef = {
  connector: EmailConnector;
  messageId: string;
  from?: string;
  subject?: string;
  receivedAt?: string;
};

export type WorkItemRequest = {
  project: Project;
  routine: Routine;
  runId: string;
  item: PlanItem;
  /** intake: prepared for a person; escalation: waits for a person's decision; proposal: dates. */
  kind: "intake" | "escalation" | "proposal";
  title?: string;
  type?: string;
  priority?: string;
  note?: string;
  /** Business: department whose `<department>-work` queue takes the item (when it exists). */
  department?: string;
  /** Why a person must act (escalations); null for a plain intake. */
  awaitingPerson: string | null;
  /** Actions the autopilot did not execute, as `kind: reason` lines. */
  pending: string[];
  /** `never` actions the model proposed for the item (a person decides them). */
  never?: string[];
  /** Set when the item is a message the routine read: then it goes through email intake. */
  origin?: EmailOriginRef;
  /** Extra scalar fields (proposal slots …). */
  fields?: Record<string, string | number | boolean | null>;
  /** Project-relative files the item's actions wrote (設計書, Office documents). */
  documents?: string[];
};

/**
 * The item's summary: the plan item's own summary, else the intake note (models often put the
 * substance in workitem.intake's note and leave the summary empty), never empty when either
 * has text. Bounded and in the engine's own words (no connector boundary marker).
 */
export function itemSummary(req: Pick<WorkItemRequest, "item" | "note">): string {
  const text = req.item.summary.trim() || req.note?.trim() || "";
  return (
    ownWords(text)
      .replace(/\r\n?/g, "\n")
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
      .slice(0, SUMMARY_MAX)
      .trim()
  );
}

export type WorkItemSink = {
  create(req: WorkItemRequest): { id: string; created?: boolean };
  /**
   * The item this routine already filed for the message, if any (idempotency across runs: the
   * engine then does not act on the message again). Optional for test sinks.
   */
  handled?(project: Project, routine: Routine, origin: EmailOriginRef): { id: string } | null;
  /** A case of this Project by id (po.prepare reads its recorded selection). */
  get?(project: Project, id: string): WorkItem | null;
  /** Mark the purchase order po.prepare drafted on the case, so later runs skip it. */
  recordPurchaseOrder?(
    project: Project,
    routine: Routine,
    id: string,
    draft: {
      document: string | null;
      comparisonDigest: string;
      supplier: string;
      selectionRevision: number;
      source: DraftQuoteSource | null;
      runId: string;
    },
  ): void;
};

export function autopilotActorId(routineId: string): string {
  return `autopilot:${routineId}`;
}

export function isAutopilotActor(id: string): boolean {
  return id.startsWith("autopilot:");
}

/** `never` actions whose mere proposal means suspected fraud (changed bank details, BEC). */
const FRAUD_NEVER_ACTIONS = new Set(["bank.change"]);
const WORK_FLAGS = new Set<string>(WORK_ITEM_FLAGS);
/** The connector's untrusted-content boundary (intake refuses text that carries it). */
const MARKER_RE = /<<<\s*(?:END_)?EXTERNAL_UNTRUSTED_CONTENT\s*>>>/gi;

const ownWords = (v: string) => v.replace(MARKER_RE, "[…]");

/**
 * The item's risk flags as work-item flags: the engine's blocking flags that the queue knows,
 * plus suspected_fraud when the model proposed a fraud-shaped `never` action.
 */
export function intakeFlagsOf(req: Pick<WorkItemRequest, "item" | "never" | "awaitingPerson">): {
  flags: WorkItemFlag[];
  reason: string | undefined;
  /** Engine flags the queue has no flag for (kept as the autopilotFlags field). */
  other: string[];
} {
  const flags = new Set<WorkItemFlag>(
    req.item.flags.filter((f): f is WorkItemFlag => WORK_FLAGS.has(f)),
  );
  const reasons: string[] = [];
  const fraudNever = (req.never ?? []).filter((a) => FRAUD_NEVER_ACTIONS.has(a));
  if (fraudNever.length > 0 && !flags.has("suspected_fraud")) {
    flags.add("suspected_fraud");
    reasons.push(`proposed ${fraudNever.join(", ")}`);
  }
  if (flags.size > 0 && req.awaitingPerson) {
    reasons.unshift(req.awaitingPerson);
  }
  const ordered = WORK_ITEM_FLAGS.filter((f) => flags.has(f));
  return {
    flags: ordered,
    reason: ordered.length ? ownWords(reasons.join("; ")).slice(0, 500) || undefined : undefined,
    other: req.item.flags.filter((f) => !WORK_FLAGS.has(f)),
  };
}

function resolveQueue(req: WorkItemRequest, home?: string): string | undefined {
  const queues = loadWorkQueuePolicy(req.project, home).queues;
  const dept = req.department;
  if (
    dept &&
    req.routine.edition === "business" &&
    (DEPARTMENT_IDS as readonly string[]).includes(dept) &&
    queues.some((q) => q.id === `${dept}-work`)
  ) {
    return `${dept}-work`;
  }
  // No queue named: the Project's first queue (the work queue requires one when it has many).
  return req.routine.queue ?? queues[0]?.id;
}

export function defaultWorkItemSink(opts: { home?: string } = {}): WorkItemSink {
  return {
    create(req) {
      const { routine, item } = req;
      const type =
        req.type && (WORK_ITEM_TYPES as readonly string[]).includes(req.type)
          ? req.type
          : undefined;
      const wanted = req.priority ?? item.priority;
      const priority = (WORK_ITEM_PRIORITIES as readonly string[]).includes(wanted)
        ? wanted
        : "normal";
      const dept = departmentOf(routine);
      const queue = resolveQueue(req, opts.home);
      const risk = intakeFlagsOf(req);
      const title = ownWords(req.title ?? item.title).slice(0, 200);
      const actor = { id: autopilotActorId(routine.id), kind: "agent" as const };
      const fields: Record<string, string | number | boolean | null> = {
        autopilotRoutine: routine.id,
        autopilotRun: req.runId,
        autopilotKind: req.kind,
        autopilotRef: item.ref.slice(0, 200),
        autopilotEdition: routine.edition,
        autopilotArea: routine.area,
        // Not `department`: routes read that field to pick approvers.
        ...(dept ? { autopilotDepartment: dept } : {}),
        ...(item.category ? { category: item.category } : {}),
        // Flags the queue has no flag for (unverified_citation, informational flags).
        ...(risk.other.length ? { autopilotFlags: risk.other.join(",") } : {}),
        ...(req.awaitingPerson ? { awaitingPerson: req.awaitingPerson.slice(0, 500) } : {}),
        ...(req.pending.length ? { pendingActions: req.pending.join("\n").slice(0, 4000) } : {}),
        ...(req.note ? { note: req.note.slice(0, 4000) } : {}),
        ...(req.documents?.length
          ? { autopilotDocuments: req.documents.join("\n").slice(0, 4000) }
          : {}),
        ...req.fields,
      };
      const summary = itemSummary(req);
      // Files under the Project folder (cleanDocuments checks each exists there). A reference
      // that is not there (any more) is left out rather than failing the intake.
      // Each is pinned by its SHA-256 now, so approval can refuse bytes changed after intake.
      const documents = (req.documents ?? [])
        .filter((ref) => fs.existsSync(path.join(req.project.folder, ref)))
        .map((ref) => {
          const sha = fileSha256(path.join(req.project.folder, ref));
          return { kind: "file" as const, ref, ...(sha ? { sha256: sha } : {}) };
        });
      if (req.origin) {
        const { item: filed, created } = intakeEmail(
          req.project,
          {
            ...(queue ? { queue } : {}),
            ...(type ? { type } : {}),
            title,
            priority,
            summary: summary || title,
            source: { kind: "email", ...req.origin },
            ...(risk.flags.length ? { flags: risk.flags, flagReason: risk.reason } : {}),
          },
          actor,
          { home: opts.home },
          { fields, ...(documents.length ? { documents } : {}) },
        );
        return { id: filed.id, created };
      }
      const created = createWorkItem(
        req.project,
        {
          ...(queue ? { queue } : {}),
          ...(type ? { type } : {}),
          title,
          priority,
          source: {
            documents,
            fields: { summary, ...fields },
          },
        },
        actor,
        { home: opts.home },
        // The summary on the item itself (what the queue and the console show); it used to
        // reach only source.fields, so autopilot items looked empty.
        {
          ...(summary ? { summary } : {}),
          ...(risk.flags.length ? { flags: risk.flags, flagReason: risk.reason } : {}),
        },
      );
      return { id: created.id, created: true };
    },
    // Any item about this message counts, whoever filed it (this routine, another routine, a
    // person or an earlier tool): someone already carries it, and acting again would draft a
    // second reply on every run.
    handled(project, _routine, origin) {
      const existing: WorkItem | null = findByEmailOrigin(project.id, origin, opts.home);
      return existing ? { id: existing.id } : null;
    },
    get(project, id) {
      return readWorkItem(project.id, id, opts.home);
    },
    recordPurchaseOrder(project, routine, id, draft) {
      const actor = { id: autopilotActorId(routine.id), kind: "agent" as const };
      recordPurchaseOrderDraft(project, id, draft, actor, { home: opts.home });
    },
  };
}

/** History actions by a person that count as correcting an autopilot-prepared item. */
const CORRECTIONS = new Set(["update", "decide.send_back", "decide.cancel"]);

/**
 * Per routine: work items the autopilot created, and how many a person edited, sent back or
 * cancelled (the learning signal). Derived from the items' own history, so it counts real
 * events only. `since` limits to items created at or after that time.
 */
export function autopilotCorrections(
  projectId: string,
  opts: { home?: string; since?: Date; until?: Date } = {},
): Map<string, { items: number; corrected: number }> {
  const out = new Map<string, { items: number; corrected: number }>();
  for (const item of readAllWorkItems(projectId, { home: opts.home })) {
    if (!isAutopilotActor(item.createdBy)) {
      continue;
    }
    const at = Date.parse(item.createdAt);
    if ((opts.since && at < opts.since.getTime()) || (opts.until && at > opts.until.getTime())) {
      continue;
    }
    const routineId = item.createdBy.slice("autopilot:".length);
    const row = out.get(routineId) ?? { items: 0, corrected: 0 };
    row.items++;
    if (item.history.some((h) => h.actorKind === "person" && CORRECTIONS.has(h.action))) {
      row.corrected++;
    }
    out.set(routineId, row);
  }
  return out;
}
