// Immutable source snapshots (KIMS-010, AC-010/011). A snapshot freezes a Project folder scope
// into a content-addressed store under the Project's data area:
//
//   <data>/snapshots/objects/<sha256>     file content, written once (0444), named by its hash
//   <data>/snapshots/snap-<sha256>.json   manifest: files (hash, size, encoding, line endings),
//                                         skipped entries, toolchain identity, parent
//
// The snapshot id is the SHA-256 of the canonical manifest, so the same content and toolchain
// always give the same id and any change (one byte of source, a flag) gives a new one. Nothing
// is ever rewritten: an existing object or manifest is re-hashed, never overwritten. Builds read
// from the store (materializeSnapshot), never from the live folder.
import fs from "node:fs";
import path from "node:path";
import type {
  FileEncoding,
  LineEnding,
  LocatorCheck,
  SnapshotFile,
  SnapshotManifest,
  SourceLocator,
  SourceSnapshot,
  ToolchainIdentity,
} from "./types.js";
import { canonicalJson, sha256Hex } from "../continuity-suite/manifest.js";

export const SNAPSHOT_SCHEMA = "kurahi.source-snapshot/1" as const;
const SKIP_DIRS = new Set([".git", "node_modules", "output", ".legacy-index", "_answer-keys"]);
export const SNAPSHOT_LIMITS = {
  maxFiles: 5000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotal: 64 << 20,
};
const ID_RE = /^snap-[0-9a-f]{64}$/;

export function snapshotsDir(dataDir: string): string {
  return path.join(dataDir, "snapshots");
}

function objectPath(dataDir: string, sha: string): string {
  return path.join(snapshotsDir(dataDir), "objects", sha);
}

function manifestPath(dataDir: string, id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(`not a snapshot id: ${id}`);
  }
  return path.join(snapshotsDir(dataDir), `${id}.json`);
}

export function isSnapshotId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/** Encoding as observed: ASCII, valid UTF-8, 8-bit text of unknown code page, or binary. */
export function detectEncoding(buf: Buffer): FileEncoding {
  if (buf.includes(0)) {
    return "binary";
  }
  if (buf.every((b) => b < 0x80)) {
    return "ascii";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return "utf-8";
  } catch {
    return "unknown-8bit";
  }
}

export function detectLineEnding(buf: Buffer): LineEnding {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (buf[i] === 0x0a) {
      lf++;
    }
  }
  const kinds = [lf > 0, crlf > 0, cr > 0].filter(Boolean).length;
  if (kinds === 0) {
    return "none";
  }
  if (kinds > 1) {
    return "mixed";
  }
  return lf ? "lf" : crlf ? "crlf" : "cr";
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

type Walked = { files: Array<{ rel: string; abs: string }>; skipped: SnapshotManifest["skipped"] };

function walkScope(root: string): Walked {
  const out: Walked = { files: [], skipped: [] };
  const walk = (dir: string, prefix: string) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        out.skipped.push({ path: rel, reason: "symbolic link (not followed)" });
      } else if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) {
          out.skipped.push({ path: rel, reason: "excluded folder" });
        } else {
          walk(abs, rel);
        }
      } else if (e.isFile()) {
        out.files.push({ rel, abs });
      } else {
        out.skipped.push({ path: rel, reason: "not a regular file" });
      }
    }
  };
  walk(root, "");
  return out;
}

