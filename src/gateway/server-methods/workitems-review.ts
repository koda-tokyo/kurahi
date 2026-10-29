import type { HandOffEvent } from "../../workitems/handoff.js";
import type { DepartmentFilter, WorkItem } from "../../workitems/types.js";
// Work queue review methods: workitems.delegate and workitems.withdrawDelegation (person only,
// attach + operator.approvals),
// workitems.document, workitems.draftDiff, workitems.handoffs and workitems.stats (observe),
// workitems.handoff.open (person only, attach + operator.approvals) and workitems.handoff.event
// (attach; person-only events refused in the hand-off itself). Reads apply the same
// visibility as workitems.get: requesters see their own items, approvers the items routed to
// them, privileged operators everything.
import type { GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { resolveKoloHome } from "../../config/kolo-home.js";
import { actedInStage, canRead, isPrivileged } from "../../workitems/access.js";
import { draftDiff, previewDocumentText } from "../../workitems/documents.js";
import { WorkItemRefused } from "../../workitems/errors.js";
import { delegateStage, escalateIfDue, withdrawDelegation } from "../../workitems/escalation.js";
import { applyHandOffEvent, listHandOffs, openHandOff } from "../../workitems/handoff-store.js";
import { departmentQueueMatcher, loadWorkQueuePolicy } from "../../workitems/policy.js";
import { computeStats } from "../../workitems/stats.js";
import { readAllWorkItems, readWorkItem, readWorkItemsInQueues } from "../../workitems/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { actorFor, emit, fail, nonPersonOrigin, projectOf, valid } from "./workitems-shared.js";

type HandOffDestinationParams = { product: string; object: string; writable: boolean };
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

  /** Person-only: the caller takes back their delegation on the current stage. */
  "workitems.withdrawDelegation": ({ params, respond, client, context }) => {
    const origin = nonPersonOrigin(client);
    if (origin) {
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.projectId === "string" ? params.projectId : null,
        action: "workitem.delegate.withdraw",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: params?.id, reason: origin },
      });
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `only a person may withdraw a delegation (${origin})`,
          { details: { code: "not_a_person" } },
        ),
      );
      return;
    }
    if (!valid("workitems.withdrawDelegation", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = withdrawDelegation(
        project,
        p.id,
        { reason: p.reason },
        actorFor(client),
        p.expectedRevision,
      );
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "workitem.delegate.withdraw",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: p.id, code: err instanceof WorkItemRefused ? err.code : "error" },
      });
      fail(respond, err);
    }
  },

  "workitems.document": async ({ params, respond, client }) => {
    if (!valid("workitems.document", params, respond)) {
      return;
    }
    const p = params as P & { ref: string; maxChars?: number };
    try {
      const project = projectOf(p.projectId);
      const item = visible(project, p.id, client);
      respond(true, {
        document: await previewDocumentText(project, item, p.ref, {
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

  /** Read-only: the case's hand-offs; a record edited on disk refuses the list (handoff_tampered). */
  "workitems.handoffs": ({ params, respond, client }) => {
    if (!valid("workitems.handoffs", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = visible(project, p.id, client);
      respond(true, { handOffs: listHandOffs(project.id, item.id) });
    } catch (err) {
      fail(respond, err);
    }
  },
  /**
   * Person only: hand an approved case to one downstream product and object. Not the requester;
   * a principal who approved a stage of the case, or a privileged operator.
   */
  "workitems.handoff.open": ({ params, respond, client }) => {
    const origin = nonPersonOrigin(client);
    if (origin) {
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.projectId === "string" ? params.projectId : null,
        action: "workitem.handoff.open",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: params?.id, reason: origin },
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `only a person may open a hand-off (${origin})`, {
          details: { code: "not_a_person" },
        }),
      );
      return;
    }
    if (!valid("workitems.handoff.open", params, respond)) {
      return;
    }
    const p = params as P & { action: string; destination: HandOffDestinationParams };
    const actor = actorFor(client);
    try {
      const project = projectOf(p.projectId);
      const item = visible(project, p.id, client);
      const approver = (item.route?.stages ?? []).some((st) => actedInStage(st, actor.id));
      if (
        actor.id === item.requestedBy ||
        !(approver || isPrivileged(actor, loadWorkQueuePolicy(project), project.id))
      ) {
        throw new WorkItemRefused(
          "not_authorised",
          "only an approver of this case, other than its requester, may hand it off",
        );
      }
      const handOff = openHandOff(project.id, item.id, p, actor, new Date());
      void auditSafe({
        identity: actor.id,
        scope: project.id,
        action: "workitem.handoff.open",
        outcome: "success",
        source: "gateway.workitems",
        detail: { id: item.id, handOffId: handOff.id },
      });
      respond(true, { handOff });
    } catch (err) {
      void auditSafe({
        identity: actor.id,
        scope: p.projectId,
        action: "workitem.handoff.open",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: p.id, code: err instanceof WorkItemRefused ? err.code : "error" },
      });
      fail(respond, err);
    }
  },

  /** One hand-off event by the caller; the hand-off itself refuses person-only events from agents. */
  "workitems.handoff.event": ({ params, respond, client }) => {
    if (!valid("workitems.handoff.event", params, respond)) {
      return;
    }
    const p = params as P & { handOffId: string; event: HandOffEvent };
    const actor = actorFor(client);
    try {
      const project = projectOf(p.projectId);
      const item = visible(project, p.id, client);
      const handOff = applyHandOffEvent(
        project.id,
        item.id,
        p.handOffId,
        p.event,
        actor,
        new Date(),
        undefined,
        // Settlement SoD mode comes from the server-side policy, never from the client event.
        { settlementSod: loadWorkQueuePolicy(project).settlementSod },
      );
      void auditSafe({
        identity: actor.id,
        scope: project.id,
        action: `workitem.handoff.${p.event.type}`,
        outcome: "success",
        source: "gateway.workitems",
        detail: { id: item.id, handOffId: p.handOffId, state: handOff.state },
      });
      respond(true, { handOff });
    } catch (err) {
      void auditSafe({
        identity: actor.id,
        scope: p.projectId,
        action: `workitem.handoff.${p.event?.type ?? "event"}`,
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: p.id, code: err instanceof WorkItemRefused ? err.code : "error" },
      });
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
      const prepare = (item: WorkItem) =>
        escalateIfDue(project, item, { now, onChange: (next) => emit(context, next) });
      // Department is a view over the readable set (applied after access), not a permission.
      const inDepartment = p.department ? departmentQueueMatcher(policy, p.department) : null;
      // A queue or department slice, or a non-privileged viewer, reads through the list index
      // only the items that slice and viewer could include; operators' full totals read every item.
      const items = (
        p.queue || inDepartment || !all
          ? readWorkItemsInQueues(
              project.id,
              {
                queue: p.queue,
                inDepartment: inDepartment ?? undefined,
                reader: all ? undefined : actor.id,
              },
              { prepare },
            )
          : readAllWorkItems(project.id, { prepare })
      ).filter((item) => all || canRead(item, actor, policy, now));
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
