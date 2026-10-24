// Interrupted evidence (KoLo 2.0, M12): a job cut off by a process stop leaves events.jsonl with no
// job.end and no manifest, listed as "running" forever. On the first job of a new process its
// recorder no longer exists, so the log is closed the way jobs.ts closes the job record: a chained
// job.end with status "failed" and the interrupted error, then a signed manifest. A log whose chain
// does not verify, or that cannot be parsed, is left as it is: signing it would vouch for it.
//
// Idle time alone does not prove a log is abandoned when several processes share the state dir,
// so job.start records its owner (pid + per-process instance id). A log is sealed only when its
// owner is gone: a different instance whose pid is dead, or our own pid reused by a new instance
// (a restarted container is pid 1 again). Logs without an owner (older builds) fall back to the
// idle check. A pid is only meaningful on the host (pid namespace) that recorded it, so the owner
// also records the hostname, and a log owned on another host is never sealed here: two containers
// sharing a volume are both pid 1. Each seal holds a per-job lock (exclusive takeover, never from a
// live holder) and re-reads the log under it, so two processes cannot both append a job.end.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceEvent } from "./types.js";
import { type SigningKey } from "../continuity-suite/manifest.js";
import { acquireRefreshLock, releaseRefreshLock } from "../infra/refresh-lock.js";
import {
  EVENTS_FILE,
  eventHash,
  fileEntryOf,
  isSafeJobId,
  MANIFEST_FILE,
  readEventsFile,
  resolveEvidenceRoot,
  resolveEvidenceSigningKey,
  signEvidenceManifest,
  verifyEventChain,
} from "./store.js";
import { EVIDENCE_VERSION } from "./types.js";

/** Error on the job.end the seal appends; matches the job record's interrupted error. */
export const EVIDENCE_INTERRUPTED_ERROR = "interrupted: gateway restarted before the run finished";

/** A log written to this recently may belong to another live process sharing the state dir. */
export const SEAL_MIN_IDLE_MS = 10 * 60_000;

export type EvidenceOwner = { pid: number; instance: string; host?: string };

const PROCESS_INSTANCE = randomUUID();

/** The owner job.start records for logs written by this process. */
export function evidenceProcessOwner(): EvidenceOwner {
  return { pid: process.pid, instance: PROCESS_INSTANCE, host: os.hostname() };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why a log's owner may still be writing it, or null when the owner is gone or unrecorded. */
function ownerHold(
  raw: unknown,
  self: EvidenceOwner,
  isPidAlive: (pid: number) => boolean,
): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const { pid, instance, host } = raw as Partial<EvidenceOwner>;
  if (typeof pid !== "number" || typeof instance !== "string") {
    return "owner unrecognised";
  }
  if (instance === self.instance) {
    return "owned by this process";
  }
  // Owners recorded before the hostname was (3d3f4b7ad6 only) are judged on this host.
  if (host !== undefined && host !== (self.host ?? os.hostname())) {
    return "owner on another host";
  }
  if (pid === self.pid) {
    return null;
  }
  return isPidAlive(pid) ? "owner process alive" : null;
}

export type SealResult = {
  sealed: string[];
  skipped: Array<{ jobId: string; reason: string }>;
};

export function sealInterruptedEvidence(
  opts: {
    env?: NodeJS.ProcessEnv;
    key?: SigningKey;
    now?: () => Date;
    minIdleMs?: number;
    /** Jobs this process is still recording; never sealed. */
    isLive?: (jobId: string) => boolean;
    /** Injected for tests: the sealing process's identity and pid liveness. */
    self?: EvidenceOwner;
    isPidAlive?: (pid: number) => boolean;
  } = {},
): SealResult {
  const result: SealResult = { sealed: [], skipped: [] };
  const root = resolveEvidenceRoot(opts.env);
  const now = opts.now ?? (() => new Date());
  const minIdleMs = opts.minIdleMs ?? SEAL_MIN_IDLE_MS;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return result;
  }
  for (const jobId of names) {
    if (
      !isSafeJobId(jobId) ||
      opts.isLive?.(jobId) ||
      fs.existsSync(path.join(root, jobId, MANIFEST_FILE))
    ) {
      continue;
    }
    const lockPath = path.join(root, `.seal.${jobId}.lock`);
    if (!acquireRefreshLock(lockPath, { timeoutMs: Number.POSITIVE_INFINITY })) {
      result.skipped.push({ jobId, reason: "seal in progress elsewhere" });
      continue;
    }
    try {
      sealOne(jobId, root, opts, result, now, minIdleMs);
    } finally {
      releaseRefreshLock(lockPath);
    }
  }
  return result;
}

