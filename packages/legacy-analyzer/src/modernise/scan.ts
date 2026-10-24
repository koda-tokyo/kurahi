// Project scan for language detection: every regular file under the root (excluded folders not
// entered, symbolic links not followed), in sorted order, with its extension and the first bytes
// for content sniffing. Read-only. Paths are root-relative, POSIX style, like the COBOL index.

import fs from "node:fs";
import path from "node:path";
import type { Scan, ScannedFile } from "./scan-types.js";
import { SKIPPED_DIRS } from "../indexer.js";
export type { Scan, ScannedFile } from "./scan-types.js";

const EXTRA_SKIPPED = new Set([".kurahi", "target", "build", "dist", ".gradle", ".idea", ".mvn"]);
export const SCAN_LIMITS = { maxFiles: 20_000, headBytes: 4096, maxFileBytes: 4 * 1024 * 1024 };

function readHead(abs: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function scanProject(rootInput: string): Scan {
  const root = path.resolve(rootInput);
  const isFile = fs.statSync(root).isFile();
  const base = isFile ? path.dirname(root) : root;
  const files: ScannedFile[] = [];
  let partial = false;
  const add = (abs: string, st: fs.Stats) => {
    const rel = path.relative(base, abs).split(path.sep).join("/");
    files.push({
      path: rel,
      ext: path.extname(abs).toLowerCase(),
      size: st.size,
      head: readHead(abs, SCAN_LIMITS.headBytes),
    });
  };
  if (isFile) {
    add(root, fs.statSync(root));
    return { root, base, files, partial };
  }
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= SCAN_LIMITS.maxFiles) {
        partial = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name) && !EXTRA_SKIPPED.has(e.name)) {
          visit(full);
        }
      } else if (e.isFile()) {
        add(full, fs.statSync(full));
      }
    }
  };
  visit(root);
  return { root, base, files, partial };
}

/** Full text of a scanned file, or null when it is too large or unreadable. */
export function readScanned(scan: Scan, f: ScannedFile): string | null {
  if (f.size > SCAN_LIMITS.maxFileBytes) {
    return null;
  }
  try {
    const buf = fs.readFileSync(path.join(scan.base, f.path));
    const text = buf.toString("utf8");
    return text.includes("�") ? buf.toString("latin1") : text;
  } catch {
    return null;
  }
}
