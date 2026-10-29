// Append-only, hash-chained audit log (KoLo 2.0, M2b).
//
// <KOLO_HOME>/audit/audit-YYYY-MM.jsonl   one JSON entry per line (UTC month)
// <KOLO_HOME>/audit/HEAD                  current chain head {day, month, seq, lineHash, ts}
// <KOLO_HOME>/audit/HEADS.jsonl           closing head of every past day (one line per day)
//
// Every entry carries `seq` (monotonic across months), `prev` (SHA-256 of the previous raw
// line; 64 zeros for the genesis entry) and `hash` (SHA-256 of the entry's canonical JSON
// including `prev`). The chain runs across month files, so deleting, editing, reordering or
// truncating lines breaks it; HEAD/HEADS catch tail truncation.
//
// One writer: appends are serialized in-process through a promise queue and across processes
// (gateway + CLI) through an O_EXCL lock file. Every append is fsync'd before it resolves.

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { redactAuditValue } from "./redact.js";

export const AUDIT_GENESIS = "0".repeat(64);

export type AuditOutcome = "ok" | "denied" | "failed" | "error" | (string & {});

export type AuditInput = {
  /** Who acted: agent id, operator, device display name, user id. */
  identity?: string | null;
  /** Device id (paired device) when known. */
  device?: string | null;
  /** Scope / role / session key the action ran under. */
  scope?: string | null;
  /** Dotted action name, e.g. `device.pair.approve`, `integrity.verify`. */
  action: string;
  outcome: AuditOutcome;
  /** Subsystem that wrote the entry (`gateway.http`, `cli`, `before_tool_call`, …). */
  source: string;
  /** Free-form context. Redacted before it is written; never put secret values here. */
  detail?: unknown;
};

export type AuditEntry = {
  ts: string;
  seq: number;
  identity: string | null;
  device: string | null;
  scope: string | null;
  action: string;
  outcome: string;
  source: string;
  detail: unknown;
  prev: string;
  hash: string;
};

export type AuditHead = {
  day: string;
  month: string;
  seq: number;
  lineHash: string;
  ts: string;
};

export type AuditOptions = {
  /** Audit directory. Default `<KOLO_HOME>/audit`. */
  dir?: string;
  /** Clock override (tests). */
  now?: () => Date;
};

const LOCK_STALE_MS = 15_000;
const LOCK_DEADLINE_MS = 5_000;
const TAIL_READ_BYTES = 256 * 1024;

export function resolveAuditDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "audit");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function auditFileForMonth(dir: string, month: string): string {
  return path.join(dir, `audit-${month}.jsonl`);
}

/** Canonical JSON of an entry without its `hash` field (fixed key order). */
export function canonicalEntryText(entry: Omit<AuditEntry, "hash"> | AuditEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    seq: entry.seq,
    identity: entry.identity,
    device: entry.device,
    scope: entry.scope,
    action: entry.action,
    outcome: entry.outcome,
    source: entry.source,
    detail: entry.detail,
    prev: entry.prev,
  });
}

export function computeEntryHash(entry: Omit<AuditEntry, "hash"> | AuditEntry): string {
  return sha256Hex(canonicalEntryText(entry));
}

/** Month files present in `dir`, oldest first. */
export function listAuditMonths(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => /^audit-(\d{4}-\d{2})\.jsonl$/.exec(n)?.[1])
    .filter((m): m is string => Boolean(m))
    .toSorted();
}

/** Last non-empty line of a file (reads at most the final 256 KiB). */
export async function readLastLine(file: string): Promise<string | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return null;
    }
    const len = Math.min(size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, size - len);
    const lines = buf
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } finally {
    await handle.close();
  }
}

async function findChainTip(dir: string): Promise<{ line: string; seq: number } | null> {
  const months = listAuditMonths(dir);
  for (let i = months.length - 1; i >= 0; i--) {
    const line = await readLastLine(auditFileForMonth(dir, months[i]));
    if (line) {
      let seq = 0;
      try {
        seq = Number((JSON.parse(line) as { seq?: unknown }).seq) || 0;
      } catch {
        // A corrupt tip still anchors the chain; `kurahi audit verify` reports it.
      }
      return { line, seq };
    }
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        await fsp.rm(lockPath, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    // Stale lock: holder dead, or lock older than LOCK_STALE_MS.
    try {
      const [raw, st] = await Promise.all([fsp.readFile(lockPath, "utf8"), fsp.stat(lockPath)]);
      const pid = Number.parseInt(raw.trim(), 10);
      const dead = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid);
      if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lockPath, { force: true });
        continue;
      }
    } catch {
      continue; // lock vanished between open and read
    }
    if (Date.now() > deadline) {
      throw new Error(`audit log lock busy (${lockPath})`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function appendLineDurably(file: string, text: string): Promise<void> {
  const handle = await fsp.open(file, "a", 0o600);
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fsp.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

export async function readAuditHead(dir: string): Promise<AuditHead | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "HEAD"), "utf8")) as AuditHead;
  } catch {
    return null;
  }
}

