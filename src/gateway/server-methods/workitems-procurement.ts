// Procurement work queue methods (相見積 → 発注):
//   workitems.recordQuotes (attach): an agent or a person stores the request lines and supplier
//     quotes on a case; it never chooses a supplier.
//   workitems.selectSupplier (attach + operator.approvals, approval method): person only, like
//     workitems.decide; agent tool connections, nodes and voice are refused before it runs, and
//     the selector recorded is the session actor, never a request field.
import type { GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { WorkItemRefused } from "../../workitems/errors.js";
import { recordWorkItemProcurement, selectWorkItemSupplier } from "../../workitems/procurement.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { actorFor, emit, fail, nonPersonOrigin, projectOf, valid } from "./workitems-shared.js";

type P = Record<string, unknown> & { projectId: string; id: string; expectedRevision?: number };

export const workitemsProcurementHandlers: GatewayRequestHandlers = {
  "workitems.recordQuotes": ({ params, respond, client, context }) => {
    if (!valid("workitems.recordQuotes", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const item = recordWorkItemProcurement(
        projectOf(p.projectId),
        p.id,
        { request: p.request, quotes: p.quotes },
        actorFor(client),
        p.expectedRevision,
      );
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Person-only. Records which supplier the caller chose from the case's stored quotes. */
  "workitems.selectSupplier": ({ params, respond, client, context }) => {
    const origin = nonPersonOrigin(client, { decision: true });
    if (origin) {
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.projectId === "string" ? params.projectId : null,
        action: "workitem.supplier.select",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: params?.id, supplier: params?.supplier, reason: origin },
      });
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `only a person may choose the supplier (${origin})`,
          {
            details: { code: "not_a_person" },
          },
        ),
      );
      return;
    }
    if (!valid("workitems.selectSupplier", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const item = selectWorkItemSupplier(
        projectOf(p.projectId),
        p.id,
        { supplier: p.supplier, reason: p.reason },
        actorFor(client),
        p.expectedRevision,
      );
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "workitem.supplier.select",
        outcome: "ok",
        source: "gateway.workitems",
        detail: {
          id: p.id,
          supplier: item.supplierSelection?.supplier,
          deviatesFromLowest: item.supplierSelection?.deviatesFromLowest,
          comparisonDigest: item.supplierSelection?.comparisonDigest,
        },
      });
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "workitem.supplier.select",
        outcome: "denied",
        source: "gateway.workitems",
        detail: {
          id: p.id,
          supplier: p.supplier,
          code: err instanceof WorkItemRefused ? err.code : "error",
          error: String(err),
        },
      });
      fail(respond, err);
    }
  },
};
