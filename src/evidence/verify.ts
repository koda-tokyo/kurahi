// Offline verification of an evidence bundle (KoLo 2.0, M12b): chain, root, every file digest,
// the export signature, the job-end signature, audit-slice lines and snapshot objects. Needs the
// bundle and nothing else.
import fs from "node:fs";
import path from "node:path";
import type { AuditEntry } from "../audit/audit-log.js";
import type {
  EvidenceEvent,
  EvidenceManifest,
  EvidenceSummary,
  EvidenceVerification,
} from "./types.js";
import { computeEntryHash } from "../audit/audit-log.js";
import { sha256Hex } from "../continuity-suite/manifest.js";
import {
  AUDIT_SLICE_FILE,
  SNAPSHOT_INDEX_FILE,
  SNAPSHOT_OBJECTS_DIR,
  type SnapshotIndexEntry,
} from "./bundle.js";
import {
  EVENTS_FILE,
  EVIDENCE_VERSION,
  MANIFEST_FILE,
  parseEventsText,
  verifyEventChain,
  verifyEvidenceSignature,
} from "./store.js";
import { summarizeEvents } from "./summary.js";
import { type BundleFiles, readZip } from "./zip.js";

// ── verify ──────────────────────────────────────────────────────────────────────────────────

function walkDir(root: string): BundleFiles {
  const out: BundleFiles = new Map();
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.set(rel, fs.readFileSync(abs));
      }
    }
  };
  walk(root, "");
  return out;
}

/** Load a bundle from a directory or a zip file into memory. */
export async function loadBundle(target: string): Promise<BundleFiles> {
  const resolved = path.resolve(target);
  const st = fs.statSync(resolved);
  if (st.isDirectory()) {
    return walkDir(resolved);
  }
  return await readZip(fs.readFileSync(resolved));
}

export type BundleVerification = EvidenceVerification & {
  manifest: EvidenceManifest | null;
  summary: EvidenceSummary | null;
  events: number;
  auditSliceOk: boolean | null;
  snapshotsOk: boolean | null;
  /** null when no trusted keys were given; otherwise whether every signer is one of them. */
  trustedOk: boolean | null;
};

export type VerifyBundleOptions = {
  /**
   * Trust anchors: signer key ids (sha256 of the Ed25519 public key) accepted for this bundle.
   * Without them a bundle only proves it is self-consistent; with them a bundle re-signed by any
   * other key fails.
   */
  trustedKeyIds?: string[];
};

