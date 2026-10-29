// Evidence tombstones (docs/security/data-governance.md#evidence-tombstones).
//
// Retention may delete an evidence bundle's events (they can hold redacted tool arguments and
// excerpts), but never the proof that the bundle existed and what it said. Deleting a bundle
// replaces it with a tombstone that keeps:
//
//   - the bundle's original signed manifest (jobId, status, times, event count, chain root, the
//     SHA-256 of every file, the recorder's Ed25519 signature): the signature still verifies,
//     because it covers the manifest fields, not the deleted bytes;
//   - the SHA-256 of the manifest file as it was on disk;
//   - for a work item bundle, the `prevBundle` / `prevRoot` its job.start named, so the item's
//     bundle chain (bundle N names bundle N-1's root) can still be walked across the gap;
//   - when, why (retention / data subject request) and the id of the signed deletion manifest;
//
// and is itself signed with the installation key. A verifier checks the tombstone signature, the
// original manifest signature, and the links; what it can no longer do is re-hash the events,
// which is exactly what was deleted.
//
//   job evidence        <KOLO_HOME>/evidence/_tombstones/<jobId>.json  (the job dir is removed)
//   work item evidence  <item>/evidence/<0001-action>/tombstone.json   (the dir keeps its name)
import fs from "node:fs";
import path from "node:path";
import type { ManifestSigner } from "../continuity-suite/types.js";
import type { EvidenceManifest } from "./types.js";
import {
  canonicalJson,
  loadSigningKey,
  sha256Hex,
  signerFromKey,
} from "../continuity-suite/manifest.js";
import {
  deriveDeviceIdFromPublicKey,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";
import {
  EVENTS_FILE,
  isSafeJobId,
  MANIFEST_FILE,
  readEventsFile,
  verifyEvidenceSignature,
} from "./store.js";

export const TOMBSTONE_FILE = "tombstone.json";
export const TOMBSTONES_DIR = "_tombstones";

export type EvidenceTombstoneBody = {
  v: 1;
  kind: "job" | "workitem";
  jobId: string;
  /** Work item bundle id (`0003-decide`); null for job evidence. */
  bundle: string | null;
  projectId: string | null;
  workItemId: string | null;
  /** The bundle's signed manifest exactly as recorded (null when it never got one). */
  manifest: EvidenceManifest | null;
  manifestSha256: string | null;
  /** Chain root of the deleted events (manifest.events.root, or recomputed for unsigned logs). */
  root: string | null;
  events: number;
  prevBundle: string | null;
  prevRoot: string | null;
  deletedAt: string;
  /** `retention` | `dsr` | `prune`. */
  cause: string;
  /** Deletion manifest (governance) that lists this bundle. */
  deletionManifest: string | null;
};

export type EvidenceTombstone = EvidenceTombstoneBody & {
  signer: ManifestSigner;
  signature: string;
};

function signingInput(body: EvidenceTombstoneBody): string {
  return `kolo-evidence-tombstone\n${canonicalJson(body)}`;
}

export type TombstoneCheck = {
  ok: boolean;
  signatureOk: boolean;
  manifestOk: boolean | null;
  problems: string[];
};

export function verifyTombstone(t: EvidenceTombstone): TombstoneCheck {
  const problems: string[] = [];
  const { signer, signature, ...body } = t;
  let signatureOk = false;
  if (signer?.alg === "ed25519" && deriveDeviceIdFromPublicKey(signer.publicKey) === signer.keyId) {
    try {
      signatureOk = verifyDeviceSignature(
        signer.publicKey,
        signingInput(body as EvidenceTombstoneBody),
        signature,
      );
    } catch {
      signatureOk = false;
    }
  }
  if (!signatureOk) {
    problems.push("tombstone signature does not verify");
  }
  let manifestOk: boolean | null = null;
  if (t.manifest) {
    const v = verifyEvidenceSignature(t.manifest, t.manifest.signer, t.manifest.signature);
    manifestOk = v.keyIdOk && v.signatureOk && t.manifest.events.root === t.root;
    if (!manifestOk) {
      problems.push("the recorded manifest signature does not verify");
    }
  }
  return { ok: signatureOk && manifestOk !== false, signatureOk, manifestOk, problems };
}

function readManifestRaw(dir: string): { manifest: EvidenceManifest | null; sha: string | null } {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILE));
    return { manifest: JSON.parse(raw.toString("utf8")) as EvidenceManifest, sha: sha256Hex(raw) };
  } catch {
    return { manifest: null, sha: null };
  }
}

