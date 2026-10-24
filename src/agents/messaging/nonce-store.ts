// Persistent replay guard for signed inter-agent messages (OWASP ASI07).
//
// The in-memory NonceCache forgets everything on restart, so a message captured inside the
// accepted window could be replayed once against a freshly started gateway. This store keeps
// the same bounded map in memory and mirrors every accepted nonce to an append-only JSONL file
// (`<KOLO_HOME>/identity/agent-message-nonces.jsonl`, file 0600, folder 0700) before the
// message is accepted. On first use the file is read back and expired entries are dropped; the
// file is rewritten (atomically, live entries only) whenever it grows past twice the entry cap.
//
// A write failure is logged once and the guard keeps working from memory: the process still
// rejects replays it has seen, only the restart protection is lost until the disk recovers.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { NonceCache, type ReplayGuard } from "./envelope.js";

const log = createSubsystemLogger("agents/messaging");

export const DEFAULT_NONCE_STORE_MAX_ENTRIES = 20_000;
/** Longest key accepted from the file (sender id + ":" + nonce); longer lines are ignored. */
const MAX_KEY_LENGTH = 256;

export function resolveNonceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", "agent-message-nonces.jsonl");
}

type StoredNonce = { k: string; e: number };

function parseLine(line: string): StoredNonce | null {
  if (!line) {
    return null;
  }
  try {
    const raw = JSON.parse(line) as Partial<StoredNonce>;
    if (
      typeof raw.k === "string" &&
      raw.k.length > 0 &&
      raw.k.length <= MAX_KEY_LENGTH &&
      typeof raw.e === "number" &&
      Number.isFinite(raw.e)
    ) {
      return { k: raw.k, e: raw.e };
    }
  } catch {
    // A torn last line after a crash: ignore it.
  }
  return null;
}

export class PersistentNonceCache implements ReplayGuard {
  private readonly memory: NonceCache;
  private readonly live = new Map<string, number>();
  private loaded = false;
  private lines = 0;
  private writeFailed = false;

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = DEFAULT_NONCE_STORE_MAX_ENTRIES,
  ) {
    this.memory = new NonceCache(maxEntries);
  }

  remember(key: string, expiresAt: number, now: number): boolean {
    this.load(now);
    if (!this.memory.remember(key, expiresAt, now)) {
      return false;
    }
    this.live.set(key, expiresAt);
    if (this.live.size > this.maxEntries) {
      this.pruneLive(now);
    }
    this.append({ k: key, e: expiresAt }, now);
    return true;
  }

  clear(): void {
    this.memory.clear();
    this.live.clear();
    this.loaded = false;
    this.lines = 0;
  }

  /** Entries currently tracked as live (tests and diagnostics). */
  size(): number {
    return this.live.size;
  }

  private load(now: number): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    const entries: StoredNonce[] = [];
    let total = 0;
    for (const line of text.split("\n")) {
      if (line.trim()) {
        total += 1;
      }
      const entry = parseLine(line.trim());
      if (entry && entry.e > now) {
        entries.push(entry);
      }
    }
    // Keep only the newest entries the cap allows, in file (insertion) order.
    for (const entry of entries.slice(-this.maxEntries)) {
      this.memory.remember(entry.k, entry.e, now);
      this.live.set(entry.k, entry.e);
    }
    this.lines = total;
    if (this.lines > this.live.size) {
      this.compact(now);
    } else {
      this.tightenMode();
    }
  }

  private pruneLive(now: number): void {
    for (const [k, exp] of this.live) {
      if (exp <= now) {
        this.live.delete(k);
      }
    }
    for (const k of this.live.keys()) {
      if (this.live.size <= this.maxEntries) {
        break;
      }
      this.live.delete(k);
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  private append(entry: StoredNonce, now: number): void {
    try {
      this.ensureDir();
      const fd = fs.openSync(this.filePath, "a", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.lines += 1;
      if (this.lines > this.maxEntries * 2) {
        this.compact(now);
      }
    } catch (err) {
      this.reportWriteFailure(err);
    }
  }

  private compact(now: number): void {
    try {
      this.pruneLive(now);
      this.ensureDir();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      const body = [...this.live].map(([k, e]) => JSON.stringify({ k, e })).join("\n");
      fs.writeFileSync(tmp, body ? `${body}\n` : "", { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.lines = this.live.size;
    } catch (err) {
      this.reportWriteFailure(err);
    }
    this.tightenMode();
  }

  private tightenMode(): void {
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort (e.g. Windows); new files are created 0600.
    }
  }

  private reportWriteFailure(err: unknown): void {
    if (this.writeFailed) {
      return;
    }
    this.writeFailed = true;
    log.warn(
      `cannot persist inter-agent message nonces to ${this.filePath} (replay protection now ` +
        `lasts only until restart): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

let shared: { path: string; cache: PersistentNonceCache } | null = null;

/**
 * The gateway's replay guard, shared by the `agent` and `sibling.send` checks. Resolved on use
 * (not at import) so the state directory follows the environment.
 */
export function sharedReplayGuard(): PersistentNonceCache {
  const filePath = resolveNonceStorePath();
  if (!shared || shared.path !== filePath) {
    shared = { path: filePath, cache: new PersistentNonceCache(filePath) };
  }
  return shared.cache;
}

/** Tests only: forget the in-memory state (the file is left alone). */
export function resetSharedReplayGuard(): void {
  shared?.cache.clear();
  shared = null;
}
