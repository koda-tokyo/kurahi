// Polyglot knowledge graph: the COBOL/JCL graph (graph.ts) plus Java types, methods and calls and
// the SQL DDL schema, with the same node/edge conventions (sorted, every edge with the file:line of
// its fact). Tables are one node per canonical name (`table:EMPLOYEE`), so a COBOL EXEC SQL
// table, a JPA @Table and a CREATE TABLE of the same name meet in the same node; the CRUD matrix
// (crud.ts) and graph queries then work across the languages unchanged. FORTRAN and PL/I are
// added by sci-graph.ts.

import type { GraphEdge, GraphNode, KnowledgeGraph } from "../graph.js";
import type { Loc } from "../types.js";
import type { Polyglot } from "./project.js";
import { buildGraph, nodeId } from "../graph.js";
import { methodId } from "./java-resolve.js";
import { addFortranPli } from "./sci-graph.js";

export const polyId = {
  pkg: (name: string) => `package:${name}`,
  type: (qn: string) => `type:${qn}`,
  method: (id: string) => `method:${id}`,
  column: (table: string, col: string) => `column:${table}.${col}`,
  index: (name: string) => `index:${name}`,
};

const loc = (x: Loc): Loc => ({ file: x.file, line: x.line });
const byText = (a: string, z: string) => (a < z ? -1 : a > z ? 1 : 0);

export function sortGraph(nodes: Map<string, GraphNode>, edges: GraphEdge[]): KnowledgeGraph {
  const seen = new Set<string>();
  const unique = edges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.kind}|${e.loc.file}:${e.loc.line}|${e.detail ?? ""}|${e.paragraph ?? ""}|${e.via ?? ""}`;
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
      if (c.references) {
        edges.push({
          from: nodeId.table(t.name),
          to: table(c.references.table),
          kind: "FK",
          loc: loc(c),
          detail: `${c.name} -> ${c.references.table}${c.references.column ? `.${c.references.column}` : ""}`,
        });
      }
    }
    for (const k of t.constraints.filter((x) => x.kind === "FOREIGN KEY" && x.references)) {
      const ref = k.references as { table: string; columns: string[] };
      edges.push({
        from: nodeId.table(t.name),
        to: table(ref.table),
        kind: "FK",
        loc: loc(k),
        detail: `${k.columns.join(",")} -> ${ref.table}(${ref.columns.join(",")})`,
      });
    }
    for (const s of t.sources) {
      edges.push({
        from: nodeId.table(t.name),
        to: table(s),
        kind: "VIEW",
        loc: loc(t),
        detail: "SELECT",
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
    });
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
    if (u.kind !== "access") {
      edges.push({ from, to, kind: "MAPS", loc: loc(u), detail: u.via });
    } else if (u.sqlOp !== undefined) {
      edges.push({
        from,
        to,
        kind: "SQL",
        loc: loc(u),
        detail: u.sqlOp,
        ...(u.method ? { paragraph: u.method } : {}),
        via: u.via,
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
      detail: `${c.field}${c.implicit ? " (implicit name)" : ""}`,
    });
  }
  addFortranPli(poly, nodes, edges);
  return sortGraph(nodes, edges);
}
