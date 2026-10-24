// Business connectors: audit rows, human approval for writes, untrusted-content wrapping.
//
// Audit rows carry ids, counts, sizes, durations and error codes; never subjects, bodies,
// addresses, file names or search text. Every write asks a person through the same approval path
// the policy guard uses (exec.approval.request), on top of whatever the policy file decides, and
// is refused when nobody approves before the timeout.
import type { AskParams, AskVerdict } from "../../policy/guard.js";
import {
  wrapExternalContent,
  type ExternalContentSource,
} from "../../security/external-content.js";
import { ConnectorError, errorCodeOf } from "./errors.js";

export type ConnectorAuditSink = (input: {
  action: string;
  outcome?: "ok" | "denied" | "failed" | "error";
  identity?: string;
  scope?: string;
  detail?: Record<string, unknown>;
}) => void;

export type ConnectorCallAudit = {
  connectorId: string;
  /** Dotted operation, e.g. `mail.list`, `files.read`. */
  op: string;
  agentId?: string;
  sessionKey?: string;
  /** Provider ids of the items touched (message, event, drive item, user, group). */
  ids?: readonly string[];
  count?: number;
  bytes?: number;
  durationMs?: number;
};

const MAX_IDS = 25;
const ID_SAFE = /^[A-Za-z0-9._=!+/-]{1,256}$/;

function safeIds(ids: readonly string[] | undefined): string[] | undefined {
  if (!ids) {
    return undefined;
  }
  // Provider ids are opaque tokens; anything that does not look like one is dropped, so a
  // caller cannot smuggle content into the audit log through this field.
  return ids.filter((id) => ID_SAFE.test(id)).slice(0, MAX_IDS);
}

export function auditConnectorCall(
  sink: ConnectorAuditSink | undefined,
  call: ConnectorCallAudit,
  result: { ok: true } | { ok: false; error: unknown },
): void {
  if (!sink) {
    return;
  }
  const ids = safeIds(call.ids);
  const detail: Record<string, unknown> = {
    connector: call.connectorId,
    op: call.op,
    ...(ids && ids.length > 0 ? { ids, idCount: call.ids?.length ?? ids.length } : {}),
    ...(typeof call.count === "number" ? { count: call.count } : {}),
    ...(typeof call.bytes === "number" ? { bytes: call.bytes } : {}),
    ...(typeof call.durationMs === "number" ? { durationMs: Math.round(call.durationMs) } : {}),
  };
  let outcome: "ok" | "denied" | "failed" = "ok";
  if (!result.ok) {
    const code = errorCodeOf(result.error);
    detail.error = code;
    outcome = code === "approval_denied" || code === "scope_missing" ? "denied" : "failed";
  }
  try {
    sink({
      action: `connector.${call.connectorId}.${call.op}`,
      outcome,
      identity: call.agentId,
      scope: call.sessionKey,
      detail,
    });
  } catch {
    // Audit sinks never break a tool call.
  }
}

/** Run `fn` and audit it; `meta` derives ids/counts from the result. */
export async function audited<T>(
  sink: ConnectorAuditSink | undefined,
  call: ConnectorCallAudit,
  fn: () => Promise<T>,
  meta?: (value: T) => Pick<ConnectorCallAudit, "ids" | "count" | "bytes">,
  now: () => number = Date.now,
): Promise<T> {
  const start = now();
  try {
    const value = await fn();
    auditConnectorCall(
      sink,
      { ...call, ...meta?.(value), durationMs: now() - start },
      { ok: true },
    );
    return value;
  } catch (err) {
    auditConnectorCall(sink, { ...call, durationMs: now() - start }, { ok: false, error: err });
    throw err;
  }
}

export type ApprovalAsk = (params: AskParams) => Promise<"allow" | "deny" | AskVerdict>;

export type WriteApprovalRequest = {
  connectorId: string;
  tool: string;
  agentId: string;
  sessionKey?: string;
  /** What the approver sees: recipients, subject, time. Not written to the audit log. */
  preview: Record<string, unknown>;
  timeoutMs?: number;
};

/** Ask a person; throws `approval_denied` unless they allow it. */
export async function requireWriteApproval(
  req: WriteApprovalRequest,
  ask: ApprovalAsk,
): Promise<void> {
  let verdict: "allow" | "deny";
  try {
    const raw = await ask({
      agentId: req.agentId,
      sessionKey: req.sessionKey,
      tool: req.tool,
      args: req.preview,
      ruleId: `connector:${req.connectorId}:write`,
      timeoutMs: Math.min(req.timeoutMs ?? 120_000, 600_000),
    });
    verdict = typeof raw === "string" ? raw : raw.decision;
  } catch (err) {
    if (errorCodeOf(err) === "approval_denied") {
      throw err;
    }
    verdict = "deny";
  }
  if (verdict !== "allow") {
    throw new ConnectorError("approval_denied", "the write was not approved");
  }
}

/** Wrap provider content (mail bodies, event text, file text) before the model reads it. */
export function wrapUntrusted(
  content: string,
  opts: { source: ExternalContentSource; sender?: string; subject?: string },
): string {
  return wrapExternalContent(content, {
    source: opts.source,
    sender: opts.sender,
    subject: opts.subject,
    includeWarning: true,
  });
}
