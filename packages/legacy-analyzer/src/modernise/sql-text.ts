// SQL text helpers shared by the DDL engine and the Java engine: a tokenizer (words, quoted
// identifiers, strings, numbers, punctuation, each with its line), canonical table names, and the
// tables a DML/query statement touches (FROM / JOIN / INTO / UPDATE / DELETE FROM / MERGE INTO /
// USING). Names are folded to upper case and the schema is dropped, so `payroll.employee`,
// `"EMPLOYEE"` and `EMPLOYEE` are one table; that is the documented join rule across languages.

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
  const ctes = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    // WITH name AS ( ... ), name2 AS ( ... )
    if (isW(toks[k], "WITH", ",") || toks[k].v === ",") {
      if (isIdent(toks[k + 1]) && isW(toks[k + 2], "AS") && toks[k + 3]?.v === "(") {
        ctes.add(canonical(toks[k + 1].v));
      }
    }
  }
  const tables: string[] = [];
  const add = (j: number): number => {
    const nm = readName(toks, j);
    if (nm.parts.length === 0 || STOP.has(nm.parts[nm.parts.length - 1])) {
      return j;
    }
    const t = canonical(nm.parts[nm.parts.length - 1]);
    if (!ctes.has(t) && t !== "DUAL") {
      tables.push(t);
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
      let j = k + 1;
      // A comma-separated list after FROM: name [AS] [alias], name ...
      for (;;) {
        if (toks[j]?.v === "(") {
          break; // a sub-query: its own FROM is found by the outer loop
        }
        const after = add(j);
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
  return [...new Set(tables)].toSorted();
}

/** Text that reads as a SQL statement (used to pick SQL out of Java string literals). */
export function looksLikeSql(text: string): boolean {
  const t = text.trim();
  return (
    /^(SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|WITH\s+\w+\s+AS|CALL\s)/i.test(
      t,
    ) || /^(SELECT)\b[\s\S]*\bFROM\b/i.test(t)
  );
}
