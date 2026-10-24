// FORTRAN file parser: program units (PROGRAM, SUBROUTINE, FUNCTION, MODULE, BLOCK DATA, with
// internal and module procedures after CONTAINS), and per unit its declarations, IMPLICIT rule,
// USE, INCLUDE, COMMON, EQUIVALENCE, CALL sites, names referenced with `(` (function references
// are resolved later), I/O statements and ENTRY points. Interface blocks and derived type
// definitions are skipped (they declare, they do not define units). Constructs that change
// control flow or storage in ways the engine does not follow are gaps: computed and assigned
// GO TO, arithmetic IF, ENTRY, alternate returns, Cray pointers, EXEC SQL, preprocessor lines.

import type { FortranFile, FortranUnit, FortranUnitKind } from "./fortran-types.js";
import type { EngineGap } from "./types.js";
import {
  blankLiterals,
  closeParen,
  fortranForm,
  fortranStatements,
  splitTop,
} from "./fortran-source.js";
import {
  TYPE_SPEC,
  declEntities,
  parseCommon,
  parseEquivalence,
  parseIo,
  parseParameter,
  typeText,
  unitEnd,
  unitHeader,
} from "./fortran-stmt.js";

const SPEC_START =
  /^(IMPLICIT|DIMENSION|PARAMETER|COMMON|EQUIVALENCE|EXTERNAL|INTRINSIC|SAVE|DATA|USE|INCLUDE|NAMELIST|ALLOCATABLE|POINTER|TARGET|INTENT|OPTIONAL|PUBLIC|PRIVATE|PROTECTED|VOLATILE|VALUE|IMPORT|FORMAT|ENTRY|PROCEDURE|SEQUENCE|BIND)\b/;
const NOT_FUNCS = new Set([
  "IF",
  "ELSEIF",
  "CALL",
  "READ",
  "WRITE",
  "OPEN",
  "CLOSE",
  "PRINT",
  "INQUIRE",
  "REWIND",
  "BACKSPACE",
  "FORMAT",
  "DO",
  "WHILE",
  "WHERE",
  "SELECT",
  "CASE",
  "ALLOCATE",
  "DEALLOCATE",
  "NULLIFY",
  "RETURN",
  "STOP",
  "THEN",
  "FORALL",
  "ASSOCIATE",
  "GOTO",
]);

function newUnit(
  kind: FortranUnitKind,
  name: string,
  file: string,
  line: number,
  extra: Partial<FortranUnit> = {},
): FortranUnit {
  return {
    file,
    line,
    name,
    kind,
    endLine: line,
    args: [],
    prefixes: [],
    decls: [],
    uses: [],
    commons: [],
    equivalences: [],
    includes: [],
    calls: [],
    io: [],
    entries: [],
    refs: [],
    ...extra,
  };
}

const isAssignment = (t: string) =>
  !t.includes("::") && /^[A-Z]\w*\s*(\((?:[^()]|\([^()]*\))*\))?\s*(%\s*\w+\s*)*=(?!=)/.test(t);

