// Building blocks of the SQL DDL engine: the statement splitter (with per-line `--` remarks),
// top-level comma splitting, bracket matching, normalised source text, name lists, table
// constraints and column definitions.

import type { SqlColumn, SqlConstraint } from "./types.js";
import { type SqlTok, canonical, isIdent, isW, readName } from "./sql-text.js";

export type Stmt = { text: string; line: number };

// Routine bodies (CREATE PROCEDURE / FUNCTION / TRIGGER / PACKAGE) hold `;` of their own. Inside
// one, a `;` ends the statement only once the body is over: after a PostgreSQL $tag$ body, after
// the END that closes its outermost BEGIN (IF / LOOP / WHILE / REPEAT / FOR ends do not count;
// CASE opens a block), or at once when nothing is still open (a single-statement trigger, a DB2
// RETURN function). An Oracle IS / AS / DECLARE section waits for its block; a package waits for
// its own END. The word after an END is read past comments. A `/` or GO line always ends the
// statement.
const ROUTINE_KINDS = new Set(["PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE"]);
const NOT_A_BLOCK_END = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR"]);

type Routine = {
  first: string;
  head: number;
  prev: string;
  kind?: string;
  depth: number;
  begun: boolean;
  pending: boolean;
  closed: boolean;
  dollar: boolean;
};

const freshRoutine = (): Routine => ({
  first: "",
  head: 0,
  prev: "",
  depth: 0,
  begun: false,
  pending: false,
  closed: false,
  dollar: false,
});

function routineWord(r: Routine, word: string, next: string) {
  const w = word.toUpperCase();
  const prev = r.prev;
  r.prev = w;
  if (!r.kind) {
    // CREATE [OR REPLACE] [EDITIONABLE] <kind>: the kind is within the first five words.
    r.head++;
    if (r.head <= 5 && r.first === "CREATE" && ROUTINE_KINDS.has(w)) {
      r.kind = w;
    }
    r.first ||= w;
    return;
  }
  if (w === "BEGIN" || (w === "CASE" && prev !== "END")) {
    r.depth++;
    r.begun = true;
  } else if (w === "END" && !NOT_A_BLOCK_END.has(next)) {
    r.depth--;
    if (r.kind === "PACKAGE" ? r.depth < 0 : r.depth <= 0) {
      r.closed = true;
    }
  } else if ((w === "IS" || w === "AS" || w === "DECLARE") && r.depth === 0 && !r.begun) {
    r.pending = true;
  }
}

const routineEnds = (r: Routine) =>
  !r.kind || r.dollar || r.closed || (!r.pending && !r.begun && r.depth <= 0);

