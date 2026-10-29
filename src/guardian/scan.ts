// Guardian share scan (docs/security/guardian.md): the company's file shares (`guardian.shares`)
// through the resolved malware scanner (src/security/scanner.ts), incrementally.
//
// - The scan index (<KOLO_HOME>/guardian/scan-index.json) remembers files the same engine found
//   clean, by path + size + mtime + ctime + inode (the last two cannot be set back from user
//   space, so a same-size swap with a restored mtime is rescanned); an unchanged file is skipped. Infected and failed files are
//   never remembered, so they are scanned again next run.
// - Bounded: maxFiles, maxBytes (bytes handed to the engine) and a wall clock for the whole run;
//   the result says `truncated` when one was hit. A file that does not fit the remaining byte
//   budget is passed over (smaller ones still fit), one larger than maxBytes is an error entry;
//   the walk stops only when the budget is spent, files run out or the clock does.
// - Symlinks: a file link that resolves inside its share is scanned; a link that escapes the share
//   is an error entry; a directory link (cycles) or a dangling link is skipped and counted.
// - Quarantine: an infected file is COPIED to <quarantine>/<sha256> with <sha256>.json beside it
//   (original path, hash, engine verdict, time). `mode: "move"` then also renames the original
//   into the quarantine folder; a move that would need a copy + delete (another volume), or of a
//   symlink, is not done and is reported. The copy is hashed from the same open descriptor it is
//   read from, and only if the file is still the one the engine scanned. Guardian never deletes.
// - Fail closed: an engine error, an unreadable folder or an unreadable share is an error entry,
//   never a clean file; no engine at all (`none`) is an error for the whole run.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SCAN_TIMEOUT_MS,
  type FileScanner,
  type ScannerName,
  scanWithDeadline,
} from "../security/scanner.js";

export const DEFAULT_SCAN_MAX_FILES = 50_000;
export const DEFAULT_SCAN_MAX_BYTES = 10 * 1024 ** 3;
/** Wall clock for one whole run (a nightly job, not an all-day one). */
export const DEFAULT_SCAN_DEADLINE_MS = 60 * 60 * 1000;
const INDEX_VERSION = 2;
/** Sightings kept in one quarantine sidecar (the same content found again and again). */
const SIGHTINGS_MAX = 100;
/** Error entries kept in a result (the count is exact). */
const ERRORS_MAX = 200;

export type ShareScanOptions = {
  shares: string[];
  scanner: FileScanner;
  /** KOLO_HOME: the scan index and the default quarantine live under <home>/guardian. */
  home: string;
  maxFiles?: number;
  maxBytes?: number;
  quarantine?: { dir?: string; mode?: "copy" | "move" };
  /** Per-file engine wall clock. */
  fileTimeoutMs?: number;
  /** Whole-run wall clock. */
  deadlineMs?: number;
  now?: () => number;
};

export type InfectedFile = {
  path: string;
  sha256: string | null;
  signature: string | null;
  /** The quarantine copy, or null when it could not be made (an error entry says why). */
  quarantined: string | null;
  /** Where the original was moved (`mode: "move"`), else null. */
  movedTo: string | null;
};

export type ShareScanResult = {
  scanner: ScannerName;
  scanned: number;
  /** Unchanged since the same engine found them clean. */
  skipped: number;
  /** Symlinks not followed (escaping the share, or a directory link). */
  symlinksSkipped: number;
  bytes: number;
  infected: InfectedFile[];
  errors: { path: string; detail: string }[];
  /** Total errors (the list keeps the first ERRORS_MAX). */
  errorCount: number;
  truncated: boolean;
  truncatedBy: "maxFiles" | "maxBytes" | "deadline" | null;
  quarantineDir: string;
  ms: number;
};

type IndexEntry = FileStamp & { scanner: ScannerName };
type ScanIndex = { version: number; files: Record<string, IndexEntry> };

export function guardianDir(home: string): string {
  return path.join(home, "guardian");
}

export function scanIndexPath(home: string): string {
  return path.join(guardianDir(home), "scan-index.json");
}

