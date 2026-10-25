// Polyglot knowledge graph: the COBOL/JCL graph (graph.ts) plus Java types, methods and calls and
// the SQL DDL schema, with the same node/edge conventions (sorted, every edge with the file:line of
// its fact). Tables are one node per canonical name (`table:EMPLOYEE`), so a COBOL EXEC SQL
// table, a JPA @Table and a CREATE TABLE of the same name meet in the same node; the CRUD matrix
// (crud.ts) and graph queries then work across the languages unchanged. FORTRAN and PL/I are
// added by sci-graph.ts.

import type { GraphEdge, GraphNode, KnowledgeGraph } from "../graph.js";
import type { Loc } from "../types.js";
import type { JavaColumnMap } from "./java-names.js";
import type { Polyglot } from "./project.js";
import type { SqlColumn, SqlConstraint, SqlTable } from "./types.js";
import { buildGraph, nodeId } from "../graph.js";
import { methodId } from "./java-resolve.js";
import { compareJoinKeys } from "./jpa-keys.js";
import { addFortranPli } from "./sci-graph.js";
import { canonical, routineCall } from "./sql-text.js";

export const polyId = {
  pkg: (name: string) => `package:${name}`,
  type: (qn: string) => `type:${qn}`,
  method: (id: string) => `method:${id}`,
  column: (table: string, col: string) => `column:${table}.${col}`,
  index: (name: string) => `index:${name}`,
  routine: (name: string) => `routine:${name}`,
};

const loc = (x: Loc): Loc => ({ file: x.file, line: x.line });
const byText = (a: string, z: string) => (a < z ? -1 : a > z ? 1 : 0);

