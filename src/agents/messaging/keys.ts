// Per-agent message signing keys and the owner-signed agent key registry (OWASP ASI07).
//
// <KOLO_HOME>/secrets/agent-keys/<agentId>.json   Ed25519 identity of one agent (0600, dir 0700)
// <KOLO_HOME>/identity/agent-keys.json            registry: agent id -> public key, signed by the
//                                                 policy owner key (src/policy/attestation.ts)
//
// A key is created the first time its agent sends an inter-agent message. The registry is only
// trusted when its signature verifies under a pinned policy owner (`policy/owners.json`), or,
// when no owner is pinned yet, under the local owner key. Private keys are never logged.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  deriveDeviceIdFromPublicKey,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "../../infra/device-identity.js";
import {
  loadOrCreateOwnerKey,
  readOwnerKey,
  readOwners,
  sha256Hex,
} from "../../policy/attestation.js";
import { resolvePolicyLocations } from "../../policy/paths.js";

const REGISTRY_DOMAIN = "kolo-agent-registry-v1";
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type AgentKeyLocations = {
  /** `<KOLO_HOME>/secrets/agent-keys` */
  keysDir: string;
  /** `<KOLO_HOME>/identity/agent-keys.json` */
  registryPath: string;
  /** Policy owner key (signs the registry). */
  ownerKeyPath: string;
  /** Pinned policy owners (trust anchor for the registry). */
  ownersPath: string;
};

export type AgentKey = { agentId: string; keyId: string; publicKey: string; privateKeyPem: string };

export type AgentRegistryEntry = {
  agentId: string;
  keyId: string;
  publicKey: string;
  addedAt: string;
};

export type AgentRegistrySignature = {
  alg: "ed25519";
  keyId: string;
  publicKey: string;
  sha256: string;
  signedAt: string;
  signature: string;
};

export type AgentRegistry = {
  version: 1;
  agents: AgentRegistryEntry[];
  signature?: AgentRegistrySignature;
};

export type RegistryVerification =
  | { ok: true; agents: Map<string, AgentRegistryEntry>; signerKeyId: string }
  | { ok: false; reason: string };

export function resolveAgentKeyLocations(env: NodeJS.ProcessEnv = process.env): AgentKeyLocations {
  const home = resolveStateDir(env);
  const policy = resolvePolicyLocations(env);
  return {
    keysDir: path.join(home, "secrets", "agent-keys"),
    registryPath: path.join(home, "identity", "agent-keys.json"),
    ownerKeyPath: policy.ownerKeyPath,
    ownersPath: policy.ownersPath,
  };
}

export function isValidAgentKeyId(agentId: string): boolean {
  return AGENT_ID_RE.test(agentId);
}

function agentKeyPath(loc: AgentKeyLocations, agentId: string): string {
  if (!isValidAgentKeyId(agentId)) {
    throw new Error(`invalid agent id for a signing key: ${JSON.stringify(agentId)}`);
  }
  return path.join(loc.keysDir, `${agentId}.json`);
}

/** The agent's signing key; created (0600) on first use. */
export function loadOrCreateAgentKey(loc: AgentKeyLocations, agentId: string): AgentKey {
  const file = agentKeyPath(loc, agentId);
  fs.mkdirSync(loc.keysDir, { recursive: true, mode: 0o700 });
  const id = loadOrCreateDeviceIdentity(file);
  const publicKey = publicKeyRawBase64UrlFromPem(id.publicKeyPem);
  return {
    agentId,
    keyId: deriveDeviceIdFromPublicKey(publicKey) ?? "",
    publicKey,
    privateKeyPem: id.privateKeyPem,
  };
}

function canonicalEntries(agents: AgentRegistryEntry[]): string {
  return JSON.stringify(
    agents
      .map((a) => ({
        agentId: a.agentId,
        keyId: a.keyId,
        publicKey: a.publicKey,
        addedAt: a.addedAt,
      }))
      .toSorted((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)),
  );
}

function registrySigningInput(sha256: string, signedAt: string): string {
  return `${REGISTRY_DOMAIN}\n${sha256}\n${signedAt}`;
}

export function readAgentRegistry(registryPath: string): AgentRegistry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as AgentRegistry;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.agents)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeRegistry(registryPath: string, registry: AgentRegistry): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  const tmp = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, registryPath);
}

