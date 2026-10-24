// Business connectors: helpers for agent tools (params, results, audited execution, documents).
import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import type { ConnectorRuntime } from "./runtime.js";
import { extractText, validateDocument } from "../../projects/documents.js";
import { ConnectorError, describeConnectorError, errorCodeOf } from "./errors.js";
import { audited, type ConnectorCallAudit } from "./guardrails.js";

export type ToolContext = { agentId?: string; sessionKey?: string };

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

/** The agent sees a code and a hint; never a provider message, URL or token. */
export function errorResult(err: unknown): ToolResult {
  return textResult(`Error: ${describeConnectorError(err)}`, { error: errorCodeOf(err) });
}

export function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function strParam(
  value: unknown,
  name: string,
  opts: { required?: boolean; max?: number } = {},
): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) {
    if (opts.required) {
      throw new ConnectorError("bad_request", `${name} is required`);
    }
    return undefined;
  }
  if (s.length > (opts.max ?? 1000)) {
    throw new ConnectorError("bad_request", `${name} is too long`);
  }
  return s;
}

export function isoParam(value: unknown, name: string): Date | undefined {
  const s = strParam(value, name, { max: 64 });
  if (!s) {
    return undefined;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new ConnectorError("bad_request", `${name} must be an ISO 8601 date-time`);
  }
  return d;
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export function emailListParam(value: unknown, name: string, max = 20): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = list.map((v) => String(v).trim()).filter(Boolean);
  if (out.length > max) {
    throw new ConnectorError("bad_request", `${name}: at most ${max} addresses`);
  }
  for (const addr of out) {
    if (!EMAIL.test(addr)) {
      throw new ConnectorError("bad_request", `${name}: invalid address`);
    }
  }
  return out;
}

/** Truncate for the model, saying so. */
export function clip(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters]`
    : text;
}

/**
 * Run a tool body audited (ids/counts only) and turn every failure into a safe error result.
 * `meta` derives the audit ids/counts from the value the body returns.
 */
export async function runConnectorTool<T>(
  runtime: ConnectorRuntime,
  ctx: ToolContext,
  op: string,
  body: () => Promise<{ value: T; result: ToolResult }>,
  meta?: (value: T) => Pick<ConnectorCallAudit, "ids" | "count" | "bytes">,
): Promise<ToolResult> {
  try {
    const out = await audited(
      runtime.audit,
      { connectorId: runtime.id, op, agentId: ctx.agentId, sessionKey: ctx.sessionKey },
      body,
      (o) => meta?.(o.value) ?? {},
      runtime.deps.now,
    );
    return out.result;
  } catch (err) {
    return errorResult(err);
  }
}

/** Text of a downloaded document (PDF, DOCX, XLSX, CSV, TXT, MD) via the project extractors. */
export async function extractDocumentText(name: string, buf: Buffer): Promise<string> {
  const check = await validateDocument(name, buf);
  if (!check.ok) {
    throw new ConnectorError("unsupported", "unsupported or mismatched file type");
  }
  if (["png", "jpeg", "gif", "webp"].includes(check.kind)) {
    throw new ConnectorError("unsupported", "images have no text to extract");
  }
  return extractText(check.kind, buf);
}

/** Narrow a plugin-built tool to the runtime's tool type. */
export function asAgentTool(tool: {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}
