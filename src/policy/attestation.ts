// Policy attestation (KoLo 2.0, M13a). The policy bytes are signed by an owner key (Ed25519,
// the same key format as device identities) into a detached `policy.yaml.sig`; the keys a
// signature may come from are pinned in `owners.json`. The runtime loads a document only when
// the signature verifies against the exact bytes on disk and the key is a pinned owner.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PolicyLocations } from "./paths.js";
import {
  deriveDeviceIdFromPublicKey,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";

export const SIGNATURE_VERSION = 1;
const SIGNING_DOMAIN = "kolo-policy-v1";
/** Domain for the supply-chain lock (src/integrity/supply-chain-lock.ts): never valid as a policy. */
export const SUPPLY_CHAIN_SIGNING_DOMAIN = "kolo-supply-chain-v1";

export type PolicySignature = {
  version: number;
  alg: "ed25519";
  /** sha256 of the raw public key (hex). */
  keyId: string;
  /** base64url raw Ed25519 public key. */
  publicKey: string;
  /** sha256 of the signed policy bytes (hex). */
  sha256: string;
  signedAt: string;
  signature: string;
};

export type PolicyOwner = { keyId: string; publicKey: string; label?: string; addedAt: string };
export type PolicyOwners = { version: number; owners: PolicyOwner[] };

export type OwnerKey = { keyId: string; publicKey: string; privateKeyPem: string };

export type AttestationState = "signed" | "unsigned" | "invalid" | "untrusted" | "no-owners";

export type AttestationResult = {
  state: AttestationState;
  keyId?: string;
  signedAt?: string;
  reason?: string;
};

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signingInput(sha256: string, signedAt: string, domain = SIGNING_DOMAIN): string {
  return `${domain}\n${sha256}\n${signedAt}`;
}

/** The local owner signing key; created (0600) on first use. */
export function loadOrCreateOwnerKey(keyPath: string): OwnerKey {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const id = loadOrCreateDeviceIdentity(keyPath);
  const publicKey = publicKeyRawBase64UrlFromPem(id.publicKeyPem);
  return {
    keyId: deriveDeviceIdFromPublicKey(publicKey) ?? "",
    publicKey,
    privateKeyPem: id.privateKeyPem,
  };
}

export function readOwnerKey(keyPath: string): OwnerKey | null {
  if (!fs.existsSync(keyPath)) {
    return null;
  }
  return loadOrCreateOwnerKey(keyPath);
}

export function readOwners(ownersPath: string): PolicyOwners | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownersPath, "utf8")) as PolicyOwners;
    if (!parsed || !Array.isArray(parsed.owners)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/** Pin a public key as an owner (idempotent by keyId). Returns true when it was new. */
export function addOwner(
  ownersPath: string,
  owner: { publicKey: string; label?: string },
  now: Date = new Date(),
): boolean {
  const keyId = deriveDeviceIdFromPublicKey(owner.publicKey);
  if (!keyId) {
    throw new Error("owner public key is not a valid Ed25519 key");
  }
  const current = readOwners(ownersPath) ?? { version: 1, owners: [] };
  if (current.owners.some((o) => o.keyId === keyId)) {
    return false;
  }
  current.owners.push({
    keyId,
    publicKey: owner.publicKey,
    ...(owner.label ? { label: owner.label } : {}),
    addedAt: now.toISOString(),
  });
  writeJsonAtomic(ownersPath, current, 0o600);
  return true;
}

/** Sign the exact bytes of `policyPath` and write the detached signature next to it. */
export function signPolicyFile(params: {
  policyPath: string;
  signaturePath: string;
  key: OwnerKey;
  now?: Date;
  /** Signing domain (default the policy domain); keeps one document's signature off another. */
  domain?: string;
}): PolicySignature {
  const bytes = fs.readFileSync(params.policyPath);
  const sha256 = sha256Hex(bytes);
  const signedAt = (params.now ?? new Date()).toISOString();
  const signature: PolicySignature = {
    version: SIGNATURE_VERSION,
    alg: "ed25519",
    keyId: params.key.keyId,
    publicKey: params.key.publicKey,
    sha256,
    signedAt,
    signature: signDevicePayload(
      params.key.privateKeyPem,
      signingInput(sha256, signedAt, params.domain),
    ),
  };
  writeJsonAtomic(params.signaturePath, signature, 0o600);
  return signature;
}

export function readSignature(signaturePath: string): PolicySignature | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(signaturePath, "utf8")) as PolicySignature;
    return parsed && typeof parsed.signature === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Verify `policyBytes` against the detached signature and the pinned owners. Pure apart from
 * reads. `owners` may be injected (tests, `kurahi policy verify --owners`).
 */
export function verifyPolicyAttestation(params: {
  policyBytes: Buffer;
  signaturePath: string;
  ownersPath: string;
  owners?: PolicyOwners | null;
  domain?: string;
}): AttestationResult {
  if (!fs.existsSync(params.signaturePath)) {
    return { state: "unsigned", reason: "no signature file" };
  }
  const sig = readSignature(params.signaturePath);
  if (!sig) {
    return { state: "invalid", reason: "signature file is not valid JSON" };
  }
  const actual = sha256Hex(params.policyBytes);
  if (sig.sha256 !== actual) {
    return {
      state: "invalid",
      keyId: sig.keyId,
      signedAt: sig.signedAt,
      reason: "policy bytes changed since it was signed",
    };
  }
  if (sig.alg !== "ed25519" || deriveDeviceIdFromPublicKey(sig.publicKey) !== sig.keyId) {
    return { state: "invalid", keyId: sig.keyId, reason: "signer keyId does not match its key" };
  }
  if (
    !verifyDeviceSignature(
      sig.publicKey,
      signingInput(sig.sha256, sig.signedAt, params.domain),
      sig.signature,
    )
  ) {
    return {
      state: "invalid",
      keyId: sig.keyId,
      signedAt: sig.signedAt,
      reason: "signature does not verify",
    };
  }
  const owners = params.owners === undefined ? readOwners(params.ownersPath) : params.owners;
  if (!owners || owners.owners.length === 0) {
    return {
      state: "no-owners",
      keyId: sig.keyId,
      signedAt: sig.signedAt,
      reason: "no pinned owner keys",
    };
  }
  if (!owners.owners.some((o) => o.keyId === sig.keyId)) {
    return {
      state: "untrusted",
      keyId: sig.keyId,
      signedAt: sig.signedAt,
      reason: "signer is not a pinned owner",
    };
  }
  return { state: "signed", keyId: sig.keyId, signedAt: sig.signedAt };
}

export function attestationFor(loc: PolicyLocations, policyBytes: Buffer): AttestationResult {
  return verifyPolicyAttestation({
    policyBytes,
    signaturePath: loc.signaturePath,
    ownersPath: loc.ownersPath,
  });
}
