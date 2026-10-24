// Gmail message parsing (MIME tree from the Gmail API) and RFC 5322 composition for send.
import { ConnectorError } from "../../../src/connectors/business/index.js";

export type GmailHeader = { name?: string; value?: string };
export type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

export function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return (h?.value ?? "").replace(/[\r\n]+/g, " ");
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function walk(part: GmailPart | undefined, mime: string, depth = 0): GmailPart | undefined {
  if (!part || depth > 12) {
    return undefined;
  }
  if (part.mimeType === mime && part.body?.data && !part.filename) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const hit = walk(child, mime, depth + 1);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** Minimal HTML to text: drop script/style, tags to breaks/spaces, decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function bodyText(msg: GmailMessage): string {
  const plain = walk(msg.payload, "text/plain");
  if (plain) {
    return decode(plain.body?.data);
  }
  const html = walk(msg.payload, "text/html");
  return html ? htmlToText(decode(html.body?.data)) : "";
}

export function attachmentCount(part: GmailPart | undefined, depth = 0): number {
  if (!part || depth > 12) {
    return 0;
  }
  const self = part.filename && part.body?.attachmentId ? 1 : 0;
  return self + (part.parts ?? []).reduce((n, p) => n + attachmentCount(p, depth + 1), 0);
}

/** RFC 2047 encoded-word for non-ASCII header text; CR/LF removed (no header injection). */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  // oxlint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function composeRaw(input: {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}): string {
  if (input.to.length === 0) {
    throw new ConnectorError("bad_request", "to needs at least one address");
  }
  const lines = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