function describeEvents(dir: string): {
  root: string | null;
  events: number;
  prevBundle: string | null;
  prevRoot: string | null;
  projectId: string | null;
} {
  try {
    const events = readEventsFile(path.join(dir, EVENTS_FILE));
    const start = events[0]?.type === "job.start" ? events[0].data : {};
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      root: events.at(-1)?.hash ?? null,
      events: events.length,
      prevBundle: str(start.prevBundle),
      prevRoot: str(start.prevRoot),
      projectId: str(start.projectId),
    };
  } catch {
    return { root: null, events: 0, prevBundle: null, prevRoot: null, projectId: null };
  }
}

function sign(body: EvidenceTombstoneBody, stateDir: string): EvidenceTombstone {
  const key = loadSigningKey(stateDir);
  return {
    ...body,
    signer: signerFromKey(key),
    signature: signDevicePayload(key.privateKeyPem, signingInput(body)),
  };
}

/** Describe a bundle dir as the tombstone that would replace it (nothing is written). */
export function tombstoneBodyFor(
  dir: string,
  meta: {
    kind: "job" | "workitem";
    jobId: string;
    bundle?: string | null;
    workItemId?: string | null;
    cause: string;
    deletionManifest?: string | null;
    now: Date;
  },
): EvidenceTombstoneBody {
  const { manifest, sha } = readManifestRaw(dir);
  const ev = describeEvents(dir);
  return {
    v: 1,
    kind: meta.kind,
    jobId: manifest?.jobId ?? meta.jobId,
    bundle: meta.bundle ?? null,
    projectId: ev.projectId,
    workItemId: meta.workItemId ?? null,
    manifest,
    manifestSha256: sha,
    root: manifest?.events.root ?? ev.root,
    events: manifest?.events.count ?? ev.events,
    prevBundle: ev.prevBundle,
    prevRoot: ev.prevRoot,
    deletedAt: meta.now.toISOString(),
    cause: meta.cause,
    deletionManifest: meta.deletionManifest ?? null,
  };
}

/** Replace one job's evidence dir with a signed tombstone under `_tombstones/`. */
export function tombstoneJobEvidence(opts: {
  stateDir: string;
  jobId: string;
  cause: string;
  deletionManifest?: string | null;
  now?: Date;
}): EvidenceTombstone {
  if (!isSafeJobId(opts.jobId)) {
    throw new Error(`invalid job id: ${opts.jobId}`);
  }
  const root = path.join(opts.stateDir, "evidence");
  const dir = path.join(root, opts.jobId);
  const body = tombstoneBodyFor(dir, {
    kind: "job",
    jobId: opts.jobId,
    cause: opts.cause,
    deletionManifest: opts.deletionManifest,
    now: opts.now ?? new Date(),
  });
  const tomb = sign(body, opts.stateDir);
  const file = path.join(root, TOMBSTONES_DIR, `${opts.jobId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(tomb, null, 2)}\n`, { mode: 0o600 });
  fs.rmSync(dir, { recursive: true, force: true });
  return tomb;
}

/** Replace a work item bundle's contents with a signed tombstone (the dir keeps its name). */
export function tombstoneBundleDir(opts: {
  stateDir: string;
  dir: string;
  jobId: string;
  bundle: string;
  workItemId: string;
  cause: string;
  deletionManifest?: string | null;
  now?: Date;
}): EvidenceTombstone {
  const body = tombstoneBodyFor(opts.dir, {
    kind: "workitem",
    jobId: opts.jobId,
    bundle: opts.bundle,
    workItemId: opts.workItemId,
    cause: opts.cause,
    deletionManifest: opts.deletionManifest,
    now: opts.now ?? new Date(),
  });
  const tomb = sign(body, opts.stateDir);
  // Tombstone first, then remove the rest: a crash leaves both, never neither.
  const file = path.join(opts.dir, TOMBSTONE_FILE);
  fs.writeFileSync(file, `${JSON.stringify(tomb, null, 2)}\n`, { mode: 0o600 });
  for (const name of fs.readdirSync(opts.dir)) {
    if (name !== TOMBSTONE_FILE) {
      fs.rmSync(path.join(opts.dir, name), { recursive: true, force: true });
    }
  }
  return tomb;
}

export function readTombstone(file: string): EvidenceTombstone | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as EvidenceTombstone;
  } catch {
    return null;
  }
}

export function listJobTombstones(stateDir: string): EvidenceTombstone[] {
  const dir = path.join(stateDir, "evidence", TOMBSTONES_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => readTombstone(path.join(dir, n)))
    .filter((t): t is EvidenceTombstone => t !== null);
}