/** Verify a loaded bundle: chain, root, every file digest, both signatures, slice lines, objects. */
export function verifyBundleFiles(
  files: BundleFiles,
  opts: VerifyBundleOptions = {},
): BundleVerification {
  const problems: string[] = [];
  const result: BundleVerification = {
    ok: false,
    chainOk: false,
    rootOk: false,
    filesOk: false,
    signatureOk: false,
    keyIdOk: false,
    recordedOk: null,
    auditSliceOk: null,
    snapshotsOk: null,
    trustedOk: null,
    events: 0,
    problems,
    manifest: null,
    summary: null,
  };
  const manifestRaw = files.get(MANIFEST_FILE);
  if (!manifestRaw) {
    problems.push(`${MANIFEST_FILE} missing`);
    return result;
  }
  let manifest: EvidenceManifest;
  try {
    manifest = JSON.parse(manifestRaw.toString("utf8")) as EvidenceManifest;
  } catch {
    problems.push(`${MANIFEST_FILE} is not valid JSON`);
    return result;
  }
  result.manifest = manifest;
  if (manifest.version !== EVIDENCE_VERSION) {
    problems.push(`unsupported manifest version ${String(manifest.version)}`);
  }

  // Files: every listed file present with the right digest; nothing unlisted.
  result.filesOk = true;
  for (const [name, entry] of Object.entries(manifest.files ?? {})) {
    const data = files.get(name);
    if (!data) {
      result.filesOk = false;
      problems.push(`${name} listed in the manifest but missing`);
      continue;
    }
    if (sha256Hex(data) !== entry.sha256 || data.length !== entry.size) {
      result.filesOk = false;
      problems.push(`${name} does not match its manifest digest`);
    }
  }
  for (const name of files.keys()) {
    if (name !== MANIFEST_FILE && !(name in (manifest.files ?? {}))) {
      result.filesOk = false;
      problems.push(`${name} is not listed in the manifest`);
    }
  }

  // Chain.
  let events: EvidenceEvent[] = [];
  const eventsRaw = files.get(EVENTS_FILE);
  if (!eventsRaw) {
    problems.push(`${EVENTS_FILE} missing`);
  } else {
    let parseError: string | null = null;
    try {
      events = parseEventsText(eventsRaw.toString("utf8"));
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
      problems.push(`${EVENTS_FILE}: ${parseError}`);
    }
    const chain = parseError
      ? { ok: false, root: "", count: 0, firstBreak: 0, reason: parseError }
      : verifyEventChain(events);
    result.chainOk = chain.ok;
    result.events = events.length;
    if (!chain.ok) {
      result.firstBreak = chain.firstBreak;
      problems.push(`event chain broken: ${chain.reason}`);
    }
    result.rootOk =
      chain.ok && chain.root === manifest.events?.root && events.length === manifest.events?.count;
    if (chain.ok && !result.rootOk) {
      problems.push("event chain root or count does not match the manifest");
    }
    if (events.length > 0) {
      const end = events[events.length - 1];
      if (end.type !== "job.end") {
        problems.push("the log does not end with job.end");
      } else if (end.data.status !== manifest.status) {
        problems.push(
          `job.end status ${String(end.data.status)} differs from manifest status ${manifest.status}`,
        );
      }
      for (const e of events) {
        if (e.jobId !== manifest.jobId) {
          problems.push(`event ${e.seq} belongs to job ${e.jobId}, not ${manifest.jobId}`);
          break;
        }
      }
    }
    result.summary = summarizeEvents(events, { signed: true });
  }

  // Export signature.
  const sig = verifyEvidenceSignature(manifest, manifest.signer, manifest.signature);
  result.keyIdOk = sig.keyIdOk;
  result.signatureOk = sig.signatureOk;
  if (!sig.keyIdOk) {
    problems.push("signer keyId does not match the public key");
  } else if (!sig.signatureOk) {
    problems.push("manifest signature does not verify");
  }

  // Job-end signature, over the recorder's view: only events.jsonl, its own createdAt/root/count.
  if (manifest.recorded && eventsRaw) {
    const recordedView = {
      version: manifest.version,
      jobId: manifest.jobId,
      status: manifest.status,
      endedAt: manifest.endedAt,
      createdAt: manifest.recorded.createdAt,
      events: {
        count: manifest.recorded.count,
        root: manifest.recorded.root,
        truncated: manifest.events.truncated,
      },
      files: { [EVENTS_FILE]: { sha256: sha256Hex(eventsRaw), size: eventsRaw.length } },
    };
    const rec = verifyEvidenceSignature(
      recordedView,
      manifest.recorded.signer,
      manifest.recorded.signature,
    );
    result.recordedOk =
      rec.keyIdOk && rec.signatureOk && manifest.recorded.root === manifest.events.root;
    if (!result.recordedOk) {
      problems.push(
        "the job-end signature does not cover these events (log changed after the job ended)",
      );
    }
  }

  // Audit slice: every line recomputes its own hash.
  const sliceRaw = files.get(AUDIT_SLICE_FILE);
  if (sliceRaw) {
    result.auditSliceOk = true;
    let prevSeq: number | null = null;
    for (const line of sliceRaw.toString("utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (computeEntryHash(entry) !== entry.hash) {
          result.auditSliceOk = false;
          problems.push(`audit slice entry seq ${entry.seq} does not recompute`);
        }
        if (prevSeq !== null && entry.seq <= prevSeq) {
          result.auditSliceOk = false;
          problems.push(`audit slice is not in seq order at ${entry.seq}`);
        }
        prevSeq = entry.seq;
      } catch {
        result.auditSliceOk = false;
        problems.push("audit slice has a line that is not valid JSON");
      }
    }
  }

  // Snapshot objects are content-addressed.
  const indexRaw = files.get(SNAPSHOT_INDEX_FILE);
  if (indexRaw) {
    result.snapshotsOk = true;
    try {
      const index = JSON.parse(indexRaw.toString("utf8")) as SnapshotIndexEntry[];
      for (const entry of index) {
        for (const f of entry.files) {
          if (!f.included || !f.hash) {
            continue;
          }
          const data = files.get(`${SNAPSHOT_OBJECTS_DIR}/${f.hash}`);
          if (!data || sha256Hex(data) !== f.hash) {
            result.snapshotsOk = false;
            problems.push(
              `snapshot object ${f.hash.slice(0, 16)} for ${f.path} is missing or altered`,
            );
          }
        }
      }
    } catch {
      result.snapshotsOk = false;
      problems.push(`${SNAPSHOT_INDEX_FILE} is not valid JSON`);
    }
    for (const name of files.keys()) {
      if (name.startsWith(`${SNAPSHOT_OBJECTS_DIR}/`)) {
        const hash = name.slice(SNAPSHOT_OBJECTS_DIR.length + 1);
        if (sha256Hex(files.get(name)!) !== hash) {
          result.snapshotsOk = false;
          problems.push(`${name} content does not hash to its name`);
        }
      }
    }
  }

  // Trust anchors: the export signer and the job-end signer must both be trusted keys.
  const trusted = (opts.trustedKeyIds ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (trusted.length > 0) {
    const signers = [manifest.signer?.keyId, manifest.recorded?.signer?.keyId].filter(
      (k): k is string => typeof k === "string",
    );
    result.trustedOk =
      signers.length > 0 && signers.every((k) => trusted.includes(k.toLowerCase()));
    if (!result.trustedOk) {
      problems.push(
        `signer key ${String(manifest.signer?.keyId ?? "none").slice(0, 16)} is not a trusted key`,
      );
    }
  }

  result.ok =
    problems.length === 0 &&
    result.trustedOk !== false &&
    result.chainOk &&
    result.rootOk &&
    result.filesOk &&
    result.keyIdOk &&
    result.signatureOk &&
    result.recordedOk !== false &&
    result.auditSliceOk !== false &&
    result.snapshotsOk !== false;
  return result;
}

export async function verifyEvidenceBundle(
  target: string,
  opts: VerifyBundleOptions = {},
): Promise<BundleVerification> {
  return verifyBundleFiles(await loadBundle(target), opts);
}

/** Events of a bundle, for replay. */
export function eventsOfBundle(files: BundleFiles): EvidenceEvent[] {
  const raw = files.get(EVENTS_FILE);
  return raw ? parseEventsText(raw.toString("utf8")) : [];
}
