// The server's only writes: `<root>/.kurahi/legacy-mcp/cache/` (index cache) and
// `<root>/.kurahi/legacy-mcp/audit.jsonl` (append-only call log). Every folder on the way is
// created by the server or checked to be a real folder (not a symbolic link) inside the root, and
// files are opened with O_NOFOLLOW / O_EXCL, so a link planted in the repository cannot redirect
// a write elsewhere.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KURAHI_DIR_NAME, type ProjectRoot } from "./root-guard.js";

export const STATE_SUBDIR = "legacy-mcp";

const { O_APPEND, O_CREAT, O_EXCL, O_WRONLY } = fs.constants;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Create `rel` (segments under the root) as real folders; refuse any symlinked segment. */
function ensureOwnDir(root: ProjectRoot, segments: string[]): string {
  let dir = root.abs;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing to use ${dir}: not a plain folder inside the project.`);
    }
  }
  if (fs.realpathSync(dir) !== dir) {
    throw new Error(`Refusing to use ${dir}: it resolves outside the project.`);
  }
  return dir;
}

export type ServerState = {
  readonly dir: string;
  readonly cacheDir: string;
  readonly auditFile: string;
  /** Write `name` atomically inside the cache folder. */
  writeCache(name: string, content: string): string;
  readCache(name: string): string | null;
  appendAudit(entry: Record<string, unknown>): void;
};

export function openServerState(root: ProjectRoot): ServerState {
  const dir = ensureOwnDir(root, [KURAHI_DIR_NAME, STATE_SUBDIR]);
  const cacheDir = ensureOwnDir(root, [KURAHI_DIR_NAME, STATE_SUBDIR, "cache"]);
  const auditFile = path.join(dir, "audit.jsonl");

  const cachePath = (name: string) => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name.startsWith(".")) {
      throw new Error(`Refusing cache file name ${name}.`);
    }
    return path.join(cacheDir, name);
  };

  const writeCache = (name: string, content: string) => {
    const target = cachePath(name);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return target;
  };

  const readCache = (name: string) => {
    const target = cachePath(name);
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile()) {
        return null;
      }
      return fs.readFileSync(target, "utf8");
    } catch {
      return null;
    }
  };

  const appendAudit = (entry: Record<string, unknown>) => {
    const fd = fs.openSync(auditFile, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };

  return { dir, cacheDir, auditFile, writeCache, readCache, appendAudit };
}

/** Stable hash of tool arguments (sorted keys), so the log never holds the arguments. */
export function argsHash(args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(canon);
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .toSorted()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canon(args ?? {})))
    .digest("hex");
}
