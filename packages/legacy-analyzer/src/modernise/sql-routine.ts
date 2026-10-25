// Stored routine bodies (SQL DDL engine). A CREATE PROCEDURE / FUNCTION / TRIGGER whose body is a
// balanced BEGIN ... END (DB2 SQL PL, Oracle PL/SQL, T-SQL), or a trigger whose body is one
// statement, becomes a routine: each static statement of the body gives the tables it names with
// its verb and line, a CALL gives a call to another routine, and a trigger gives its table and
// events. Dynamic SQL (EXECUTE IMMEDIATE, PREPARE, EXECUTE, EXEC, sp_executesql, OPEN ... FOR a
// variable) and DDL inside a body are gaps, never facts. A PACKAGE, a dollar-quoted PostgreSQL
// body, a body without BEGIN (a DB2 RETURN function) or an unbalanced body returns undefined, and
// the caller keeps the one-gap reading. An Oracle call written without CALL (`pkg.proc(x);`,
// `do_it;`) is a call too, when the name and its argument list are the whole statement; a
// function called inside an expression is not.
//
// An Oracle PACKAGE BODY is split into its members: each PROCEDURE / FUNCTION with a body is a
// routine named PACKAGE.MEMBER, read as above. A forward declaration is skipped; an external
// member (AS LANGUAGE / EXTERNAL), a package-level declaration naming tables (a cursor) and the
// initialisation block are gaps. A member that declares its own nested subprogram keeps the whole
// package on the one-gap reading, since its end cannot be told from the subprogram's.

import type { EngineGap, SqlRoutine } from "./types.js";
import { close } from "./sql-ddl-parts.js";
import { type SqlTok, canonical, isIdent, isW, readName, tableAccess } from "./sql-text.js";

const NOT_A_BLOCK_END = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR"]);

type Pkg = { name: string; raw: string; schema?: string };

/** BEGIN / CASE ... END nesting of a body, as the statement splitter counts it. */
function balanced(body: SqlTok[]): { begun: boolean; ok: boolean } {
  let depth = 0;
  let begun = false;
  for (const [j, t] of body.entries()) {
    if (isW(t, "BEGIN") || (isW(t, "CASE") && !isW(body[j - 1], "END"))) {
      depth++;
      begun = true;
    } else if (
      isW(t, "END") &&
      !(body[j + 1]?.k === "word" && NOT_A_BLOCK_END.has(body[j + 1].v))
    ) {
      depth--;
      if (depth < 0) {
        return { begun, ok: false };
      }
    }
  }
  return { begun, ok: depth === 0 };
}

// A body statement whose SQL text is built or chosen at run time: the reason, or undefined.
function dynamic(seg: SqlTok[]): string | undefined {
  const runtime = (what: string) =>
    `dynamic SQL (${what}); the statement text is built at run time, so its tables are not known`;
  for (const [j, t] of seg.entries()) {
    const next = seg[j + 1];
    if (isW(t, "EXECUTE") && isW(next, "IMMEDIATE")) {
      return runtime("EXECUTE IMMEDIATE");
    }
    if (isW(t, "PREPARE") && isIdent(next)) {
      return runtime("PREPARE");
    }
    if (isW(t, "SP_EXECUTESQL") || (isW(t, "EXECUTE", "EXEC") && next?.v === "(")) {
      return runtime(isW(t, "SP_EXECUTESQL") ? "sp_executesql" : `${t.v}(...)`);
    }
    if (isW(t, "EXECUTE", "EXEC") && isIdent(next)) {
      return `${t.v} ${next.v} runs a prepared statement (DB2) or a procedure (T-SQL); it is not read`;
    }
    if (
      isW(t, "OPEN") &&
      isIdent(next) &&
      isW(seg[j + 2], "FOR") &&
      !isW(seg[j + 3], "SELECT", "WITH")
    ) {
      return runtime("OPEN ... FOR a variable");
    }
  }
  return undefined;
}

