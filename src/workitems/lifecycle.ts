// Work item lifecycle: create, update (non-decision fields), submit for review, mark done.
// Agent drafting lives in drafting.ts and person-only decisions in decide.ts. Every transition
// goes through `applyTransition`: under the item lock it writes a signed evidence bundle, appends
// a history entry naming that bundle, bumps the revision, and then appends an audit entry.

import type { Project } from "../projects/types.js";
import type { Actor, WorkItem, WorkItemStatus, WorkItemType } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { getArtifact } from "../projects/artifacts.js";
import { writeTransitionEvidence } from "./evidence.js";
import {
  cleanDocuments,
  cleanDueAt,
  cleanEnum,
  cleanFields,
  cleanPersonAssignee,
  cleanTitle,
  resolveQueue,
} from "./inputs.js";
import { evaluatePolicy, loadWorkQueuePolicy } from "./policy.js";
import { insertWorkItem, mutateWorkItem, newWorkItemId } from "./store.js";
import {
  TERMINAL_STATUSES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
} from "./types.js";

export type LifecycleOpts = { home?: string; now?: Date; env?: NodeJS.ProcessEnv };

// ---- transitions ----

export type TransitionSpec = {
  action: string;
  actor: Actor;
  to?: WorkItemStatus;
  comment?: string | null;
  detail?: Record<string, unknown>;
};

/** Apply one change under the lock with evidence, history and audit. */
export function applyTransition(
  project: Pick<Project, "id">,
  id: string,
  expectedRevision: number | undefined,
  build: (cur: WorkItem, now: Date) => { next: WorkItem; spec: TransitionSpec },
  opts: LifecycleOpts = {},
): WorkItem {
  const now = opts.now ?? new Date();
  let audit: { spec: TransitionSpec; from: WorkItemStatus; evidence: unknown } | null = null;
  const item = mutateWorkItem(
    project.id,
    id,
    expectedRevision,
    (cur) => {
      const { next, spec } = build(cur, now);
      const from = cur.status;
      next.status = spec.to ?? cur.status;
      const evidence = writeTransitionEvidence(
        next,
        {
          action: spec.action,
          actor: spec.actor,
          from,
          to: next.status,
          data: { comment: spec.comment ?? null, revision: cur.revision + 1, ...spec.detail },
          now,
        },
        opts,
      );
      next.history.push({
        at: now.toISOString(),
        by: spec.actor.id,
        actorKind: spec.actor.kind,
        action: spec.action,
        ...(next.status !== from ? { from, to: next.status } : {}),
        ...(spec.comment ? { comment: spec.comment } : {}),
        ...(spec.detail ? { detail: spec.detail } : {}),
        evidence,
      });
      next.updatedAt = now.toISOString();
      audit = { spec, from, evidence };
      return next;
    },
    opts.home,
  );
  const a = audit as { spec: TransitionSpec; from: WorkItemStatus; evidence: unknown } | null;
  if (a) {
    void auditSafe({
      identity: a.spec.actor.id,
      scope: project.id,
      action: `workitem.${a.spec.action}`,
      outcome: "ok",
      source: "gateway.workitems",
      detail: { id, from: a.from, to: item.status, evidence: a.evidence, ...a.spec.detail },
    });
  }
  return item;
}

/** Run the project's policy against the item (and its pinned draft) and store the results. */
export function recheck(project: Project, item: WorkItem, now: Date, home: string): WorkItem {
  const policy = loadWorkQueuePolicy(project, home);
  let draft: { text: string; version: number } | null = null;
  if (item.draft) {
    const got = getArtifact(item.draft.artifactId, item.draft.version, { home });
    draft = { text: got.content, version: got.version };
  }
  const { checks, requiredApprovals } = evaluatePolicy(policy, item, draft, now);
  item.checks = checks;
  item.requiredApprovals = requiredApprovals;
  return item;
}

export function checkSummary(item: WorkItem) {
  return {
    pass: item.checks.filter((c) => c.result === "pass").length,
    warn: item.checks.filter((c) => c.result === "warn").length,
    fail: item.checks.filter((c) => c.result === "fail").length,
    requiredApprovals: item.requiredApprovals,
  };
}

export type CreateInput = {
  queue?: unknown;
  type?: unknown;
  title?: unknown;
  source?: { documents?: unknown; fields?: unknown };
  priority?: unknown;
  dueAt?: unknown;
  slaHours?: unknown;
  assignee?: unknown;
};

export function createWorkItem(
  project: Project,
  input: CreateInput,
  actor: Actor,
  opts: LifecycleOpts = {},
): WorkItem {
  if (project.archived) {
    throw new Error("project is archived");
  }
  const home = opts.home ?? resolveKoloHome();
  const now = opts.now ?? new Date();
  const policy = loadWorkQueuePolicy(project, home);
  const queue = resolveQueue(policy, input.queue);
  const type: WorkItemType =
    input.type !== undefined
      ? cleanEnum(input.type, WORK_ITEM_TYPES, "type")
      : (queue.def?.types[0] ?? "request");
  const sla =
    typeof input.slaHours === "number" && input.slaHours > 0
      ? input.slaHours
      : (queue.def?.slaHours ?? null);
  const dueAt =
    input.dueAt !== undefined
      ? cleanDueAt(input.dueAt)
      : sla
        ? new Date(now.getTime() + sla * 3_600_000).toISOString()
        : null;
  const item: WorkItem = {
    id: newWorkItemId(),
    projectId: project.id,
    queue: queue.id,
    type,
    title: cleanTitle(input.title),
    source: {
      documents: cleanDocuments(input.source?.documents, project, home),
      fields: cleanFields(input.source?.fields),
    },
    status: "new",
    assignee: input.assignee !== undefined ? cleanPersonAssignee(input.assignee) : null,
    priority:
      input.priority !== undefined
        ? cleanEnum(input.priority, WORK_ITEM_PRIORITIES, "priority")
        : "normal",
    dueAt,
    slaHours: sla,
    draft: null,
    checks: [],
    requiredApprovals: 1,
    approvals: [],
    override: null,
    history: [],
    runIds: [],
    lastError: null,
    createdAt: now.toISOString(),
    createdBy: actor.id,
    updatedAt: now.toISOString(),
    revision: 0,
  };
  recheck(project, item, now, home);
  insertWorkItem(item, home);
  return applyTransition(
    project,
    item.id,
    0,
    (cur) => ({
      next: cur,
      spec: {
        action: "create",
        actor,
        detail: { queue: cur.queue, type: cur.type, title: cur.title, checks: checkSummary(cur) },
      },
    }),
    { ...opts, now },
  );
}

