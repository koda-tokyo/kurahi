// Kurahi Work Console: gateway-owned terminal broker (src/console/terminal). Admin scope only.
// The UI owns all copy: events carry stable codes and safe params, never prose.
import { type TProperties, Type } from "@sinclair/typebox";
import { TERMINAL_NOTICE_CODES, TERMINAL_RISK_CODES } from "../../../console/terminal/codes.js";
import { NonEmptyString } from "./primitives.js";

const literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

const SessionId = Type.String({ minLength: 1, maxLength: 64 });
const SafeParams = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);

export const TerminalRiskSchema = Type.Object(
  { code: literals(TERMINAL_RISK_CODES), params: Type.Optional(SafeParams) },
  { additionalProperties: false },
);

export const TerminalOpenParamsSchema = Type.Object(
  {
    projectId: NonEmptyString,
    /** Tab label chosen by the UI (display only). */
    name: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const TerminalOpenResultSchema = Type.Object(
  {
    sessionId: SessionId,
    projectId: Type.String(),
    name: Type.String(),
    mode: Type.Union([Type.Literal("plan"), Type.Literal("act")]),
    sandboxed: Type.Boolean(),
    /** Working directory relative to the project root ("." = the root). */
    cwd: Type.String(),
    /** Seq of the newest event already emitted (replay with afterSeq = this to skip them). */
    seq: Type.Integer({ minimum: 0 }),
    limits: Type.Object(
      {
        maxLineLength: Type.Integer(),
        idleTimeoutMs: Type.Integer(),
        outputBytesPerSecond: Type.Integer(),
        approvalTimeoutMs: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TerminalInputParamsSchema = Type.Object(
  { sessionId: SessionId, data: Type.String({ maxLength: 65_536 }) },
  { additionalProperties: false },
);

export const TerminalResizeParamsSchema = Type.Object(
  {
    sessionId: SessionId,
    cols: Type.Integer({ minimum: 2, maximum: 1000 }),
    rows: Type.Integer({ minimum: 2, maximum: 500 }),
  },
  { additionalProperties: false },
);

export const TerminalCancelParamsSchema = Type.Object(
  { sessionId: SessionId },
  { additionalProperties: false },
);

export const TerminalCloseParamsSchema = Type.Object(
  { sessionId: SessionId },
  { additionalProperties: false },
);

export const TerminalAckResultSchema = Type.Object(
  { ok: Type.Boolean() },
  { additionalProperties: false },
);

const common = {
  sessionId: SessionId,
  seq: Type.Integer({ minimum: 1 }),
  ts: Type.Integer({ minimum: 0 }),
};
const base = <T extends string, P extends TProperties>(type: T, extra: P) =>
  Type.Object(
    { ...common, type: Type.Literal(type), runId: Type.Optional(Type.String()), ...extra },
    { additionalProperties: false },
  );
/** Events of one command execution always carry its runId. */
const baseRun = <T extends string, P extends TProperties>(type: T, extra: P) =>
  Type.Object(
    { ...common, type: Type.Literal(type), runId: Type.String(), ...extra },
    { additionalProperties: false },
  );

export const TerminalDiffFileSummarySchema = Type.Object(
  {
    path: Type.String(),
    status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
    added: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
    /** Why no line diff exists: binary, too large, or a secret-looking file (content hidden). */
    skipped: Type.Optional(
      Type.Union([Type.Literal("binary"), Type.Literal("too-large"), Type.Literal("secret")]),
    ),
    /** The file is inside a read-only folder of the project: a policy violation. */
    violation: Type.Optional(Type.Literal("read-only-path")),
  },
  { additionalProperties: false },
);

const Totals = Type.Object(
  {
    files: Type.Integer({ minimum: 0 }),
    added: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerminalEventSchema = Type.Union([
  base("stdout", { data: Type.String() }),
  base("stderr", { data: Type.String() }),
  baseRun("exit", {
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String(), Type.Null()]),
    durationMs: Type.Integer({ minimum: 0 }),
    reason: Type.Union([Type.Literal("exited"), Type.Literal("cancelled"), Type.Literal("closed")]),
  }),
  baseRun("approval.requested", {
    approvalId: Type.String(),
    /** The command line as submitted, with secrets redacted. */
    command: Type.String(),
    cwd: Type.String(),
    /** The most severe risk; `risks` lists all of them. */
    risk: TerminalRiskSchema,
    risks: Type.Array(TerminalRiskSchema),
    expiresAtMs: Type.Integer({ minimum: 0 }),
  }),
  baseRun("approval.resolved", {
    approvalId: Type.String(),
    decision: Type.Union([
      Type.Literal("allow-once"),
      Type.Literal("allow-always"),
      Type.Literal("deny"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
    ]),
    resolvedBy: Type.Union([Type.String(), Type.Null()]),
  }),
  baseRun("file.diff", {
    diffId: Type.String(),
    /** At most 200 entries; `totals` counts every changed file. */
    files: Type.Array(TerminalDiffFileSummarySchema),
    totals: Totals,
    /** The project had more files than the snapshot covers; changes beyond it are not shown. */
    truncated: Type.Boolean(),
    /** Changed files inside read-only folders (policy violations; listed first in `files`). */
    violations: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  base("notice", { code: literals(TERMINAL_NOTICE_CODES), params: Type.Optional(SafeParams) }),
]);

export const TerminalReplayParamsSchema = Type.Object(
  {
    sessionId: SessionId,
    afterSeq: Type.Integer({ minimum: 0 }),
    /** Page size, at most 200 (default 200). */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const TerminalReplayResultSchema = Type.Object(
  {
    events: Type.Array(TerminalEventSchema),
    /** Events after `afterSeq` were dropped from the ring buffer (5,000 events / 10 MB). */
    truncated: Type.Boolean(),
    /** More events follow: call again with afterSeq = the last returned seq. */
    hasMore: Type.Boolean(),
    lastSeq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerminalDiffParamsSchema = Type.Object(
  {
    diffId: NonEmptyString,
    /** Opaque cursor from a previous page (200 files per page). */
    cursor: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { additionalProperties: false },
);

export const TerminalDiffFileSchema = Type.Object(
  {
    path: Type.String(),
    status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
    added: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
    skipped: Type.Optional(
      Type.Union([Type.Literal("binary"), Type.Literal("too-large"), Type.Literal("secret")]),
    ),
    /** Unified diff lines, secrets redacted; null when skipped. */
    lines: Type.Union([Type.Array(Type.String()), Type.Null()]),
    /** The line diff covers only the first 2,000 lines of the file. */
    linesTruncated: Type.Boolean(),
    /** The file is inside a read-only folder of the project: a policy violation. */
    violation: Type.Optional(Type.Literal("read-only-path")),
  },
  { additionalProperties: false },
);

export const TerminalDiffResultSchema = Type.Object(
  {
    diffId: Type.String(),
    sessionId: Type.String(),
    runId: Type.String(),
    projectId: Type.String(),
    files: Type.Array(TerminalDiffFileSchema),
    totals: Totals,
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