/** Seal one job under its lock; every check is repeated now that the lock is held. */
function sealOne(
  jobId: string,
  root: string,
  opts: Parameters<typeof sealInterruptedEvidence>[0] & object,
  result: SealResult,
  now: () => Date,
  minIdleMs: number,
): void {
  const dir = path.join(root, jobId);
  const eventsPath = path.join(dir, EVENTS_FILE);
  let mtimeMs: number;
  let size: number;
  try {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) {
      return;
    }
    ({ mtimeMs, size } = fs.statSync(eventsPath));
  } catch {
    return;
  }
  if (now().getTime() - mtimeMs < minIdleMs) {
    result.skipped.push({ jobId, reason: "recent writes" });
    return;
  }
  let events: EvidenceEvent[];
  try {
    events = readEventsFile(eventsPath);
  } catch (err) {
    result.skipped.push({ jobId, reason: `unreadable: ${String(err)}` });
    return;
  }
  const chain = verifyEventChain(events);
  const start = events[0];
  if (!chain.ok || !start || start.type !== "job.start") {
    result.skipped.push({ jobId, reason: chain.reason ?? "no job.start" });
    return;
  }
  const hold = ownerHold(
    start.data.owner,
    opts.self ?? evidenceProcessOwner(),
    opts.isPidAlive ?? pidAlive,
  );
  if (hold) {
    result.skipped.push({ jobId, reason: hold });
    return;
  }
  try {
    let last = events[events.length - 1];
    let { root: prev, count } = chain;
    const endedAt =
      last.type === "job.end" ? String(last.data.endedAt ?? last.ts) : now().toISOString();
    // The log must be exactly what was verified: a write since then means someone holds it.
    const current = fs.statSync(eventsPath);
    if (current.size !== size || current.mtimeMs !== mtimeMs) {
      result.skipped.push({ jobId, reason: "changed while sealing" });
      return;
    }
    if (last.type !== "job.end") {
      const base = {
        seq: count + 1,
        ts: endedAt,
        type: "job.end" as const,
        jobId,
        data: {
          status: "failed",
          endedAt,
          error: EVIDENCE_INTERRUPTED_ERROR,
          interrupted: true,
          lastEventAt: last.ts,
        },
      };
      const hash = eventHash(prev, base);
      last = { ...base, prev, hash };
      fs.appendFileSync(eventsPath, `${JSON.stringify(last)}\n`, { mode: 0o600 });
      prev = hash;
      count += 1;
    }
    const manifest = signEvidenceManifest(
      {
        version: EVIDENCE_VERSION,
        jobId,
        agent: String(start.data.agent ?? ""),
        sessionKey: String(start.data.sessionKey ?? ""),
        kind: String(start.data.kind ?? ""),
        status: String(last.data.status ?? "failed"),
        startedAt: String(start.data.startedAt ?? start.ts),
        endedAt,
        createdAt: now().toISOString(),
        events: { count, root: prev, truncated: events.some((e) => e.type === "truncated") },
        files: { [EVENTS_FILE]: fileEntryOf(eventsPath) },
      },
      opts.key ?? resolveEvidenceSigningKey(opts.env),
    );
    const target = path.join(dir, MANIFEST_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
    result.sealed.push(jobId);
  } catch (err) {
    result.skipped.push({ jobId, reason: `seal failed: ${String(err)}` });
  }
}
