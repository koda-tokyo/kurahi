// Japanese personal identifier detector (APPI / マイナンバー法), docs/security/data-governance.md.
//
// Pure functions: no config, no I/O. Detects
//   my_number          個人番号: 12 digits whose check digit validates (番号法施行令 第8条)
//   corporate_number   法人番号: 13 digits whose leading check digit validates; public, never
//                      personal data, reported so a 13-digit number is never taken for a 個人番号
//   residence_card     在留カード番号: 2 letters + 8 digits + 2 letters
//   passport           旅券番号: 2 letters + 7 digits
//   bank_account       口座番号: 7 digits after 口座 / 普通 / 当座 / 支店 / 店番 (optionally after a
//                      3-digit 支店 code)
//   phone              Japanese phone numbers (0X…, 0X0 mobile, +81)
//   email
//
// Full-width digits, letters and dashes (０-９, Ａ-Ｚ, －, ー, ‐) are matched as their ASCII forms;
// positions are UTF-16 offsets into the original text (the normalisation is one-for-one).

import { createHmac } from "node:crypto";

export const PERSONAL_DATA_KINDS = [
  "my_number",
  "corporate_number",
  "residence_card",
  "passport",
  "bank_account",
  "phone",
  "email",
] as const;
export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

/** Kinds that are personal data under APPI (法人番号 is published by the NTA and is not). */
export const PERSONAL_KINDS: ReadonlySet<PersonalDataKind> = new Set([
  "my_number",
  "residence_card",
  "passport",
  "bank_account",
  "phone",
  "email",
]);

export type PersonalDataFinding = {
  kind: PersonalDataKind;
  /** UTF-16 offsets into the scanned text, end exclusive. */
  start: number;
  end: number;
  /** The matched text (never written to audit or evidence; see `findingDigest`). */
  value: string;
};

const DASHES = /[‐-―−ー－ｰ]/g;

