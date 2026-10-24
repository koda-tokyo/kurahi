// Content digest for skills and plugin packages (OWASP ASI04, supply-chain lock).
//
// The digest of a directory is SHA-256 over one line per regular file, sorted by relative POSIX
// path (byte order): `<relPath>\0<sha256 of the file bytes>\n`. `node_modules` and `.git` are
// skipped at any depth; symlinks are followed (cycle-safe), so the digest covers what the loader
// would read. A single file (a one-file plugin) digests as a directory holding just that file.
// File modes, mtimes and empty directories are not part of the digest.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SUPPLY_CHAIN_IGNORED_DIRS = new Set(["node_modules", ".git"]);
/** Refuse to digest more than this many files (a skill is a handful; a dump is not a skill). */
export const SUPPLY_CHAIN_MAX_FILES = 5000;

export type ArtifactFile = {
  rel: string;
  abs: string;
  size: number;
  stamp: string;
  /** ctime in ms (racy-cache check). */
  ctimeMs: number;
};

export type ArtifactDigest = {
  sha256: string;
  files: number;
  bytes: number;
};

/** Walk `target` and list its regular files, sorted by relative path. Throws when unreadable. */
export function listArtifactFiles(target: string): ArtifactFile[] {
  const root = fs.realpathSync(target);
  const statOf = (p: string) => fs.statSync(p, { bigint: true });
  const entryOf = (rel: string, abs: string, st: fs.BigIntStats): ArtifactFile => ({
    rel,
    abs,
    size: Number(st.size),
    stamp: `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`,
    ctimeMs: Number(st.ctimeMs),
  });
  const rootStat = statOf(root);
  if (rootStat.isFile()) {
    return [entryOf(path.basename(target), root, rootStat)];
  }
  const out: ArtifactFile[] = [];
  const visited = new Set<string>([root]);
  const walk = (dir: string, relDir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (SUPPLY_CHAIN_IGNORED_DIRS.has(name)) {
        continue;
      }
      const abs = path.join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st: fs.BigIntStats;
      try {
        st = statOf(abs);
      } catch {
        // Dangling symlink: record it so a link that later resolves changes the digest.
        out.push({ rel, abs, size: -1, stamp: "dangling", ctimeMs: 0 });
        continue;
      }
      if (st.isDirectory()) {
        const real = fs.realpathSync(abs);
        if (visited.has(real)) {
          continue;
        }
        visited.add(real);
        walk(abs, rel);
      } else if (st.isFile()) {
        out.push(entryOf(rel, abs, st));
      }
      if (out.length > SUPPLY_CHAIN_MAX_FILES) {
        throw new Error(`more than ${SUPPLY_CHAIN_MAX_FILES} files under ${target}`);
      }
    }
  };
  walk(root, "");
  return out.toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function digestFiles(files: ArtifactFile[]): ArtifactDigest {
  const outer = createHash("sha256");
  let bytes = 0;
  for (const f of files) {
    const inner =
      f.size < 0 ? "dangling" : createHash("sha256").update(fs.readFileSync(f.abs)).digest("hex");
    bytes += Math.max(0, f.size);
    outer.update(`${f.rel}\0${inner}\n`);
  }
  return { sha256: outer.digest("hex"), files: files.length, bytes };
}

// Per-process cache keyed by the stat signature (size, mtime, ctime, inode of every file), so
// repeated skill loads do not re-read unchanged trees. ctime cannot be set back from userspace,
// so an edit that restores the mtime still invalidates the entry. Like git's "racy" index
// check, a tree with a file changed in the last RACY_WINDOW_MS is never cached: a same-size
// edit inside the filesystem's timestamp granularity would otherwise look unchanged.
const cache = new Map<string, { stamp: string; digest: ArtifactDigest }>();
const RACY_WINDOW_MS = 3000;

/** SHA-256 digest of a skill directory or plugin package (file or directory). */
export function digestArtifact(target: string, opts: { cache?: boolean } = {}): ArtifactDigest {
  const files = listArtifactFiles(target);
  const stamp = files.map((f) => `${f.rel}\0${f.stamp}`).join("\n");
  const key = path.resolve(target);
  if (opts.cache !== false) {
    const hit = cache.get(key);
    if (hit?.stamp === stamp) {
      return hit.digest;
    }
  }
  const digest = digestFiles(files);
  const newest = files.reduce((max, f) => Math.max(max, f.ctimeMs), 0);
  if (opts.cache !== false && Date.now() - newest > RACY_WINDOW_MS) {
    cache.set(key, { stamp, digest });
  } else {
    cache.delete(key);
  }
  return digest;
}

export function clearArtifactDigestCache(): void {
  cache.clear();
}
