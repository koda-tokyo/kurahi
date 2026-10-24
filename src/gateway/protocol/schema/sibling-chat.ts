import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ── Sibling Chat Protocol Schemas ──────────────────────────────────────────────

export const SiblingSendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    text: NonEmptyString,
    attachments: Type.Optional(
      Type.Array(
        Type.Object(
          {
            type: Type.Optional(NonEmptyString),
            mimeType: Type.Optional(NonEmptyString),
            fileName: Type.Optional(NonEmptyString),
            content: Type.Optional(Type.String()), // base64-encoded
          },
          { additionalProperties: false },
        ),
      ),
    ),
    idempotencyKey: NonEmptyString,
    /** Signed sender envelope (src/agents/messaging/sibling.ts verifies it). */
    agentEnvelope: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const SiblingSubscribeParamsSchema = Type.Object(
  {
    from: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SiblingHistoryParamsSchema = Type.Object(
  {
    with: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
    before: Type.Optional(NonEmptyString), // cursor (ISO timestamp)
  },
  { additionalProperties: false },
);

export const SiblingReadParamsSchema = Type.Object(
  {
    with: NonEmptyString,
    upToSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SiblingMessageSchema = Type.Object(
  {
    id: NonEmptyString,
    runId: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    text: NonEmptyString,
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    seq: Type.Integer({ minimum: 0 }),
    timestamp: NonEmptyString, // ISO 8601
    deliveredAt: Type.Optional(NonEmptyString),
    readAt: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SiblingHistoryResultSchema = Type.Object(
  {
    messages: Type.Array(SiblingMessageSchema),
    hasMore: Type.Boolean(),
    nextCursor: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SiblingSendResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    runId: NonEmptyString,
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SiblingDeliveryAckSchema = Type.Object(
  {
    type: Type.Literal("delivery_ack"),
    runId: NonEmptyString,
    deliveredTo: NonEmptyString,
    at: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SiblingEventMessageSchema = Type.Object(
  {
    type: Type.Literal("message"),
    from: NonEmptyString,
    text: NonEmptyString,
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    seq: Type.Integer({ minimum: 0 }),
    runId: NonEmptyString,
    timestamp: NonEmptyString,
  },
  { additionalProperties: false },
);

// TypeScript types (manual, since Static<> from TypeBox doesn't re-export cleanly)
export type SiblingSendParams = {
  to: string;
  text: string;
  attachments?: Array<{ type?: string; mimeType?: string; fileName?: string; content?: string }>;
  idempotencyKey: string;
  agentEnvelope?: Record<string, unknown>;
};

export type SiblingSendResult = {
  ok: boolean;
  runId: string;
  seq?: number;
};

export type SiblingSubscribeParams = {
  from?: string;
};

export type SiblingHistoryParams = {
  with: string;
  limit?: number;
  before?: string;
};

export type SiblingHistoryResult = {
  messages: Array<{
    id: string;
    runId: string;
    from: string;
    to: string;
    text: string;
    attachments?: Array<Record<string, unknown>>;
    seq: number;
    timestamp: string;
    deliveredAt?: string;
    readAt?: string;
  }>;
  hasMore: boolean;
  nextCursor?: string;
};

export type SiblingReadParams = {
  with: string;
  upToSeq?: number;
};

export type SiblingMessage = {
  id: string;
  runId: string;
  from: string;
  to: string;
  text: string;
  attachments?: Array<Record<string, unknown>>;
  seq: number;
  timestamp: string;
  deliveredAt?: string;
  readAt?: string;
};

export type SiblingEventMessage = {
  type: "message";
  from: string;
  text: string;
  attachments?: Array<Record<string, unknown>>;
  seq: number;
  runId: string;
  timestamp: string;
};

export type SiblingDeliveryAck = {
  type: "delivery_ack";
  runId: string;
  deliveredTo: string;
  at: string;
};

// Agent id (membership is validated at handler level against the configured agents)
export const SiblingNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" });
