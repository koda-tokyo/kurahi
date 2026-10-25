// Small parsing helpers shared by the work queue policy sections (rules, routes, access).

import type { WorkItemType } from "./types.js";
import { WORK_ITEM_TYPES } from "./types.js";

export type Text = { ja?: string; en?: string };

export const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A principal as the gateway names it: `device:<id>`, `pair:<fingerprint>`, `owner`, … */
export const PRINCIPAL_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}$/;

export function text(raw: unknown): Text {
  if (typeof raw === "string") {
    return { en: raw.slice(0, 200) };
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(typeof r.ja === "string" ? { ja: r.ja.slice(0, 200) } : {}),
    ...(typeof r.en === "string" ? { en: r.en.slice(0, 200) } : {}),
  };
}

export function num(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function strList(raw: unknown, re: RegExp): string[] {
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string" && re.test(v))
    : [];
}

export function types(raw: unknown): WorkItemType[] {
  return Array.isArray(raw)
    ? raw.filter((v): v is WorkItemType => (WORK_ITEM_TYPES as readonly unknown[]).includes(v))
    : [];
}