function writeOnce(file: string, data: Buffer | string, expectSha?: string): void {
  if (fs.existsSync(file)) {
    if (expectSha && sha256Hex(fs.readFileSync(file)) !== expectSha) {
      throw new Error(
        `stored object ${path.basename(file)} is corrupt: it no longer matches its hash`,
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o444 });
  fs.renameSync(tmp, file);
}

export function snapshotIdOf(manifest: SnapshotManifest): string {
  return `snap-${sha256Hex(canonicalJson(manifest))}`;
}

/** Freeze `root` (a folder scope) into the store; returns the stored snapshot. */
export function freezeSnapshot(params: {
  root: string;
  dataDir: string;
  toolchain: ToolchainIdentity;
  parent?: string | null;
  now?: () => Date;
}): SourceSnapshot {
  const root = fs.realpathSync(path.resolve(params.root));
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`${params.root} is not a folder`);
  }
  const walked = walkScope(root);
  if (walked.files.length > SNAPSHOT_LIMITS.maxFiles) {
    throw new Error(`more than ${SNAPSHOT_LIMITS.maxFiles} files under ${root}; narrow the scope`);
  }
  let total = 0;
  const files: SnapshotFile[] = [];
  for (const f of walked.files) {
    const buf = fs.readFileSync(f.abs);
    if (buf.length > SNAPSHOT_LIMITS.maxFileBytes) {
      walked.skipped.push({ path: f.rel, reason: `over ${SNAPSHOT_LIMITS.maxFileBytes} bytes` });
      continue;
    }
    total += buf.length;
    if (total > SNAPSHOT_LIMITS.maxTotal) {
      throw new Error(`the scope is over ${SNAPSHOT_LIMITS.maxTotal} bytes; narrow it`);
    }
    const sha = sha256Hex(buf);
    writeOnce(objectPath(params.dataDir, sha), buf, sha);
    const encoding = detectEncoding(buf);
    files.push({
      path: f.rel,
      sha256: sha,
      size: buf.length,
      encoding,
      lineEnding: encoding === "binary" ? "none" : detectLineEnding(buf),
      lines: encoding === "binary" ? 0 : splitLines(buf.toString("latin1")).length,
    });
  }
  const manifest: SnapshotManifest = {
    schema: SNAPSHOT_SCHEMA,
    origin: root,
    parent: params.parent ?? null,
    files,
    skipped: walked.skipped,
    toolchain: params.toolchain,
  };
  const id = snapshotIdOf(manifest);
  const file = manifestPath(params.dataDir, id);
  if (fs.existsSync(file)) {
    return loadSnapshot(params.dataDir, id);
  }
  const stored: SourceSnapshot = {
    ...manifest,
    id,
    createdAt: (params.now?.() ?? new Date()).toISOString(),
  };
  writeOnce(file, `${JSON.stringify(stored, null, 1)}\n`);
  return stored;
}

function manifestOf(s: SourceSnapshot): SnapshotManifest {
  return {
    schema: s.schema,
    origin: s.origin,
    parent: s.parent,
    files: s.files,
    skipped: s.skipped,
    toolchain: s.toolchain,
  };
}

/** Load a stored snapshot; throws when its manifest no longer hashes to its id. */
export function loadSnapshot(dataDir: string, id: string): SourceSnapshot {
  const file = manifestPath(dataDir, id);
  if (!fs.existsSync(file)) {
    throw new Error(`snapshot ${id} is not in the store`);
  }
  const s = JSON.parse(fs.readFileSync(file, "utf8")) as SourceSnapshot;
  if (s.id !== id || snapshotIdOf(manifestOf(s)) !== id) {
    throw new Error(`snapshot ${id} manifest was altered: it no longer hashes to its id`);
  }
  return s;
}

/** Re-hash the manifest and every object: problems, empty when the snapshot is intact. */
export function verifySnapshot(dataDir: string, id: string): string[] {
  let s: SourceSnapshot;
  try {
    s = loadSnapshot(dataDir, id);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const problems: string[] = [];
  for (const f of s.files) {
    const obj = objectPath(dataDir, f.sha256);
    if (!fs.existsSync(obj)) {
      problems.push(`${f.path}: object missing`);
    } else if (sha256Hex(fs.readFileSync(obj)) !== f.sha256) {
      problems.push(`${f.path}: object altered`);
    }
  }
  return problems;
}

export function readSnapshotFile(dataDir: string, snap: SourceSnapshot, rel: string): Buffer {
  const f = snap.files.find((x) => x.path === rel);
  if (!f) {
    throw new Error(`${rel} is not in snapshot ${snap.id}`);
  }
  const buf = fs.readFileSync(objectPath(dataDir, f.sha256));
  if (sha256Hex(buf) !== f.sha256) {
    throw new Error(`${rel}: stored object altered`);
  }
  return buf;
}

/** Write the snapshot's files under `dir` (a fresh build folder) from the store. */
export function materializeSnapshot(dataDir: string, snap: SourceSnapshot, dir: string): void {
  for (const f of snap.files) {
    const target = path.resolve(dir, f.path);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`refusing to materialize ${f.path}: outside the build folder`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readSnapshotFile(dataDir, snap, f.path), { mode: 0o600 });
  }
}

