// Supply-chain lock (OWASP ASI04). <KOLO_HOME>/integrity/supply-chain.lock.json pins the content
// digest (src/integrity/supply-chain-hash.ts) of every approved skill and plugin package; the
// gate (supply-chain-gate.ts) compares what the loader is about to read against it.
//
// The lock is signed with the local owner key (the same Ed25519 key and owners.json as the
// policy attestation, src/policy/attestation.ts) under its own signing domain, into a detached
// `supply-chain.lock.json.sig`. Trust:
//   signed by a pinned owner   trusted
//   no owners pinned at all    trusted with a warning (unsigned installs keep working)
//   owners pinned, no/bad sig  untrusted: enforce refuses every non-bundled artifact
// It lives under <KOLO_HOME>/integrity, which the write policy (write-policy.ts) already denies
// to agent tools; `kurahi skills pin` is the operator path.

import fs from "node:fs";
import path from "node:path";
import {
  SUPPLY_CHAIN_SIGNING_DOMAIN,
  addOwner,
  loadOrCreateOwnerKey,
  readOwners,
  signPolicyFile,
  verifyPolicyAttestation,
} from "../policy/attestation.js";
import { resolvePolicyLocations } from "../policy/paths.js";
import { resolveIntegrityLocations } from "./registry.js";

export const SUPPLY_CHAIN_LOCK_VERSION = 1;

export type SupplyChainKind = "skill" | "plugin";

export type SupplyChainLockEntry = {
  kind: SupplyChainKind;
  name: string;
  /** Where it was pinned from (informational; the digest is what is compared). */
  path: string;
  sha256: string;
  files: number;
  bytes: number;
  pinnedAt: string;
  /** Static scan findings at pin time (rule ids) and whether `--force` accepted them. */
  scan?: { findings: string[]; forced: boolean };
};

export type SupplyChainLock = {
  version: number;
  updatedAt: string;
  /** Keyed by `<kind>:<name>`. */
  entries: Record<string, SupplyChainLockEntry>;
};

export type SupplyChainLocations = {
  lockPath: string;
  signaturePath: string;
  ownersPath: string;
  ownerKeyPath: string;
};

export type LockTrust = "signed" | "unsigned" | "untrusted" | "missing";

export type LockState = {
  lock: SupplyChainLock | null;
  trust: LockTrust;
  reason?: string;
  keyId?: string;
};

export function resolveSupplyChainLocations(
  env: NodeJS.ProcessEnv = process.env,
): SupplyChainLocations {
  const integrity = resolveIntegrityLocations(env);
  const policy = resolvePolicyLocations(env);
  const lockPath = path.join(integrity.dir, "supply-chain.lock.json");
  return {
    lockPath,
    signaturePath: `${lockPath}.sig`,
    ownersPath: policy.ownersPath,
    ownerKeyPath: policy.ownerKeyPath,
  };
}

export function lockKey(kind: SupplyChainKind, name: string): string {
  return `${kind}:${name}`;
}

export function emptyLock(now: Date = new Date()): SupplyChainLock {
  return { version: SUPPLY_CHAIN_LOCK_VERSION, updatedAt: now.toISOString(), entries: {} };
}

function parseLock(raw: string): SupplyChainLock | null {
  try {
    const parsed = JSON.parse(raw) as SupplyChainLock;
    if (!parsed || typeof parsed.entries !== "object" || parsed.entries === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function statStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return "absent";
  }
}

let stateCache: { key: string; state: LockState } | null = null;

/** Read the lock and decide how far to trust it (cached on the lock, sig and owners stats). */
export function readLockState(
  loc: SupplyChainLocations = resolveSupplyChainLocations(),
): LockState {
  const key = [loc.lockPath, loc.signaturePath, loc.ownersPath]
    .map((f) => `${f}=${statStamp(f)}`)
    .join("|");
  if (stateCache?.key === key) {
    return stateCache.state;
  }
  const state = computeLockState(loc);
  stateCache = { key, state };
  return state;
}

function computeLockState(loc: SupplyChainLocations): LockState {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(loc.lockPath);
  } catch {
    return { lock: null, trust: "missing" };
  }
  const lock = parseLock(bytes.toString("utf8"));
  if (!lock) {
    return { lock: null, trust: "untrusted", reason: "lock file is not valid JSON" };
  }
  const att = verifyPolicyAttestation({
    policyBytes: bytes,
    signaturePath: loc.signaturePath,
    ownersPath: loc.ownersPath,
    domain: SUPPLY_CHAIN_SIGNING_DOMAIN,
  });
  const ownersPinned = (readOwners(loc.ownersPath)?.owners.length ?? 0) > 0;
  if (att.state === "signed") {
    return { lock, trust: "signed", keyId: att.keyId };
  }
  if (!ownersPinned && (att.state === "unsigned" || att.state === "no-owners")) {
    return { lock, trust: "unsigned", reason: "no owner keys are pinned; the lock is unsigned" };
  }
  return {
    lock,
    trust: "untrusted",
    keyId: att.keyId,
    reason: `lock signature: ${att.state}${att.reason ? ` (${att.reason})` : ""}`,
  };
}

export function clearLockStateCache(): void {
  stateCache = null;
}

export type WriteLockResult = { signed: boolean; keyId: string; ownerPinned: boolean };

/**
 * Operator action: write the lock and sign it with the local owner key. The key is created on
 * first use and pinned as an owner when no owner is pinned yet (same as `kurahi policy init`).
 */
export function writeLock(
  lock: SupplyChainLock,
  loc: SupplyChainLocations = resolveSupplyChainLocations(),
  now: Date = new Date(),
): WriteLockResult {
  const next: SupplyChainLock = {
    version: SUPPLY_CHAIN_LOCK_VERSION,
    updatedAt: now.toISOString(),
    entries: Object.fromEntries(
      Object.entries(lock.entries).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  fs.mkdirSync(path.dirname(loc.lockPath), { recursive: true, mode: 0o700 });
  const tmp = `${loc.lockPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, loc.lockPath);

  const key = loadOrCreateOwnerKey(loc.ownerKeyPath);
  const owners = readOwners(loc.ownersPath);
  let ownerPinned = false;
  if (!owners || owners.owners.length === 0) {
    ownerPinned = addOwner(loc.ownersPath, { publicKey: key.publicKey, label: "local owner" }, now);
  }
  signPolicyFile({
    policyPath: loc.lockPath,
    signaturePath: loc.signaturePath,
    key,
    now,
    domain: SUPPLY_CHAIN_SIGNING_DOMAIN,
  });
  clearLockStateCache();
  const trusted = readOwners(loc.ownersPath)?.owners.some((o) => o.keyId === key.keyId) ?? false;
  return { signed: trusted, keyId: key.keyId, ownerPinned };
}