const UPDATABLE = new Set([
  "title",
  "queue",
  "type",
  "priority",
  "dueAt",
  "assignee",
  "source",
  "draft",
  "status",
]);
const DECISION_KEYS = new Set(["decision", "approvals", "override", "checks", "history", "runIds"]);

/** Update non-decision fields. `status` only allows submit (→ awaiting_review) and done. */
export function updateWorkItem(
  project: Project,
  id: string,
  patch: Record<string, unknown>,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  if (project.archived) {
    throw new Error("project is archived");
  }
  for (const k of Object.keys(patch)) {
    if (DECISION_KEYS.has(k)) {
      throw new Error(`${k} cannot be changed with workitems.update; use workitems.decide`);
    }
    if (!UPDATABLE.has(k)) {
      throw new Error(`unknown field ${k}`);
    }
  }
  const home = opts.home ?? resolveKoloHome();
  return applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      if (TERMINAL_STATUSES.has(cur.status)) {
        throw new Error(`work item is ${cur.status}`);
      }
      const locked = cur.status === "approved";
      const changed: string[] = [];
      const policy = loadWorkQueuePolicy(project, home);
      if (patch.title !== undefined) {
        cur.title = cleanTitle(patch.title);
        changed.push("title");
      }
      if (patch.priority !== undefined) {
        cur.priority = cleanEnum(patch.priority, WORK_ITEM_PRIORITIES, "priority");
        changed.push("priority");
      }
      if (patch.dueAt !== undefined) {
        cur.dueAt = cleanDueAt(patch.dueAt);
        changed.push("dueAt");
      }
      if (patch.assignee !== undefined) {
        cur.assignee = cleanPersonAssignee(patch.assignee);
        changed.push("assignee");
      }
      let content = false;
      if (patch.queue !== undefined || patch.type !== undefined || patch.source !== undefined) {
        if (locked || cur.status === "drafting") {
          throw new Error(`queue, type and source cannot change while the item is ${cur.status}`);
        }
        if (patch.queue !== undefined) {
          cur.queue = resolveQueue(policy, patch.queue).id;
          changed.push("queue");
        }
        if (patch.type !== undefined) {
          cur.type = cleanEnum(patch.type, WORK_ITEM_TYPES, "type");
          changed.push("type");
        }
        if (patch.source !== undefined) {
          const s = (patch.source ?? {}) as Record<string, unknown>;
          if (s.fields !== undefined) {
            cur.source.fields = cleanFields(s.fields);
          }
          if (s.documents !== undefined) {
            cur.source.documents = cleanDocuments(s.documents, project, home);
          }
          changed.push("source");
        }
        content = true;
      }
      let to: WorkItemStatus | undefined;
      if (patch.draft !== undefined) {
        if (!["new", "sent_back", "awaiting_review"].includes(cur.status)) {
          throw new Error(`a draft cannot be attached while the item is ${cur.status}`);
        }
        const d = (patch.draft ?? {}) as Record<string, unknown>;
        const got = getArtifact(
          typeof d.artifactId === "string" ? d.artifactId : "",
          typeof d.version === "number" ? d.version : null,
          { home },
        );
        if (got.artifact.projectId !== project.id) {
          throw new Error("the draft artifact is not in this project");
        }
        const v = got.artifact.versions.find((x) => x.version === got.version)!;
        cur.draft = {
          artifactId: got.artifact.id,
          version: got.version,
          sha256: v.sha256,
          agentId: v.createdByAgent,
          runId: null,
          createdAt: v.createdAt,
        };
        to = "awaiting_review";
        changed.push("draft");
        content = true;
      }
      if (patch.status !== undefined) {
        const want = cleanEnum(patch.status, WORK_ITEM_STATUSES, "status");
        if (want === "awaiting_review" && ["new", "sent_back"].includes(cur.status)) {
          to = "awaiting_review";
        } else if (want === "done" && cur.status === "approved") {
          to = "done";
        } else if (want !== cur.status) {
          throw new Error(
            `status ${cur.status} → ${want} is not an update; decisions use workitems.decide`,
          );
        }
        changed.push("status");
      }
      if (content || to === "awaiting_review") {
        // The content under review changed: earlier approvals no longer apply.
        cur.approvals = [];
        cur.override = null;
        recheck(project, cur, now, home);
      }
      const action = to === "done" ? "done" : to === "awaiting_review" ? "submit" : "update";
      return {
        next: cur,
        spec: {
          action,
          actor,
          to,
          detail: { fields: changed, ...(content ? { checks: checkSummary(cur) } : {}) },
        },
      };
    },
    opts,
  );
}
