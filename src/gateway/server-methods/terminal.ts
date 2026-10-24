// Kurahi Work Console terminal methods (src/console/terminal). Every `terminal.*` method needs
// operator.admin (server-methods.ts falls through to admin; scopes.ts defaults paired
// credentials to admin), and a session answers only to the identity that opened it.
// Approvals are answered with `exec.approval.resolve` (the id is in `approval.requested`).

import type { ErrorObject } from "ajv";
import type { TerminalBroker } from "../../console/terminal/broker.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { TerminalError } from "../../console/terminal/broker.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTerminalCancelParams,
  validateTerminalCloseParams,
  validateTerminalDiffParams,
  validateTerminalInputParams,
  validateTerminalOpenParams,
  validateTerminalReplayParams,
  validateTerminalResizeParams,
} from "../protocol/index.js";
import { actorOf } from "./projects.js";

export const TERMINAL_METHODS = [
  "terminal.open",
  "terminal.input",
  "terminal.resize",
  "terminal.cancel",
  "terminal.close",
  "terminal.replay",
  "terminal.diff",
] as const;

type Validator = ((params: unknown) => boolean) & { errors?: ErrorObject[] | null };

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof TerminalError) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, err.message, { details: { code: err.code } }),
    );
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
  );
}

function invalid(respond: RespondFn, method: string, validate: Validator) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
}

export function createTerminalHandlers(broker: TerminalBroker): GatewayRequestHandlers {
  const handler =
    <P>(method: string, validate: Validator, run: (p: P, actor: string) => unknown) =>
    async ({ params, respond, client }: Parameters<GatewayRequestHandlers[string]>[0]) => {
      if (!validate(params)) {
        invalid(respond, method, validate);
        return;
      }
      try {
        respond(true, await run(params as P, actorOf(client)), undefined);
      } catch (err) {
        fail(respond, err);
      }
    };
  return {
    "terminal.open": handler<{ projectId: string; name: string }>(
      "terminal.open",
      validateTerminalOpenParams,
      (p, actor) => broker.open({ projectId: p.projectId, name: p.name, actor }),
    ),
    "terminal.input": handler<{ sessionId: string; data: string }>(
      "terminal.input",
      validateTerminalInputParams,
      (p, actor) => {
        broker.input(p.sessionId, actor, p.data);
        return { ok: true };
      },
    ),
    "terminal.resize": handler<{ sessionId: string; cols: number; rows: number }>(
      "terminal.resize",
      validateTerminalResizeParams,
      (p, actor) => {
        broker.resize(p.sessionId, actor, p.cols, p.rows);
        return { ok: true };
      },
    ),
    "terminal.cancel": handler<{ sessionId: string }>(
      "terminal.cancel",
      validateTerminalCancelParams,
      (p, actor) => {
        broker.cancel(p.sessionId, actor);
        return { ok: true };
      },
    ),
    "terminal.close": handler<{ sessionId: string }>(
      "terminal.close",
      validateTerminalCloseParams,
      (p, actor) => {
        broker.close(p.sessionId, actor);
        return { ok: true };
      },
    ),
    "terminal.replay": handler<{ sessionId: string; afterSeq: number; limit?: number }>(
      "terminal.replay",
      validateTerminalReplayParams,
      (p, actor) => broker.replay(p.sessionId, actor, p.afterSeq, p.limit),
    ),
    "terminal.diff": handler<{ diffId: string; cursor?: string }>(
      "terminal.diff",
      validateTerminalDiffParams,
      (p, actor) => broker.diff(p.diffId, actor, p.cursor),
    ),
  };
}
