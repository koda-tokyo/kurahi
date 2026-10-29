// Retention for evidence dirs (KoLo 2.0, M12): a job's evidence is removed once its end time (or,
// for a log that never got a manifest, its last write) is older than `evidence.retentionDays`.
// Data governance (docs/security/data-governance.md): a removed job leaves a signed tombstone
// (tombstone.ts), evidence under an active legal hold is kept, governance records (`gov-*`:
// deletion manifests) are never pruned, and `minimumDays` (governance.minimumRetentionDays.
// evidence, when governance is configured) raises `days`.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { holdsBlockingDeletion } from "../governance/holds.js";
import { parseProjectSessionKey } from "../projects/scope.js";
import {
  EVENTS_FILE,
  isSafeJobId,
  MANIFEST_FILE,
  readManifestFile,
  resolveEvidenceRoot,
} from "./store.js";
import { tombstoneJobEvidence } from "./tombstone.js";

export type PruneRow = { jobId: string; endedAt: string; bytes: number; removed: boolean };

export type PruneResult = {
  root: string;
  cutoff: string;
  removed: PruneRow[];
  kept: number;
  /** Jobs past the cutoff kept because a legal hold covers them. */
  held: number;
};

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        total += fs.statSync(p).size;
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // partial total is fine for a report
  }
  return total;
}

/**
 * Remove evidence older than `days`. `days: 0` keeps nothing older than now, i.e. everything
 * finished; a running job (no manifest, recent writes) is never removed.
 */
export function pruneEvidence(opts: {
  days: number;
  /** Floor for `days` (governance minimum evidence retention). */
  minimumDays?: number;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): PruneResult {
  const root = resolveEvidenceRoot(opts.env);
  const now = (opts.now ?? (() => new Date()))();
  const days = Math.max(0, opts.days, opts.minimumDays ?? 0);
  const cutoffMs = now.getTime() - days * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const result: PruneResult = { root, cutoff, removed: [], kept: 0, held: 0 };
  const stateDir = resolveStateDir(opts.env);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!isSafeJobId(name) || name.startsWith("gov-")) {
      continue;
    }
    const dir = path.join(root, name);
    const manifest = readManifestFile(path.join(dir, MANIFEST_FILE));
    let endedAt: string | null = manifest?.endedAt ?? null;
    if (!endedAt) {
      try {
        const st = fs.statSync(path.join(dir, EVENTS_FILE));
        // No manifest: treat as abandoned only after a full day of silence.
        if (now.getTime() - st.mtimeMs < 86_400_000) {
          result.kept += 1;
          continue;
        }
        endedAt = new Date(st.mtimeMs).toISOString();
      } catch {
        result.kept += 1;
        continue;
      }
    }
    if (Date.parse(endedAt) >= cutoffMs) {
      result.kept += 1;
      continue;
    }
    const held = holdsBlockingDeletion(stateDir, {
      class: "evidence",
      id: name,
      projectId: manifest
        ? (parseProjectSessionKey(manifest.sessionKey)?.projectId ?? null)
        : undefined,
      workItemId: null,
      custodians: manifest?.agent ? [manifest.agent] : undefined,
      from: manifest?.startedAt ?? endedAt,
      to: endedAt,
    });
    if (held.length > 0) {
      result.kept += 1;
      result.held += 1;
      continue;
    }
    const row: PruneRow = { jobId: name, endedAt, bytes: dirBytes(dir), removed: false };
    if (!opts.dryRun) {
      try {
        tombstoneJobEvidence({ stateDir, jobId: name, cause: "prune", now });
        row.removed = true;
      } catch {
        row.removed = false;
      }
    }
    result.removed.push(row);
  }
  return result;
}
