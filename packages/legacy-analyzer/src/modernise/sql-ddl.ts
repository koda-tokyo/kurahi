// SQL DDL engine (deterministic, dialect-tolerant: ANSI, DB2, Oracle, PostgreSQL basics).
// Statements are split at `;`, a line holding only `/` (Oracle) or `GO`, outside strings and
// comments. Modelled: CREATE TABLE (columns with type, NULL / NOT NULL, DEFAULT incl. DB2 WITH
// DEFAULT, inline and table PRIMARY KEY / UNIQUE / REFERENCES / CHECK), CREATE VIEW (its source
// tables), CREATE INDEX, ALTER TABLE ... ADD [CONSTRAINT] / ADD [COLUMN], COMMENT ON, DB2 LABEL
// ON, inline COMMENT '...' and trailing `--` remarks. A routine (PROCEDURE / FUNCTION / TRIGGER /
// PACKAGE) stays one statement and one gap naming the tables its body mentions; no schema fact is
// taken from inside it. After a column list, a query fill (AS SELECT / SELECT) makes the table a
// gap, and INHERITS or PARTITION BY adds a gap beside it. Every other statement is a gap.

import type {
  EngineGap,
  SqlColumn,
  SqlConstraint,
  SqlFile,
  SqlIndex,
  SqlModel,
  SqlTable,
} from "./types.js";
import {
  close,
  column,
  constraint,
  nameList,
  splitStatements,
  splitTop,
  text,
} from "./sql-ddl-parts.js";
import {
  type SqlTok,
  canonical,
  isIdent,
  isW,
  lexSql,
  readName,
  sqlTables,
  tablesIn,
} from "./sql-text.js";

export { splitStatements } from "./sql-ddl-parts.js";