/** Owner keys a registry signature may come from: pinned owners, else the local owner key. */
function registryTrustAnchors(loc: AgentKeyLocations): Set<string> {
  const pinned = readOwners(loc.ownersPath)?.owners ?? [];
  if (pinned.length > 0) {
    return new Set(pinned.map((o) => o.keyId));
  }
  const local = readOwnerKey(loc.ownerKeyPath);
  return new Set(local ? [local.keyId] : []);
}

/**
 * Make sure `key` is in the registry and re-sign it with the local owner key when it changed.
 * Throws when the local owner key is not a pinned owner (the registry would not be trusted).
 */
export function registerAgentKey(
  loc: AgentKeyLocations,
  key: AgentKey,
  now: Date = new Date(),
): { changed: boolean } {
  const current = readAgentRegistry(loc.registryPath) ?? { version: 1 as const, agents: [] };
  const existing = current.agents.find((a) => a.agentId === key.agentId);
  if (existing?.keyId === key.keyId && current.signature && verifyAgentRegistry(loc).ok) {
    return { changed: false };
  }
  const owner = loadOrCreateOwnerKey(loc.ownerKeyPath);
  if (!registryTrustAnchors(loc).has(owner.keyId)) {
    throw new Error(
      "the local owner key is not a pinned policy owner; cannot sign the agent key registry",
    );
  }
  const agents = current.agents.filter((a) => a.agentId !== key.agentId);
  agents.push({
    agentId: key.agentId,
    keyId: key.keyId,
    publicKey: key.publicKey,
    addedAt: now.toISOString(),
  });
  const sha256 = sha256Hex(canonicalEntries(agents));
  const signedAt = now.toISOString();
  writeRegistry(loc.registryPath, {
    version: 1,
    agents,
    signature: {
      alg: "ed25519",
      keyId: owner.keyId,
      publicKey: owner.publicKey,
      sha256,
      signedAt,
      signature: signDevicePayload(owner.privateKeyPem, registrySigningInput(sha256, signedAt)),
    },
  });
  return { changed: true };
}

/** Load (creating on demand) the agent's key and make sure the registry lists it. */
export function ensureAgentSigningKey(
  agentId: string,
  opts: { loc?: AgentKeyLocations; now?: Date } = {},
): AgentKey & { registered: boolean } {
  const loc = opts.loc ?? resolveAgentKeyLocations();
  const key = loadOrCreateAgentKey(loc, agentId);
  const { changed } = registerAgentKey(loc, key, opts.now);
  return { ...key, registered: changed };
}

/** Verify the registry signature against the trust anchors. Pure apart from reads. */
export function verifyAgentRegistry(loc: AgentKeyLocations): RegistryVerification {
  const registry = readAgentRegistry(loc.registryPath);
  if (!registry) {
    return { ok: false, reason: "no agent key registry" };
  }
  const sig = registry.signature;
  if (!sig || sig.alg !== "ed25519") {
    return { ok: false, reason: "agent key registry is not signed" };
  }
  if (sig.sha256 !== sha256Hex(canonicalEntries(registry.agents))) {
    return { ok: false, reason: "agent key registry changed since it was signed" };
  }
  if (deriveDeviceIdFromPublicKey(sig.publicKey) !== sig.keyId) {
    return { ok: false, reason: "registry signer keyId does not match its key" };
  }
  if (
    !verifyDeviceSignature(
      sig.publicKey,
      registrySigningInput(sig.sha256, sig.signedAt),
      sig.signature,
    )
  ) {
    return { ok: false, reason: "agent key registry signature does not verify" };
  }
  if (!registryTrustAnchors(loc).has(sig.keyId)) {
    return { ok: false, reason: "agent key registry is not signed by a trusted owner" };
  }
  const agents = new Map<string, AgentRegistryEntry>();
  for (const entry of registry.agents) {
    if (deriveDeviceIdFromPublicKey(entry.publicKey) === entry.keyId) {
      agents.set(entry.agentId, entry);
    }
  }
  return { ok: true, agents, signerKeyId: sig.keyId };
}

type CacheEntry = { stamp: string; result: RegistryVerification };
const registryCache = new Map<string, CacheEntry>();

function statStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** {@link verifyAgentRegistry}, cached until the registry, owners or owner key file changes. */
export function verifyAgentRegistryCached(loc: AgentKeyLocations): RegistryVerification {
  const stamp = [loc.registryPath, loc.ownersPath, loc.ownerKeyPath].map(statStamp).join("|");
  const cached = registryCache.get(loc.registryPath);
  if (cached?.stamp === stamp) {
    return cached.result;
  }
  const result = verifyAgentRegistry(loc);
  registryCache.set(loc.registryPath, { stamp, result });
  return result;
}
