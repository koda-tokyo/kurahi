// Cross-process lock for credential refreshes. One file holding `<pid>:<timestamp>:<nonce>`,
// published whole: the token is written to a private temp file that is then hard-linked to the
// lock path, which fails if the lock exists. (O_EXCL create-then-write left a window in which the
// lock existed empty; a second process read that as stale, took it over, and both held it.)
// Release unlinks the file. A lock whose timestamp is older than the timeout, or whose owning pid
// no longer exists, is stale and may be taken over; so is an empty or unparseable one, but only
// once its file is older than EMPTY_LOCK_GRACE_MS, since a fresh one may be mid-write by an older
// writer. (Writing "" on release used to leave a file whose timestamp parsed as NaN,
// which is never older than the timeout: every later refresh in every process was blocked.)
//
// Taking over a stale lock is exclusive: candidates that read the same stale content race for a
// reaper lock keyed by that content (the same protocol, one level down), and only the winner
// removes the stale file, after re-reading it under the reaper lock, before creating its own with
// O_EXCL. Each holder writes a unique token, and release unlinks only a file still holding that
// token, so a holder that was taken over cannot remove its successor's lock.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { koloRunDir } from "../config/kolo-home.js";

export const DEFAULT_REFRESH_LOCK_TIMEOUT_MS = 120_000;

export type RefreshLockOptions = {
  /** Age after which a live-looking lock is treated as abandoned; Infinity: only a dead holder. */
  timeoutMs?: number;
  now?: () => number;
  pid?: number;
  /** Injected for tests: whether a pid is alive. */
  isPidAlive?: (pid: number) => boolean;
};

/** `<KOLO_HOME>/run/<name>.lock` — the default lock location for a named refresh. */
export function defaultRefreshLockPath(name: string): string {
  return path.join(koloRunDir(), `${name}.lock`);
}

export function parseRefreshLock(content: string): { pid: number; timestamp: number } | null {
  const [pidRaw, tsRaw] = content.trim().split(":");
  const pid = Number.parseInt(pidRaw ?? "", 10);
  const timestamp = Number.parseInt(tsRaw ?? "", 10);
  if (!Number.isFinite(pid) || !Number.isFinite(timestamp) || pid <= 0 || timestamp <= 0) {
    return null;
  }
  return { pid, timestamp };
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

/** Age after which an empty or unparseable lock file is abandoned rather than mid-write. */
export const EMPTY_LOCK_GRACE_MS = 30_000;

/**
 * Whether the content of an existing lock file no longer protects anything. `mtimeMs` is the
 * file's modification time; without it an unparseable lock is never stale.
 */
export function isRefreshLockStale(
  content: string,
  opts: RefreshLockOptions = {},
  mtimeMs?: number,
): boolean {
  const now = opts.now ?? Date.now;
  const parsed = parseRefreshLock(content);
  if (!parsed) {
    return mtimeMs !== undefined && now() - mtimeMs > EMPTY_LOCK_GRACE_MS;
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REFRESH_LOCK_TIMEOUT_MS;
  if (now() - parsed.timestamp > timeoutMs) {
    return true;
  }
  const alive = opts.isPidAlive ?? pidAlive;
  return !alive(parsed.pid);
}

/** Reaper locks nest only when a reaper itself died mid-takeover; give up past this depth. */
const MAX_REAP_DEPTH = 4;

/** Token this process wrote into each lock it holds; release removes only a matching file. */
const heldTokens = new Map<string, string>();

function createExclusive(lockPath: string, token: string): boolean {
  const tmpPath = `${lockPath}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(tmpPath, token, { flag: "wx", mode: 0o600 });
    fs.linkSync(tmpPath, lockPath);
    heldTokens.set(lockPath, token);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Never created.
    }
  }
}

function readLock(lockPath: string): { content: string; mtimeMs: number } | null {
  try {
    const fd = fs.openSync(lockPath, "r");
    try {
      return { content: fs.readFileSync(fd, "utf8"), mtimeMs: fs.fstatSync(fd).mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Take the lock. Returns true when this process now holds it. Never throws: an unreadable lock
 * directory means "not acquired".
 */
export function acquireRefreshLock(lockPath: string, opts: RefreshLockOptions = {}): boolean {
  return acquireAt(lockPath, opts, 0);
}

function acquireAt(lockPath: string, opts: RefreshLockOptions, depth: number): boolean {
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const token = `${pid}:${now()}:${randomBytes(8).toString("hex")}`;
  if (createExclusive(lockPath, token)) {
    return true;
  }
  const current = readLock(lockPath);
  if (current === null) {
    // Released between our create and read: one more exclusive attempt, no takeover.
    return createExclusive(lockPath, token);
  }
  const { content } = current;
  if (depth >= MAX_REAP_DEPTH || !isRefreshLockStale(content, opts, current.mtimeMs)) {
    return false;
  }
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const reapPath = `${lockPath}.reap-${digest}`;
  if (!acquireAt(reapPath, opts, depth + 1)) {
    return false;
  }
  try {
    const again = readLock(lockPath)?.content ?? null;
    if (again !== null && again !== content) {
      // Already taken over (or released and re-acquired): the stale file is gone.
      return false;
    }
    if (again !== null) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    return false;
  } finally {
    releaseRefreshLock(reapPath);
  }
  return createExclusive(lockPath, token);
}

/** Release a lock this process holds. A file that no longer holds our token is left alone. */
export function releaseRefreshLock(lockPath: string): void {
  const token = heldTokens.get(lockPath);
  heldTokens.delete(lockPath);
  if (token === undefined) {
    return;
  }
  try {
    if (fs.readFileSync(lockPath, "utf8") === token) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Already gone.
  }
}

/** Run `fn` under the lock; returns null when the lock is held elsewhere. */
export async function withRefreshLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: RefreshLockOptions = {},
): Promise<T | null> {
  if (!acquireRefreshLock(lockPath, opts)) {
    return null;
  }
  try {
    return await fn();
  } finally {
    releaseRefreshLock(lockPath);
  }
}
