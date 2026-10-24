// Parsers of single FORTRAN statements (text already upper-cased outside literals): program unit
// headers, type declarations, COMMON, EQUIVALENCE, PARAMETER, USE and I/O control lists.

import type { FortranCommon, FortranDecl, FortranIo, FortranUnitKind } from "./fortran-types.js";
import { closeParen, literal, splitTop } from "./fortran-source.js";

export type Header = {
  kind: FortranUnitKind;
  name: string;
  args: string[];
  prefixes: string[];
  resultType?: string;
  result?: string;
};

const PREFIX = /^(RECURSIVE|PURE|ELEMENTAL|IMPURE|MODULE|NON_RECURSIVE)\b\s*/;
export const TYPE_SPEC =
  /^(INTEGER|REAL|DOUBLE\s*PRECISION|DOUBLE\s*COMPLEX|COMPLEX|LOGICAL|CHARACTER|BYTE|TYPE\s*\(\s*\w+\s*\)|CLASS\s*\(\s*[\w*]+\s*\))(\s*\*\s*(\d+|\(\s*[^)]*\)))?(\s*\((?:[^()]|\([^()]*\))*\))?/;

const args = (s: string | undefined) =>
  s === undefined
    ? []
    : splitTop(s)
        .map((x) => x.trim())
        .filter(Boolean);

/** Normalised type text: `REAL*8`, `REAL(KIND=8)`, `DOUBLE PRECISION`, `CHARACTER(LEN=*)`. */
export function typeText(spec: string): string {
  return spec
    .trim()
    .replace(/^DOUBLE\s*(PRECISION|COMPLEX)/, "DOUBLE $1")
    .replace(/\s*([*(),=])\s*/g, "$1")
    .replace(/\s+/g, " ");
}

/** A program unit header, or null. */
export function unitHeader(t: string): Header | null {
  let m = /^PROGRAM\s+(\w+)/.exec(t);
  if (m) {
    return { kind: "program", name: m[1], args: [], prefixes: [] };
  }
  m = /^BLOCK\s*DATA(?:\s+(\w+))?\s*$/.exec(t);
  if (m) {
    return { kind: "block-data", name: m[1] ?? "(UNNAMED)", args: [], prefixes: [] };
  }
  m = /^MODULE\s+(?!PROCEDURE\b)(\w+)\s*$/.exec(t);
  if (m) {
    return { kind: "module", name: m[1], args: [], prefixes: [] };
  }
  let rest = t;
  const prefixes: string[] = [];
  let typ: string | undefined;
  for (;;) {
    const p = PREFIX.exec(rest);
    if (p) {
      prefixes.push(p[1]);
      rest = rest.slice(p[0].length);
      continue;
    }
    const ts = typ === undefined ? TYPE_SPEC.exec(rest) : null;
    if (ts && /^\s*(RECURSIVE|PURE|ELEMENTAL|IMPURE|FUNCTION)\b/.test(rest.slice(ts[0].length))) {
      typ = typeText(ts[0]);
      rest = rest.slice(ts[0].length).trimStart();
      continue;
    }
    break;
  }
  m = /^SUBROUTINE\s+(\w+)\s*(?:\((.*)\))?\s*(BIND\s*\(.*\))?\s*$/.exec(rest);
  if (m) {
    return { kind: "subroutine", name: m[1], args: args(m[2]), prefixes };
  }
  m = /^FUNCTION\s+(\w+)\s*\(([^)]*)\)\s*(?:RESULT\s*\(\s*(\w+)\s*\))?/.exec(rest);
  if (m) {
    return {
      kind: "function",
      name: m[1],
      args: args(m[2]),
      prefixes,
      ...(typ ? { resultType: typ } : {}),
      ...(m[3] ? { result: m[3] } : {}),
    };
  }
  return null;
}

/** END of a program unit (not END DO / END IF / ...): the unit kind word, if written. */
export function unitEnd(t: string): { word?: string; name?: string } | null {
  if (/^END\s*$/.test(t)) {
    return {};
  }
  const m =
    /^END\s*(PROGRAM|SUBROUTINE|FUNCTION|MODULE|BLOCK\s*DATA|SUBMODULE)\b\s*(\w+)?\s*$/.exec(t);
  return m ? { word: m[1].replace(/\s+/g, " "), ...(m[2] ? { name: m[2] } : {}) } : null;
}

/** Entities of a declaration statement after its type spec. */
export function declEntities(
  rest: string,
  type: string,
  loc: { file: string; line: number },
): FortranDecl[] {
  let attrs: string[] = [];
  let list = rest.trim();
  const dc = list.indexOf("::");
  if (dc >= 0) {
    attrs = splitTop(list.slice(0, dc))
      .map((a) => a.replace(/\s+/g, ""))
      .filter(Boolean);
    list = list.slice(dc + 2);
  } else if (list.startsWith(",")) {
    list = list.slice(1);
  }
  const out: FortranDecl[] = [];
  for (const ent of splitTop(list)) {
    const m = /^(\w+)\s*(\(([\s\S]*?)\))?\s*(\*\s*(\(\s*[^)]*\)|\d+))?\s*(=>?\s*([\s\S]*))?$/.exec(
      ent,
    );
    if (!m) {
      continue;
    }
    const dimAttr = attrs.find((a) => a.startsWith("DIMENSION("));
    const dims = m[3]?.replace(/\s+/g, "") ?? dimAttr?.slice(10, -1);
    const t = m[4] ? `${type.replace(/\*.*$/, "")}*${m[5].replace(/\s+/g, "")}` : type;
    out.push({
      ...loc,
      name: m[1],
      type: t,
      ...(dims ? { dims } : {}),
      attrs: attrs.filter((a) => !a.startsWith("DIMENSION(")),
      ...(m[7] !== undefined ? { value: m[7].trim() } : {}),
    });
  }
  return out;
}

