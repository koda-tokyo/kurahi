// Consequential actions are NEVER approved by voice.
//
// A transcript only ever becomes a chat message the user edits and sends by hand; it is not an
// approval. This guard is the hard line on the gateway side: every approval-type method refuses
// a request that carries any voice-origin marker, before schema validation and before the
// handler runs, so no future schema change can quietly add a "voice approved" path.
//
// The Work Console must still render approvals as explicit click/keyboard confirmations; it must
// never bind a voice transcript ("yes", "承認") to an approval call.

/** Methods that approve, resolve or grant something consequential. */
export const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  "exec.approval.resolve",
  "exec.approvals.set",
  "exec.approvals.node.set",
  "device.pair.approve",
  "node.pair.approve",
  "pair.approve",
  "pair.invite",
  "policy.release",
  "artifacts.setStatus",
  "workitems.decide",
]);

/** Matches future approval-type methods by name as well (fail closed). */
export function isApprovalMethod(method: string): boolean {
  return (
    APPROVAL_METHODS.has(method) ||
    /(^|\.)(approve|approval\.resolve|approvals\.set|approvals\.node\.set)$/.test(method)
  );
}

const ORIGIN_KEYS = ["origin", "inputOrigin", "inputMode", "source", "via"];
/** Envelope objects whose own keys are checked as well (one level). */
const ENVELOPE_KEYS = ["meta", "context", "client", "origin"];
const FLAG_KEYS = [
  "voice",
  "voiceOrigin",
  "voiceSessionId",
  "fromVoice",
  "byVoice",
  "spoken",
  "transcript",
];

/**
 * True when params carry anything that says "this came from voice": a flag key at the top level
 * or inside a `meta` / `context` / `client` / `origin` envelope, or an origin-like string field
 * naming voice / speech / transcription. Payload data deeper down (e.g. agent ids in an approvals
 * file) is not inspected, so an agent called "voice" is not mistaken for a voice origin.
 */
export function hasVoiceOrigin(params: unknown, envelope = false): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  const obj = params as Record<string, unknown>;
  for (const key of FLAG_KEYS) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== false) {
      return true;
    }
  }
  for (const key of ORIGIN_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && /voice|speech|stt|transcri/i.test(v)) {
      return true;
    }
  }
  if (!envelope) {
    for (const key of ENVELOPE_KEYS) {
      if (hasVoiceOrigin(obj[key], true)) {
        return true;
      }
    }
  }
  return false;
}

/** Refusal message when an approval method carries a voice-origin marker, else null. */
export function voiceApprovalRefusal(method: string, params: unknown): string | null {
  if (isApprovalMethod(method) && hasVoiceOrigin(params)) {
    return `${method} cannot be approved by voice; confirm it explicitly`;
  }
  return null;
}
