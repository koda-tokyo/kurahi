// PL/I facts across files: %INCLUDE members resolved to files of the project (their declarations
// become the including procedure's, cited at the member's lines), CALL edges resolved to internal
// procedures in scope, external procedures of the PL/I sources, or names declared ENTRY (linked by
// name to COBOL or FORTRAN programs of the project in the polyglot graph), file I/O bound to the
// FILE constant and its DD name (TITLE of the OPEN, else the file name), EXEC SQL table access
// per procedure, structures and ON-units.

import type { Loc } from "../types.js";
import type { PliDecl, PliFile, PliFileDecl, PliProc } from "./pli-types.js";
import type { EngineGap } from "./types.js";

export type PliResolvedCall = Loc & {
  /** Qualified name of the calling procedure. */
  from: string;
  to: string;
  name: string;
  resolution: "internal" | "external procedure" | "declared ENTRY" | "not in the PL/I sources";
};

export type PliFileUse = Loc & {
  /** External (outermost) procedure the file belongs to, and the procedure doing the I/O. */
  program: string;
  proc: string;
  verb: string;
  /** The FILE constant. */
  fileName: string;
  dd: string;
  declared?: Loc & { attrs: string[] };
  mode?: string;
};

export type PliTableUse = Loc & {
  program: string;
  proc: string;
  table: string;
  op: string;
  text: string;
};

export type PliAnalysis = {
  files: PliFile[];
  procs: PliProc[];
  includes: Array<Loc & { proc: string; name: string; resolved?: string }>;
  includeFiles: string[];
  calls: PliResolvedCall[];
  fileUses: PliFileUse[];
  tableUses: PliTableUse[];
  /** Level-1 structures with their members, by declaring procedure. */
  structures: Array<{ proc: string; root: PliDecl; members: PliDecl[] }>;
  gaps: EngineGap[];
};

const outer = (qn: string) => qn.split(".")[0];

export function analysePli(
  files: PliFile[],
  parseInclude: (name: string, from: string) => PliFile | null = () => null,
): PliAnalysis {
  const gaps: EngineGap[] = files.flatMap((f) => f.gaps);
  const procs: PliProc[] = [];
  const byQn = new Map<string, PliProc>();
  for (const p of files.flatMap((f) => f.procs)) {
    const prev = byQn.get(p.qualified);
    if (prev) {
      gaps.push({
        file: p.file,
        line: p.line,
        construct: "duplicate procedure",
        detail: `${p.qualified} is also defined at ${prev.file}:${prev.line}; the first definition is used`,
      });
      continue;
    }
    byQn.set(p.qualified, p);
    procs.push(p);
  }
  procs.sort((a, b) => (a.qualified < b.qualified ? -1 : a.qualified > b.qualified ? 1 : 0));

  // %INCLUDE: the member's declarations join the procedure.
  const includes: PliAnalysis["includes"] = [];
  const includeFiles = new Set<string>();
  for (const p of procs) {
    for (const inc of p.includes) {
      const f = parseInclude(inc.name, p.file);
      includes.push({
        file: inc.file,
        line: inc.line,
        proc: p.qualified,
        name: inc.name,
        ...(f ? { resolved: f.path } : {}),
      });
      if (f) {
        includeFiles.add(f.path);
        p.decls.push(...(f.fragment ?? []).map((d) => ({ ...d, via: f.path })));
      }
    }
  }

  // Calls: internal procedures visible from the caller, then external ones.
  const children = (qn: string) => procs.filter((x) => x.parent === qn);
  const scopeChain = (p: PliProc): PliProc[] => {
    const out = [p];
    let cur = p.parent ? byQn.get(p.parent) : undefined;
    while (cur) {
      out.push(cur);
      cur = cur.parent ? byQn.get(cur.parent) : undefined;
    }
    return out;
  };
  const externals = new Map(procs.filter((p) => !p.parent).map((p) => [p.name, p]));
  const calls: PliResolvedCall[] = [];
  for (const p of procs) {
    const chain = scopeChain(p);
    for (const c of p.calls) {
      const base = { file: c.file, line: c.line, from: p.qualified, name: c.name };
      const internal = chain
        .flatMap((s) => [s, ...children(s.qualified)])
        .find((x) => x.name === c.name && x.parent);
      if (internal) {
        calls.push({ ...base, to: internal.qualified, resolution: "internal" });
      } else if (externals.has(c.name)) {
        calls.push({ ...base, to: c.name, resolution: "external procedure" });
      } else if (chain.some((s) => s.entries.some((e) => e.name === c.name))) {
        calls.push({ ...base, to: c.name, resolution: "declared ENTRY" });
      } else {
        calls.push({ ...base, to: c.name, resolution: "not in the PL/I sources" });
      }
    }
  }

  // File I/O: the FILE constant in scope; its DD name is the OPEN TITLE, else the file name.
  const fileUses: PliFileUse[] = [];
  for (const p of procs) {
    const chain = scopeChain(p);
    const program = outer(p.qualified);
    const titles = new Map<string, string>();
    for (const s of procs.filter((x) => outer(x.qualified) === program)) {
      for (const io of s.io.filter((x) => x.verb === "OPEN" && x.title)) {
        titles.set(io.fileName, io.title as string);
      }
    }
    for (const io of p.io) {
      const decl: PliFileDecl | undefined = chain
        .flatMap((s) => s.files)
        .find((f) => f.name === io.fileName);
      if ((io.fileName === "SYSPRINT" || io.fileName === "SYSIN") && !decl) {
        continue; // console stream I/O
      }
      fileUses.push({
        file: io.file,
        line: io.line,
        program,
        proc: p.qualified,
        verb: io.verb,
        fileName: io.fileName,
        dd: titles.get(io.fileName) ?? io.fileName,
        ...(decl ? { declared: { file: decl.file, line: decl.line, attrs: decl.attrs } } : {}),
        ...(io.mode ? { mode: io.mode } : {}),
      });
    }
  }

  // SQL table access.
  const tableUses: PliTableUse[] = [];
  for (const p of procs) {
    for (const q of p.sql) {
      for (const t of q.tables) {
        tableUses.push({
          file: q.file,
          line: q.line,
          program: outer(p.qualified),
          proc: p.qualified,
          table: t,
          op: q.op,
          text: q.text,
        });
      }
    }
  }

  // Structures.
  const structures: PliAnalysis["structures"] = [];
  for (const p of procs) {
    for (const d of p.decls.filter((x) => x.level === 1)) {
      const members = p.decls.filter(
        (x) =>
          x !== d &&
          x.path.length > 1 &&
          x.path[0] === d.name &&
          x.file === d.file &&
          x.line >= d.line,
      );
      if (members.length > 0) {
        structures.push({ proc: p.qualified, root: d, members });
      }
    }
  }
  return {
    files,
    procs,
    includes,
    includeFiles: [...includeFiles].toSorted(),
    calls,
    fileUses,
    tableUses,
    structures,
    gaps: gaps.toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)),
  };
}
