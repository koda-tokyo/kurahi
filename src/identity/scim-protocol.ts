// SCIM 2.0 wire helpers: schema URNs, the error body, JSON body reading, the `eq` filter and
// pagination. Shared by the Users / Groups handler in scim.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

export const SCIM_BASE = "/scim/v2";
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const MAX_BODY = 1024 * 1024;
export const MAX_COUNT = 200;

export type Json = Record<string, unknown>;

export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: string | null,
    message: string,
  ) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/scim+json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, err: ScimError) {
  send(res, err.status, {
    schemas: [ERROR_SCHEMA],
    status: String(err.status),
    ...(err.scimType ? { scimType: err.scimType } : {}),
    detail: err.message,
  });
}

export async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY) {
      throw new ScimError(413, null, "request too large");
    }
    chunks.push(buf);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("not an object");
    }
    return v as Json;
  } catch {
    throw new ScimError(400, "invalidSyntax", "body must be a JSON object");
  }
}

export const str = (v: unknown, max = 256): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** SCIM booleans arrive as JSON booleans or (Entra ID) as "True" / "False". */
/**
 * SCIM attribute names are case-insensitive (RFC 7643 §2.1): the keys of `value` that match one of
 * `names` regardless of case are renamed to that spelling; other keys stay as they are. Two keys
 * folding to the same attribute (`active` and `Active`) are ambiguous: 400.
 */
export function foldKeys(value: unknown, names: readonly string[]): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const canonical = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) {
    const name = canonical.get(k.toLowerCase()) ?? k;
    if (Object.hasOwn(out, name)) {
      throw new ScimError(400, "invalidSyntax", `attribute ${name.slice(0, 64)} given twice`);
    }
    out[name] = v;
  }
  return out;
}

/** PatchOp message and operation attributes. */
export const PATCH_KEYS = ["schemas", "Operations"] as const;
export const PATCH_OP_KEYS = ["op", "path", "value"] as const;
/** Multi-valued attribute entries (emails, members). */
export const MULTI_VALUE_KEYS = ["value", "primary", "type", "display", "$ref"] as const;

export function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string" && /^(true|false)$/i.test(v)) {
    return v.toLowerCase() === "true";
  }
  return null;
}

/** `attr eq "value"`; the only filter form the provisioning clients use. */
export function parseEqFilter(
  raw: string | null,
  allowed: string[],
): { attr: string; value: string } | null {
  if (!raw) {
    return null;
  }
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  const attr = m ? allowed.find((a) => a.toLowerCase() === m[1].toLowerCase()) : undefined;
  if (!m || !attr) {
    throw new ScimError(
      400,
      "invalidFilter",
      `supported filters: ${allowed.map((a) => `${a} eq "…"`).join(", ")}`,
    );
  }
  return { attr, value: m[2].replace(/\\(.)/g, "$1") };
}

export function paginate<T>(
  items: T[],
  url: URL,
): { page: T[]; startIndex: number; total: number } {
  const start = Math.max(1, Number.parseInt(url.searchParams.get("startIndex") ?? "1", 10) || 1);
  const countRaw = Number.parseInt(url.searchParams.get("count") ?? String(MAX_COUNT), 10);
  const count = Math.min(Math.max(Number.isFinite(countRaw) ? countRaw : MAX_COUNT, 0), MAX_COUNT);
  return {
    page: items.slice(start - 1, start - 1 + count),
    startIndex: start,
    total: items.length,
  };
}