/** Split a script into statements, with the line each starts on, and the `--` remark per line. */
export function splitStatements(text: string): { stmts: Stmt[]; remarks: Map<number, string> } {
  const stmts: Stmt[] = [];
  const remarks = new Map<number, string>();
  let buf = "";
  let start = 0;
  let line = 1;
  let i = 0;
  let routine = freshRoutine();
  const flush = () => {
    if (buf.trim()) {
      stmts.push({ text: buf, line: start });
    }
    buf = "";
    start = 0;
    routine = freshRoutine();
  };
  while (i < text.length) {
    const c = text[i];
    if (start === 0 && !/\s/.test(c)) {
      start = line;
    }
    if (c === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      const remark = text.slice(i + 2, stop).trim();
      if (remark && buf.trim()) {
        remarks.set(line, remark);
      }
      if (!buf.trim()) {
        start = 0;
      }
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let j = i; j < stop; j++) {
        if (text[j] === "\n") {
          line++;
        }
      }
      if (!buf.trim()) {
        start = 0;
      }
      buf += " ";
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === c && text[j + 1] !== c)) {
        if (text[j] === c) {
          j++;
        }
        if (text[j] === "\n") {
          line++;
        }
        j++;
      }
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        const stop = end < 0 ? text.length : end + tag.length;
        for (let j = i; j < stop; j++) {
          if (text[j] === "\n") {
            line++;
          }
        }
        buf += text.slice(i, stop);
        routine.dollar = true;
        i = stop;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c) && !/[\w$#.]/.test(text[i - 1] ?? "")) {
      const word = /^[A-Za-z_][\w$#]*/.exec(text.slice(i))![0];
      const next =
        /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*([A-Za-z_]\w*)/.exec(text.slice(i + word.length))?.[1] ??
        "";
      routineWord(routine, word, next.toUpperCase());
      buf += word;
      i += word.length;
      continue;
    }
    if (c === ";" && routineEnds(routine)) {
      flush();
      i++;
      continue;
    }
    if (c === "\n") {
      line++;
      // Leading blank lines are not part of the statement (its tokens are numbered from `start`).
      buf = buf.trim() ? buf + c : "";
      i++;
      // A line holding only "/" or "GO" ends the statement.
      for (
        let m = /^[ \t]*(\/|GO)[ \t]*(\r?\n|$)/i.exec(text.slice(i));
        m && m[0];
        m = /^[ \t]*(\/|GO)[ \t]*(\r?\n|$)/i.exec(text.slice(i))
      ) {
        flush();
        i += m[0].length;
        if (m[2]) {
          line++;
        }
      }
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return { stmts, remarks };
}

export const COL_STOP = new Set([
  "NOT",
  "NULL",
  "DEFAULT",
  "PRIMARY",
  "UNIQUE",
  "REFERENCES",
  "CONSTRAINT",
  "CHECK",
  "GENERATED",
  "COMMENT",
  "AUTO_INCREMENT",
  "IDENTITY",
  "COLLATE",
  "ENCODE",
  "INLINE",
]);

/** Split tokens [a, b) at top-level commas. */
export function splitTop(toks: SqlTok[], a: number, b: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let s = a;
  for (let k = a; k < b; k++) {
    if (toks[k].v === "(") {
      depth++;
    } else if (toks[k].v === ")") {
      depth--;
    } else if (toks[k].v === "," && depth === 0) {
      out.push([s, k]);
      s = k + 1;
    }
  }
  if (b > s) {
    out.push([s, b]);
  }
  return out;
}

export function close(toks: SqlTok[], open: number): number {
  let d = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k].v === "(") {
      d++;
    } else if (toks[k].v === ")" && --d === 0) {
      return k;
    }
  }
  return toks.length;
}

