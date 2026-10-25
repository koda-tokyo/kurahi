// Which plan items are emails: the engine knows, from its own gather, which message ids it read
// through a mail connector's read tool (a fan-out step). A plan item whose ref is one of those
// ids (or that cites exactly one such source) is an email-origin item and goes through email
// intake with a reference to the message. The model cannot make something an email: the
// origin comes from what the engine read, never from the plan.

import type { EmailOriginRef } from "./workitems-adapter.js";
import { cleanEmailOrigin } from "../workitems/intake.js";

/** Mail read tools → the connector the work queue records. */
export const MAIL_READ_TOOLS: Record<string, EmailOriginRef["connector"]> = {
  m365_mail_read: "microsoft-365",
  gmail_read: "gmail",
};

// `N. id: …` / `received: …` / `from: Name <addr>` / `subject: …` blocks of a list output.
const LIST_BLOCK_RE = /id: (\S+)\n\s+received: ([^\n]*)\n\s+from: ([^\n]*)\n\s+subject: ([^\n]*)/g;

export type ListHeaders = { from?: string; subject?: string; receivedAt?: string };

/** Header values per message id from a mail list/search output (best effort). */
export function parseListHeaders(text: string): Map<string, ListHeaders> {
  const out = new Map<string, ListHeaders>();
  for (const m of text.matchAll(LIST_BLOCK_RE)) {
    const from = /<([^<>\s]+@[^<>\s]+)>/.exec(m[3])?.[1] ?? m[3].trim();
    const received = m[2].trim().split(/\s+/)[0] ?? "";
    out.set(m[1], {
      ...(from ? { from } : {}),
      ...(m[4].trim() ? { subject: m[4].trim().slice(0, 300) } : {}),
      ...(received ? { receivedAt: received } : {}),
    });
  }
  return out;
}

/**
 * A reference intake accepts: the connector and message id always; each optional header only
 * when intake's own validation accepts it (a malformed sender, a subject carrying the untrusted
 * boundary, a time without a zone are dropped instead of failing the item). Null when even the
 * id is not a valid message id.
 */
export function safeEmailOrigin(
  connector: EmailOriginRef["connector"],
  messageId: string,
  headers: ListHeaders = {},
): EmailOriginRef | null {
  const base = { kind: "email", connector, messageId };
  try {
    cleanEmailOrigin(base);
  } catch {
    return null;
  }
  const out: EmailOriginRef = { connector, messageId };
  for (const key of ["from", "subject", "receivedAt"] as const) {
    const v = headers[key];
    if (v === undefined) {
      continue;
    }
    try {
      const cleaned = cleanEmailOrigin({ ...base, [key]: v });
      if (cleaned[key] !== undefined) {
        out[key] = cleaned[key];
      }
    } catch {
      // Not a value intake accepts: left out.
    }
  }
  return out;
}
