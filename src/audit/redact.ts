// Redaction for audit entries (KoLo 2.0, M2b).
//
// Applied twice: when an entry is appended (secret values never reach disk) and again when
// `kurahi audit tail` prints (defence in depth for entries written by older code).

import { redactPersonalData, type PersonalDataKind } from "../governance/personal-data.js";
import { redactSensitiveText } from "../logging/redact.js";

const SECRET_KEY_RE =
  /(token|secret|password|passwd|passphrase|authorization|cookie|credential|api[-_]?key|private[-_]?key|bearer|otp)/i;
// Hash-like fields are evidence, not secrets.
const SAFE_KEY_RE = /^(sha256|hash|prev|lineHash|from|to|keyId)$/i;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_KEYS = 64;
const MAX_STRING = 2000;

export const REDACTED = "[redacted]";

// Personal identifiers (docs/security/data-governance.md#personal-data): a valid マイナンバー is
// always masked in audit rows and evidence events; `governance.personalData.redactLogs` masks
// every personal kind the detector knows.
const MY_NUMBER_ONLY: ReadonlySet<PersonalDataKind> = new Set(["my_number"]);
let personalKinds: ReadonlySet<PersonalDataKind> = MY_NUMBER_ONLY;

export function setAuditPersonalDataRedaction(kinds: "my_number" | "all"): void {
  personalKinds =
    kinds === "all"
      ? new Set(["my_number", "residence_card", "passport", "bank_account", "phone", "email"])
      : MY_NUMBER_ONLY;
}

function redactString(value: string): string {
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  const masked =
    /[0-9\uFF10-\uFF19]{4}/.test(clipped) || personalKinds !== MY_NUMBER_ONLY
      ? redactPersonalData(clipped, personalKinds).text
      : clipped;
  return redactSensitiveText(masked, { mode: "tools" });
}

export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= MAX_DEPTH) {
    return "[depth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => redactAuditValue(v, depth + 1));
  }
  if (value instanceof Error) {
    return redactString(value.message);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) {
        out["…"] = "truncated";
        break;
      }
      if (!SAFE_KEY_RE.test(k) && SECRET_KEY_RE.test(k)) {
        out[k] = v === undefined || v === null || v === "" ? (v ?? null) : REDACTED;
        continue;
      }
      out[k] = redactAuditValue(v, depth + 1);
    }
    return out;
  }
  return typeof value === "symbol" ? value.toString() : "[unserializable]";
}