// A column whose DDL type cannot hold the mapping's storage (an enum STRING in a numeric column,
// an ORDINAL in a character one, a temporal value in a non-temporal column) says so.
const STORE_TYPES: Record<NonNullable<JavaColumnMap["stores"]>, RegExp> = {
  STRING: /CHAR|TEXT|CLOB|GRAPHIC|STRING/,
  ORDINAL: /INT|NUMBER|NUMERIC|DEC|SERIAL/,
  DATE: /^(DATE|TIMESTAMP)/,
  TIME: /^(TIME|DATETIME)/,
  TIMESTAMP: /^(TIMESTAMP|DATETIME|DATE$)/,
};
const storeTypeMismatch = (stores: NonNullable<JavaColumnMap["stores"]>, type?: string) => {
  const base = type
    ?.toUpperCase()
    .replace(/\s*\(.*$/, "")
    .trim();
  return base && !STORE_TYPES[stores].test(base) ? `; DDL type ${type} does not hold it` : "";
};

export function sortGraph(nodes: Map<string, GraphNode>, edges: GraphEdge[]): KnowledgeGraph {
  const seen = new Set<string>();
  const unique = edges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.kind}|${e.loc.file}:${e.loc.line}|${e.detail ?? ""}|${e.paragraph ?? ""}|${e.via ?? ""}|${e.schema ?? ""}`;
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
  return {
    schema: "kurahi.legacy-graph/1",
    nodes: [...nodes.values()].toSorted((x, y) => byText(x.id, y.id)),
    edges: unique.toSorted(
      (x, y) =>
        byText(x.from, y.from) ||
        byText(x.kind, y.kind) ||
        byText(x.to, y.to) ||
        byText(x.loc.file, y.loc.file) ||
        x.loc.line - y.loc.line ||
        byText(x.detail ?? "", y.detail ?? "") ||
        byText(x.paragraph ?? "", y.paragraph ?? ""),
    ),
  };
}

export function buildPolyglotGraph(poly: Polyglot): KnowledgeGraph {
  const base = buildGraph(poly.index);
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [...base.edges];
  const node = (n: GraphNode) => {
    if (!nodes.has(n.id)) {
      nodes.set(n.id, n);
    }
    return n.id;
  };
  const table = (name: string) =>
    node({
      id: nodeId.table(name),
      kind: "table",
      name,
      attrs: { defined: "not in the analysed DDL" },
    });

  // SQL DDL: tables and views (replacing the COBOL graph's location-less table nodes), columns,
  // foreign keys, indexes and view sources.
  for (const t of poly.sql.tables) {
    const prev = nodes.get(nodeId.table(t.name));
    nodes.set(nodeId.table(t.name), {
      id: nodeId.table(t.name),
      kind: "table",
      name: t.name,
      loc: loc(t),
      attrs: {
        ...prev?.attrs,
        type: t.kind,
        columns: String(t.columns.length),
        ...(t.schema ? { schema: t.schema } : {}),
        ...(t.comment ? { comment: t.comment } : {}),
      },
    });
    for (const c of t.columns) {
      const cid = node({
        id: polyId.column(t.name, c.name),
        kind: "column",
        name: c.name,
        loc: loc(c),
        attrs: {
          table: t.name,
          ...(c.type ? { type: c.type } : {}),
          ...(c.nullable === false ? { nullable: "false" } : {}),
          ...(c.primaryKey ? { primaryKey: "true" } : {}),
        },
      });
      edges.push({ from: nodeId.table(t.name), to: cid, kind: "CONTAINS", loc: loc(c) });
    }
    keysAndSources(nodeId.table(t.name), t);
  }
  // Foreign keys and view sources of a table definition, from its node. A reference that names a
  // schema keeps it on the edge, so it binds to that schema's node when the name is split below.
  function keysAndSources(from: string, t: SqlTable) {
    for (const c of t.columns.filter((x) => x.references)) {
      const ref = c.references as NonNullable<SqlColumn["references"]>;
      edges.push({
        from,
        to: table(ref.table),
        kind: "FK",
        loc: loc(c),
        detail: `${c.name} -> ${ref.table}${ref.column ? `.${ref.column}` : ""}`,
        ...(ref.schema ? { schema: ref.schema } : {}),
      });
    }
    for (const k of t.constraints.filter((x) => x.kind === "FOREIGN KEY" && x.references)) {
      const ref = k.references as NonNullable<SqlConstraint["references"]>;
      edges.push({
        from,
        to: table(ref.table),
        kind: "FK",
        loc: loc(k),
        detail: `${k.columns.join(",")} -> ${ref.table}(${ref.columns.join(",")})`,
        ...(ref.schema ? { schema: ref.schema } : {}),
      });
    }
    for (const s of t.sources) {
      const schema = t.sourceSchemas?.[s];
      edges.push({
        from,
        to: table(s),
        kind: "VIEW",
        loc: loc(t),
        detail: "SELECT",
        ...(schema ? { schema } : {}),
      });
    }
  }
  for (const ix of poly.sql.indexes) {
    const id = node({
      id: polyId.index(ix.name),
      kind: "sql-index",
      name: ix.name,
      loc: loc(ix),
      attrs: { table: ix.table, ...(ix.unique ? { unique: "true" } : {}) },
    });
    edges.push({
      from: id,
      to: table(ix.table),
      kind: "INDEX",
      loc: loc(ix),
      detail: ix.columns.join(","),
      ...(ix.tableSchema ? { schema: ix.tableSchema } : {}),
    });
  }
  // Stored routines with a read body: each static statement is an SQL edge to its table (so the
  // CRUD matrix and impact queries reach through the routine), CALL edges between routines, and a
  // TRIGGER edge from a trigger's table. A called name with no definition stays a node that says so.
  for (const r of poly.sql.routines) {
    nodes.set(polyId.routine(r.name), {
      id: polyId.routine(r.name),
      kind: "routine",
      name: r.name,
      loc: loc(r),
      attrs: {
        type: r.kind.toLowerCase(),
        endLine: String(r.endLine),
        ...(r.schema ? { schema: r.schema } : {}),
        ...(r.package ? { package: r.package } : {}),
        ...(r.on ? { on: r.on } : {}),
      },
    });
  }
  for (const r of poly.sql.routines) {
    const rid = polyId.routine(r.name);
    for (const a of r.access) {
      edges.push({
        from: rid,
        to: table(a.table),
        kind: "SQL",
        loc: loc(a),
        detail: a.op,
        ...(a.schema ? { schema: a.schema } : {}),
      });
    }
    for (const c of r.calls) {
      const to = node({
        id: polyId.routine(c.name),
        kind: "routine",
        name: c.name,
        attrs: { defined: "not in the analysed DDL" },
      });
      edges.push({ from: rid, to, kind: "CALL", loc: loc(c), detail: "SQL CALL" });
    }
    if (r.on) {
      edges.push({
        from: table(r.on),
        to: rid,
        kind: "TRIGGER",
        loc: loc(r),
        detail: (r.events ?? []).join(","),
      });
    }
  }
  // Host-language calls into routines (Java JDBC/JPA/MyBatis): a CALL edge from the calling type,
  // the method as the paragraph. `PREFIX.NAME` binds like a call between routines: a package
  // member unless the DDL defines PREFIX as a schema; a name with no routine stays a node that
  // says so.
  const routineNames = new Set(poly.sql.routines.map((r) => r.name));
  const packages = new Set(poly.sql.routines.flatMap((r) => (r.package ? [r.package] : [])));
  const schemas = new Set(
    [...poly.sql.tables, ...poly.sql.routines].flatMap((x) =>
      x.schema ? [canonical(x.schema)] : [],
    ),
  );
  const routineOf = (parts: string[]) => {
    const name = parts.at(-1) ?? "";
    const q = parts.at(-2);
    return q && (routineNames.has(`${q}.${name}`) || packages.has(q) || !schemas.has(q))
      ? `${q}.${name}`
      : name;
  };
  for (const c of poly.java.routineCalls ?? []) {
    const to = node({
      id: polyId.routine(routineOf(c.routine)),
      kind: "routine",
      name: routineOf(c.routine),
      attrs: { defined: "not in the analysed DDL" },
    });
    edges.push({
      from: polyId.type(c.type),
      to,
      kind: "CALL",
      loc: loc(c),
      detail: c.via,
      ...(c.method ? { paragraph: c.method } : {}),
    });
  }
  // COBOL and PL/I EXEC SQL CALL: a CALL edge from the program, the paragraph (COBOL) or internal
  // procedure (PL/I) as the paragraph, bound the same way. `CALL :HOST-VAR` names no routine.
  const hostCall = (from: string, sql: string, at: Loc, paragraph?: string) => {
    const parts = routineCall(sql.replace(/^\s*EXEC\s+SQL\s+/i, ""));
    if (!parts) {
      return;
    }
    const name = routineOf(parts);
    const to = node({
      id: polyId.routine(name),
      kind: "routine",
      name,
      attrs: { defined: "not in the analysed DDL" },
    });
    edges.push({
      from,
      to,
      kind: "CALL",
      loc: loc(at),
      detail: "EXEC SQL CALL",
      ...(paragraph ? { paragraph } : {}),
    });
  };
  for (const prog of poly.index.programs) {
    for (const para of prog.paragraphs) {
      for (const st of para.statements) {
        if (st.sql?.ops[0] === "CALL") {
          hostCall(nodeId.program(prog.name), st.code, st, para.name);
        }
      }
    }
  }
  for (const pr of poly.pli.procs) {
    for (const q of pr.sql) {
      if (/^CALL\b/i.test(q.text)) {
        const qn = pr.qualified;
        const dot = qn.lastIndexOf(".");
        hostCall(
          nodeId.program(qn.split(".")[0]),
          q.text,
          q,
          dot >= 0 ? qn.slice(dot + 1) : undefined,
        );
      }
    }
  }
  // A bare name two schemas define is one node (the first schema's table), so every language's
  // edge to it may mean either table; the node says so rather than letting the join look certain.
  for (const a of poly.sql.ambiguous) {
    const n = nodes.get(nodeId.table(a.name));
    if (n) {
      n.attrs = { ...n.attrs, ambiguousSchemas: a.schemas.join(",") };
    }
  }
  // Each schema's table of an ambiguous name is its own node `table:SCHEMA.NAME`, with its own
  // columns, under the bare-name node (a SCHEMA edge), which stays for bare references.
  const split = new Set<string>();
  for (const t of poly.sql.schemaTables ?? []) {
    const q = `${t.schema}.${t.name}`;
    split.add(q);
    nodes.set(nodeId.table(q), {
      id: nodeId.table(q),
      kind: "table",
      name: q,
      loc: loc(t),
      attrs: {
        type: t.kind,
        columns: String(t.columns.length),
        schema: t.schema ?? "",
        umbrella: t.name,
        ...(t.comment ? { comment: t.comment } : {}),
      },
    });
    edges.push({
      from: nodeId.table(t.name),
      to: nodeId.table(q),
      kind: "SCHEMA",
      loc: loc(t),
      detail: t.schema,
    });
    for (const c of t.columns) {
      const cid = node({
        id: polyId.column(q, c.name),
        kind: "column",
        name: c.name,
        loc: loc(c),
        attrs: {
          table: q,
          ...(c.type ? { type: c.type } : {}),
          ...(c.nullable === false ? { nullable: "false" } : {}),
          ...(c.primaryKey ? { primaryKey: "true" } : {}),
        },
      });
      edges.push({ from: nodeId.table(q), to: cid, kind: "CONTAINS", loc: loc(c) });
    }
    keysAndSources(nodeId.table(q), t);
  }

  // Java: packages, types, methods, supertypes, calls, mappings and table access.
  const java = poly.java;
  for (const t of java.model.types) {
    const tid = node({
      id: polyId.type(t.qualifiedName),
      kind: "java-type",
      name: t.name,
      loc: loc(t),
      attrs: {
        type: t.kind,
        ...(t.package ? { package: t.package } : {}),
        ...(java.stereotypes[t.qualifiedName]
          ? { stereotypes: java.stereotypes[t.qualifiedName].join(",") }
          : {}),
        endLine: String(t.endLine),
      },
    });
    if (t.outer) {
      edges.push({ from: polyId.type(t.outer), to: tid, kind: "CONTAINS", loc: loc(t) });
    } else if (t.package) {
      node({ id: polyId.pkg(t.package), kind: "java-package", name: t.package });
      edges.push({ from: polyId.pkg(t.package), to: tid, kind: "CONTAINS", loc: loc(t) });
    }
    for (const m of t.methods) {
      const mid = node({
        id: polyId.method(methodId(t.qualifiedName, m)),
        kind: "java-method",
        name: m.signature,
        loc: loc(m),
        attrs: { type: t.qualifiedName, kind: m.kind, endLine: String(m.endLine) },
      });
      edges.push({ from: tid, to: mid, kind: "CONTAINS", loc: loc(m) });
    }
  }
  for (const s of java.supertypes) {
    const to = s.resolved
      ? polyId.type(s.resolved)
      : node({
          id: polyId.type(s.name.replace(/<.*$/s, "").trim()),
          kind: "java-type",
          name: s.name.replace(/<.*$/s, "").trim().split(".").pop() ?? s.name,
          attrs: { external: "true" },
        });
    edges.push({ from: polyId.type(s.type), to, kind: s.kind, loc: loc(s) });
  }
  for (const c of java.calls) {
    for (const target of c.to) {
      const to = target.includes("#") ? polyId.method(target) : polyId.type(target);
      edges.push({
        from: polyId.method(c.from),
        to,
        kind: "INVOKES",
        loc: loc(c),
        detail: c.resolution,
      });
    }
  }
  for (const u of java.tableUses) {
    const to = table(u.table);
    const from = polyId.type(u.type);
    const schema = u.schema ? { schema: u.schema } : {};
    if (u.kind !== "access") {
      const d = u.discriminator;
      edges.push({
        from,
        to,
        kind: "MAPS",
        loc: loc(u),
        detail: d
          ? `${u.via}; ${d.column} = ${d.value === undefined ? (d.abstract ? "(abstract, no rows)" : "(provider-specific)") : `'${d.value}'`}${d.duplicate ? " (duplicate)" : ""}`
          : u.via,
        ...schema,
      });
    } else if (u.sqlOp !== undefined) {
      edges.push({
        from,
        to,
        kind: "SQL",
        loc: loc(u),
        detail: u.sqlOp,
        ...(u.method ? { paragraph: u.method } : {}),
        via: u.via,
        ...schema,
      });
    } else {
      edges.push({
        from,
        to,
        kind: "JPA",
        loc: loc(u),
        detail: u.ops.join(","),
        ...(u.method ? { paragraph: u.method } : {}),
        via: u.via,
        ...schema,
      });
    }
  }
  for (const c of java.columns) {
    const cid = node({
      id: polyId.column(c.table, c.column),
      kind: "column",
      name: c.column,
      attrs: { table: c.table, defined: "not in the analysed DDL" },
    });
    edges.push({
      from: polyId.type(c.type),
      to: cid,
      kind: "MAPS",
      loc: loc(c),
      detail: `${c.discriminator ? "discriminator" : c.primaryKeyJoin ? "primary key join column" : c.field}${c.implicit ? " (implicit name)" : ""}${c.mapsId ? `; maps id ${c.mapsId}` : ""}${c.stores ? `; stored as ${c.stores}${storeTypeMismatch(c.stores, nodes.get(cid)?.attrs?.type)}` : ""}`,
    });
  }
  // JPA relationships (to-one, @OneToMany @JoinColumn, join tables, secondary tables, JOINED inheritance): a JOIN edge between the tables, the mapping's claim; it says so
  // when the DDL declares no matching foreign key (jpa-keys.ts).
  const noKey = new Set(
    compareJoinKeys(java, poly.sql).flatMap((f) =>
      f.kind === "join without foreign key" ? [f.relation] : [],
    ),
  );
  const joinFrom: Array<[GraphEdge, string]> = [];
  for (const r of java.relations ?? []) {
    if (!r.target) {
      continue;
    }
    const e: GraphEdge = {
      from: table(r.table),
      to: table(r.target),
      kind: "JOIN",
      loc: loc(r),
      detail: `${r.columns.join(",")} -> ${r.target}${r.referenced ? `(${r.referenced.join(",")})` : ""}${r.implicit ? " (implicit name)" : ""}${r.joinTable ? " (join table)" : ""}${noKey.has(r) ? "; no foreign key in the DDL" : ""}`,
      via: `@${r.kind} ${r.type.split(".").pop()}${r.field ? `.${r.field}` : ""}`,
      ...(r.targetSchema ? { schema: r.targetSchema } : {}),
    };
    edges.push(e);
    if (r.schema) {
      joinFrom.push([e, r.schema]);
    }
  }
  // A reference that names one of those schemas binds to that schema's node; a bare one, or one
  // naming a schema that does not define the table, stays on the bare-name node.
  if (split.size) {
    for (const e of edges) {
      const q = e.schema && `${canonical(e.schema)}.${e.to.slice("table:".length)}`;
      if (q && e.to.startsWith("table:") && split.has(q)) {
        e.to = nodeId.table(q);
      }
    }
    for (const [e, schema] of joinFrom) {
      const q = `${schema}.${e.from.slice("table:".length)}`;
      if (split.has(q)) {
        e.from = nodeId.table(q);
      }
    }
  }
  addFortranPli(poly, nodes, edges);
  return sortGraph(nodes, edges);
}