export function parseSqlFile(
  path: string,
  source: string,
): {
  file: SqlFile;
  tables: SqlTable[];
  indexes: SqlIndex[];
  comments: Array<{ table: string; column?: string; text: string; line: number }>;
  alters: Array<{
    table: string;
    constraint?: SqlConstraint;
    column?: SqlColumn;
    ifNotExists?: boolean;
    /** An action this analysis does not model (DROP, RENAME, ALTER COLUMN, ...). */
    unmodelled?: boolean;
    stmt: number;
    line: number;
  }>;
} {
  const { stmts, remarks } = splitStatements(source);
  const gaps: EngineGap[] = [];
  const tables: SqlTable[] = [];
  const indexes: SqlIndex[] = [];
  const comments: Array<{ table: string; column?: string; text: string; line: number }> = [];
  const alters: Array<{
    table: string;
    constraint?: SqlConstraint;
    column?: SqlColumn;
    ifNotExists?: boolean;
    /** An action this analysis does not model (DROP, RENAME, ALTER COLUMN, ...). */
    unmodelled?: boolean;
    stmt: number;
    line: number;
  }> = [];
  for (const [si, st] of stmts.entries()) {
    const toks = lexSql(st.text, st.line);
    if (toks.length === 0) {
      continue;
    }
    const line = toks[0].line;
    let k = 0;
    const gap = (detail: string) =>
      gaps.push({
        file: path,
        line,
        construct: toks
          .slice(0, 3)
          .map((t) => t.v)
          .join(" "),
        detail,
      });
    if (isW(toks[k], "CREATE")) {
      k++;
      if (isW(toks[k], "OR") && isW(toks[k + 1], "REPLACE")) {
        k += 2;
      }
      while (
        isW(
          toks[k],
          "GLOBAL",
          "LOCAL",
          "TEMPORARY",
          "TEMP",
          "UNLOGGED",
          "FORCE",
          "NOFORCE",
          "MATERIALIZED",
          "EDITIONABLE",
          "NONEDITIONABLE",
        )
      ) {
        k++;
      }
      if (isW(toks[k], "PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE")) {
        gap(routineGap(toks, k));
        continue;
      }
      const unique = isW(toks[k], "UNIQUE");
      if (unique) {
        k++;
      }
      if (isW(toks[k], "TABLE")) {
        k++;
        if (isW(toks[k], "IF") && isW(toks[k + 1], "NOT") && isW(toks[k + 2], "EXISTS")) {
          k += 3;
        }
        const nm = readName(toks, k);
        k = nm.next;
        if (toks[k]?.v !== "(") {
          gap(
            `CREATE TABLE ${nm.raw} without a column list (e.g. AS SELECT or LIKE) is not modelled.`,
          );
          continue;
        }
        const end = close(toks, k);
        // Clauses after the column list: a query fill means the list is only names (no fact);
        // inheritance and partitioning keep the table but say what it does not show. Storage
        // options (WITH (...), TABLESPACE, ENGINE=, LOB ... STORE AS) change no column.
        const tail = trailing(toks, end + 1);
        if (tail.query) {
          gap(
            `CREATE TABLE ${nm.raw} is filled from a query (${tail.query}); its column types and rows are not modelled.`,
          );
          continue;
        }
        if (tail.inherits) {
          gap(
            `CREATE TABLE ${nm.raw} inherits from ${tail.inherits}; its inherited columns are not modelled.`,
          );
        }
        if (tail.partitioned) {
          gap(
            `CREATE TABLE ${nm.raw} is partitioned (PARTITION BY); its partitions are not modelled.`,
          );
        }
        const table: SqlTable = {
          file: path,
          line,
          name: canonical(nm.parts.at(-1) ?? ""),
          ...(nm.parts.length > 1 ? { schema: nm.parts.at(-2) } : {}),
          rawName: nm.raw,
          kind: "table",
          columns: [],
          constraints: [],
          sources: [],
          endLine: toks[end]?.line ?? line,
        };
        for (const [a, b] of splitTop(toks, k + 1, end)) {
          const keyword = isW(toks[a], "CONSTRAINT", "PRIMARY", "FOREIGN", "CHECK");
          const keyed =
            isW(toks[a], "UNIQUE", "KEY", "INDEX") &&
            (toks[a + 1]?.v === "(" ||
              isW(toks[a + 1], "KEY", "INDEX") ||
              (isIdent(toks[a + 1]) && toks[a + 2]?.v === "("));
          if (keyword || keyed) {
            const c = constraint(path, toks, a, b);
            if (c) {
              table.constraints.push(c);
            } else {
              gaps.push({
                file: path,
                line: toks[a].line,
                construct: "table element",
                detail: `Table element "${text(toks, a, Math.min(b, a + 6))}" of ${table.name} is not modelled.`,
              });
            }
          } else if (
            isW(toks[a], "LIKE") ||
            (isW(toks[a], "PERIOD") && isW(toks[a + 1], "FOR", "SYSTEM_TIME", "BUSINESS_TIME"))
          ) {
            gaps.push({
              file: path,
              line: toks[a].line,
              construct: "table element",
              detail: `${toks[a].v} clause of ${table.name} is not modelled.`,
            });
          } else if (isIdent(toks[a])) {
            table.columns.push(column(path, toks, a, b, remarks));
          }
        }
        tables.push(table);
        continue;
      }
      if (isW(toks[k], "VIEW")) {
        const nm = readName(toks, k + 1);
        k = nm.next;
        let cols: string[] = [];
        if (toks[k]?.v === "(") {
          const l = nameList(toks, k);
          cols = l.names;
          k = l.next;
        }
        const as = toks.findIndex((t, j) => j >= k && isW(t, "AS"));
        const body =
          as >= 0
            ? toks
                .slice(as + 1)
                .map((t) => t.raw)
                .join(" ")
            : "";
        const q = sqlTables(body);
        tables.push({
          file: path,
          line,
          name: canonical(nm.parts.at(-1) ?? ""),
          ...(nm.parts.length > 1 ? { schema: nm.parts.at(-2) } : {}),
          rawName: nm.raw,
          kind: "view",
          columns: cols.map((c) => ({ file: path, line, name: c, type: "" })),
          constraints: [],
          sources: q.tables,
          endLine: toks.at(-1)?.line ?? line,
        });
        continue;
      }
      if (isW(toks[k], "INDEX")) {
        k++;
        if (isW(toks[k], "CONCURRENTLY")) {
          k++;
        }
        if (isW(toks[k], "IF") && isW(toks[k + 1], "NOT") && isW(toks[k + 2], "EXISTS")) {
          k += 3;
        }
        const nm = readName(toks, k);
        k = nm.next;
        if (!isW(toks[k], "ON")) {
          gap("CREATE INDEX without ON is not modelled.");
          continue;
        }
        const tn = readName(toks, k + 1);
        k = tn.next;
        // PostgreSQL puts the access method between the table and the key list.
        if (isW(toks[k], "USING") && toks[k + 2]?.v === "(") {
          k += 2;
        }
        const idx = canonical(nm.parts.at(-1) ?? "");
        if (toks[k]?.v !== "(") {
          gap(`CREATE INDEX ${idx} has no key list that is modelled.`);
          continue;
        }
        const end = close(toks, k);
        const keys = splitTop(toks, k + 1, end);
        // A key is a column only when it is a bare name, optionally ASC/DESC and NULLS FIRST/LAST.
        // An expression (lower(c), a + b), a COLLATE, an operator class (c text_pattern_ops) or a
        // partial index (WHERE ...) is a gap, never a fact.
        const bare = keys.every(
          ([a, b]) =>
            isIdent(toks[a]) &&
            toks.slice(a + 1, b).every((t) => isW(t, "ASC", "DESC", "NULLS", "FIRST", "LAST")),
        );
        if (!bare) {
          gap(
            `CREATE INDEX ${idx} has a key that is not a bare column (expression, COLLATE or operator class); its columns are not modelled.`,
          );
          continue;
        }
        if (toks.slice(end + 1).some((t) => isW(t, "WHERE"))) {
          gap(`CREATE INDEX ${idx} is partial (WHERE); its rows are not modelled.`);
          continue;
        }
        const cols = nameList(toks, k).names;
        indexes.push({
          file: path,
          line,
          name: canonical(nm.parts.at(-1) ?? ""),
          table: canonical(tn.parts.at(-1) ?? ""),
          columns: cols,
          unique,
        });
        continue;
      }
      gap(`CREATE ${toks[k]?.v ?? ""} is not modelled.`);
      continue;
    }
    if (isW(toks[0], "ALTER") && isW(toks[1], "TABLE")) {
      k = 2;
      // IF EXISTS / IF NOT EXISTS are guards (PostgreSQL, MySQL, MariaDB), never names.
      if (isW(toks[k], "IF") && isW(toks[k + 1], "EXISTS")) {
        k += 2;
      }
      if (isW(toks[k], "ONLY")) {
        k++;
      }
      const nm = readName(toks, k);
      k = nm.next;
      const table = canonical(nm.parts.at(-1) ?? "");
      // One ALTER TABLE can carry several comma-separated actions; each is read on its own.
      const actions = splitTop(toks, k, toks.length);
      if (actions.length === 0) {
        gap(`ALTER TABLE ${table} without an action is not modelled.`);
      }
      for (const [a, b] of actions) {
        let j = a;
        const at = toks[a]?.line ?? line;
        if (!isW(toks[j], "ADD")) {
          gap(`ALTER TABLE ${table} ${toks[j]?.v ?? ""} is not modelled.`);
          alters.push({ table, unmodelled: true, stmt: si, line: at });
          continue;
        }
        j++;
        const c = constraint(path, toks, j, b);
        if (c) {
          alters.push({ table, constraint: c, stmt: si, line: at });
          continue;
        }
        if (isW(toks[j], "COLUMN")) {
          j++;
        }
        const ifNotExists =
          isW(toks[j], "IF") && isW(toks[j + 1], "NOT") && isW(toks[j + 2], "EXISTS");
        if (ifNotExists) {
          j += 3;
        }
        if (isIdent(toks[j])) {
          alters.push({
            table,
            column: column(path, toks, j, b, remarks),
            ifNotExists,
            stmt: si,
            line: at,
          });
        } else {
          gap(`ALTER TABLE ${table} ADD ... is not modelled.`);
          alters.push({ table, unmodelled: true, stmt: si, line: at });
        }
      }
      continue;
    }
    if (isW(toks[0], "COMMENT", "LABEL") && isW(toks[1], "ON") && isW(toks[2], "TABLE", "COLUMN")) {
      const nm = readName(toks, 3);
      const isText = toks.findIndex((t) => isW(t, "IS"));
      const str = isText >= 0 ? toks[isText + 1] : undefined;
      if (!str || str.k !== "str") {
        gap("COMMENT/LABEL without a string is not modelled.");
        continue;
      }
      if (isW(toks[2], "TABLE")) {
        comments.push({ table: canonical(nm.parts.at(-1) ?? ""), text: str.v, line: str.line });
      } else {
        comments.push({
          table: canonical(nm.parts.at(-2) ?? ""),
          column: canonical(nm.parts.at(-1) ?? ""),
          text: str.v,
          line: str.line,
        });
      }
      continue;
    }
    gap(`${toks[0].v} statement is not modelled (no schema fact taken from it).`);
  }
  return { file: { path, statements: stmts.length, gaps }, tables, indexes, comments, alters };
}