export function parseFortranFile(path: string, text: string): FortranFile {
  const form = fortranForm(path, text);
  const { stmts, pre, comments, code } = fortranStatements(text, form);
  /** The comment block right above a unit header (its purpose, as the author wrote it). */
  const docAbove = (line: number): string | undefined => {
    const out: string[] = [];
    for (let l = line - 1; l > 0 && !code.has(l); l--) {
      const c = comments.get(l);
      if (c) {
        out.unshift(c);
      }
    }
    const text = out.join(" ").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 300) : undefined;
  };
  const gaps: EngineGap[] = pre.map((p) => ({
    file: path,
    line: p.line,
    construct: "preprocessor",
    detail: `${p.text} (not evaluated: every branch is read as written)`,
  }));
  const gap = (line: number, construct: string, detail: string) =>
    gaps.push({ file: path, line, construct, detail: detail.slice(0, 160) });
  const units: FortranUnit[] = [];
  const stack: FortranUnit[] = [];
  const contains = new Set<FortranUnit>();
  let fragment: FortranUnit | undefined;
  let skipInterface = 0;
  let skipType = 0;

  const current = (line: number, executable: boolean): FortranUnit => {
    const top = stack[stack.length - 1];
    if (top) {
      return top;
    }
    if (executable) {
      // A main program without a PROGRAM statement (FORTRAN 77): named after the file.
      const base =
        path
          .split("/")
          .pop()
          ?.replace(/\.[^.]*$/, "")
          .toUpperCase() ?? "MAIN";
      const u = newUnit(
        "program",
        base,
        path,
        line,
        fragment ? { ...fragment, kind: "program", name: base } : {},
      );
      gap(
        line,
        "unnamed main program",
        `no PROGRAM statement: the unit is named ${base} after the file`,
      );
      fragment = undefined;
      units.push(u);
      stack.push(u);
      return u;
    }
    fragment ??= newUnit("program", "(include)", path, line);
    return fragment;
  };

  const executable = (t: string, line: number, u: FortranUnit) => {
    const loc = { file: path, line };
    if (/^GO\s*TO\s*\(/.test(t)) {
      gap(line, "computed GO TO", t);
    } else if (/^GO\s*TO\s*[A-Z]\w*\s*(,|\(|$)/.test(t) || /^ASSIGN\s+\d+\s+TO\b/.test(t)) {
      gap(line, "assigned GO TO", t);
    } else if (/^EXEC\s+SQL\b/.test(t)) {
      gap(line, "EXEC SQL", t);
      return;
    } else if (/^RETURN\s+\S/.test(t)) {
      gap(line, "alternate return", t);
    }
    if (/^(ELSE\s*)?IF\s*\(/.test(t) || /^WHERE\s*\(/.test(t)) {
      const open = t.indexOf("(");
      const end = closeParen(t, open);
      if (end > 0) {
        const rest = t.slice(end).trim();
        refsOf(t.slice(0, end), line, u);
        if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(rest)) {
          gap(line, "arithmetic IF", t);
        } else if (rest !== "" && !/^THEN\b/.test(rest)) {
          executable(rest, line, u);
        }
        return;
      }
    }
    const call = /^CALL\s+(\w+)\s*(\(([\s\S]*)\))?\s*$/.exec(t);
    if (call) {
      const list = call[3] !== undefined ? splitTop(call[3]) : [];
      if (list.some((a) => /^[*&]\s*\d+$/.test(a))) {
        gap(line, "alternate return", t);
      }
      u.calls.push({ ...loc, name: call[1], args: list.length, form: "call" });
      if (call[3] !== undefined) {
        refsOf(call[3], line, u);
      }
      return;
    }
    const io = parseIo(t, loc);
    if (io) {
      u.io.push(io);
      const close = t.indexOf("(") >= 0 ? closeParen(t, t.indexOf("(")) : -1;
      refsOf(close > 0 ? t.slice(close) : t.replace(/^\w+/, ""), line, u);
      return;
    }
    refsOf(t, line, u);
  };

  const refsOf = (t: string, line: number, u: FortranUnit) => {
    const re = /(^|[^.\w%])([A-Z]\w*)\s*\(/g;
    const s = blankLiterals(t);
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (!NOT_FUNCS.has(m[2])) {
        u.refs.push({ file: path, line, name: m[2] });
      }
    }
  };

  for (const st of stmts) {
    const t = st.text.trim();
    const line = st.line;
    const loc = { file: path, line };
    if (skipInterface > 0) {
      if (/^(ABSTRACT\s+)?INTERFACE\b/.test(t)) {
        skipInterface++;
      } else if (/^END\s*INTERFACE\b/.test(t)) {
        skipInterface--;
      }
      continue;
    }
    if (skipType > 0) {
      if (/^END\s*TYPE\b/.test(t)) {
        skipType--;
      }
      continue;
    }
    if (/^(ABSTRACT\s+)?INTERFACE\b/.test(t)) {
      skipInterface = 1;
      continue;
    }
    if (/^TYPE\s*(,[^:]*)?::\s*\w+/.test(t) || /^TYPE\s+(?!IS\b)\w+\s*$/.test(t)) {
      skipType = 1;
      continue;
    }
    if (/^SUBMODULE\b/.test(t)) {
      gap(line, "SUBMODULE", t);
      continue;
    }
    const h = unitHeader(t);
    if (h) {
      const top = stack[stack.length - 1];
      if (top && !contains.has(top)) {
        gap(line, "unit inside a unit", `${h.name}: ${top.name} has no END before it`);
        top.endLine = line - 1;
        stack.pop();
      }
      const host = stack[stack.length - 1];
      const u = newUnit(h.kind, h.name, path, line, {
        args: h.args,
        prefixes: h.prefixes,
        ...(h.resultType ? { resultType: h.resultType } : {}),
        ...(docAbove(line) ? { doc: docAbove(line) } : {}),
        ...(host ? { host: host.host ? `${host.host}.${host.name}` : host.name } : {}),
      });
      units.push(u);
      stack.push(u);
      continue;
    }
    const end = unitEnd(t);
    if (end) {
      const u = stack.pop();
      if (!u) {
        if (fragment) {
          current(line, true).endLine = line;
          stack.pop();
        } else {
          gap(line, "END without unit", t);
        }
        continue;
      }
      u.endLine = line;
      if (end.name && end.name !== u.name) {
        gap(line, "END name mismatch", `END ${end.word} ${end.name} closes ${u.name}`);
      }
      continue;
    }
    if (/^CONTAINS\s*$/.test(t)) {
      const top = stack[stack.length - 1];
      if (top) {
        contains.add(top);
      }
      continue;
    }
    const spec = SPEC_START.test(t) || (TYPE_SPEC.test(t) && !isAssignment(t));
    const u = current(line, !spec);
    if (!spec) {
      executable(t, line, u);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^IMPLICIT\s*(NONE)?/.exec(t))) {
      u.implicit = m[1] ? "NONE" : t;
      u.implicitAt = loc;
    } else if (
      (m =
        /^USE\b\s*(?:,\s*(INTRINSIC|NON_INTRINSIC)\s*)?(?:::)?\s*(\w+)\s*(?:,\s*ONLY\s*:\s*([\s\S]*))?$/.exec(
          t,
        ))
    ) {
      u.uses.push({
        ...loc,
        module: m[2],
        ...(m[3] !== undefined ? { only: splitTop(m[3]).map((x) => x.replace(/\s+/g, "")) } : {}),
        ...(m[1] === "INTRINSIC" ? { intrinsic: true } : {}),
      });
    } else if ((m = /^INCLUDE\s*(['"])(.+)\1/.exec(t))) {
      u.includes.push({ ...loc, name: m[2] });
    } else if ((m = /^COMMON\b([\s\S]*)$/.exec(t))) {
      for (const c of parseCommon(m[1], loc)) {
        const prev = u.commons.find((x) => x.block === c.block);
        if (prev) {
          prev.members.push(...c.members);
        } else {
          u.commons.push(c);
        }
      }
    } else if ((m = /^EQUIVALENCE\b([\s\S]*)$/.exec(t))) {
      u.equivalences.push({ ...loc, groups: parseEquivalence(m[1]) });
    } else if ((m = /^PARAMETER\s*(\([\s\S]*\))\s*$/.exec(t))) {
      for (const p of parseParameter(m[1])) {
        const d = u.decls.find((x) => x.name === p.name);
        if (d) {
          d.value = p.value;
          d.attrs = [...new Set([...d.attrs, "PARAMETER"])];
        } else {
          u.decls.push({ ...loc, name: p.name, type: "", attrs: ["PARAMETER"], value: p.value });
        }
      }
    } else if ((m = /^(DIMENSION|EXTERNAL)\b\s*(?:::)?([\s\S]*)$/.exec(t))) {
      for (const e of splitTop(m[2])) {
        const em = /^(\w+)\s*(?:\(([\s\S]*)\))?$/.exec(e.trim());
        if (!em) {
          continue;
        }
        const d = u.decls.find((x) => x.name === em[1]);
        const dims = em[2]?.replace(/\s+/g, "");
        if (d) {
          if (dims) {
            d.dims = dims;
          }
          d.attrs = [...new Set([...d.attrs, m[1]])];
        } else {
          u.decls.push({ ...loc, name: em[1], type: "", attrs: [m[1]], ...(dims ? { dims } : {}) });
        }
      }
    } else if ((m = /^ENTRY\s+(\w+)/.exec(t))) {
      u.entries.push({ ...loc, name: m[1] });
      gap(
        line,
        "ENTRY",
        `${m[1]} in ${u.name}: an alternate entry point (calls to it are linked to ${u.name}; the flow from it is not modelled)`,
      );
    } else if (/^POINTER\s*\(\s*\w+\s*,/.test(t)) {
      gap(line, "Cray pointer", t);
    } else if (TYPE_SPEC.test(t) && !/^(DATA|FORMAT)\b/.test(t)) {
      const ts = TYPE_SPEC.exec(t) as RegExpExecArray;
      for (const d of declEntities(t.slice(ts[0].length), typeText(ts[0]), loc)) {
        const prev = u.decls.find((x) => x.name === d.name);
        if (prev && prev.type === "") {
          Object.assign(prev, {
            ...d,
            attrs: [...new Set([...prev.attrs, ...d.attrs])],
            dims: d.dims ?? prev.dims,
            value: d.value ?? prev.value,
          });
        } else if (!prev) {
          u.decls.push(d);
        }
      }
    }
  }
  for (const u of stack) {
    gap(u.line, "unterminated unit", `${u.name} has no END (the file may be truncated)`);
    u.endLine = Math.max(u.line, stmts[stmts.length - 1]?.line ?? u.line);
  }
  const hasContent = (f: FortranUnit) =>
    f.decls.length + f.commons.length + f.equivalences.length + f.includes.length + f.uses.length >
    0;
  return {
    path,
    form,
    units,
    ...(fragment && hasContent(fragment) ? { fragment } : {}),
    statements: stmts.length,
    gaps: gaps.toSorted((a, b) => a.line - b.line),
  };
}