export function resolveQuarantineDir(home: string, dir?: string): string {
  return dir ? path.resolve(dir) : path.join(guardianDir(home), "quarantine");
}

function readIndex(file: string): ScanIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ScanIndex;
    if (raw?.version === INDEX_VERSION && raw.files && typeof raw.files === "object") {
      return raw;
    }
  } catch {
    // missing or unreadable: start over (every file is scanned, never skipped)
  }
  return { version: INDEX_VERSION, files: {} };
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function sha256OfFile(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    h.update(chunk as Buffer);
  }
  return h.digest("hex");
}

/** True when `child` is `parent` or inside it (both resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  // `..data` is a name inside the parent; only `..` itself or `../…` leaves it.
  return !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

type Sidecar = {
  sha256: string;
  size: number;
  firstSeen: string;
  sightings: {
    originalPath: string;
    scanner: ScannerName;
    verdict: "infected";
    signature: string | null;
    at: string;
    movedTo: string | null;
  }[];
};

/** What a file looked like when the engine judged it (inode and ctime cannot be set by users). */
export type FileStamp = { size: number; mtimeMs: number; ctimeMs: number; ino: number };

export const stampOf = (st: fs.Stats): FileStamp => ({
  size: st.size,
  mtimeMs: st.mtimeMs,
  ctimeMs: st.ctimeMs,
  ino: st.ino,
});

const sameStamp = (a: FileStamp, b: FileStamp) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

/**
 * Hash and copy `file` through ONE open descriptor into `tmp`, so the hash is of the bytes copied.
 * When `expect` is given, the open file must still be the one the engine scanned (same inode,
 * size, mtime and ctime) before and after the copy; anything else throws.
 */