/** Top-level clauses after a CREATE TABLE column list that change what the list means. */
function trailing(
  toks: SqlTok[],
  from: number,
): { query?: string; inherits?: string; partitioned?: boolean } {
  const out: { query?: string; inherits?: string; partitioned?: boolean } = {};
  for (let j = from; j < toks.length; j++) {
    if (toks[j].v === "(") {
      j = close(toks, j);
    } else if (isW(toks[j], "AS") && !isW(toks[j - 1], "STORE")) {
      out.query = "AS SELECT";
      return out;
    } else if (isW(toks[j], "SELECT")) {
      out.query = "SELECT";
      return out;
    } else if (isW(toks[j], "INHERITS") && toks[j + 1]?.v === "(") {
      out.inherits = nameList(toks, j + 1).names.join(", ");
    } else if (isW(toks[j], "PARTITION") && isW(toks[j + 1], "BY")) {
      out.partitioned = true;
    }
  }
  return out;
}

/** The schema model of several DDL files: ALTER and COMMENT statements applied to their tables. */
// A routine is one gap: its kind, name, trigger table and line span, and the tables its body
// names, read textually from the body only (DML targets and sources, CREATE/ALTER/DROP TABLE).
const BODY_TABLE_VERBS = ["CREATE", "ALTER", "DROP", "TEMP", "TEMPORARY", "TRUNCATE"];

