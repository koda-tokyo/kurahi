// Business connectors: scope names and enforcement.
//
// Each tool declares the scope it needs; the call is refused before any request when the stored
// grant does not include it. Write scopes are separate opt-ins and never requested by default.
import { ConnectorError } from "./errors.js";

const RESOURCE_PREFIXES = [
  "https://graph.microsoft.com/",
  "https://www.googleapis.com/auth/",
  "https://mail.google.com/",
];

/** Short display name: `https://www.googleapis.com/auth/gmail.readonly` -> `gmail.readonly`. */
export function scopeName(scope: string): string {
  let s = scope.trim();
  for (const prefix of RESOURCE_PREFIXES) {
    if (s.toLowerCase().startsWith(prefix)) {
      s = s.slice(prefix.length) || "mail.google.com";
      break;
    }
  }
  return s;
}

function norm(scope: string): string {
  return scopeName(scope).toLowerCase();
}

/** Graph `.ReadWrite` implies `.Read` for the same resource; nothing else is implied. */
export function scopeSatisfied(granted: readonly string[], required: string): boolean {
  const want = norm(required);
  const have = new Set(granted.map(norm));
  if (have.has(want)) {
    return true;
  }
  if (want.endsWith(".read")) {
    return have.has(`${want.slice(0, -".read".length)}.readwrite`);
  }
  if (want.endsWith(".read.all")) {
    return have.has(`${want.slice(0, -".read.all".length)}.readwrite.all`);
  }
  return false;
}

export function assertScopes(granted: readonly string[], required: readonly string[]): void {
  const missing = required.filter((s) => !scopeSatisfied(granted, s));
  if (missing.length > 0) {
    throw new ConnectorError(
      "scope_missing",
      `missing permission: ${missing.map(scopeName).join(", ")}`,
    );
  }
}

/** Scope names safe for the status method: short names, a narrow charset, deduplicated. */
export function sanitizeScopeNames(scopes: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const s of scopes) {
    if (typeof s !== "string") {
      continue;
    }
    const name = scopeName(s);
    // `:` and `/` for provider scope names such as kintone `k:app_record:read` or Money Forward
    // `mfc/invoice/data.read`; never `//`, so a URL cannot pass as a scope name.
    if (/^[A-Za-z][A-Za-z0-9._:/-]{0,63}$/.test(name) && !name.includes("//")) {
      out.add(name);
    }
  }
  return [...out].toSorted();
}