/**
 * Whether the live folder still holds exactly the snapshot's files (same paths, same bytes):
 * the list of differences, empty when it matches.
 */
export function diffLiveFolder(snap: SourceSnapshot, root: string): string[] {
  const walked = walkScope(fs.realpathSync(path.resolve(root)));
  const live = new Map(walked.files.map((f) => [f.rel, f.abs]));
  const out: string[] = [];
  for (const f of snap.files) {
    const abs = live.get(f.path);
    if (!abs) {
      out.push(`${f.path} removed`);
    } else if (sha256Hex(fs.readFileSync(abs)) !== f.sha256) {
      out.push(`${f.path} changed`);
    }
    live.delete(f.path);
  }
  for (const rel of live.keys()) {
    if (!snap.skipped.some((s) => s.path === rel)) {
      out.push(`${rel} added`);
    }
  }
  return out;
}

function excerptSha(buf: Buffer, start: number, end: number): string | null {
  const lines = splitLines(buf.toString("latin1"));
  if (start < 1 || end < start || end > lines.length) {
    return null;
  }
  return sha256Hex(Buffer.from(lines.slice(start - 1, end).join("\n"), "latin1"));
}

/** A locator for lines start..end of `rel` in a stored snapshot. */
export function makeLocator(
  dataDir: string,
  snapshotId: string,
  rel: string,
  startLine: number,
  endLine: number,
): SourceLocator {
  const snap = loadSnapshot(dataDir, snapshotId);
  const sha = excerptSha(readSnapshotFile(dataDir, snap, rel), startLine, endLine);
  if (!sha) {
    throw new Error(`lines ${startLine}-${endLine} are outside ${rel}`);
  }
  return { snapshot: snapshotId, path: rel, startLine, endLine, sha256: sha };
}

/**
 * Check a locator against the frozen snapshot (and, with `liveRoot`, against the live folder):
 * unknown snapshot, path outside it, lines out of range, an excerpt that no longer hashes the
 * same, or a live file that changed since the freeze are all rejected as stale.
 */
export function checkLocator(
  dataDir: string,
  loc: SourceLocator,
  opts: { liveRoot?: string } = {},
): LocatorCheck {
  let snap: SourceSnapshot;
  try {
    snap = loadSnapshot(dataDir, loc.snapshot);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const entry = snap.files.find((f) => f.path === loc.path);
  if (!entry) {
    return { ok: false, reason: `${loc.path} is not in snapshot ${loc.snapshot}` };
  }
  const sha = excerptSha(readSnapshotFile(dataDir, snap, loc.path), loc.startLine, loc.endLine);
  if (!sha) {
    return { ok: false, reason: `lines ${loc.startLine}-${loc.endLine} are outside ${loc.path}` };
  }
  if (sha !== loc.sha256) {
    return { ok: false, reason: `the excerpt of ${loc.path} does not match the locator hash` };
  }
  if (opts.liveRoot) {
    const live = path.join(opts.liveRoot, loc.path);
    if (!fs.existsSync(live)) {
      return { ok: false, reason: `stale: ${loc.path} no longer exists in the live folder` };
    }
    if (sha256Hex(fs.readFileSync(live)) !== entry.sha256) {
      return { ok: false, reason: `stale: ${loc.path} changed since snapshot ${loc.snapshot}` };
    }
  }
  return { ok: true };
}
