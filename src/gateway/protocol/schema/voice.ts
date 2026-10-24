// WS `voice.*` (Work Console push-to-talk). See docs/tools/voice.md.
//
//   voice.start  {projectId?, lang?, deviceHint?}   → {sessionId}
//   voice.audio  {sessionId, chunk, seq}            → {sessionId, seq, duplicate?}
//   voice.stop   {sessionId}                        → VoiceTranscriptFinalEvent payload
//   voice.speak  {text, lang, voice?, rate?}        → {speakId, format}, then voice.audio.out events
//   voice.cancel {sessionId?, speakId?}             → {cancelled}
//
// Events go only to the connection that owns the session:
//   voice.transcript.partial {sessionId, text, lang?}
//   voice.transcript.final   {sessionId, text, lang, confidence?}
//   voice.audio.out          {seq, chunk, done, speakId?, error?}
//   voice.session.ended      {sessionId, reason}   (server-side end: limit, idle, error)
import { Type } from "@sinclair/typebox";

export const VoiceLangSchema = Type.Union([Type.Literal("ja"), Type.Literal("en")]);
export const VoiceLangRequestSchema = Type.Union([
  Type.Literal("ja"),
  Type.Literal("en"),
  Type.Literal("auto"),
]);

const Id = Type.String({ minLength: 1, maxLength: 128 });

export const VoiceStartParamsSchema = Type.Object(
  {
    projectId: Type.Optional(Id),
    lang: Type.Optional(VoiceLangRequestSchema),
    /** Free-form capture hint from the native layer (e.g. "builtin-mic"); audited, truncated. */
    deviceHint: Type.Optional(Type.String({ maxLength: 128 })),
  },
  { additionalProperties: false },
);

export const VoiceStartResultSchema = Type.Object(
  { sessionId: Type.String() },
  { additionalProperties: false },
);

export const VoiceAudioParamsSchema = Type.Object(
  {
    sessionId: Id,
    /** Base64 of signed 16-bit little-endian PCM, mono, 16 kHz. */
    chunk: Type.String({ minLength: 1, maxLength: 2_000_000 }),
    /** 0, 1, 2, … per session. A repeated seq is acknowledged as a duplicate and ignored. */
    seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const VoiceAudioResultSchema = Type.Object(
  {
    sessionId: Type.String(),
    seq: Type.Integer({ minimum: 0 }),
    duplicate: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const VoiceStopParamsSchema = Type.Object(
  { sessionId: Id },
  { additionalProperties: false },
);

export const VoiceTranscriptFinalEventSchema = Type.Object(
  {
    sessionId: Type.String(),
    text: Type.String(),
    lang: VoiceLangSchema,
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

export const VoiceStopResultSchema = VoiceTranscriptFinalEventSchema;

export const VoiceTranscriptPartialEventSchema = Type.Object(
  {
    sessionId: Type.String(),
    text: Type.String(),
    lang: Type.Optional(VoiceLangSchema),
  },
  { additionalProperties: false },
);

export const VoiceSpeakParamsSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
    lang: VoiceLangSchema,
    /** Admin-configured voice id; opaque to the UI. */
    voice: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    rate: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
  },
  { additionalProperties: false },
);

export const VoiceSpeakResultSchema = Type.Object(
  {
    speakId: Type.String(),
    /** Media type of the concatenated `voice.audio.out` chunks. */
    format: Type.String(),
  },
  { additionalProperties: false },
);

export const VoiceAudioOutEventSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    /** Base64 audio bytes; empty on the final event. */
    chunk: Type.String(),
    done: Type.Boolean(),
    speakId: Type.Optional(Type.String()),
    /** Set on a final event that ended early ("cancelled" or an engine error). */
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VoiceCancelParamsSchema = Type.Object(
  {
    sessionId: Type.Optional(Id),
    speakId: Type.Optional(Id),
  },
  { additionalProperties: false },
);

export const VoiceCancelResultSchema = Type.Object(
  { cancelled: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export const VoiceSessionEndedEventSchema = Type.Object(
  {
    sessionId: Type.String(),
    reason: Type.Union([Type.Literal("limit"), Type.Literal("idle"), Type.Literal("error")]),
  },
  { additionalProperties: false },
);