// Words that end a statement on their own and so are never a routine name (PL/SQL, SQL PL and
// T-SQL `BEGIN TRAN`), and Oracle-supplied routines that are not the application's.
const NOT_A_CALL = new Set([
  "NULL",
  "COMMIT",
  "ROLLBACK",
  "RETURN",
  "RAISE",
  "RESIGNAL",
  "EXIT",
  "CONTINUE",
  "BREAK",
  "END",
  "WORK",
  "TRAN",
  "TRANSACTION",
  "RAISE_APPLICATION_ERROR",
]);
const SUPPLIED_PACKAGE = /^(?:DBMS|UTL)_/;

// Where a statement may start inside one `;` segment: its first token, and after BEGIN, THEN,
// ELSE, LOOP or a `<<label>>`.
const STATEMENT_AFTER = ["BEGIN", "THEN", "ELSE", "LOOP"];

/** A PL/SQL procedure call written without CALL: a name, and its argument list, ending `seg`. */
function bareCall(seg: SqlTok[]): { parts: string[]; line: number } | undefined {
  for (let s = 0; s < seg.length; s++) {
    if (
      s > 0 &&
      !isW(seg[s - 1], ...STATEMENT_AFTER) &&
      !(seg[s - 1].v === ">" && seg[s - 2]?.v === ">")
    ) {
      continue;
    }
    const nm = readName(seg, s);
    if (nm.parts.length === 0) {
      continue;
    }
    const ends =
      nm.next === seg.length || (seg[nm.next].v === "(" && close(seg, nm.next) === seg.length - 1);
    const name = canonical(nm.parts.at(-1) ?? "");
    const qualifier = nm.parts.length > 1 ? canonical(nm.parts.at(-2) ?? "") : "";
    if (
      ends &&
      !(nm.parts.length === 1 && NOT_A_CALL.has(name)) &&
      !SUPPLIED_PACKAGE.test(qualifier)
    ) {
      return { parts: nm.parts, line: seg[s].line };
    }
  }
  return undefined;
}

const DDL_OBJECTS = ["TABLE", "VIEW", "INDEX", "SEQUENCE", "PROCEDURE", "FUNCTION", "TRIGGER"];

function ddl(seg: SqlTok[]): string | undefined {
  for (const [j, t] of seg.entries()) {
    if (isW(t, "CREATE", "ALTER", "DROP")) {
      let k = j + 1;
      while (isW(seg[k], "OR", "REPLACE", "GLOBAL", "LOCAL", "TEMPORARY", "TEMP", "UNIQUE")) {
        k++;
      }
      if (isW(seg[k], ...DDL_OBJECTS)) {
        return `${t.v} ${seg[k].v}`;
      }
    }
    if (isW(t, "DECLARE") && isW(seg[j + 1], "GLOBAL") && isW(seg[j + 2], "TEMPORARY")) {
      return "DECLARE GLOBAL TEMPORARY TABLE";
    }
  }
  return undefined;
}

/**
 * The routine a CREATE statement defines, `toks[k]` being its kind word, or undefined when its
 * body is not one this engine reads.
 */
