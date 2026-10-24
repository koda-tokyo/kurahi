// FORTRAN facts across files: INCLUDE resolution (the include's declarations and COMMON become
// the including unit's, cited at the include's lines), COMMON blocks shared across units with
// each unit's member layout and types (explicit or from the IMPLICIT rule), CALL edges and
// function references resolved to units of the sources (internal, module through USE, external),
// USE edges to modules, and file I/O bound to files: a FILE= literal of an OPEN on the same unit
// number (in the same unit, else the only one in the project), otherwise the mainframe DD name
// FTnnF001 for the unit number. Units given by variables, FILE= expressions and units opened
// with several files are listed as unresolved, never guessed.

import type { Loc } from "../types.js";
import type { FortranDecl, FortranFile, FortranIo, FortranUnit } from "./fortran-types.js";
import type { EngineGap } from "./types.js";
import { implicitMap } from "./fortran-stmt.js";

export type FortranMember = { name: string; dims?: string; type: string; implicit: boolean };

export type FortranCommonUse = Loc & {
  unit: string;
  members: FortranMember[];
  /** Include file the declaration came from. */
  via?: string;
};

export type FortranCommonBlock = {
  name: string;
  users: FortranCommonUse[];
  /** same: every unit declares the same names, types and dimensions; otherwise what differs. */
  layout: "same" | "names differ" | "types or sizes differ";
};

export type FortranResolvedCall = Loc & {
  from: string;
  to: string;
  name: string;
  form: "call" | "function";
  resolution: "internal" | "module" | "external unit" | "entry" | "not in the FORTRAN sources";
};

export type FortranFileUse = Loc & {
  unit: string;
  op: "OPEN" | "READ" | "WRITE";
  target: { kind: "file"; name: string } | { kind: "dd"; name: string };
  /** How the unit number was bound to the target. */
  binding: string;
  status?: string;
};

export type FortranAnalysis = {
  files: FortranFile[];
  /** Units sorted by id; the id is the name, or HOST.NAME for internal and module procedures. */
  units: Array<FortranUnit & { id: string }>;
  includes: Array<Loc & { unit: string; name: string; resolved?: string }>;
  /** Include files read through INCLUDE (not program units themselves). */
  includeFiles: string[];
  commons: FortranCommonBlock[];
  calls: FortranResolvedCall[];
  uses: Array<Loc & { unit: string; module: string; resolved: boolean; intrinsic: boolean }>;
  fileUses: FortranFileUse[];
  unresolvedIo: Array<Loc & { unit: string; op: string; reason: string }>;
  consoleIo: number;
  gaps: EngineGap[];
};

export type IncludeReader = (name: string, from: string) => { path: string; text: string } | null;

const unitId = (u: FortranUnit) => (u.host ? `${u.host}.${u.name}` : u.name);

