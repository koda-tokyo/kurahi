// FORTRAN and PL/I inventory of the modernisation tools: the unit or procedure list, or one entry
// in full with its declarations, COMMON blocks, calls, file I/O, SQL and ON-units, each at
// path:line. COMMON blocks are listed with the FORTRAN units (name `/GRID/` gives one block).

import type { Polyglot } from "./project.js";

export function sciInventory(poly: Polyglot, kind: "fortran" | "pli", name?: string) {
  if (kind === "fortran") {
    const f = poly.fortran;
    if (!name) {
      return {
        units: f.units.map((u) => ({
          name: u.id,
          kind: u.kind,
          ...(u.host ? { host: u.host } : {}),
          implicit: u.implicit ?? "default (I-N INTEGER, others REAL)",
          calls: f.calls.filter((c) => c.from === u.id).length,
          commons: f.commons.filter((c) => c.users.some((x) => x.unit === u.id)).map((c) => c.name),
          file: u.file,
          line: u.line,
        })),
        commons: f.commons.map((c) => ({
          name: c.name,
          layout: c.layout,
          users: c.users.map((u) => ({ unit: u.unit, file: u.file, line: u.line })),
        })),
      };
    }
    const q = name.trim().toUpperCase();
    const block = /^\/(.*)\/$/.exec(q);
    if (block) {
      const c = f.commons.find((x) => x.name === (block[1] === "" ? "//" : block[1]));
      if (!c) {
        throw new Error(`No COMMON block ${name} in the FORTRAN sources.`);
      }
      return { common: c };
    }
    const u = f.units.find((x) => x.id === q) ?? f.units.find((x) => x.name === q);
    if (!u) {
      throw new Error(`No FORTRAN unit named ${name}.`);
    }
    return {
      unit: u,
      calls: f.calls.filter((c) => c.from === u.id),
      callers: f.calls.filter((c) => c.to === u.id),
      commons: f.commons
        .filter((c) => c.users.some((x) => x.unit === u.id))
        .map((c) => ({
          name: c.name,
          layout: c.layout,
          use: c.users.find((x) => x.unit === u.id),
        })),
      includes: f.includes.filter((i) => i.unit === u.id),
      fileUses: f.fileUses.filter((x) => x.unit === u.id),
      unresolvedIo: f.unresolvedIo.filter((x) => x.unit === u.id),
    };
  }
  const p = poly.pli;
  if (!name) {
    return {
      procedures: p.procs.map((x) => ({
        name: x.qualified,
        main: x.main,
        ...(x.parent ? { parent: x.parent } : {}),
        calls: x.calls.length,
        tables: [...new Set(x.sql.flatMap((s) => s.tables))].toSorted(),
        files: [...new Set(x.io.map((i) => i.fileName))].toSorted(),
        file: x.file,
        line: x.line,
      })),
      structures: p.structures.map((s) => ({
        name: s.root.name,
        proc: s.proc,
        members: s.members.length,
        file: s.root.file,
        line: s.root.line,
      })),
    };
  }
  const q = name.trim().toUpperCase();
  const x = p.procs.find((y) => y.qualified === q) ?? p.procs.find((y) => y.name === q);
  if (!x) {
    throw new Error(`No PL/I procedure named ${name}.`);
  }
  return {
    procedure: x,
    calls: p.calls.filter((c) => c.from === x.qualified),
    callers: p.calls.filter((c) => c.to === x.qualified || c.to === x.name),
    fileUses: p.fileUses.filter((u) => u.proc === x.qualified),
    tableUses: p.tableUses.filter((u) => u.proc === x.qualified),
    structures: p.structures.filter((s) => s.proc === x.qualified),
  };
}