export function parseRoutine(
  path: string,
  toks: SqlTok[],
  k: number,
  pkg?: Pkg,
): { routine: SqlRoutine; gaps: EngineGap[] } | undefined {
  const kind = toks[k].v;
  if (kind !== "PROCEDURE" && kind !== "FUNCTION" && kind !== "TRIGGER") {
    return undefined;
  }
  // A PostgreSQL body is a dollar-quoted string: PL/pgSQL is read in a later slice.
  if (
    toks.some((t) => t.k === "str" && /^\$\w*\$/.test(t.raw)) ||
    toks.some((t) => /^\$\w*\$$/.test(t.v))
  ) {
    return undefined;
  }
  const nm = readName(toks, k + 1);
  if (nm.parts.length === 0) {
    return undefined;
  }
  let j = nm.next;
  let on: string | undefined;
  const events: string[] = [];
  if (kind === "TRIGGER") {
    while (j < toks.length && !isW(toks[j], "ON")) {
      if (isW(toks[j], "INSERT", "UPDATE", "DELETE") && !events.includes(toks[j].v)) {
        events.push(toks[j].v);
      }
      j++;
    }
    const tn = readName(toks, j + 1);
    if (tn.parts.length === 0) {
      return undefined;
    }
    on = canonical(tn.parts.at(-1) ?? "");
    j = tn.next;
  } else if (toks[j]?.v === "(") {
    j = close(toks, j) + 1;
  }
  const body = toks.slice(j);
  const shape = balanced(body);
  if (!shape.ok || (!shape.begun && kind !== "TRIGGER")) {
    return undefined;
  }
  const routine: SqlRoutine = {
    file: path,
    line: toks[0].line,
    kind,
    name: pkg
      ? `${pkg.name}.${canonical(nm.parts.at(-1) ?? "")}`
      : canonical(nm.parts.at(-1) ?? ""),
    ...(pkg
      ? { ...(pkg.schema ? { schema: pkg.schema } : {}), package: pkg.name }
      : nm.parts.length > 1
        ? { schema: nm.parts.at(-2) }
        : {}),
    rawName: pkg ? `${pkg.raw}.${nm.raw}` : nm.raw,
    endLine: toks.at(-1)?.line ?? toks[0].line,
    ...(on ? { on, events } : {}),
    access: [],
    calls: [],
  };
  const gaps: EngineGap[] = [];
  const gap = (line: number, construct: string, detail: string) =>
    gaps.push({ file: path, line, construct, detail });
  const seen = new Set<string>();
  let a = 0;
  for (let b = 0; b <= body.length; b++) {
    if (b < body.length && body[b].v !== ";") {
      continue;
    }
    const seg = body.slice(a, b);
    a = b + 1;
    if (seg.length === 0) {
      continue;
    }
    const where = `${routine.kind} ${routine.name}`;
    const dyn = dynamic(seg);
    if (dyn) {
      gap(seg[0].line, "routine statement", `${where}: ${dyn}.`);
      continue;
    }
    const d = ddl(seg);
    if (d) {
      gap(
        seg[0].line,
        "routine statement",
        `${where}: ${d} inside the routine body is not modelled (no schema fact taken from it).`,
      );
      continue;
    }
    for (const [c, t] of seg.entries()) {
      if (isW(t, "CALL")) {
        const cn = readName(seg, c + 1);
        if (cn.parts.length) {
          routine.calls.push({
            file: path,
            line: t.line,
            name: canonical(cn.parts.at(-1) ?? ""),
            ...(cn.parts.length > 1 ? { qualifier: canonical(cn.parts.at(-2) ?? "") } : {}),
          });
        }
      }
    }
    const bare = bareCall(seg);
    if (bare) {
      routine.calls.push({
        file: path,
        line: bare.line,
        name: canonical(bare.parts.at(-1) ?? ""),
        ...(bare.parts.length > 1 ? { qualifier: canonical(bare.parts.at(-2) ?? "") } : {}),
      });
    }
    for (const r of tableAccess(seg)) {
      const key = `${r.table}|${r.op}|${r.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        routine.access.push({
          file: path,
          line: r.line,
          table: r.table,
          ...(r.schema ? { schema: r.schema } : {}),
          op: r.op,
        });
      }
    }
  }
  return { routine, gaps };
}

// Where the package member starting at `toks[m]` ends: the `;` after the END that closes its
// body, or the `;` of a forward declaration or an external member. Undefined when the member
// declares a nested subprogram or its body never closes.
function memberEnd(
  toks: SqlTok[],
  m: number,
): { kind: "body" | "forward" | "external"; semi: number } | undefined {
  let paren = 0;
  let depth = 0;
  let begun = false;
  let decl = false;
  let external = false;
  for (let i = m + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.v === "(") {
      paren++;
    } else if (t.v === ")") {
      paren--;
    }
    if (paren > 0 || t.v === ")") {
      continue;
    }
    if (!decl && isW(t, "IS", "AS")) {
      decl = true;
      external = isW(toks[i + 1], "LANGUAGE", "EXTERNAL");
    } else if (decl && !begun && isW(t, "PROCEDURE", "FUNCTION")) {
      return undefined;
    } else if (isW(t, "BEGIN") || (isW(t, "CASE") && !isW(toks[i - 1], "END"))) {
      depth++;
      begun = true;
    } else if (
      isW(t, "END") &&
      !(toks[i + 1]?.k === "word" && NOT_A_BLOCK_END.has(toks[i + 1].v))
    ) {
      depth--;
      if (depth < 0) {
        return undefined;
      }
      if (depth === 0) {
        const semi = isIdent(toks[i + 1]) ? i + 2 : i + 1;
        return toks[semi]?.v === ";" ? { kind: "body", semi } : undefined;
      }
    } else if (t.v === ";" && depth === 0 && !begun) {
      if (!decl) {
        return { kind: "forward", semi: i };
      }
      if (external) {
        return { kind: "external", semi: i };
      }
    }
  }
  return undefined;
}

const tableList = (seg: SqlTok[]) => [...new Set(tableAccess(seg).map((r) => r.table))].toSorted();

/**
 * The member routines of a CREATE PACKAGE BODY, `toks[k]` being PACKAGE, or undefined when the
 * statement is not a package body this engine reads.
 */
export function parsePackageBody(
  path: string,
  toks: SqlTok[],
  k: number,
): { routines: SqlRoutine[]; gaps: EngineGap[] } | undefined {
  if (!isW(toks[k], "PACKAGE") || !isW(toks[k + 1], "BODY")) {
    return undefined;
  }
  const nm = readName(toks, k + 2);
  if (nm.parts.length === 0 || !isW(toks[nm.next], "IS", "AS")) {
    return undefined;
  }
  const pkg: Pkg = {
    name: canonical(nm.parts.at(-1) ?? ""),
    raw: nm.raw,
    ...(nm.parts.length > 1 ? { schema: nm.parts.at(-2) } : {}),
  };
  const where = `PACKAGE BODY ${pkg.name}`;
  const routines: SqlRoutine[] = [];
  const gaps: EngineGap[] = [];
  const gap = (line: number, construct: string, detail: string) =>
    gaps.push({ file: path, line, construct, detail });
  let a = nm.next + 1;
  for (let j = a; j < toks.length; j++) {
    const t = toks[j];
    if (isW(t, "PROCEDURE", "FUNCTION")) {
      const end = memberEnd(toks, j);
      if (!end) {
        return undefined;
      }
      if (end.kind === "body") {
        const read = parseRoutine(path, toks.slice(j, end.semi), 0, pkg);
        if (!read) {
          return undefined;
        }
        routines.push(read.routine);
        gaps.push(...read.gaps);
      } else if (end.kind === "external") {
        const mn = readName(toks, j + 1);
        gap(
          t.line,
          "package member",
          `${where}: ${t.v} ${canonical(mn.parts.at(-1) ?? "")} is an external routine (LANGUAGE / EXTERNAL); its body is not SQL and is not read.`,
        );
      }
      j = end.semi;
      a = j + 1;
      continue;
    }
    if (isW(t, "BEGIN")) {
      const names = tableList(toks.slice(j));
      gap(
        t.line,
        "package initialisation",
        `${where}: the initialisation block is not analysed; it names ${names.length ? `tables ${names.join(", ")}` : "no tables"} (textual, unverified).`,
      );
      break;
    }
    if (isW(t, "END")) {
      break;
    }
    if (t.v === ";") {
      const names = tableList(toks.slice(a, j));
      if (names.length) {
        gap(
          toks[a].line,
          "package declaration",
          `${where}: a package-level declaration names tables ${names.join(", ")}; it is not attributed to a member.`,
        );
      }
      a = j + 1;
    }
  }
  return { routines, gaps };
}
