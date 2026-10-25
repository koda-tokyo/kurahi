// SQL text helpers shared by the DDL engine and the Java engine: a tokenizer (words, quoted
// identifiers, strings, numbers, punctuation, each with its line), canonical table names, and the
// tables a DML/query statement touches (FROM / JOIN / INTO / UPDATE / DELETE FROM / MERGE INTO /
// USING). Names are folded to upper case and the schema is dropped, so `payroll.employee`,
// `"EMPLOYEE"` and `EMPLOYEE` are one table; that is the documented join rule across languages.
// `tableSchemas` keeps the schema a reference names, for tables two schemas define.

export type SqlTok = {
  k: "word" | "qid" | "str" | "num" | "op";
  /** Words upper-cased; quoted identifiers unquoted (case kept); strings unquoted. */
  v: string;
  raw: string;
  line: number;
};

/** Tokens of SQL text; comments are skipped. `line0` is the line of the first character. */
export function lexSql(text: string, line0 = 1): SqlTok[] {
  const out: SqlTok[] = [];
  let i = 0;
  let line = line0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let j = i; j < stop; j++) {
        if (text[j] === "\n") {
          line++;
        }
      }
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      let body = "";
      const start = line;
      while (j < n) {
        if (text[j] === close && text[j + 1] === close && close !== "]") {
          body += close;
          j += 2;
          continue;
        }
        if (text[j] === close) {
          break;
        }
        if (text[j] === "\n") {
          line++;
        }
        body += text[j];
        j++;
      }
      out.push({ k: c === "'" ? "str" : "qid", v: body, raw: text.slice(i, j + 1), line: start });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_#@$:À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_#@$À-￿]/.test(text[j])) {
        j++;
      }
      const raw = text.slice(i, j);
      out.push({ k: "word", v: raw.toUpperCase(), raw, line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(text[j])) {
        j++;
      }
      out.push({ k: "num", v: text.slice(i, j), raw: text.slice(i, j), line });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    const op = ["<=", ">=", "<>", "!=", "||", "::"].includes(two) ? two : c;
    out.push({ k: "op", v: op, raw: op, line });
    i += op.length;
  }
  return out;
}

export const isW = (t: SqlTok | undefined, ...words: string[]) =>
  Boolean(t && t.k === "word" && words.includes(t.v));

export const isIdent = (t: SqlTok | undefined) =>
  Boolean(t && (t.k === "qid" || (t.k === "word" && !t.v.startsWith(":") && !t.v.startsWith("?"))));

