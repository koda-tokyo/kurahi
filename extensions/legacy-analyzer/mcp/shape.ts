// Response shaping: every fact gets an `at: "path:line"` (project-root relative), large arrays are
// paginated (`offset`/`limit`, the same window over every top-level list), and the serialized
// result is held under a byte cap: the page shrinks first, then long strings are clipped, and
// when nothing fits the response says so instead of returning a partial JSON document.

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
const CLIP_AT = 2000;

/** Add `at: "path:line"` to every object with `file` (string) and `line` (number). */
export function annotateLocations(
  value: unknown,
  toProjectPath: (file: string) => string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => annotateLocations(v, toProjectPath));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = annotateLocations(v, toProjectPath);
  }
  if (typeof obj.file === "string" && typeof obj.line === "number" && !("at" in obj)) {
    const p = toProjectPath(obj.file);
    out.at = obj.line > 0 ? `${p}:${obj.line}` : p;
  }
  return out;
}

export type PageInfo = {
  offset: number;
  limit: number;
  /** Length of the longest paginated list. */
  total: number;
  /** Lists that were paginated, with their full lengths. */
  lists: Record<string, number>;
  nextOffset: number | null;
};

function window(value: unknown, offset: number, limit: number): { data: unknown; page: PageInfo } {
  const lists: Record<string, number> = {};
  let data: unknown = value;
  if (Array.isArray(value)) {
    lists["(result)"] = value.length;
    data = value.slice(offset, offset + limit);
  } else if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        lists[k] = v.length;
        out[k] = v.slice(offset, offset + limit);
      } else {
        out[k] = v;
      }
    }
    data = out;
  }
  const total = Math.max(0, ...Object.values(lists));
  return {
    data,
    page: {
      offset,
      limit,
      total,
      lists,
      nextOffset: offset + limit < total ? offset + limit : null,
    },
  };
}

function clipStrings(value: unknown, at: number): { value: unknown; clipped: number } {
  let clipped = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && v.length > at) {
      clipped++;
      return `${v.slice(0, at)}… [clipped ${v.length - at} characters]`;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), clipped };
}

export type Shaped = {
  data: unknown;
  page: PageInfo;
  bytes: number;
  /** Set when the page was shrunk, strings were clipped, or nothing fit. */
  reduced?: { reason: string; clippedStrings?: number };
  /** True when not even one entry fit under the cap; `data` is null. */
  overflow: boolean;
};

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");

export function shapeResult(
  value: unknown,
  opts: { offset?: number; limit?: number; maxBytes: number },
): Shaped {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const asked = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  let limit = asked;
  let w = window(value, offset, limit);
  let bytes = size(w.data);
  while (bytes > opts.maxBytes && limit > 1 && w.page.total > 0) {
    limit = Math.max(1, Math.floor(limit / 2));
    w = window(value, offset, limit);
    bytes = size(w.data);
  }
  let reduced: Shaped["reduced"] =
    limit < asked
      ? { reason: `page reduced to ${limit} entries to stay under ${opts.maxBytes} bytes` }
      : undefined;
  if (bytes > opts.maxBytes) {
    const c = clipStrings(w.data, CLIP_AT);
    const clippedBytes = size(c.value);
    if (c.clipped > 0) {
      w = { ...w, data: c.value };
      bytes = clippedBytes;
      reduced = {
        reason: `${reduced ? `${reduced.reason}; ` : ""}long text clipped at ${CLIP_AT} characters`,
        clippedStrings: c.clipped,
      };
    }
  }
  if (bytes > opts.maxBytes) {
    return {
      data: null,
      page: w.page,
      bytes: 0,
      reduced: { reason: `result exceeds ${opts.maxBytes} bytes even at one entry per page` },
      overflow: true,
    };
  }
  return { data: w.data, page: w.page, bytes, reduced, overflow: false };
}

export function pageLine(page: PageInfo): string {
  if (page.total === 0 || Object.keys(page.lists).length === 0) {
    return "";
  }
  const end = Math.min(page.total, page.offset + page.limit);
  const from = page.total === 0 ? 0 : Math.min(page.offset + 1, page.total);
  const next = page.nextOffset === null ? "last page" : `next offset ${page.nextOffset}`;
  return `Entries ${from}-${end} of ${page.total} (${next}).`;
}