function routineGap(toks: SqlTok[], k: number): string {
  const kind = toks[k].v.toUpperCase();
  let j = isW(toks[k + 1], "BODY") ? k + 2 : k + 1;
  const nm = readName(toks, j);
  j = nm.next;
  let on = "";
  if (kind === "TRIGGER") {
    while (j < toks.length && !isW(toks[j], "ON")) {
      j++;
    }
    const tn = readName(toks, j + 1);
    on = tn.parts.length ? ` on ${canonical(tn.parts.at(-1) ?? "")}` : "";
    j = tn.next;
  }
  const body = toks.slice(j);
  const names = new Set(tablesIn(body));
  for (let b = 0; b < body.length; b++) {
    if (isW(body[b], "TABLE") && isW(body[b - 1], ...BODY_TABLE_VERBS)) {
      let c = b + 1;
      while (isW(body[c], "IF", "NOT", "EXISTS")) {
        c++;
      }
      const tn = readName(body, c);
      if (tn.parts.length) {
        names.add(canonical(tn.parts.at(-1) ?? ""));
      }
    }
  }
  const list = [...names].toSorted();
  return (
    `${kind} ${canonical(nm.parts.at(-1) ?? "")}${on} (lines ${toks[0].line}-${toks.at(-1)?.line}): ` +
    `routine body not analysed; it names ${list.length ? `tables ${list.join(", ")}` : "no tables"} ` +
    "(textual, unverified)."
  );
}