export function analyseFortran(
  files: FortranFile[],
  parseInclude: (name: string, from: string) => FortranFile | null = () => null,
): FortranAnalysis {
  const gaps: EngineGap[] = files.flatMap((f) => f.gaps);
  const units = files
    .flatMap((f) => f.units)
    .map((u) => ({ ...u, id: unitId(u) }))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map<string, (typeof units)[number]>();
  for (const u of units) {
    const prev = byId.get(u.id);
    if (prev) {
      gaps.push({
        file: u.file,
        line: u.line,
        construct: "duplicate unit",
        detail: `${u.id} is also defined at ${prev.file}:${prev.line}; the first definition is used`,
      });
      continue;
    }
    byId.set(u.id, u);
  }

  // INCLUDE: merge the include file's specification part into the unit.
  const includes: FortranAnalysis["includes"] = [];
  const includeFiles = new Set<string>();
  const merged = new Map<
    string,
    { decls: FortranDecl[]; commons: Array<FortranCommonUse & { block: string }> }
  >();
  const implicitOf = (u: FortranUnit | undefined): string | undefined =>
    u?.implicit ?? (u?.host ? implicitOf(byId.get(u.host)) : undefined);
  for (const u of byId.values()) {
    const decls = [...u.decls];
    const commonRaw: Array<{ c: FortranUnit["commons"][number]; via?: string }> = u.commons.map(
      (c) => ({ c }),
    );
    for (const inc of u.includes) {
      const f = parseInclude(inc.name, u.file);
      includes.push({
        file: inc.file,
        line: inc.line,
        unit: u.id,
        name: inc.name,
        ...(f ? { resolved: f.path } : {}),
      });
      if (!f) {
        continue;
      }
      includeFiles.add(f.path);
      const frag = f.fragment;
      if (frag) {
        decls.push(...frag.decls.filter((d) => !decls.some((x) => x.name === d.name)));
        commonRaw.push(...frag.commons.map((c) => ({ c, via: f.path })));
        if (!u.implicit && frag.implicit) {
          u.implicit = frag.implicit;
          u.implicitAt = frag.implicitAt;
        }
      }
    }
    const rule = implicitOf(u);
    const letters = rule && rule !== "NONE" ? implicitMap(rule) : new Map<string, string>();
    const typeOf = (name: string): { type: string; implicit: boolean } => {
      const d = decls.find((x) => x.name === name && x.type !== "");
      if (d) {
        return { type: d.type, implicit: false };
      }
      if (rule === "NONE") {
        return { type: "(undeclared under IMPLICIT NONE)", implicit: true };
      }
      const first = name[0];
      return {
        type: letters.get(first) ?? (first >= "I" && first <= "N" ? "INTEGER" : "REAL"),
        implicit: true,
      };
    };
    const commons = commonRaw.map(({ c, via }) => ({
      file: c.file,
      line: c.line,
      unit: u.id,
      block: c.block,
      ...(via ? { via } : {}),
      members: c.members.map((m) => {
        const d = decls.find((x) => x.name === m.name);
        const dims = m.dims ?? d?.dims;
        return { name: m.name, ...(dims ? { dims } : {}), ...typeOf(m.name) };
      }),
    }));
    merged.set(u.id, { decls, commons });
    u.decls = decls; // with the include files' declarations, at their own lines
  }

  // COMMON blocks across units.
  const blocks = new Map<string, FortranCommonUse[]>();
  for (const [, m] of merged) {
    for (const c of m.commons) {
      const { block, ...use } = c;
      blocks.set(block, [...(blocks.get(block) ?? []), use]);
    }
  }
  const commons: FortranCommonBlock[] = [...blocks]
    .toSorted((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, users]) => {
      // DOUBLE PRECISION is REAL*8; dimensions with PARAMETER constants compare by value.
      const sig = (u: FortranCommonUse, names: boolean) => {
        const params = (merged.get(u.unit)?.decls ?? []).filter((d) =>
          d.attrs.includes("PARAMETER"),
        );
        const dims = (d?: string) =>
          (d ?? "").replace(/[A-Z]\w*/g, (w) => params.find((p) => p.name === w)?.value ?? w);
        return u.members
          .map(
            (m) =>
              `${names ? m.name : ""}:${m.type.replace(/^DOUBLE PRECISION$/, "REAL*8")}:${dims(m.dims)}`,
          )
          .join(",");
      };
      const types = new Set(users.map((u) => sig(u, false)));
      const names = new Set(users.map((u) => sig(u, true)));
      return {
        name,
        users,
        layout: types.size > 1 ? "types or sizes differ" : names.size > 1 ? "names differ" : "same",
      };
    });

  // USE edges.
  const modules = new Map(units.filter((u) => u.kind === "module").map((u) => [u.name, u]));
  const uses: FortranAnalysis["uses"] = [];
  for (const u of byId.values()) {
    for (const x of u.uses) {
      uses.push({
        file: x.file,
        line: x.line,
        unit: u.id,
        module: x.module,
        resolved: modules.has(x.module),
        intrinsic:
          x.intrinsic === true || /^(ISO_FORTRAN_ENV|ISO_C_BINDING|IEEE_\w+)$/.test(x.module),
      });
    }
  }

  // Calls and function references.
  const usedModules = (u: FortranUnit | undefined): string[] =>
    u ? [...u.uses.map((x) => x.module), ...(u.host ? usedModules(byId.get(u.host)) : [])] : [];
  const entries = new Map<string, string>();
  for (const u of byId.values()) {
    for (const e of u.entries) {
      entries.set(e.name, u.id);
    }
  }
  const resolve = (u: (typeof units)[number], name: string) => {
    const scopes = [u.id, u.host].filter((x): x is string => Boolean(x));
    for (const s of scopes) {
      const hit = byId.get(`${s}.${name}`);
      if (hit) {
        return {
          to: hit,
          resolution: modules.has(s) ? ("module" as const) : ("internal" as const),
        };
      }
    }
    for (const m of usedModules(u)) {
      const hit = byId.get(`${m}.${name}`);
      if (hit) {
        return { to: hit, resolution: "module" as const };
      }
    }
    const ext = byId.get(name);
    if (ext && ext.kind !== "module" && ext.kind !== "block-data") {
      return { to: ext, resolution: "external unit" as const };
    }
    return undefined;
  };
  const calls: FortranResolvedCall[] = [];
  for (const u of byId.values()) {
    for (const c of u.calls) {
      const r = resolve(u, c.name);
      const entry = entries.get(c.name);
      calls.push({
        file: c.file,
        line: c.line,
        from: u.id,
        name: c.name,
        form: "call",
        ...(r
          ? { to: r.to.id, resolution: r.resolution }
          : entry
            ? { to: entry, resolution: "entry" as const }
            : { to: c.name, resolution: "not in the FORTRAN sources" as const }),
      });
    }
    const local = merged.get(u.id)?.decls ?? [];
    const arrays = new Set([
      ...local
        .filter((d) => d.dims !== undefined || d.type.startsWith("CHARACTER"))
        .map((d) => d.name),
      ...(merged.get(u.id)?.commons ?? []).flatMap((c) =>
        c.members.filter((m) => m.dims).map((m) => m.name),
      ),
    ]);
    const seen = new Set<string>();
    for (const ref of u.refs) {
      if (arrays.has(ref.name) || ref.name === u.name || seen.has(`${ref.name}:${ref.line}`)) {
        continue;
      }
      const r = resolve(u, ref.name);
      if (r && r.to.kind === "function") {
        seen.add(`${ref.name}:${ref.line}`);
        calls.push({
          file: ref.file,
          line: ref.line,
          from: u.id,
          to: r.to.id,
          name: ref.name,
          form: "function",
          resolution: r.resolution,
        });
      }
    }
  }

  // File I/O.
  const fileUses: FortranFileUse[] = [];
  const unresolvedIo: FortranAnalysis["unresolvedIo"] = [];
  let consoleIo = 0;
  const numberOf = (u: FortranUnit, text: string): string | undefined => {
    if (/^\d+$/.test(text)) {
      return String(Number(text));
    }
    const d = (merged.get(unitId(u))?.decls ?? []).find(
      (x) => x.name === text && x.attrs.includes("PARAMETER"),
    );
    return d?.value && /^\d+$/.test(d.value) ? String(Number(d.value)) : undefined;
  };
  const opens = new Map<string, Array<FortranIo & { unitId: string }>>();
  for (const u of byId.values()) {
    for (const io of u.io.filter((x) => x.op === "OPEN" && x.unit && !x.newunit)) {
      const n = numberOf(u, io.unit as string);
      if (n !== undefined) {
        opens.set(n, [...(opens.get(n) ?? []), { ...io, unitId: u.id }]);
      }
    }
  }
  for (const u of byId.values()) {
    const decls = merged.get(u.id)?.decls ?? [];
    for (const io of u.io) {
      if (io.op !== "OPEN" && io.op !== "READ" && io.op !== "WRITE" && io.op !== "PRINT") {
        continue;
      }
      const op = io.op === "PRINT" ? "WRITE" : io.op;
      const base = { file: io.file, line: io.line, unit: u.id, op };
      const text = io.unit ?? "";
      if (text === "*" || text === "") {
        consoleIo++;
        continue;
      }
      const record = (target: FortranFileUse["target"], binding: string, status?: string) =>
        fileUses.push({ ...base, target, binding, ...(status ? { status } : {}) });
      let open: FortranIo | undefined;
      let binding = "";
      const n = numberOf(u, text);
      if (io.op === "OPEN") {
        open = io;
        binding = "OPEN";
      } else if (n === undefined) {
        open = u.io.find((x) => x.op === "OPEN" && x.newunit && x.unit === text);
        binding = `OPEN NEWUNIT=${text}`;
        if (!open) {
          const d = decls.find((x) => x.name === text);
          if (d?.type.startsWith("CHARACTER")) {
            continue; // internal file: I/O on a character variable
          }
          unresolvedIo.push({ ...base, reason: `unit given by the variable ${text}` });
          continue;
        }
      } else {
        const all = opens.get(n) ?? [];
        const own = all.filter((x) => x.unitId === u.id);
        const named = [...new Set(all.map((x) => x.fileName ?? `(${x.fileExpr ?? "no FILE="})`))];
        if (own.length > 0) {
          open = own[0];
          binding = `OPEN of unit ${n} at line ${own[0].line}`;
        } else if (named.length === 1) {
          open = all[0];
          binding = `OPEN of unit ${n} in ${all[0].unitId} (${all[0].file}:${all[0].line})`;
        } else if (named.length > 1) {
          unresolvedIo.push({
            ...base,
            reason: `unit ${n} is opened with several files: ${named.join(", ")}`,
          });
          continue;
        } else if (n === "5" || n === "6") {
          consoleIo++;
          continue;
        } else {
          const dd = `FT${n.padStart(2, "0")}F001`;
          record({ kind: "dd", name: dd }, `no OPEN of unit ${n}: mainframe DD name ${dd}`);
          continue;
        }
      }
      if (open.fileName !== undefined) {
        record({ kind: "file", name: open.fileName }, binding, open.status);
      } else if (open.fileExpr !== undefined) {
        unresolvedIo.push({ ...base, reason: `file name from the expression ${open.fileExpr}` });
      } else {
        const dd = n !== undefined ? `FT${n.padStart(2, "0")}F001` : undefined;
        if (dd) {
          record(
            { kind: "dd", name: dd },
            `OPEN without FILE=: mainframe DD name ${dd}`,
            open.status,
          );
        } else {
          unresolvedIo.push({ ...base, reason: "OPEN without FILE= on a unit variable" });
        }
      }
    }
  }
  return {
    files,
    units: [...byId.values()],
    includes,
    includeFiles: [...includeFiles].toSorted(),
    commons,
    calls,
    uses,
    fileUses,
    unresolvedIo,
    consoleIo,
    gaps: gaps.toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)),
  };
}

/** Members of a COMMON block as one unit declares it, for display: `T(1000) REAL*8`. */
export function memberText(m: FortranMember): string {
  return `${m.name}${m.dims ? `(${m.dims})` : ""} ${m.type}${m.implicit ? " (implicit)" : ""}`;
}
