import type { DepartmentFilter } from "../../workitems/types.js";
// Work queue review methods: workitems.delegate (person only, attach + operator.approvals),
// workitems.document, workitems.draftDiff and workitems.stats (observe). Reads apply the same
// visibility as workitems.get: requesters see their own items, approvers the items routed to
// them, privileged operators everything.
import type { GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { resolveKoloHome } from "../../config/kolo-home.js";
import { canRead, isPrivileged } from "../../workitems/access.js";
import { draftDiff, previewDocument } from "../../workitems/documents.js";
import { WorkItemRefused } from "../../workitems/errors.js";
import { delegateStage, escalateIfDue } from "../../workitems/escalation.js";
import { departmentQueueMatcher, loadWorkQueuePolicy } from "../../workitems/policy.js";
import { computeStats } from "../../workitems/stats.js";
import { readAllWorkItems, readWorkItem } from "../../workitems/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { actorFor, emit, fail, nonPersonOrigin, projectOf, valid } from "./workitems-shared.js";

type P = Record<string, unknown> & { projectId: string; id: string; expectedRevision?: number };

function visible(
  project: ReturnType<typeof projectOf>,
  id: string,
  client: Parameters<typeof actorFor>[0],
) {
  const item = readWorkItem(project.id, id);
  if (!item) {
    throw new Error("work item not found");
  }
  if (!canRead(item, actorFor(client), loadWorkQueuePolicy(project), new Date())) {
    throw new WorkItemRefused("not_authorised", "you are not authorised to read this work item");
  }
  return item;
}

export const workitemsReviewHandlers: GatewayRequestHandlers = {
  /** Person-only: hand the caller's decision on the current stage to another principal. */
  "workitems.delegate": ({ params, respond, client, context }) => {
    const origin = nonPersonOrigin(client);
    if (origin) {
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.projectId === "string" ? params.projectId : null,
        action: "workitem.delegate",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: params?.id, reason: origin },
      });
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `only a person may delegate a decision (${origin})`,
          {
            details: { code: "not_a_person" },
          },
        ),
      );
      return;
    }
    if (!valid("workitems.delegate", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = delegateStage(
        project,
        p.id,
        { to: p.to, reason: p.reason, expiresAt: p.expiresAt },
        actorFor(client),
        p.expectedRevision,
      );
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "workitem.delegate",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: p.id, code: err instanceof WorkItemRefused ? err.code : "error" },
      });
      fail(respond, err);
    }
  },

  "workitems.document": ({ params, respond, client }) => {
    if (!valid("workitems.document", params, respond)) {
      return;
    }
    const p = params as P & { ref: string; maxChars?: number };
    try {
      const project = projectOf(p.projectId);
      const item = visible(project, p.id, client);
      respond(true, {
        document: previewDocument(project, item, p.ref, {
          home: resolveKoloHome(),
          maxChars: p.maxChars,
        }),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.draftDiff": ({ params, respond, client }) => {
    if (!valid("workitems.draftDiff", params, respond)) {
      return;
    }
    const p = params as P & { fromVersion: number; toVersion: number };
    try {
      const project = projectOf(p.projectId);
      const item = visible(project, p.id, client);
      respond(
        true,
        draftDiff(project, item, p.fromVersion, p.toVersion, { home: resolveKoloHome() }),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Counts and approval times over every item the caller may read (all, for operators). */
  "workitems.stats": ({ params, respond, client, context }) => {
    if (!valid("workitems.stats", params, respond)) {
      return;
    }
    const p = params as {
      projectId: string;
      queue?: string;
      windowDays?: number;
      department?: DepartmentFilter;
    };
    try {
      const project = projectOf(p.projectId);
      const policy = loadWorkQueuePolicy(project);
      const actor = actorFor(client);
      const now = new Date();
      const all = isPrivileged(actor, policy, project.id);
      const items = readAllWorkItems(project.id, {
        prepare: (item) =>
          escalateIfDue(project, item, { now, onChange: (next) => emit(context, next) }),
      }).filter((item) => all || canRead(item, actor, policy, now));
      // Department is a view over the readable set (applied after access), not a permission.
      const inDepartment = p.department ? departmentQueueMatcher(policy, p.department) : null;
      const scoped = inDepartment ? items.filter((item) => inDepartment(item.queue)) : items;
      respond(true, {
        scope: all ? "all" : "visible",
        ...computeStats(scoped, { queue: p.queue, windowDays: p.windowDays, now }),
      });
    } catch (err) {
      fail(respond, err);
    }
  },
};
