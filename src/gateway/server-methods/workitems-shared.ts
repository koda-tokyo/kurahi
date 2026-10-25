// Helpers shared by the work queue gateway handlers (workitems.ts, workitems-review.ts).
import type { Actor, WorkItem } from "../../workitems/types.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";
import { nonDeciderReason, nonPersonReason } from "../../identity/connect.js";
import { getIdentityService } from "../../identity/service.js";
import { getProject } from "../../projects/store.js";
import { WorkItemRefused } from "../../workitems/errors.js";
import { changedEventPayload } from "../../workitems/escalation.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import { workitemsValidators, type WorkitemsMethod } from "../protocol/workitems-validators.js";
import { actorOf } from "./projects.js";

export const WORKITEMS_EVENT = "workitems.changed";

/**
 * Why a connection is not a person for decisions, or null when it is. The single person check
 * for every person-only method (work items, autopilot, identity): derived from the credential
 * the connection authenticated with (see `nonPersonReason`), never from client-declared fields.
 * With `decision`, the stricter check for `SSO_PERSON_DECISIONS` (see `nonDeciderReason`).
 */
export function nonPersonOrigin(
  client: GatewayClient | null | undefined,
  opts: { decision?: boolean } = {},
): string | null {
  const settings = getIdentityService().settings;
  // The highest-impact decisions (SSO_PERSON_DECISIONS) need an SSO person when identity is
  // configured; break-glass is not enough for them.
  return opts.decision ? nonDeciderReason(client, settings) : nonPersonReason(client, settings);
}

/**
 * The connection's identity as a work queue actor: the same principal string the rest of the
 * gateway records (paired credential, device identity, or owner), person or agent by origin,
 * and privileged when the connection holds the operator.admin scope.
 */
export function actorFor(client: GatewayClient | null | undefined): Actor {
  const scopes = client?.connect?.scopes ?? [];
  return {
    id: actorOf(client),
    kind: nonPersonOrigin(client) ? "agent" : "person",
    privileged: scopes.includes("operator.admin"),
  };
}

export function fail(respond: RespondFn, err: unknown) {
  if (err instanceof WorkItemRefused) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, err.message, {
        details: { code: err.code, ...err.details },
      }),
    );
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
  );
}

export function valid(method: WorkitemsMethod, params: unknown, respond: RespondFn): boolean {
  const validate = workitemsValidators[method];
  if (validate(params)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
  return false;
}

export function projectOf(id: unknown) {
  const project = typeof id === "string" ? getProject(id) : null;
  if (!project) {
    throw new Error("project not found");
  }
  return project;
}

export function emit(context: GatewayRequestContext | undefined, item: WorkItem) {
  context?.broadcast?.(WORKITEMS_EVENT, changedEventPayload(item), { dropIfSlow: true });
}