/** Canonical name: last dotted segment, upper case. */
export function canonical(name: string): string {
  const parts = name.split(".");
  return (parts[parts.length - 1] ?? name).replace(/^["`[]|["`\]]$/g, "").toUpperCase();
}

/** A possibly qualified name starting at `toks[i]`: its parts and the index after it. */
export function readName(
  toks: SqlTok[],
  i: number,
): { parts: string[]; raw: string; next: number } {
  const parts: string[] = [];
  const raws: string[] = [];
  let j = i;
  while (isIdent(toks[j])) {
    parts.push(toks[j].k === "qid" ? toks[j].v.toUpperCase() : toks[j].v);
    raws.push(toks[j].raw);
    j++;
    if (toks[j]?.v === "." && isIdent(toks[j + 1])) {
      j++;
      continue;
    }
    break;
  }
  return { parts, raw: raws.join("."), next: j };
}

const STOP = new Set([
  "WHERE",
  "JOIN",
  "ON",
  "SET",
  "ORDER",
  "GROUP",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "MINUS",
  "FOR",
  "WITH",
  "HAVING",
  "FETCH",
  "VALUES",
  "LIMIT",
  "OFFSET",
  "USING",
  "WHEN",
  "SELECT",
  "RETURNING",
  "NATURAL",
]);

/** First keyword and the tables of a query or DML statement. CTE names are not tables. */
export function sqlTables(text: string): { op: string; tables: string[] } {
  const toks = lexSql(text);
  return { op: toks.find((t) => t.k === "word")?.v ?? "", tables: tablesIn(toks) };
}

/** The tables a token run reads or writes (FROM, JOIN, UPDATE, INSERT/MERGE INTO, ...). */
export function tablesIn(toks: SqlTok[]): string[] {
  return [...new Set(tableAccess(toks).map((r) => r.table))].toSorted();
}

/**
 * The schema each table of a query or DML statement is named with, for tables every reference
 * to which names the same schema (`payroll.employee` twice). A table also named bare, or with two
 * schemas, has no entry: which schema it means is not in the text.
 */
export function tableSchemas(text: string): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const r of tableAccess(lexSql(text))) {
    seen.set(r.table, (seen.get(r.table) ?? new Set()).add(r.schema ?? ""));
  }
  const out = new Map<string, string>();
  for (const [t, s] of seen) {
    const [only] = [...s];
    if (s.size === 1 && only) {
      out.set(t, only);
    }
  }
  return out;
}

export type TableRef = { table: string; schema?: string; line: number; op: string };

/**
 * Each table reference of a token run with its line and the operation it is: the target of an
 * INSERT / MERGE INTO, UPDATE, DELETE FROM or TRUNCATE TABLE is that verb; every other reference
 * (FROM, JOIN, MERGE ... USING) is a SELECT.
 */
export function tableAccess(toks: SqlTok[]): TableRef[] {
  const ctes = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    // WITH name AS ( ... ), name2 AS ( ... )
    if (isW(toks[k], "WITH", ",") || toks[k].v === ",") {
      if (isIdent(toks[k + 1]) && isW(toks[k + 2], "AS") && toks[k + 3]?.v === "(") {
        ctes.add(canonical(toks[k + 1].v));
      }
    }
  }
  const tables: TableRef[] = [];
  const add = (j: number, op: string): number => {
    const nm = readName(toks, j);
    if (nm.parts.length === 0 || STOP.has(nm.parts[nm.parts.length - 1])) {
      return j;
    }
    const t = canonical(nm.parts[nm.parts.length - 1]);
    if (!ctes.has(t) && t !== "DUAL") {
      const schema = nm.parts.length > 1 ? canonical(nm.parts[nm.parts.length - 2]) : undefined;
      const line = toks[j].line;
      tables.push(schema ? { table: t, schema, line, op } : { table: t, line, op });
    }
    return nm.next;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    const intoAfter = isW(t, "INTO") && isW(prev, "INSERT", "MERGE");
    if (isW(t, "UPDATE") && isW(prev, "FOR", "KEY")) {
      continue; // SELECT ... FOR UPDATE
    }
    if (
      isW(t, "FROM", "JOIN", "UPDATE", "USING") ||
      intoAfter ||
      (isW(t, "TABLE") && isW(prev, "TRUNCATE"))
    ) {
      if (isW(t, "USING") && !toks.slice(0, k).some((x) => isW(x, "MERGE"))) {
        continue; // JOIN ... USING (col)
      }
      const op = intoAfter
        ? prev.v
        : isW(t, "UPDATE")
          ? "UPDATE"
          : isW(t, "FROM") && isW(prev, "DELETE")
            ? "DELETE"
            : isW(t, "TABLE")
              ? "TRUNCATE"
              : "SELECT";
      let j = k + 1;
      // A comma-separated list after FROM: name [AS] [alias], name ...
      for (;;) {
        if (toks[j]?.v === "(") {
          break; // a sub-query: its own FROM is found by the outer loop
        }
        const after = add(j, op);
        if (after === j) {
          break;
        }
        j = after;
        while (
          j < toks.length &&
          toks[j].v !== "," &&
          !(toks[j].k === "word" && STOP.has(toks[j].v))
        ) {
          if (toks[j].v === "(" || toks[j].v === ")" || toks[j].v === ";") {
            break;
          }
          j++;
        }
        if (toks[j]?.v !== "," || !isW(t, "FROM")) {
          break;
        }
        j++;
      }
    }
  }
  return tables;
}

/** JDBC call escape: `{call NAME(?)}` or `{? = call NAME(?)}`. */
const JDBC_CALL = /^\{\s*(?:\?\s*=\s*)?call\s/i;

/** Text that reads as a SQL statement (used to pick SQL out of Java string literals). */
export function looksLikeSql(text: string): boolean {
  const t = text.trim();
  return (
    /^(SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|WITH\s+\w+\s+AS|CALL\s)/i.test(
      t,
    ) ||
    /^(SELECT)\b[\s\S]*\bFROM\b/i.test(t) ||
    JDBC_CALL.test(t)
  );
}

/**
 * The routine a CALL statement names, as canonical name parts (`["PKG", "PROC"]` for
 * `CALL pkg.proc(?)`). Reads `CALL NAME(...)` and the JDBC escapes `{call NAME(?)}` and
 * `{? = call NAME(?)}`; anything else is not a call.
 */
export function routineCall(text: string): string[] | undefined {
  const t = text.trim();
  const toks = lexSql(JDBC_CALL.test(t) ? t.replace(/^\{\s*(?:\?\s*=\s*)?/, "") : t);
  if (!isW(toks[0], "CALL")) {
    return undefined;
  }
  const n = readName(toks, 1);
  return n.parts.length > 0 ? n.parts.map(canonical) : undefined;
}
