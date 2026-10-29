// Governance state: where holds, policy overrides, exports, reports and tombstones live, plus the
// signing helpers every governance record shares. Nothing runs at import time.
//
//   <KOLO_HOME>/governance/policy.json            per-Project overrides (retention, personal data)
//   <KOLO_HOME>/governance/holds.json             legal holds (active and released)
//   <KOLO_HOME>/governance/sweep-state.json       last scheduled sweep (UTC day)
//   <KOLO_HOME>/governance/exports/<id>.json      export job status; <id>.zip the signed archive
//   <KOLO_HOME>/governance/dsr/<id>.json          data subject request reports (no raw identifier)
//   <KOLO_HOME>/governance/pd.key                 HMAC key for identifier digests (0600)
//   <KOLO_HOME>/evidence/_tombstones/<jobId>.json signed tombstones of deleted job evidence
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ManifestSigner } from "../continuity-suite/types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { canonicalJson, loadSigningKey, signerFromKey } from "../continuity-suite/manifest.js";
import {
  deriveDeviceIdFromPublicKey,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";

export type GovernanceHome = { home?: string };

export function governanceHome(opts: GovernanceHome = {}): string {
  return opts.home ?? resolveKoloHome();
}

export function governanceDir(home: string): string {
  return path.join(home, "governance");
}

export function auditDirOf(home: string): string {
  return path.join(home, "audit");
}

export function evidenceRootOf(home: string): string {
  return path.join(home, "evidence");
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function newGovernanceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

const ID_RE = /^[a-z]{2,8}-[a-z0-9]{8,32}$/;
export function isGovernanceId(id: unknown, prefix?: string): id is string {
  return (
    typeof id === "string" &&
    ID_RE.test(id) &&
    (prefix === undefined || id.startsWith(`${prefix}-`))
  );
}

/** The installation HMAC key for identifier digests (created on first use, mode 0600). */
export function personalDataKey(home: string): Buffer {
  const file = path.join(governanceDir(home), "pd.key");
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 32) {
      return buf;
    }
  } catch {
    // created below
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch {
    return fs.readFileSync(file);
  }
}

// ── signed records ──────────────────────────────────────────────────────────────────────────

export type Signed<T> = T & { signer: ManifestSigner; signature: string };

function signingInput(kind: string, body: unknown): string {
  return `kolo-governance-${kind}\n${canonicalJson(body)}`;
}

/** Sign `body` with the installation's evidence key (Ed25519, same key as evidence manifests). */
export function signRecord<T extends Record<string, unknown>>(
  kind: string,
  body: T,
  home: string,
): Signed<T> {
  const key = loadSigningKey(home);
  return {
    ...body,
    signer: signerFromKey(key),
    signature: signDevicePayload(key.privateKeyPem, signingInput(kind, body)),
  };
}

/** Check a record signed by {@link signRecord}; any signer whose key id matches its key. */
export function verifyRecord(kind: string, record: unknown): boolean {
  if (!record || typeof record !== "object") {
    return false;
  }
  const { signer, signature, ...body } = record as Signed<Record<string, unknown>>;
  if (signer?.alg !== "ed25519" || typeof signature !== "string") {
    return false;
  }
  if (deriveDeviceIdFromPublicKey(signer.publicKey) !== signer.keyId) {
    return false;
  }
  try {
    return verifyDeviceSignature(signer.publicKey, signingInput(kind, body), signature);
  } catch {
    return false;
  }
}
