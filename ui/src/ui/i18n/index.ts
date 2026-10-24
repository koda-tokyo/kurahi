// Control UI locale system: a catalogue keyed by message ID, any number of locales.
//
// Resolution order: the user's choice (Settings / the sidebar switch, stored per browser), then
// the organisation default from config (`gateway.controlUi.defaultLocale`), then the OS/browser
// locale, then English. A message missing from a locale falls back to English, then to its ID.
//
// v0.2 ships ja and en. Further locales (zh-Hans, ko, vi, pt-BR, id, es, fr, ms) are added after
// native review: add a catalogue file and one LOCALES entry. Never machine translate.
import { en, enOne, type MessageId } from "./en";
import { ja } from "./ja";

export type { MessageId } from "./en";

export type LocaleInfo = {
  /** BCP 47 tag. */
  id: string;
  /** The language's own name, shown in the switcher. */
  label: string;
  /** The CSS font family to prefer for this locale. */
  font: "jp" | "sc" | "kr" | "latin";
};

export const LOCALES: readonly LocaleInfo[] = [
  { id: "ja", label: "日本語", font: "jp" },
  { id: "en", label: "English", font: "latin" },
];

const CATALOGUES: Record<string, Partial<Record<MessageId, string>>> = { en, ja };

/** Singular forms per locale (see `enOne`). */
const SINGULAR: Record<string, Partial<Record<MessageId, string>>> = { en: enOne };

export const DEFAULT_LOCALE = "en";

let current = DEFAULT_LOCALE;

export function isSupportedLocale(id: unknown): id is string {
  return typeof id === "string" && LOCALES.some((l) => l.id === id);
}

/** Best supported locale for a list of preferences (BCP 47 tags), or null. */
export function matchLocale(preferred: readonly (string | null | undefined)[]): string | null {
  for (const raw of preferred) {
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }
    const lower = raw.trim().replace(/_/g, "-").toLowerCase();
    const exact = LOCALES.find((l) => l.id.toLowerCase() === lower);
    if (exact) {
      return exact.id;
    }
    const base = lower.split("-")[0];
    const byBase = LOCALES.find((l) => l.id.toLowerCase().split("-")[0] === base);
    if (byBase) {
      return byBase.id;
    }
  }
  return null;
}

export function resolveLocale(opts: {
  user?: string | null;
  org?: string | null;
  os?: readonly string[];
}): string {
  return (
    matchLocale([opts.user]) ??
    matchLocale([opts.org]) ??
    matchLocale(opts.os ?? []) ??
    DEFAULT_LOCALE
  );
}

export function osLocales(): string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const list = Array.isArray(navigator.languages) ? [...navigator.languages] : [];
  if (navigator.language) {
    list.push(navigator.language);
  }
  return list;
}

export function setLocale(id: string): void {
  current = isSupportedLocale(id) ? id : DEFAULT_LOCALE;
  if (typeof document !== "undefined") {
    document.documentElement.lang = current;
    const info = LOCALES.find((l) => l.id === current);
    document.documentElement.dataset.script = info?.font ?? "latin";
  }
}

export function getLocale(): string {
  return current;
}

/** Translate a message; `{name}` placeholders are filled from `params`. */
export function t(
  id: MessageId,
  params?: Record<string, string | number>,
  locale = current,
): string {
  const singular = params?.count === 1 ? SINGULAR[locale]?.[id] : undefined;
  const text = singular ?? CATALOGUES[locale]?.[id] ?? en[id] ?? id;
  if (!params) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m));
}

/** IDs a locale has not translated yet (for review tooling and tests). */
export function missingMessages(locale: string): MessageId[] {
  const cat = CATALOGUES[locale] ?? {};
  return (Object.keys(en) as MessageId[]).filter((id) => cat[id] == null);
}