function hashCopy(file: string, tmp: string, expect?: FileStamp): string {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const before = stampOf(fs.fstatSync(fd));
    if (expect && !sameStamp(before, expect)) {
      throw new Error("file changed after it was scanned");
    }
    const out = fs.openSync(tmp, "w", 0o600);
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let n: number;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        h.update(buf.subarray(0, n));
        fs.writeSync(out, buf, 0, n);
      }
    } finally {
      fs.closeSync(out);
    }
    if (!sameStamp(before, stampOf(fs.fstatSync(fd)))) {
      throw new Error("file changed while it was quarantined");
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * Copy an infected file into quarantine as <sha256> (+ <sha256>.json) and, when asked, move the
 * original there too. Never deletes; a move across volumes is refused (it would be copy + delete),
 * and so is moving a symlink (that would move the link, not the infected file it points to).
 */
export async function quarantineFile(params: {
  file: string;
  dir: string;
  mode: "copy" | "move";
  scanner: ScannerName;
  signature: string | null;
  now: Date;
  /** The file as scanned; a different file now is an error, not a quarantine. */
  expect?: FileStamp;
  /** `file` is a symlink (inside the share) to the scanned file. */
  isLink?: boolean;
}): Promise<{ sha256: string; copy: string; movedTo: string | null; moveError: string | null }> {
  const { file, dir } = params;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.incoming.${process.pid}.${params.now.getTime()}.tmp`);
  const sha256 = hashCopy(file, tmp, params.expect);
  const copy = path.join(dir, sha256);
  if (fs.existsSync(copy)) {
    fs.rmSync(tmp, { force: true }); // the same content is already quarantined
  } else {
    fs.renameSync(tmp, copy);
  }
  let movedTo: string | null = null;
  let moveError: string | null = null;
  if (params.mode === "move" && params.isLink) {
    moveError = "original not moved: it is a symlink (a copy of its target is kept)";
  } else if (params.mode === "move") {
    const target = path.join(dir, `${sha256}.${params.now.getTime()}.original`);
    try {
      fs.renameSync(file, target);
      movedTo = target;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      moveError =
        code === "EXDEV"
          ? "original not moved: quarantine is on another volume (a copy is kept)"
          : `original not moved (${code}); a copy is kept`;
    }
  }
  const sidecarPath = path.join(dir, `${sha256}.json`);
  let sidecar: Sidecar | null = null;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as Sidecar;
  } catch {
    sidecar = null;
  }
  const at = params.now.toISOString();
  const next: Sidecar = {
    sha256,
    size: fs.statSync(copy).size,
    firstSeen: sidecar?.firstSeen ?? at,
    sightings: [
      ...(Array.isArray(sidecar?.sightings) ? sidecar.sightings : []),
      {
        originalPath: file,
        scanner: params.scanner,
        verdict: "infected" as const,
        signature: params.signature,
        at,
        movedTo,
      },
    ].slice(-SIGHTINGS_MAX),
  };
  writeJsonAtomic(sidecarPath, next);
  return { sha256, copy, movedTo, moveError };
}

/** One lock per KOLO_HOME: two runs at once would race on the index. */
function acquireLock(file: string, staleMs: number, now: number): (() => void) | null {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return null;
      }
      let age = 0;
      try {
        age = now - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age < staleMs) {
        return null;
      }
      // A lock older than two whole-run deadlines belongs to a run that died.
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

export async function scanShares(opts: ShareScanOptions): Promise<ShareScanResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const maxFiles = opts.maxFiles ?? DEFAULT_SCAN_MAX_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_SCAN_MAX_BYTES;
  const deadline = t0 + (opts.deadlineMs ?? DEFAULT_SCAN_DEADLINE_MS);
  const fileTimeoutMs = opts.fileTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const qDir = resolveQuarantineDir(opts.home, opts.quarantine?.dir);
  const result: ShareScanResult = {
    scanner: opts.scanner.name,
    scanned: 0,
    skipped: 0,
    symlinksSkipped: 0,
    bytes: 0,
    infected: [],
    errors: [],
    errorCount: 0,
    truncated: false,
    truncatedBy: null,
    quarantineDir: qDir,
    ms: 0,
  };
  const fail = (p: string, detail: string) => {
    result.errorCount += 1;
    if (result.errors.length < ERRORS_MAX) {
      result.errors.push({ path: p, detail });
    }
  };
  const done = () => ({ ...result, ms: Math.max(0, now() - t0) });

  if (opts.scanner.name === "none") {
    fail("", "no malware scanner is available (install ClamAV or Defender, or name one)");
    return done();
  }
  if (opts.shares.length === 0) {
    fail("", "no shares are configured (guardian.shares)");
    return done();
  }
  const release = acquireLock(
    path.join(guardianDir(opts.home), "scan.lock"),
    2 * (opts.deadlineMs ?? DEFAULT_SCAN_DEADLINE_MS),
    t0,
  );
  if (!release) {
    fail("", "another share scan is running");
    return done();
  }
  try {
    const indexFile = scanIndexPath(opts.home);
    const index = readIndex(indexFile);
    const seen = new Set<string>();
    const qReal = (() => {
      try {
        return fs.realpathSync(qDir);
      } catch {
        return qDir;
      }
    })();

    let overBudget = 0;
    const stop = (by: ShareScanResult["truncatedBy"]) => {
      result.truncated = true;
      result.truncatedBy = by;
    };

    const scanOne = async (file: string, st: fs.Stats, isLink: boolean): Promise<void> => {
      seen.add(file);
      const stamp = stampOf(st);
      const prior = index.files[file];
      if (prior && prior.scanner === opts.scanner.name && sameStamp(prior, stamp)) {
        result.skipped += 1;
        return;
      }
      if (result.scanned >= maxFiles) {
        stop("maxFiles");
        return;
      }
      if (st.size > maxBytes) {
        // Never fits: an error every run (escalates), while the walk goes on.
        fail(file, `too large to scan (${st.size} bytes; maxBytes ${maxBytes})`);
        return;
      }
      if (result.bytes + st.size > maxBytes) {
        // Does not fit tonight: smaller files still do; what was scanned is remembered, so the
        // next run gets further instead of stopping at the same file.
        overBudget += 1;
        return;
      }
      result.scanned += 1;
      result.bytes += st.size;
      delete index.files[file];
      const v = await scanWithDeadline(opts.scanner, file, fileTimeoutMs);
      if (v.verdict === "clean") {
        // Remember it only if it is still the file the engine read.
        try {
          if (sameStamp(stampOf(fs.statSync(file)), stamp)) {
            index.files[file] = { ...stamp, scanner: opts.scanner.name };
          }
        } catch {
          // gone or unreadable now: scanned again next run
        }
        return;
      }
      if (v.verdict !== "infected") {
        fail(file, v.detail ?? v.verdict);
        return;
      }
      const entry: InfectedFile = {
        path: file,
        sha256: null,
        signature: v.signature,
        quarantined: null,
        movedTo: null,
      };
      result.infected.push(entry);
      try {
        const q = await quarantineFile({
          file,
          dir: qDir,
          mode: opts.quarantine?.mode ?? "copy",
          scanner: opts.scanner.name,
          signature: v.signature,
          now: new Date(now()),
          expect: stamp,
          isLink,
        });
        entry.sha256 = q.sha256;
        entry.quarantined = q.copy;
        entry.movedTo = q.movedTo;
        if (q.moveError) {
          fail(file, q.moveError);
        }
      } catch (err) {
        fail(file, `quarantine failed: ${String(err instanceof Error ? err.message : err)}`);
      }
    };

    for (const share of opts.shares) {
      if (!path.isAbsolute(share)) {
        fail(share, "share path is not absolute");
        continue;
      }
      let root: string;
      try {
        root = fs.realpathSync(share);
        if (!fs.statSync(root).isDirectory()) {
          fail(share, "share is not a folder");
          continue;
        }
      } catch (err) {
        fail(share, `share unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
        continue;
      }
      const stack = [share];
      while (stack.length > 0 && !result.truncated) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
          fail(dir, `folder unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
          continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          if (result.truncated) {
            break;
          }
          if (now() > deadline) {
            stop("deadline");
            break;
          }
          if (result.bytes >= maxBytes) {
            stop("maxBytes");
            break;
          }
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            // Guardian's own quarantine is never rescanned (every copy there is infected).
            if (!isInside(qReal, full) && !isInside(qDir, full)) {
              stack.push(full);
            }
            continue;
          }
          let st: fs.Stats;
          try {
            if (e.isSymbolicLink()) {
              const real = fs.realpathSync(full);
              if (!isInside(root, real)) {
                // A link out of the share may point anywhere: unknown, so an error (escalates).
                fail(full, "symlink points outside the share; not scanned");
                continue;
              }
              st = fs.statSync(real);
              if (!st.isFile()) {
                result.symlinksSkipped += 1; // a folder link inside the share (cycles)
                continue;
              }
            } else if (e.isFile()) {
              st = fs.lstatSync(full);
            } else {
              continue; // sockets, devices, FIFOs
            }
          } catch (err) {
            if (e.isSymbolicLink()) {
              result.symlinksSkipped += 1; // dangling
              continue;
            }
            fail(full, `unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
            continue;
          }
          await scanOne(full, st, e.isSymbolicLink());
        }
      }
    }

    if (overBudget > 0 && !result.truncated) {
      stop("maxBytes");
    }
    // A complete run forgets files that are gone; a truncated one keeps what it did not reach.
    if (!result.truncated) {
      for (const p of Object.keys(index.files)) {
        if (!seen.has(p)) {
          delete index.files[p];
        }
      }
    }
    try {
      writeJsonAtomic(indexFile, index);
    } catch (err) {
      fail(indexFile, `scan index not saved (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    return done();
  } finally {
    release();
  }
}

/**
 * Fact lines for infected files (engine check output), at most `max`: the full SHA-256, the
 * engine's signature and Kurahi's quarantine copy (`<copy>.json` beside it holds the original
 * path). Never the original share path, so a model has nothing to paraphrase into one.
 */
export function infectedFileFacts(infected: InfectedFile[], max: number): Record<string, string> {
  const out: Record<string, string> = {};
  infected.slice(0, max).forEach((f, i) => {
    const n = i + 1;
    out[`infected${n}Sha256`] = f.sha256 ?? "unhashed";
    out[`infected${n}Signature`] = f.signature ?? "unknown";
    out[`infected${n}Quarantine`] = f.quarantined ?? "not-quarantined";
  });
  return out;
}