/** One-for-one ASCII folding of full-width digits, letters, @, dot and dashes. */
export function foldWidth(text: string): string {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(DASHES, "-");
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

/** 個人番号 check digit (12th digit) for the first 11 digits. */
export function myNumberCheckDigit(first11: string): number {
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = Number(first11[11 - n]);
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const r = sum % 11;
  return r <= 1 ? 0 : 11 - r;
}

export function isValidMyNumber(raw: string): boolean {
  const d = digitsOf(foldWidth(raw));
  return /^\d{12}$/.test(d) && myNumberCheckDigit(d.slice(0, 11)) === Number(d[11]);
}

/** 法人番号 check digit (leading digit) for the 12-digit base. */
export function corporateNumberCheckDigit(base12: string): number {
  let sum = 0;
  for (let n = 1; n <= 12; n++) {
    const p = Number(base12[12 - n]);
    sum += p * (n % 2 === 1 ? 1 : 2);
  }
  return 9 - (sum % 9);
}

export function isValidCorporateNumber(raw: string): boolean {
  const d = digitsOf(foldWidth(raw));
  return /^\d{13}$/.test(d) && corporateNumberCheckDigit(d.slice(1)) === Number(d[0]);
}

type Span = { start: number; end: number };

function overlaps(spans: Span[], s: Span): boolean {
  return spans.some((o) => s.start < o.end && o.start < s.end);
}

// Digit runs must not touch letters or digits: a hex digest or an id is never an identifier.
const CORPORATE_RE =
  /(?<![A-Za-z0-9-])\d[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?![A-Za-z0-9])|(?<![A-Za-z0-9])\d{13}(?![A-Za-z0-9])/g;
// Not preceded by a digit and a separator either: the tail of a longer grouped number.
const MY_NUMBER_RE = /(?<![A-Za-z0-9])(?<!\d[ -])\d{4}[ -]?\d{4}[ -]?\d{4}(?![ -]?\d)(?![A-Za-z])/g;
const RESIDENCE_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{8}[A-Z]{2}(?![A-Za-z0-9])/g;
const PASSPORT_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{7}(?![A-Za-z0-9])/g;
const BANK_RE =
  /(?:口座|普通|当座|貯蓄|支店|店番)[^\d\n]{0,12}((?:\d{3}[ -]?)?\d{7})(?![A-Za-z0-9])/g;
const PHONE_RE =
  /(?<![A-Za-z0-9+-])(?:\+81[ -]?\(?0?\)?\d{1,4}|\(?0\d{1,4}\)?)[ -]?\d{1,4}[ -]?\d{4}(?![A-Za-z0-9-])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

function phoneDigitsOk(m: string): boolean {
  const d = digitsOf(m);
  if (m.startsWith("+81")) {
    const rest = d.slice(2).replace(/^0/, "");
    return rest.length === 9 || rest.length === 10;
  }
  return d.startsWith("0") && (d.length === 10 || d.length === 11);
}

/** Every identifier in `text`, in order of position. */
export function detectPersonalData(text: string): PersonalDataFinding[] {
  if (!text) {
    return [];
  }
  const folded = foldWidth(text);
  const found: PersonalDataFinding[] = [];
  const taken: Span[] = [];
  const add = (kind: PersonalDataKind, start: number, end: number) => {
    const span = { start, end };
    if (overlaps(taken, span)) {
      return;
    }
    taken.push(span);
    found.push({ kind, start, end, value: text.slice(start, end) });
  };
  for (const m of folded.matchAll(CORPORATE_RE)) {
    if (isValidCorporateNumber(m[0])) {
      add("corporate_number", m.index, m.index + m[0].length);
    }
  }
  for (const m of folded.matchAll(MY_NUMBER_RE)) {
    if (isValidMyNumber(m[0])) {
      add("my_number", m.index, m.index + m[0].length);
    }
  }
  for (const m of folded.matchAll(RESIDENCE_RE)) {
    add("residence_card", m.index, m.index + m[0].length);
  }
  for (const m of folded.matchAll(PASSPORT_RE)) {
    add("passport", m.index, m.index + m[0].length);
  }
  for (const m of folded.matchAll(BANK_RE)) {
    const digits = m[1];
    const start = m.index + m[0].length - digits.length;
    add("bank_account", start, start + digits.length);
  }
  for (const m of folded.matchAll(PHONE_RE)) {
    if (phoneDigitsOk(m[0])) {
      add("phone", m.index, m.index + m[0].length);
    }
  }
  for (const m of folded.matchAll(EMAIL_RE)) {
    add("email", m.index, m.index + m[0].length);
  }
  return found.toSorted((a, b) => a.start - b.start);
}

export const REDACTION_LABELS: Record<PersonalDataKind, string> = {
  my_number: "[マイナンバー]",
  corporate_number: "[法人番号]",
  residence_card: "[在留カード番号]",
  passport: "[旅券番号]",
  bank_account: "[口座番号]",
  phone: "[電話番号]",
  email: "[メールアドレス]",
};

/**
 * Replace identifiers with labels. `kinds` limits what is replaced (default: every personal
 * kind; 法人番号 is kept unless named).
 */
export function redactPersonalData(
  text: string,
  kinds: ReadonlySet<PersonalDataKind> = PERSONAL_KINDS,
): { text: string; count: number } {
  const findings = detectPersonalData(text).filter((f) => kinds.has(f.kind));
  if (findings.length === 0) {
    return { text, count: 0 };
  }
  let out = "";
  let at = 0;
  for (const f of findings) {
    out += text.slice(at, f.start) + REDACTION_LABELS[f.kind];
    at = f.end;
  }
  return { text: out + text.slice(at), count: findings.length };
}

/**
 * Keyed digest of a finding for audit rows: the same identifier gives the same digest within one
 * installation (so a reviewer can tell repeats apart) but a 12-digit number cannot be recovered
 * by enumerating digests without the installation key.
 */
export function findingDigest(
  key: Buffer | string,
  f: Pick<PersonalDataFinding, "kind" | "value">,
) {
  const canonical =
    f.kind === "email" ? f.value.trim().toLowerCase() : digitsOf(foldWidth(f.value)) || f.value;
  return createHmac("sha256", key).update(`${f.kind}:${canonical}`).digest("hex").slice(0, 32);
}

/** Walk string leaves of a JSON-like value (bounded), with a dotted field path. */
export function walkStrings(
  value: unknown,
  visit: (text: string, field: string) => void,
  field = "",
  depth = 0,
): void {
  if (depth > 8) {
    return;
  }
  if (typeof value === "string") {
    visit(value, field || "$");
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((v, i) => walkStrings(v, visit, `${field}[${i}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      walkStrings(v, visit, field ? `${field}.${k}` : k, depth + 1);
    }
  }
}
