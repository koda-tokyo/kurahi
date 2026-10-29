// Audit retention without breaking the chain (docs/security/data-governance.md#audit-log).
//
// The audit log is one hash chain from the genesis entry. Retention may only remove whole month
// files from the oldest end, never the newest month, and only after writing ANCHOR.json:
//
//   <KOLO_HOME>/audit/ANCHOR.json   signed (Ed25519, the evidence key) record of the last removed
//                                   entry: its seq and the SHA-256 of its raw line
//
// `verifyAuditChain` then starts from the anchor instead of the genesis: the first remaining
// entry must name the anchored line hash as `prev` and continue its seq. Daily heads of removed
// days (HEADS.jsonl) are checked only when they are beyond the anchor. Editing, reordering or
// removing any remaining line still breaks the chain; removing a month without moving the anchor
// is reported as "first entry is not the genesis"; a forged anchor fails its signature.
import fs from "node:fs";
import path from "node:path";
import type { ManifestSigner } from "../continuity-suite/types.js";
import { canonicalJson, loadSigningKey, signerFromKey } from "../continuity-suite/manifest.js";
import {
  deriveDeviceIdFromPublicKey,
  signDevicePayload,
  verifyDeviceSignature,
} from "../infra/device-identity.js";
import { auditFileForMonth, listAuditMonths, sha256Hex } from "./audit-log.js";

export const AUDIT_ANCHOR_FILE = "ANCHOR.json";

export type AuditAnchorBody = {
  v: 1;
  /** seq of the last removed entry. */
  seq: number;
  /** SHA-256 of the last removed entry's raw line (what the next entry's `prev` names). */
  lineHash: string;
  /** ts of the last removed entry. */
  ts: string;
  /** Every month removed so far, oldest first. */
  removedMonths: string[];
  /** One row per prune. */
  history: Array<{ at: string; months: string[]; seq: number; lineHash: string; entries: number }>;
  updatedAt: string;
};

export type AuditAnchor = AuditAnchorBody & { signer: ManifestSigner; signature: string };

function signingInput(body: AuditAnchorBody): string {
  return `kolo-audit-anchor\n${canonicalJson(body)}`;
}

export function readAuditAnchor(dir: string): AuditAnchor | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, AUDIT_ANCHOR_FILE), "utf8")) as AuditAnchor;
  } catch {
    return null;
  }
}

export function verifyAuditAnchor(anchor: AuditAnchor): boolean {
  const { signer, signature, ...body } = anchor;
  if (signer?.alg !== "ed25519" || deriveDeviceIdFromPublicKey(signer.publicKey) !== signer.keyId) {
    return false;
  }
  try {
    return verifyDeviceSignature(
      signer.publicKey,
      signingInput(body as AuditAnchorBody),
      signature,
    );
  } catch {
    return false;
  }
}

export type AuditPruneResult = {
  months: string[];
  entries: number;
  anchor: AuditAnchor | null;
};

function lastLine(file: string): string | null {
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  return lines.at(-1) ?? null;
}

function countLines(file: string): number {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim()).length;
}

/**
 * Remove month files older than `beforeMonth` (YYYY-MM, exclusive), oldest first, never the
 * newest month file. Writes the signed anchor before deleting anything, so a crash between the
 * two leaves an anchor that points into history still present (verify skips nothing it has).
 * Callers hold the audit lock semantics by running from the sweeper only (one writer).
 */
export function pruneAuditMonths(opts: {
  dir: string;
  stateDir: string;
  beforeMonth: string;
  /** Months that must stay (legal hold). Pruning stops at the first one: the chain is linear. */
  keep?: (month: string) => boolean;
  dryRun?: boolean;
  now?: Date;
}): AuditPruneResult {
  const all = listAuditMonths(opts.dir);
  const candidates: string[] = [];
  for (const month of all.slice(0, -1)) {
    if (month >= opts.beforeMonth || opts.keep?.(month)) {
      break;
    }
    candidates.push(month);
  }
  if (candidates.length === 0) {
    return { months: [], entries: 0, anchor: readAuditAnchor(opts.dir) };
  }
  let entries = 0;
  for (const m of candidates) {
    entries += countLines(auditFileForMonth(opts.dir, m));
  }
  const tipLine = lastLine(auditFileForMonth(opts.dir, candidates.at(-1)!));
  if (!tipLine) {
    return { months: [], entries: 0, anchor: readAuditAnchor(opts.dir) };
  }
  const tip = JSON.parse(tipLine) as { seq: number; ts: string };
  if (opts.dryRun) {
    return { months: candidates, entries, anchor: null };
  }
  const prev = readAuditAnchor(opts.dir);
  const at = (opts.now ?? new Date()).toISOString();
  const lineHash = sha256Hex(tipLine);
  const body: AuditAnchorBody = {
    v: 1,
    seq: tip.seq,
    lineHash,
    ts: tip.ts,
    removedMonths: [...(prev?.removedMonths ?? []), ...candidates],
    history: [
      ...(prev?.history ?? []),
      { at, months: candidates, seq: tip.seq, lineHash, entries },
    ],
    updatedAt: at,
  };
  const key = loadSigningKey(opts.stateDir);
  const anchor: AuditAnchor = {
    ...body,
    signer: signerFromKey(key),
    signature: signDevicePayload(key.privateKeyPem, signingInput(body)),
  };
  const file = path.join(opts.dir, AUDIT_ANCHOR_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(anchor, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  for (const m of candidates) {
    fs.rmSync(auditFileForMonth(opts.dir, m), { force: true });
  }
  return { months: candidates, entries, anchor };
}
