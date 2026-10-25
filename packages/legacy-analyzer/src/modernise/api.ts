// Tool-facing API of the modernisation assistant. Each call loads the cached COBOL/JCL index of
// the folder (rebuilt when a source changed), runs the Java, SQL DDL, FORTRAN and PL/I engines on
// the same folder, and answers from facts only. Read-only on the sources.

import type { LegacyIndex } from "../types.js";
import { type LegacyEnv, getIndex } from "../api.js";
import { type CrudOp, crudMatrix, viewOf } from "../crud.js";
import { accessorLanguage } from "./lang.js";
import { modernisePlan } from "./plan.js";
import { plcInventory } from "./plc-inventory.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { crossImpact } from "./poly-impact.js";
import { type Polyglot, analyseProject } from "./project.js";
import { sciInventory } from "./sci-inventory.js";

export type CrossCrudRow = {
  program: string;
  name: string;
  language: string;
  table: string;
  ops: CrudOp[];
  evidence: Array<{ op: CrudOp; via: string; where?: string; file: string; line: number }>;
};

function load(root: string, env: LegacyEnv) {
  return polyglotOf(getIndex(root, env).index);
}

/** Polyglot facts and graph of an index (for callers that already hold the index). */
export function polyglotOf(index: LegacyIndex) {
  const poly = analyseProject(index);
  return { poly, graph: buildPolyglotGraph(poly) };
}

export function modernisePlanFor(index: LegacyIndex) {
  const { poly, graph } = polyglotOf(index);
  return modernisePlan(poly, graph);
}

export function legacyModernisePlan(root: string, env: LegacyEnv) {
  const { poly, graph } = load(root, env);
  return modernisePlan(poly, graph);
}

/**
 * CRUD across COBOL, Java, PL/I and JCL utilities: one row per accessor and table, with
 * evidence; `files` the same for data sets and files (COBOL, FORTRAN, PL/I, JCL utilities).
 */
export function crossCrud(
  poly: Polyglot,
  graph = buildPolyglotGraph(poly),
  filter: { table?: string; program?: string } = {},
) {
  const view = viewOf(graph);
  const m = crudMatrix(view);
  const t = filter.table?.trim().toUpperCase();
  const p = filter.program?.trim();
  const rows: CrossCrudRow[] = [];
  const files: CrossCrudRow[] = [];
  for (const prog of m.programs) {
    const node = view.node.get(prog);
    const name = node?.kind === "java-type" ? prog.replace(/^type:/, "") : (node?.name ?? prog);
    if (p && name !== p && name.split(".").pop() !== p && node?.name !== p.toUpperCase()) {
      continue;
    }
    for (const [target, ops] of m.cells.get(prog) ?? []) {
      const isTable = target.startsWith("table:");
      const tname = view.node.get(target)?.name ?? target.replace(/^[a-z-]+:/, "");
      const umbrella = view.node.get(target)?.attrs?.umbrella;
      if (t && (isTable ? target !== `table:${t}` && umbrella !== t : tname.toUpperCase() !== t)) {
        continue;
      }
      (isTable ? rows : files).push({
        program: prog,
        name,
        language: accessorLanguage(node),
        table: isTable ? target.slice("table:".length) : tname,
        ops,
        evidence: m.evidence
          .filter((a) => a.program === prog && a.target === target)
          .map((a) => ({
            op: a.op,
            via: a.via,
            ...(a.paragraph ? { where: a.paragraph } : {}),
            file: a.loc.file,
            line: a.loc.line,
          })),
      });
    }
  }
  return {
    note: "rows: SQL tables across languages; files: data sets, files without a DD binding (a FORTRAN FILE= name, a PL/I file) and CICS files.",
    tables: [...new Set(rows.map((r) => r.table))].toSorted(),
    rows,
    files,
  };
}

export function legacyCrossCrud(
  root: string,
  filter: { table?: string; program?: string },
  env: LegacyEnv,
) {
  const { poly, graph } = load(root, env);
  return crossCrud(poly, graph, filter);
}

export function legacyCrossImpact(root: string, target: string, env: LegacyEnv) {
  const { poly, graph } = load(root, env);
  return crossImpact(poly, graph, target);
}

export type InventoryKind = "java" | "sql" | "fortran" | "pli" | "plc";

/**
 * Java types, SQL tables, FORTRAN units, PL/I procedures or PLC POUs: the list, or one entry in
 * full.
 */
export function inventory(poly: Polyglot, kind: InventoryKind, name?: string) {
  if (kind === "plc") {
    return plcInventory(poly, name);
  }
  if (kind === "fortran" || kind === "pli") {
    return sciInventory(poly, kind, name);
  }
  if (kind === "java") {
    const types = poly.java.model.types;
    if (!name) {
      return {
        types: types.map((t) => ({
          name: t.qualifiedName,
          kind: t.kind,
          stereotypes: poly.java.stereotypes[t.qualifiedName] ?? [],
          methods: t.methods.length,
          fields: t.fields.length,
          file: t.file,
          line: t.line,
        })),
      };
    }
    const t = types.find((x) => x.qualifiedName === name || x.name === name);
    if (!t) {
      throw new Error(`No Java type named ${name}.`);
    }
    return {
      type: t,
      calls: poly.java.calls.filter((c) => c.from.startsWith(`${t.qualifiedName}#`)),
      unresolved: poly.java.unresolved.filter((c) => c.from.startsWith(`${t.qualifiedName}#`)),
      tables: poly.java.tableUses.filter((u) => u.type === t.qualifiedName),
      columns: poly.java.columns.filter((c) => c.type === t.qualifiedName),
    };
  }
  if (!name) {
    return {
      tables: poly.sql.tables.map((t) => ({
        name: t.name,
        schema: t.schema,
        kind: t.kind,
        columns: t.columns.length,
        file: t.file,
        line: t.line,
      })),
      indexes: poly.sql.indexes,
    };
  }
  const t = poly.sql.tables.find((x) => x.name === name.trim().toUpperCase());
  if (!t) {
    throw new Error(`No table named ${name} in the analysed DDL.`);
  }
  return { table: t, indexes: poly.sql.indexes.filter((i) => i.table === t.name) };
}

export function legacyInventory(
  root: string,
  kind: InventoryKind,
  name: string | undefined,
  env: LegacyEnv,
) {
  return inventory(load(root, env).poly, kind, name);
}
