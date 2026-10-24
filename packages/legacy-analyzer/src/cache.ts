// Index cache. The analyser writes only here: `<project>/output/.legacy-index/` when the indexed
// path is inside a project with an `output/` folder (the path itself, or up to two levels
// above it), otherwise `<state dir>/legacy-index/`. Writes are refused outside that folder.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LegacyIndex } from "./types.js";
import { isSkippedPath, listSourceFiles } from "./indexer.js";

export const CACHE_DIR_NAME = ".legacy-index";

export function resolveCacheDir(rootInput: string, stateDir: string): string {
  const root = path.resolve(rootInput);
  let dir = fs.existsSync(root) && fs.statSync(root).isFile() ? path.dirname(root) : root;
  for (let n = 0; n <= 2; n++) {
    const out = path.join(dir, "output");
    try {
      if (fs.statSync(out).isDirectory() && !isSkippedPath(out)) {
        return path.join(out, CACHE_DIR_NAME);
      }
    } catch {
      // no output folder here
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return path.join(path.resolve(stateDir), "legacy-index");
}

export function cacheFileFor(cacheDir: string, root: string): string {
  const id = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(cacheDir, `index-${id}.json`);
}

/** Write `content` to `name` inside `cacheDir` only (atomic rename). */
export function writeInCache(cacheDir: string, name: string, content: string): string {
  const dir = path.resolve(cacheDir);
  const target = path.resolve(dir, name);
  if (path.dirname(target) !== dir || target.split(path.sep).includes("_answer-keys")) {
    throw new Error(`Refusing to write ${target}: outside the analyser cache folder.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

export function saveIndex(index: LegacyIndex, cacheDir: string): string {
  return writeInCache(
    cacheDir,
    path.basename(cacheFileFor(cacheDir, index.root)),
    JSON.stringify(index),
  );
}

/** The cached index for `root`, or null when missing or when any source file changed. */
export function loadFreshIndex(root: string, cacheDir: string): LegacyIndex | null {
  const file = cacheFileFor(cacheDir, root);
  let index: LegacyIndex;
  try {
    index = JSON.parse(fs.readFileSync(file, "utf8")) as LegacyIndex;
  } catch {
    return null;
  }
  if (index.schema !== "kurahi.legacy-index/1" || index.root !== path.resolve(root)) {
    return null;
  }
  const base = fs.statSync(index.root).isFile() ? path.dirname(index.root) : index.root;
  const current = listSourceFiles(root);
  const known = new Map(index.files.map((f) => [f.path, f]));
  const skipped = index.diagnostics.filter((d) => d.message.startsWith("Skipped:")).length;
  if (current.length !== index.files.length + skipped) {
    return null;
  }
  for (const rel of current) {
    const f = known.get(rel);
    if (!f) {
      continue;
    }
    try {
      const st = fs.statSync(path.join(base, rel));
      if (st.size !== f.size || Math.floor(st.mtimeMs) !== f.mtimeMs) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return index;
}
