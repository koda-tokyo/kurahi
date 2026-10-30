// Work queue email intake and flag clearing (Kurahi Business edition).
//   workitems.intakeEmail (attach): an agent, or a person, turns a mail message into a work item
//     by reference. Idempotent per (connector, messageId) in the Project. Items start in `new`.
//   workitems.clearFlag (attach + operator.approvals, approval method): person only, like
//     workitems.decide; agent tool connections, nodes and voice are refused before it runs.
import type { GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { clearWorkItemFlag } from "../../workitems/clear-flag.js";
import { WorkItemRefused } from "../../workitems/errors.js";
import { intakeEmailForCaller, type IntakeEmailInput } from "../../workitems/intake.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { requireStepUp } from "./step-up.js";
import { actorFor, emit, fail, nonPersonOrigin, projectOf, valid } from "./workitems-shared.js";

type P = Record<string, unknown> & { projectId: string; id: string; expectedRevision?: number };

export const workitemsIntakeHandlers: GatewayRequestHandlers = {
  "workitems.intakeEmail": ({ params, respond, client, context }) => {
    if (!valid("workitems.intakeEmail", params, respond)) {
      return;
    }
    try {
      const { projectId, ...input } = params as P;
      const project = projectOf(projectId);
      const actor = actorFor(client);
      // Taken in before by someone the caller may not read: refused without showing it.
      const { item, created } = intakeEmailForCaller(project, input as IntakeEmailInput, actor);
      if (created) {
        emit(context, item);
      }
      respond(true, { item, created });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Person-only. Clears one risk flag with a written reason (kept on the item, audited). */
  "workitems.clearFlag": ({ params, respond, client, context }) => {
    const origin = nonPersonOrigin(client, { decision: true });
    if (origin) {
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.projectId === "string" ? params.projectId : null,
        action: "workitem.flag.clear",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: params?.id, flag: params?.flag, reason: origin },
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `only a person may clear a flag (${origin})`, {
          details: { code: "not_a_person" },
        }),
      );
      return;
    }
    if (!valid("workitems.clearFlag", params, respond)) {
      return;
    }
    // Clearing a risk flag (e.g. suspected fraud) is a decision: step-up whatever the amount.
    const stepUp = requireStepUp(client, "approval", respond, {
      method: "workitems.clearFlag",
      context: { always: true },
    });
    if (!stepUp) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = clearWorkItemFlag(
        project,
        p.id,
        { flag: p.flag, reason: p.reason },
        actorFor(client),
        p.expectedRevision,
        { authnEvidence: stepUp.evidence },
      );
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "workitem.flag.clear",
        outcome: "denied",
        source: "gateway.workitems",
        detail: {
          id: p.id,
          flag: p.flag,
          code: err instanceof WorkItemRefused ? err.code : "error",
          error: String(err),
        },
      });
      fail(respond, err);
    }
  },
};
