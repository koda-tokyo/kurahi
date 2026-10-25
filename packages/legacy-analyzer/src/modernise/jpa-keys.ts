// JPA relationships versus DDL keys: a join column (to-one, @OneToMany @JoinColumn, or a join
// table's) with no foreign key in the DDL, and a foreign key no mapping uses, are findings. Both
// are judged only where the facts exist: the table holding the join columns must be defined in the
// analysed DDL, and a foreign key is reported as unused only on a table an entity or a join table
// maps. Columns compare as sets; the referenced columns are
// compared only when both sides name them.

import type { Loc } from "../types.js";
import type { JavaAnalysis, JavaRelation } from "./java-names.js";
import type { SqlModel, SqlTable } from "./types.js";

export type ForeignKey = Loc & {
  table: string;
  schema?: string;
  columns: string[];
  target: string;
  targetSchema?: string;
  referenced: string[];
};

export type KeyFinding =
  | { kind: "join without foreign key"; relation: JavaRelation }
  | { kind: "foreign key without mapping"; key: ForeignKey };

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Every foreign key of the DDL, inline (column REFERENCES) and table-level, in source order. */
export function foreignKeys(sql: SqlModel): ForeignKey[] {
  const out: ForeignKey[] = [];
  const of = (t: SqlTable) => (t.schema ? { schema: t.schema } : {});
  for (const t of sql.tables.filter((x) => x.kind === "table")) {
    for (const c of t.columns) {
      if (c.references) {
        out.push({
          file: c.file,
          line: c.line,
          table: t.name,
          ...of(t),
          columns: [c.name],
          target: c.references.table,
          ...(c.references.schema ? { targetSchema: c.references.schema } : {}),
          referenced: c.references.column ? [c.references.column] : [],
        });
      }
    }
    for (const k of t.constraints) {
      if (k.kind === "FOREIGN KEY" && k.references) {
        out.push({
          file: k.file,
          line: k.line,
          table: t.name,
          ...of(t),
          columns: k.columns,
          target: k.references.table,
          ...(k.references.schema ? { targetSchema: k.references.schema } : {}),
          referenced: k.references.columns,
        });
      }
    }
  }
  return out;
}

// A schema on either side must agree when both name one; a bare name matches any schema.
const schemaOk = (a?: string, b?: string) => !a || !b || a === b;

function matches(r: JavaRelation, k: ForeignKey): boolean {
  return (
    r.target === k.target &&
    r.table === k.table &&
    schemaOk(r.schema, k.schema) &&
    schemaOk(r.targetSchema, k.targetSchema) &&
    same(r.columns, k.columns) &&
    (!r.referenced || k.referenced.length === 0 || same(r.referenced, k.referenced))
  );
}

/** The DDL foreign key a relation's join columns match, if any. */
export function keyOfRelation(r: JavaRelation, keys: ForeignKey[]): ForeignKey | undefined {
  return keys.find((k) => matches(r, k));
}

export function compareJoinKeys(java: JavaAnalysis, sql: SqlModel): KeyFinding[] {
  const keys = foreignKeys(sql);
  const relations = (java.relations ?? []).filter((r) => r.target);
  const defined = (name: string, schema?: string) =>
    sql.tables.some((t) => t.kind === "table" && t.name === name && schemaOk(schema, t.schema));
  const mapped = java.tableUses.filter((u) => u.kind === "entity");
  const out: KeyFinding[] = [];
  for (const r of relations) {
    if (defined(r.table, r.schema) && !keys.some((k) => matches(r, k))) {
      out.push({ kind: "join without foreign key", relation: r });
    }
  }
  for (const k of keys) {
    const entity =
      mapped.some((u) => u.table === k.table && schemaOk(u.schema, k.schema)) ||
      relations.some((r) => r.joinTable && r.table === k.table && schemaOk(r.schema, k.schema));
    if (entity && !relations.some((r) => matches(r, k))) {
      out.push({ kind: "foreign key without mapping", key: k });
    }
  }
  return out;
}
