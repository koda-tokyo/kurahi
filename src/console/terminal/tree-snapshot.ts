// Before/after snapshots of a project's files around each console terminal command, for the
// `file.diff` event. A shell command does not say which files it will touch, so the per-tool
// snapshot store (src/snapshots, which captures files named before a write) does not fit; this
// walks the project instead, bounded, and reuses the previous state of every file whose size,
// mtime and inode did not change, so only changed files are read again.
//
// Tracked: regular files under the project root, not following symlinks, skipping `.git`,
// `node_modules`, other hidden directories and the projects' excluded folders. Content is kept
// only for small text files; secret-looking files are hashed but their content is never kept.

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { EXCLUDED_DIR_NAMES } from "../../projects/store.js";

export type FileState = {
  size: number;
  mtimeMs: number;
  ino: number;
  /** sha256 of the content; null when not read (over the size or read budget). */
  hash: string | null;
  /** UTF-8 content for small text files (null for binary, large or secret files). */
  text: string | null;
  binary: boolean;
};

export type TreeSnapshot = { files: Map<string, FileState>; truncated: boolean };

export type SnapshotLimits = {
  maxFiles: number;
  maxDepth: number;
  /** Files larger than this are compared by size and mtime only. */
  maxHashBytes: number;
  /** Text content is kept up to this size per file. */
  maxTextBytes: number;
  /** Total text kept per session. */
  maxCacheBytes: number;
  /** Bytes read per snapshot (unchanged files are not read again). */
  maxReadBytes: number;
};

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFiles: 5_000,
  maxDepth: 16,
  maxHashBytes: 1024 * 1024,
  maxTextBytes: 256 * 1024,
  maxCacheBytes: 32 * 1024 * 1024,
  maxReadBytes: 128 * 1024 * 1024,
};

const SKIP_DIRS = new Set(["node_modules", ...EXCLUDED_DIR_NAMES]);

export const SECRET_FILE_RE =
  /(^|\/)(\.env(\..*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env))$/i;

export class TreeSnapshotter {
  private previous = new Map<string, FileState>();

  constructor(
    readonly root: string,
    private readonly limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
  ) {}

  private async walk(): Promise<{
    entries: Array<{ rel: string; abs: string }>;
    truncated: boolean;
  }> {
    const entries: Array<{ rel: string; abs: string }> = [];
    let truncated = false;
    const visit = async (dir: string, rel: string, depth: number) => {
      let items;
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= this.limits.maxFiles) {
          truncated = true;
          return;
        }
        const childRel = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) {
          if (item.name.startsWith(".") || SKIP_DIRS.has(item.name)) {
            continue;
          }
          if (depth >= this.limits.maxDepth) {
            truncated = true;
            continue;
          }
          await visit(path.join(dir, item.name), childRel, depth + 1);
        } else if (item.isFile()) {
          entries.push({ rel: childRel, abs: path.join(dir, item.name) });
        }
      }
    };
    await visit(this.root, "", 0);
    return { entries, truncated };
  }

  /** Snapshot the tree; files with an unchanged stat reuse the previous state. */
  async snapshot(): Promise<TreeSnapshot> {
    const { entries, truncated } = await this.walk();
    const files = new Map<string, FileState>();
    let readBudget = this.limits.maxReadBytes;
    let cacheBytes = 0;
    for (const { rel, abs } of entries) {
      let stat;
      try {
        stat = await fsp.lstat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const prev = this.previous.get(rel);
      if (
        prev &&
        prev.size === stat.size &&
        prev.mtimeMs === stat.mtimeMs &&
        prev.ino === stat.ino
      ) {
        files.set(rel, prev);
        cacheBytes += prev.text?.length ?? 0;
        continue;
      }
      const state: FileState = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        hash: null,
        text: null,
        binary: false,
      };
      if (stat.size <= this.limits.maxHashBytes && stat.size <= readBudget) {
        try {
          const buf = await fsp.readFile(abs);
          readBudget -= buf.length;
          state.hash = createHash("sha256").update(buf).digest("hex");
          state.binary = buf.subarray(0, 8000).includes(0);
          const keepText =
            !state.binary &&
            !SECRET_FILE_RE.test(rel) &&
            buf.length <= this.limits.maxTextBytes &&
            cacheBytes + buf.length <= this.limits.maxCacheBytes;
          if (keepText) {
            state.text = buf.toString("utf8");
            cacheBytes += state.text.length;
          }
        } catch {
          // unreadable: compared by stat only
        }
      }
      files.set(rel, state);
    }
    this.previous = files;
    return { files, truncated };
  }
}

export function sameContent(a: FileState, b: FileState): boolean {
  if (a.hash && b.hash) {
    return a.hash === b.hash;
  }
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}
