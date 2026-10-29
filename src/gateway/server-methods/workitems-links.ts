// Linked case methods: workitems.linked.get and workitems.linked.plans (observe; anyone who may
// read the parent case; plans only offers the pack worksheets' plans to prefill the builder),
// workitems.linked.create and workitems.linked.attach (attach; the parent's requester or a
// privileged operator). Attaching also needs read access to the child item, so a caller cannot
// pull an item they cannot see into a case and learn its status through the parent. The child's
// department comes from the current work-queue policy, never from the request.
import type { LinkedCasePlan } from "../../workitems/links.js";
import type { GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { assertCanRead, assertCanUpdate } from "../../workitems/access.js";
import { WorkItemRefused } from "../../workitems/errors.js";
import {
  attachLinkedStep,
  createLinkedCase,
  linkedCaseStatus,
  readLinkedCase,
} from "../../workitems/links-store.js";
import { readPackPlans } from "../../workitems/pack-plan-file.js";
import { loadWorkQueuePolicy } from "../../workitems/policy.js";
import { readWorkItem } from "../../workitems/store.js";
import { actorOf } from "./projects.js";
import { actorFor, emit, fail, projectOf, valid } from "./workitems-shared.js";

type P = Record<string, unknown> & { projectId: string; id: string };

function linkedCase(projectId: string, parentId: string) {
  const status = linkedCaseStatus(projectId, parentId);
  const rec = status && readLinkedCase(projectId, parentId);
  return status && rec ? { parentId, plan: rec.plan, ...status } : null;
}

function itemOf(projectId: string, id: string) {
  const item = readWorkItem(projectId, id);
  if (!item) {
    throw new Error("work item not found");
  }
  return item;
}

function audit(
  client: Parameters<typeof actorOf>[0],
  p: P,
  action: string,
  outcome: "success" | "denied",
  detail: Record<string, unknown>,
) {
  void auditSafe({
    identity: actorOf(client),
    scope: p.projectId,
    action,
    outcome,
    source: "gateway.workitems",
    detail: { id: p.id, ...detail },
  });
}

export const workitemsLinksHandlers: GatewayRequestHandlers = {
  "workitems.linked.get": ({ params, respond, client }) => {
    if (!valid("workitems.linked.get", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const parent = itemOf(project.id, p.id);
      assertCanRead(parent, actorFor(client), loadWorkQueuePolicy(project), new Date());
      respond(true, { linkedCase: linkedCase(project.id, parent.id) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.linked.plans": ({ params, respond, client }) => {
    if (!valid("workitems.linked.plans", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const parent = itemOf(project.id, p.id);
      assertCanRead(parent, actorFor(client), loadWorkQueuePolicy(project), new Date());
      respond(true, { plans: readPackPlans(project) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.linked.create": ({ params, respond, client, context }) => {
    if (!valid("workitems.linked.create", params, respond)) {
      return;
    }
    const p = params as P & { plan: LinkedCasePlan };
    try {
      const project = projectOf(p.projectId);
      const actor = actorFor(client);
      const parent = itemOf(project.id, p.id);
      assertCanUpdate(parent, actor, loadWorkQueuePolicy(project));
      createLinkedCase(project.id, parent.id, p.plan, actor, new Date());
      audit(client, p, "workitem.linked.create", "success", { steps: p.plan.steps.length });
      emit(context, parent);
      respond(true, { linkedCase: linkedCase(project.id, parent.id) });
    } catch (err) {
      audit(client, p, "workitem.linked.create", "denied", {
        code: err instanceof WorkItemRefused ? err.code : "error",
      });
      fail(respond, err);
    }
  },

  "workitems.linked.attach": ({ params, respond, client, context }) => {
    if (!valid("workitems.linked.attach", params, respond)) {
      return;
    }
    const p = params as P & { stepKey: string; childId: string };
    try {
      const project = projectOf(p.projectId);
      const actor = actorFor(client);
      const policy = loadWorkQueuePolicy(project);
      const parent = itemOf(project.id, p.id);
      assertCanUpdate(parent, actor, policy);
      const child = readWorkItem(project.id, p.childId);
      if (child) {
        // A missing child is refused inside attachLinkedStep (linked_child_not_found).
        assertCanRead(child, actor, policy, new Date());
      }
      const departments = new Map(policy.queues.map((q) => [q.id, q.department]));
      attachLinkedStep(
        project.id,
        parent.id,
        p.stepKey,
        p.childId,
        (queueId) => departments.get(queueId),
        actor,
        new Date(),
      );
      audit(client, p, "workitem.linked.attach", "success", {
        stepKey: p.stepKey,
        childId: p.childId,
      });
      emit(context, parent);
      respond(true, { linkedCase: linkedCase(project.id, parent.id) });
    } catch (err) {
      audit(client, p, "workitem.linked.attach", "denied", {
        stepKey: p.stepKey,
        childId: p.childId,
        code: err instanceof WorkItemRefused ? err.code : "error",
      });
      fail(respond, err);
    }
  },
};
