// Step-up for decisions at the gateway method layer (see src/identity/step-up.ts). A refusal is
// an INVALID_REQUEST whose `details` the console acts on:
//
//   { code: "step_up_required", action, why, maxAgeSeconds, requireMethods, authAt, stepUpPath }
//
// The console starts the re-authentication at `stepUpPath` and repeats the request.
import type { GatewayClient, RespondFn } from "./types.js";
import {
  type AuthnEvidence,
  type StepUpAction,
  type StepUpContext,
  stepUpGate,
} from "../../identity/step-up.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

/**
 * Check step-up for the caller; on refusal respond with the structured error and return null.
 * Otherwise the evidence block to record (null for a non-person caller).
 */
export function requireStepUp(
  client: GatewayClient | null | undefined,
  action: StepUpAction,
  respond: RespondFn,
  opts: { method: string; context?: StepUpContext },
): { evidence: AuthnEvidence | null } | null {
  const gate = stepUpGate(client?.person, action, opts.context, { method: opts.method });
  if (gate.ok) {
    return { evidence: gate.evidence };
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, gate.message, { details: gate.details }),
  );
  return null;
}

/** A form value as an amount (as routes.ts reads it): null when absent, NaN when not a number. */
export function itemAmount(v: unknown): number | null {
  if (v === undefined || v === null || v === "") {
    return null;
  }
  if (typeof v === "number") {
    return v;
  }
  return typeof v === "string" && v.trim() ? Number(v) : NaN;
}