export const text = (toks: SqlTok[], a: number, b: number) =>
  toks
    .slice(a, b)
    .map((t) => (t.k === "word" ? t.v : t.raw))
    .join(" ")
    .replace(/ ([),.])/g, "$1")
    .replace(/([(.]) /g, "$1")
    .replace(/([A-Za-z0-9_"]) \(/g, "$1(")
    .replace(/,(?! )/g, ", ");

export function nameList(toks: SqlTok[], open: number): { names: string[]; next: number } {
  const end = close(toks, open);
  const names = splitTop(toks, open + 1, end)
    .map(([a]) => (isIdent(toks[a]) ? canonical(toks[a].v) : ""))
    .filter(Boolean);
  return { names, next: end + 1 };
}

export function constraint(
  file: string,
  toks: SqlTok[],
  a: number,
  b: number,
): SqlConstraint | undefined {
  let k = a;
  let name: string | undefined;
  if (isW(toks[k], "CONSTRAINT")) {
    name = canonical(toks[k + 1]?.v ?? "");
    k += 2;
  }
  if (!toks[a]) {
    return undefined;
  }
  const line = toks[a].line;
  if (isW(toks[k], "PRIMARY") && isW(toks[k + 1], "KEY") && toks[k + 2]?.v === "(") {
    return {
      file,
      line,
      kind: "PRIMARY KEY",
      ...(name ? { name } : {}),
      columns: nameList(toks, k + 2).names,
    };
  }
  if (
    isW(toks[k], "UNIQUE") &&
    (toks[k + 1]?.v === "(" || (isW(toks[k + 1], "KEY", "INDEX") && toks[k + 2]?.v === "("))
  ) {
    const open = toks[k + 1]?.v === "(" ? k + 1 : k + 2;
    return {
      file,
      line,
      kind: "UNIQUE",
      ...(name ? { name } : {}),
      columns: nameList(toks, open).names,
    };
  }
  if (isW(toks[k], "FOREIGN") && isW(toks[k + 1], "KEY") && toks[k + 2]?.v === "(") {
    const cols = nameList(toks, k + 2);
    let j = cols.next;
    if (!isW(toks[j], "REFERENCES")) {
      return undefined;
    }
    const ref = readName(toks, j + 1);
    j = ref.next;
    const refCols = toks[j]?.v === "(" ? nameList(toks, j).names : [];
    return {
      file,
      line,
      kind: "FOREIGN KEY",
      ...(name ? { name } : {}),
      columns: cols.names,
      references: { table: canonical(ref.parts.at(-1) ?? ""), columns: refCols },
    };
  }
  if (isW(toks[k], "CHECK")) {
    return {
      file,
      line,
      kind: "CHECK",
      ...(name ? { name } : {}),
      columns: [],
      text: text(toks, k + 1, b),
    };
  }
  return undefined;
}

export function column(
  file: string,
  toks: SqlTok[],
  a: number,
  b: number,
  remarks: Map<number, string>,
): SqlColumn {
  const t0 = toks[a];
  const col: SqlColumn = { file, line: t0.line, name: canonical(t0.v), type: "" };
  let k = a + 1;
  const typeStart = k;
  while (k < b) {
    const t = toks[k];
    if (t.v === "(") {
      k = close(toks, k) + 1;
      continue;
    }
    if (t.k === "word" && COL_STOP.has(t.v)) {
      break;
    }
    if (isW(t, "WITH") && isW(toks[k + 1], "DEFAULT")) {
      break;
    }
    if (isW(t, "FOR") && !isW(toks[k + 1], "BIT", "SBCS", "MIXED")) {
      break;
    }
    k++;
  }
  col.type = text(toks, typeStart, k);
  while (k < b) {
    const t = toks[k];
    if (isW(t, "NOT") && isW(toks[k + 1], "NULL")) {
      col.nullable = false;
      k += 2;
    } else if (isW(t, "NULL")) {
      col.nullable = true;
      k++;
    } else if (isW(t, "DEFAULT") || (isW(t, "WITH") && isW(toks[k + 1], "DEFAULT"))) {
      k += isW(t, "WITH") ? 2 : 1;
      const s = k;
      while (k < b && !(toks[k].k === "word" && COL_STOP.has(toks[k].v) && toks[k].v !== "NULL")) {
        k = toks[k].v === "(" ? close(toks, k) + 1 : k + 1;
      }
      col.default = s < k ? text(toks, s, k) : "(type default)";
    } else if (isW(t, "PRIMARY") && isW(toks[k + 1], "KEY")) {
      col.primaryKey = true;
      col.nullable = col.nullable ?? false;
      k += 2;
    } else if (isW(t, "UNIQUE")) {
      col.unique = true;
      k++;
    } else if (isW(t, "REFERENCES")) {
      const ref = readName(toks, k + 1);
      k = ref.next;
      let refCol: string | undefined;
      if (toks[k]?.v === "(") {
        refCol = nameList(toks, k).names[0];
        k = close(toks, k) + 1;
      }
      col.references = {
        table: canonical(ref.parts.at(-1) ?? ""),
        ...(refCol ? { column: refCol } : {}),
      };
    } else if (isW(t, "COMMENT") && toks[k + 1]?.k === "str") {
      col.comment = toks[k + 1].v;
      col.commentAt = { file, line: toks[k + 1].line };
      k += 2;
    } else if (t.v === "(") {
      k = close(toks, k) + 1;
    } else {
      k++;
    }
  }
  const lastLine = toks[b - 1]?.line ?? t0.line;
  for (let l = t0.line; l <= lastLine && !col.comment; l++) {
    const r = remarks.get(l);
    if (r) {
      col.comment = r;
      col.commentAt = { file, line: l };
    }
  }
  return col;
}
