// WS `voice.*` methods (Work Console push-to-talk). Attach scope. Events are sent only to the
// calling connection. Off unless `voice.enabled` is true. See docs/tools/voice.md.
//
// The transcript is returned to the UI for editing; the UI sends it as an ordinary `chat.send`.
// Nothing here can approve anything: approval methods refuse voice-origin requests
// (src/voice/approval-guard.ts, enforced in server-methods.ts).
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { getVoiceManager } from "../../voice/runtime.js";
import { VoiceError } from "../../voice/types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateVoiceAudioParams,
  validateVoiceCancelParams,
  validateVoiceSpeakParams,
  validateVoiceStartParams,
  validateVoiceStopParams,
} from "../protocol/index.js";
import { actorOf } from "./projects.js";

type Validator = ((v: unknown) => boolean) & {
  errors?: Parameters<typeof formatValidationErrors>[0];
};

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof VoiceError) {
    const unavailable = err.code === "disabled" || err.code === "unavailable";
    respond(
      false,
      undefined,
      errorShape(unavailable ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST, err.message, {
        details: { voice: err.code },
        ...(err.code === "limit" || err.code === "busy" ? { retryable: true } : {}),
      }),
    );
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "voice request failed"));
}

function handler<P>(
  method: string,
  validate: Validator,
  run: (
    caller: { connId: string; actor: string },
    params: P,
    opts: GatewayRequestHandlerOptions,
  ) => unknown,
) {
  return async (opts: GatewayRequestHandlerOptions) => {
    const { params, respond, client } = opts;
    if (!validate(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!client || !connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "connect first"));
      return;
    }
    try {
      const result = await run({ connId, actor: actorOf(client) }, params as P, opts);
      respond(true, result, undefined);
    } catch (err) {
      fail(respond, err);
    }
  };
}

const manager = () => getVoiceManager();

export const VOICE_METHODS = [
  "voice.start",
  "voice.audio",
  "voice.stop",
  "voice.speak",
  "voice.cancel",
] as const;

export const VOICE_EVENTS = [
  "voice.transcript.partial",
  "voice.transcript.final",
  "voice.audio.out",
  "voice.session.ended",
] as const;

export const voiceHandlers: GatewayRequestHandlers = {
  "voice.start": handler<{ projectId?: string; lang?: "ja" | "en" | "auto"; deviceHint?: string }>(
    "voice.start",
    validateVoiceStartParams,
    (caller, p) => manager().start(caller, p),
  ),
  "voice.audio": handler<{ sessionId: string; chunk: string; seq: number }>(
    "voice.audio",
    validateVoiceAudioParams,
    (caller, p) => manager().audio(caller, p),
  ),
  "voice.stop": handler<{ sessionId: string }>("voice.stop", validateVoiceStopParams, (caller, p) =>
    manager().stop(caller, p),
  ),
  "voice.speak": handler<{ text: string; lang: "ja" | "en"; voice?: string; rate?: number }>(
    "voice.speak",
    validateVoiceSpeakParams,
    (caller, p) => manager().speak(caller, p),
  ),
  "voice.cancel": handler<{ sessionId?: string; speakId?: string }>(
    "voice.cancel",
    validateVoiceCancelParams,
    (caller, p) => manager().cancel(caller, p),
  ),
};
