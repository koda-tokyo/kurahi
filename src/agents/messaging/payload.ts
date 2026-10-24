// Schema validation of inter-agent payloads (OWASP ASI07).
//
// An inter-agent `agent` request may carry only the message and the A2A context the sending
// tool builds; its size is capped; and it may not smuggle control characters or chat-template
// role markers that a model could read as a new system/assistant turn.
import { z } from "zod";

export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

/** C0 controls other than tab/newline/carriage return, DEL and C1 controls. */
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Chat-template role tokens of common model families (ChatML, Llama 2/3, Gemma, Mistral). */
const ROLE_TEMPLATE_TOKENS =
  /<\|(?:im_start|im_end|system|user|assistant|developer|start_header_id|end_header_id|eot_id|begin_of_text|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<start_of_turn>|<end_of_turn>/i;

/**
 * A role marker at the start of a line that is preceded or broken up by invisible characters
 * (zero-width, bidi controls, word joiners, soft hyphen, BOM). Plain "System:" text is allowed;
 * disguised ones are not.
 */
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const ROLE_MARKER = /^\[?(?:system|assistant|developer|user|tool)\]?\s*:/i;

function hasDisguisedRoleMarker(value: string): boolean {
  for (const line of value.split("\n")) {
    // Not trimStart(): it also strips U+FEFF, which is one of the characters looked for.
    const head = line.replace(/^[ \t]+/, "").slice(0, 64);
    INVISIBLE_CHARS.lastIndex = 0;
    if (!INVISIBLE_CHARS.test(head)) {
      continue;
    }
    if (ROLE_MARKER.test(head.replace(INVISIBLE_CHARS, "").replace(/^[ \t]+/, ""))) {
      return true;
    }
  }
  return false;
}

export type PayloadIssue = { code: string; message: string };

function textIssues(field: string, value: string): PayloadIssue[] {
  const issues: PayloadIssue[] = [];
  if (CONTROL_CHARS.test(value)) {
    issues.push({ code: "control-chars", message: `${field} contains control characters` });
  }
  if (ROLE_TEMPLATE_TOKENS.test(value)) {
    issues.push({ code: "role-token", message: `${field} contains a chat-template role token` });
  }
  if (hasDisguisedRoleMarker(value)) {
    issues.push({ code: "role-marker", message: `${field} contains a disguised role marker` });
  }
  return issues;
}

export function buildAgentPayloadSchema(maxBytes: number) {
  return z
    .object({
      message: z.string().min(1),
      extraSystemPrompt: z.string().optional(),
    })
    .strict()
    .superRefine((payload, ctx) => {
      const bytes =
        Buffer.byteLength(payload.message, "utf8") +
        Buffer.byteLength(payload.extraSystemPrompt ?? "", "utf8");
      if (bytes > maxBytes) {
        ctx.addIssue({
          code: "custom",
          message: `payload is ${bytes} bytes (limit ${maxBytes})`,
          params: { code: "too-large" },
        });
      }
      for (const issue of [
        ...textIssues("message", payload.message),
        ...(payload.extraSystemPrompt ? textIssues("context", payload.extraSystemPrompt) : []),
      ]) {
        ctx.addIssue({ code: "custom", message: issue.message, params: { code: issue.code } });
      }
    });
}

/** Validate an inter-agent payload; returns the problems (empty when it is acceptable). */
export function validateAgentPayload(
  payload: unknown,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): PayloadIssue[] {
  const result = buildAgentPayloadSchema(maxBytes).safeParse(payload);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => ({
    code:
      issue.code === "custom"
        ? String((issue as { params?: { code?: string } }).params?.code ?? "invalid")
        : issue.code === "unrecognized_keys"
          ? "unknown-field"
          : "invalid",
    message: issue.message,
  }));
}