export function analyseSql(inputs: Array<{ path: string; text: string }>): SqlModel {
  const parsed = inputs.map((f) => parseSqlFile(f.path, f.text));
  const byName = new Map<string, SqlTable>();
  const duplicates: SqlModel["duplicates"] = [];
  for (const t of parsed.flatMap((p) => p.tables)) {
    const first = byName.get(t.name);
    if (first) {
      duplicates.push({
        file: t.file,
        line: t.line,
        name: t.name,
        first: { file: first.file, line: first.line },
      });
    } else {
      byName.set(t.name, t);
    }
  }
  // Tables an unmodelled ALTER action has touched: their column set is no longer known, so a
  // duplicate there cannot be called a rejection (DROP A, ADD A is accepted by the database).
  const uncertain = new Set<string>();
  for (const p of parsed) {
    // The actions of one ALTER TABLE are staged and published together: the database applies a
    // statement whole or not at all, so a rejected statement leaves no partial effect behind.
    const groups = new Map<number, typeof p.alters>();
    for (const a of p.alters) {
      groups.set(a.stmt, [...(groups.get(a.stmt) ?? []), a]);
    }
    for (const group of groups.values()) {
      const { table, line } = group[0];
      const unsure = uncertain.has(table) || group.some((a) => a.unmodelled);
      if (group.some((a) => a.unmodelled)) {
        uncertain.add(table);
      }
      if (group.every((a) => a.unmodelled)) {
        continue;
      }
      const t = byName.get(table);
      if (!t) {
        p.file.gaps.push({
          file: p.file.path,
          line,
          construct: "ALTER TABLE",
          detail: `ALTER TABLE ${table}: the table is not defined in the analysed DDL.`,
        });
        continue;
      }
      // A column that already exists (before the statement or earlier in it) is never added
      // twice: under IF NOT EXISTS the action is a no-op; without the guard the database rejects
      // the whole statement.
      const staged: SqlColumn[] = [];
      const constraints: SqlConstraint[] = [];
      let rejected: { name: string; line: number } | undefined;
      for (const a of group) {
        if (a.constraint) {
          constraints.push(a.constraint);
        }
        const col = a.column;
        if (!col) {
          continue;
        }
        if ([...t.columns, ...staged].some((x) => x.name === col.name)) {
          if (!a.ifNotExists && unsure) {
            p.file.gaps.push({
              file: p.file.path,
              line: a.line,
              construct: "ALTER TABLE",
              detail:
                `ALTER TABLE ${table} ADD ${col.name}: the column is in the model, but an ` +
                "unmodelled action on this table may have dropped or renamed it; whether the " +
                "database accepts this statement is not confirmed, and the column is not added twice.",
            });
          } else if (!a.ifNotExists) {
            rejected = { name: col.name, line: a.line };
            break;
          }
        } else {
          staged.push(col);
        }
      }
      if (rejected) {
        p.file.gaps.push({
          file: p.file.path,
          line: rejected.line,
          construct: "ALTER TABLE",
          detail:
            `ALTER TABLE ${table} ADD ${rejected.name}: the column already exists, so the ` +
            "database rejects this statement; none of its actions is applied.",
        });
        continue;
      }
      t.constraints.push(...constraints);
      t.columns.push(...staged);
    }
    for (const c of p.comments) {
      const t = byName.get(c.table);
      const target = c.column ? t?.columns.find((x) => x.name === c.column) : t;
      if (!target) {
        p.file.gaps.push({
          file: p.file.path,
          line: c.line,
          construct: "COMMENT ON",
          detail: `Comment on ${c.table}${c.column ? `.${c.column}` : ""}: no such table or column in the analysed DDL.`,
        });
        continue;
      }
      target.comment = c.text;
      target.commentAt = { file: p.file.path, line: c.line };
    }
  }
  // Table-level PRIMARY KEY / UNIQUE marks the columns too.
  for (const t of byName.values()) {
    for (const c of t.constraints) {
      for (const cn of c.columns) {
        const col = t.columns.find((x) => x.name === cn);
        if (col && c.kind === "PRIMARY KEY") {
          col.primaryKey = true;
        }
        if (col && c.kind === "UNIQUE" && c.columns.length === 1) {
          col.unique = true;
        }
      }
    }
  }
  const tables = [...byName.values()].toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const indexes = parsed
    .flatMap((p) => p.indexes)
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files: parsed.map((p) => p.file), tables, indexes, duplicates };
}