async function appendUnlocked(dir: string, input: AuditInput, now: Date): Promise<AuditEntry> {
  const tip = await findChainTip(dir);
  const base: Omit<AuditEntry, "hash"> = {
    ts: now.toISOString(),
    seq: (tip?.seq ?? 0) + 1,
    identity: input.identity ?? null,
    device: input.device ?? null,
    scope: input.scope ?? null,
    action: String(input.action),
    outcome: String(input.outcome),
    source: String(input.source),
    detail: redactAuditValue(input.detail ?? null),
    prev: tip ? sha256Hex(tip.line) : AUDIT_GENESIS,
  };
  const entry: AuditEntry = { ...base, hash: computeEntryHash(base) };
  const line = JSON.stringify(entry);
  const month = monthKey(now);
  await appendLineDurably(auditFileForMonth(dir, month), `${line}\n`);

  // Chain head. Close out the previous day in HEADS.jsonl before moving HEAD forward.
  const day = dayKey(now);
  const prevHead = await readAuditHead(dir);
  if (prevHead && prevHead.day !== day) {
    await appendLineDurably(path.join(dir, "HEADS.jsonl"), `${JSON.stringify(prevHead)}\n`);
  }
  const head: AuditHead = { day, month, seq: entry.seq, lineHash: sha256Hex(line), ts: entry.ts };
  await writeFileAtomic(path.join(dir, "HEAD"), `${JSON.stringify(head)}\n`);
  return entry;
}

// In-process single-writer queue (per directory).
const queues = new Map<string, Promise<unknown>>();

/** Called with every entry this process appends (SIEM export). Must be synchronous and cheap. */
export type AuditAppendListener = (entry: AuditEntry) => void;
const appendListeners = new Set<AuditAppendListener>();

/** Subscribe to appended entries; returns the unsubscribe. A throwing listener is ignored. */
export function onAuditAppend(fn: AuditAppendListener): () => void {
  appendListeners.add(fn);
  return () => {
    appendListeners.delete(fn);
  };
}

function notifyAppended(entry: AuditEntry): void {
  for (const fn of appendListeners) {
    try {
      fn(entry);
    } catch {
      // a subscriber never fails the append
    }
  }
}

/**
 * Append one entry. Resolves after the line is fsync'd. Rejects on I/O failure; callers on hot
 * paths should use {@link auditSafe}.
 */
export function appendAudit(input: AuditInput, opts: AuditOptions = {}): Promise<AuditEntry> {
  const dir = path.resolve(opts.dir ?? resolveAuditDir());
  const now = opts.now ?? (() => new Date());
  const previous = queues.get(dir) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const release = await acquireLock(dir);
      let entry: AuditEntry;
      try {
        entry = await appendUnlocked(dir, input, now());
      } finally {
        await release();
      }
      notifyAppended(entry);
      return entry;
    });
  queues.set(dir, run);
  void run
    .finally(() => {
      if (queues.get(dir) === run) {
        queues.delete(dir);
      }
    })
    .catch(() => undefined);
  return run;
}

let auditErrorReporter: (msg: string) => void = (msg) => {
  process.stderr.write(`${msg}\n`);
};

/** Override where fire-and-forget audit failures are reported (gateway logger). */
export function setAuditErrorReporter(fn: (msg: string) => void): void {
  auditErrorReporter = fn;
}

/** Fire-and-forget append for request paths: never throws, reports I/O failures. */
export function auditSafe(input: AuditInput, opts?: AuditOptions): Promise<AuditEntry | null> {
  try {
    return appendAudit(input, opts).catch((err: unknown) => {
      auditErrorReporter(`audit: append failed (${input.action}): ${String(err)}`);
      return null;
    });
  } catch (err) {
    auditErrorReporter(`audit: append failed (${input.action}): ${String(err)}`);
    return Promise.resolve(null);
  }
}

/** Wait for queued appends (tests, CLI exit). */
export async function flushAudit(): Promise<void> {
  await Promise.allSettled(queues.values());
}