/** `COMMON /A/ X, Y(10), /B/ Z` and blank `COMMON X`: one entry per block. */
export function parseCommon(rest: string, loc: { file: string; line: number }): FortranCommon[] {
  const out: FortranCommon[] = [];
  let s = rest.trim();
  let block = "//";
  let guard = 0;
  while (s.length > 0 && guard++ < 1000) {
    if (s.startsWith(",")) {
      s = s.slice(1).trimStart();
      continue;
    }
    if (s.startsWith("/")) {
      const end = s.indexOf("/", 1);
      if (end < 0) {
        break;
      }
      const name = s.slice(1, end).trim();
      block = name === "" ? "//" : name;
      s = s.slice(end + 1).trimStart();
    }
    // Members up to the next "/" outside parentheses.
    let depth = 0;
    let k = 0;
    for (; k < s.length; k++) {
      const c = s[k];
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      } else if (c === "/" && depth === 0) {
        break;
      }
    }
    const members = splitTop(s.slice(0, k))
      .map((x) => /^(\w+)\s*(?:\((.*)\))?$/.exec(x.trim()))
      .filter((x): x is RegExpExecArray => x !== null)
      .map((x) => ({ name: x[1], ...(x[2] ? { dims: x[2].replace(/\s+/g, "") } : {}) }));
    const prev = out.find((c) => c.block === block);
    if (prev) {
      prev.members.push(...members);
    } else if (members.length > 0) {
      out.push({ ...loc, block, members });
    }
    s = s.slice(k).trimStart();
  }
  return out;
}

/** `EQUIVALENCE (A, B(1)), (C, D)`: the groups as written. */
export function parseEquivalence(rest: string): string[][] {
  return splitTop(rest)
    .map((g) => g.trim().replace(/^\(([\s\S]*)\)$/, "$1"))
    .map((g) => splitTop(g).map((x) => x.replace(/\s+/g, "")))
    .filter((g) => g.length > 0);
}

/** `PARAMETER (N = 10, PI = 3.14)`. */
export function parseParameter(rest: string): Array<{ name: string; value: string }> {
  const inner = rest.trim().replace(/^\(([\s\S]*)\)$/, "$1");
  return splitTop(inner)
    .map((x) => /^(\w+)\s*=\s*([\s\S]+)$/.exec(x.trim()))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => ({ name: x[1], value: x[2].trim() }));
}

const IO_WORDS = /^(OPEN|CLOSE|READ|WRITE|REWIND|BACKSPACE|END\s*FILE|INQUIRE)\b\s*/;

/** An I/O statement, or null. Console forms (`PRINT *`, `READ *,`) have unit `*`. */
export function parseIo(t: string, loc: { file: string; line: number }): FortranIo | null {
  if (/^PRINT\b/.test(t)) {
    return { ...loc, op: "PRINT", unit: "*" };
  }
  const m = IO_WORDS.exec(t);
  if (!m) {
    return null;
  }
  const op = m[1].replace(/\s+/g, "") as FortranIo["op"];
  const after = t.slice(m[0].length);
  if (!after.startsWith("(")) {
    // READ 100, X / READ *, X (console) or REWIND 10.
    if (op === "READ") {
      return { ...loc, op, unit: "*" };
    }
    const u = /^(\w+)\s*$/.exec(after);
    return u ? { ...loc, op, unit: u[1] } : null;
  }
  const end = closeParen(after, 0);
  if (end < 0) {
    return null;
  }
  const items = splitTop(after.slice(1, end - 1));
  const io: FortranIo = { ...loc, op };
  items.forEach((it, k) => {
    const kv = /^(\w+)\s*=\s*([\s\S]+)$/.exec(it);
    if (!kv) {
      if (k === 0) {
        io.unit = it.replace(/\s+/g, "");
      }
      return;
    }
    const v = kv[2].trim();
    switch (kv[1]) {
      case "UNIT":
        io.unit = v.replace(/\s+/g, "");
        break;
      case "NEWUNIT":
        io.unit = v.replace(/\s+/g, "");
        io.newunit = true;
        break;
      case "FILE":
      case "NAME": {
        const lit = literal(v);
        if (lit !== undefined) {
          io.fileName = lit;
        } else {
          io.fileExpr = v;
        }
        break;
      }
      case "STATUS":
      case "ACTION":
      case "ACCESS":
      case "FORM": {
        const key = kv[1].toLowerCase() as "status" | "action" | "access" | "form";
        io[key] = (literal(v) ?? v).toUpperCase();
        break;
      }
      default:
        break;
    }
  });
  return io;
}

/** Letter ranges of an IMPLICIT statement: `IMPLICIT REAL*8 (A-H, O-Z), INTEGER (I-N)`. */
export function implicitMap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = text.replace(/^IMPLICIT\s*/, "");
  for (const part of splitTop(body)) {
    const lm = /\(([^()]*)\)\s*$/.exec(part);
    if (!lm || !TYPE_SPEC.test(part.trim())) {
      continue;
    }
    const type = typeText(part.slice(0, lm.index));
    for (const r of splitTop(lm[1])) {
      const rm = /^([A-Z])\s*(?:-\s*([A-Z]))?$/.exec(r.trim());
      if (!rm) {
        continue;
      }
      const a = rm[1].charCodeAt(0);
      const z = (rm[2] ?? rm[1]).charCodeAt(0);
      for (let c = a; c <= z; c++) {
        out.set(String.fromCharCode(c), type);
      }
    }
  }
  return out;
}
