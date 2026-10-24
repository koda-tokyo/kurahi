// One project, every active engine: the COBOL/JCL fact index (built by the caller, usually from
// its cache), plus the Java, SQL DDL, FORTRAN and PL/I engines run on the files the registry
// detects under the same root. INCLUDE and %INCLUDE members are looked up among all files of the
// scan (same folder first). Deterministic: files are read in sorted order and no time or absolute
// path is kept.

import path from "node:path";
import type { LegacyIndex } from "../types.js";
import type { FortranFile } from "./fortran-types.js";
import type { PliFile } from "./pli-types.js";
import type { JavaFile, SqlModel } from "./types.js";
import { parseFortranFile } from "./fortran-parser.js";
import { type FortranAnalysis, analyseFortran } from "./fortran-resolve.js";
import { parseJavaFile } from "./java-parser.js";
import { type JavaAnalysis, analyseJava } from "./java-resolve.js";
import { parsePliFile } from "./pli-parser.js";
import { type PliAnalysis, analysePli } from "./pli-resolve.js";
import { type Detection, detectLanguages } from "./registry.js";
import { type Scan, type ScannedFile, readScanned, scanProject } from "./scan.js";
import { analyseSql } from "./sql-ddl.js";

export type Polyglot = {
  index: LegacyIndex;
  scan: Pick<Scan, "partial"> & { files: number };
  detections: Detection[];
  java: JavaAnalysis;
  sql: SqlModel;
  fortran: FortranAnalysis;
  pli: PliAnalysis;
  /** Files an active engine would read but could not (too large, unreadable). */
  unread: string[];
};

const FORTRAN_INC = ["", ".inc", ".h", ".cmn", ".fi", ".f", ".for"];
const PLI_INC = [".plinc", ".pli", ".pl1", ".inc", ".cpy", ".copy", "", ".txt"];

/**
 * The file an include names: FORTRAN `INCLUDE 'GRID.CMN'` by file name, PL/I `%INCLUDE RATEREC`
 * by member name; case-insensitive, the including file's folder first, then the shortest path.
 */
export function includeFinder(files: ScannedFile[], exts: string[]) {
  const byBase = new Map<string, ScannedFile[]>();
  for (const f of files) {
    const base = path.posix.basename(f.path).toUpperCase();
    byBase.set(base, [...(byBase.get(base) ?? []), f]);
  }
  return (name: string, from: string): ScannedFile | undefined => {
    const want = path.posix.basename(name.replace(/\\/g, "/")).toUpperCase();
    const dir = path.posix.dirname(from);
    for (const ext of exts) {
      const hits = byBase.get(`${want}${ext.toUpperCase()}`) ?? [];
      if (hits.length > 0) {
        return hits.toSorted(
          (a, b) =>
            Number(path.posix.dirname(b.path) === dir) -
              Number(path.posix.dirname(a.path) === dir) ||
            a.path.length - b.path.length ||
            (a.path < b.path ? -1 : 1),
        )[0];
      }
    }
    return undefined;
  };
}

export function analyseProject(index: LegacyIndex): Polyglot {
  const scan = scanProject(index.root);
  const { detections, byLanguage } = detectLanguages(scan.files);
  const unread: string[] = [];
  const read = <T>(lang: Parameters<typeof byLanguage.get>[0], fn: (p: string, t: string) => T) => {
    const out: T[] = [];
    for (const f of byLanguage.get(lang) ?? []) {
      const text = readScanned(scan, f);
      if (text === null) {
        unread.push(f.path);
        continue;
      }
      out.push(fn(f.path, text));
    }
    return out;
  };
  const javaFiles: JavaFile[] = read("java", parseJavaFile);
  const sqlInputs = read("sql-ddl", (p, text) => ({ path: p, text }));
  const fortranFiles: FortranFile[] = read("fortran", parseFortranFile);
  const pliFiles: PliFile[] = read("pli", parsePliFile);

  const included = <T>(exts: string[], parse: (p: string, t: string) => T) => {
    const find = includeFinder(scan.files, exts);
    const cache = new Map<string, T | null>();
    return (name: string, from: string): T | null => {
      const f = find(name, from);
      if (!f) {
        return null;
      }
      if (!cache.has(f.path)) {
        const text = readScanned(scan, f);
        if (text === null && !unread.includes(f.path)) {
          unread.push(f.path);
        }
        cache.set(f.path, text === null ? null : parse(f.path, text));
      }
      return cache.get(f.path) ?? null;
    };
  };
  return {
    index,
    scan: { files: scan.files.length, partial: scan.partial },
    detections,
    java: analyseJava(javaFiles),
    sql: analyseSql(sqlInputs),
    fortran: analyseFortran(fortranFiles, included(FORTRAN_INC, parseFortranFile)),
    pli: analysePli(pliFiles, included(PLI_INC, parsePliFile)),
    unread: unread.toSorted(),
  };
}
