// Indexer: finds COBOL programs, copybooks and JCL under a root, parses them, and returns the
// fact index. It only reads. File paths in the index are relative to the root (POSIX style).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodeStream } from "./source.js";
import type { Diagnostic, LegacyIndex, SourceFile } from "./types.js";
import { parseCobolFile } from "./cobol.js";
import { expandProcs, parseJcl } from "./jcl.js";
import { readCodeStream } from "./source.js";

const COBOL_EXT = new Set([".cbl", ".cob", ".cobol", ".ccp"]);
const COPY_EXT = new Set([".cpy", ".copy", ".cob-copy", ".inc"]);
const JCL_EXT = new Set([".jcl", ".proc", ".prc"]);

/**
 * Directories never entered: hidden answer keys, caches, Kurahi's own state in a project
 * (`.kurahi/`, where `kurahi legacy mcp` keeps its cache and call log), VCS and dependency folders.
 */
export const SKIPPED_DIRS = new Set([
  "_answer-keys",
  ".legacy-index",
  ".kurahi",
  ".git",
  "node_modules",
]);

export const LIMITS = { maxFiles: 5000, maxFileBytes: 4 * 1024 * 1024 };

export type IndexOptions = { maxFiles?: number; maxFileBytes?: number };

function kindOf(file: string): SourceFile["kind"] | null {
  const ext = path.extname(file).toLowerCase();
  if (COBOL_EXT.has(ext)) {
    return "cobol";
  }
  if (COPY_EXT.has(ext)) {
    return "copybook";
  }
  if (JCL_EXT.has(ext)) {
    return "jcl";
  }
  return null;
}

/** True when `p` passes through a skipped directory. */
export function isSkippedPath(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => SKIPPED_DIRS.has(seg));
}

function walk(root: string, max: number, diagnostics: Diagnostic[]): string[] {
  const out: string[] = [];
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return [path.basename(root)];
  }
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) {
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) {
          visit(full);
        }
      } else if (e.isFile() && kindOf(e.name)) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  if (out.length >= max) {
    diagnostics.push({
      file: ".",
      line: 0,
      severity: "warning",
      message: `File limit reached (${max}); the index is partial.`,
    });
  }
  return out;
}

/** Source files (relative paths) the indexer would read under `root`. */
export function listSourceFiles(rootInput: string, opts: IndexOptions = {}): string[] {
  return walk(path.resolve(rootInput), opts.maxFiles ?? LIMITS.maxFiles, []);
}

export function buildIndex(rootInput: string, opts: IndexOptions = {}): LegacyIndex {
  const root = path.resolve(rootInput);
  if (isSkippedPath(root)) {
    throw new Error(`Refusing to index ${root}: the path is excluded from analysis.`);
  }
  const diagnostics: Diagnostic[] = [];
  const isFileRoot = fs.statSync(root).isFile();
  const base = isFileRoot ? path.dirname(root) : root;
  const rels = walk(root, opts.maxFiles ?? LIMITS.maxFiles, diagnostics);
  const contents = new Map<string, string>();
  const files: SourceFile[] = [];
  for (const rel of rels) {
    const abs = path.join(base, rel);
    const st = fs.statSync(abs);
    if (st.size > (opts.maxFileBytes ?? LIMITS.maxFileBytes)) {
      diagnostics.push({
        file: rel,
        line: 0,
        severity: "warning",
        message: `Skipped: larger than ${opts.maxFileBytes ?? LIMITS.maxFileBytes} bytes.`,
      });
      continue;
    }
    const buf = fs.readFileSync(abs);
    // Mainframe extracts are often Latin-1; decode as such when the bytes are not valid UTF-8.
    let text = buf.toString("utf8");
    if (text.includes("�")) {
      text = buf.toString("latin1");
    }
    contents.set(rel, text);
    let kind = kindOf(rel) as SourceFile["kind"];
    if (kind === "cobol" && !/\b(IDENTIFICATION|ID)\s+DIVISION\b/i.test(text)) {
      kind = "copybook"; // a copybook stored with a program extension
    }
    files.push({
      path: rel,
      kind,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    });
  }

  const streamCache = new Map<string, CodeStream>();
  const streams = (rel: string): CodeStream | null => {
    const hit = streamCache.get(rel);
    if (hit) {
      return hit;
    }
    const text = contents.get(rel);
    if (text === undefined) {
      return null;
    }
    const s = readCodeStream(rel, text);
    streamCache.set(rel, s);
    return s;
  };

  // Copybook lookup by member name (file name without extension), copybooks first.
  const members = new Map<string, string>();
  for (const f of files.toSorted(
    (a, b) => (a.kind === "copybook" ? 0 : 1) - (b.kind === "copybook" ? 0 : 1),
  )) {
    if (f.kind === "jcl") {
      continue;
    }
    const member = path
      .basename(f.path)
      .replace(/\.[^.]+$/, "")
      .toUpperCase();
    if (!members.has(member)) {
      members.set(member, f.path);
    }
  }
  const resolve = (name: string) => {
    const rel = members.get(name.toUpperCase());
    const text = rel ? contents.get(rel) : undefined;
    return rel && text !== undefined ? { file: rel, content: text } : null;
  };

  const programs: LegacyIndex["programs"] = [];
  const jobs: LegacyIndex["jobs"] = [];
  for (const f of files) {
    if (f.kind === "cobol") {
      const parsed = parseCobolFile(f.path, streams, resolve);
      programs.push(...parsed.programs);
      diagnostics.push(...parsed.diagnostics);
    } else if (f.kind === "jcl") {
      const parsed = parseJcl(f.path, contents.get(f.path) ?? "");
      jobs.push(...parsed.jobs);
      diagnostics.push(...parsed.diagnostics);
    }
  }
  expandProcs(jobs);

  const copybooks: LegacyIndex["copybooks"] = files
    .filter((f) => f.kind === "copybook")
    .map((f) => ({
      name: path
        .basename(f.path)
        .replace(/\.[^.]+$/, "")
        .toUpperCase(),
      file: f.path,
      usedBy: programs.flatMap((p) =>
        p.copies
          .filter((c) => c.resolved === f.path)
          .map((c) => ({ program: p.name, file: c.file, line: c.line })),
      ),
    }));

  // Report each unresolved COPY once per location.
  const seen = new Set<string>();
  const dedup = diagnostics.filter((d) => {
    const k = `${d.file}:${d.line}:${d.message}`;
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });

  return {
    schema: "kurahi.legacy-index/1",
    root,
    files,
    programs,
    copybooks,
    jobs,
    diagnostics: dedup,
  };
}

/** Copybook source by member name, for the dictionary (re-read from the index root). */
export function readIndexedFile(index: LegacyIndex, rel: string): string | null {
  const base = fs.statSync(index.root).isFile() ? path.dirname(index.root) : index.root;
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep) && abs !== base) {
    return null;
  }
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
