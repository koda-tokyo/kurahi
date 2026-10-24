// Modernisation assistant entry point: which languages and assistants the project contains, the
// inventory of every active engine, the tables shared across COBOL, Java, PL/I and SQL DDL, and an
// honest coverage report (what each engine did not model, what could not be resolved). Planned
// assistants are listed with the files they would cover and produce no facts.

import path from "node:path";
import type { KnowledgeGraph } from "../graph.js";
import type { Loc } from "../types.js";
import type { Polyglot } from "./project.js";
import { coverage, gapCount } from "../coverage.js";
import { type GraphView, crudMatrix, viewOf } from "../crud.js";
import { accessorLanguage } from "./lang.js";
import { buildPolyglotGraph } from "./poly-graph.js";

export type TableRow = {
  table: string;
  kind: "table" | "view" | "undefined";
  definedAt?: Loc;
  accessors: Array<{ node: string; name: string; language: string; ops: string }>;
  languages: string[];
};

export type ModernisePlan = ReturnType<typeof modernisePlan>;

const sortedCounts = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) {
    m.set(x, (m.get(x) ?? 0) + 1);
  }
  return Object.fromEntries([...m].toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
};

/** Files read by the other engines (for the COBOL coverage "not analysed" list). */
export function polyglotFiles(poly: Polyglot): Set<string> {
  return new Set([
    ...poly.java.model.files.map((f) => f.path),
    ...poly.sql.files.map((f) => f.path),
    ...poly.fortran.files.map((f) => f.path),
    ...poly.fortran.includeFiles,
    ...poly.pli.files.map((f) => f.path),
    ...poly.pli.includeFiles,
  ]);
}

export function tableRows(poly: Polyglot, view: GraphView): TableRow[] {
  const crud = crudMatrix(view);
  const ids = new Set([
    ...crud.targets.filter((t) => t.startsWith("table:")),
    ...view.graph.nodes.filter((n) => n.kind === "table").map((n) => n.id),
  ]);
  return [...ids].toSorted().map((id) => {
    const n = view.node.get(id);
    const ddl = poly.sql.tables.find((t) => `table:${t.name}` === id);
    const accessors: TableRow["accessors"] = [];
    for (const p of crud.programs) {
      const ops = crud.cells.get(p)?.get(id);
      if (ops) {
        const pn = view.node.get(p);
        const language = accessorLanguage(pn);
        accessors.push({ node: p, name: pn?.name ?? p, language, ops: ops.join("") });
      }
    }
    const langs = new Set<string>(accessors.map((a) => a.language));
    if (ddl) {
      langs.add("SQL DDL");
    }
    return {
      table: n?.name ?? id.slice(6),
      kind: ddl ? ddl.kind : "undefined",
      ...(ddl ? { definedAt: { file: ddl.file, line: ddl.line } } : {}),
      accessors,
      languages: [...langs].toSorted(),
    };
  });
}

export function modernisePlan(poly: Polyglot, graphIn?: KnowledgeGraph) {
  const graph = graphIn ?? buildPolyglotGraph(poly);
  const view = viewOf(graph);
  const { index, java, sql } = poly;
  const cov = coverage(index, view, polyglotFiles(poly));
  const types = java.model.types;
  const st = (s: string) =>
    types.filter((t) => java.stereotypes[t.qualifiedName]?.includes(s)).length;
  const tables = tableRows(poly, view);
  const statements = index.programs.flatMap((p) => p.paragraphs.flatMap((x) => x.statements));
  const javaGaps = java.model.files.flatMap((f) => f.gaps);
  const sqlGaps = sql.files.flatMap((f) => f.gaps);
  const partialSql = types.flatMap((t) =>
    t.methods.flatMap((m) =>
      m.sql
        .filter((x) => x.partial)
        .map((x) => ({
          file: x.file,
          line: x.line,
          type: t.qualifiedName,
          method: m.signature,
          text: x.text,
        })),
    ),
  );

  const engines = poly.detections.map((d) => ({
    id: d.id,
    label: d.label,
    status: d.status,
    description: d.description,
    detectedFiles: d.files,
    analysedFiles:
      d.id === "cobol"
        ? index.files.length
        : d.id === "java"
          ? java.model.files.length
          : d.id === "sql-ddl"
            ? sql.files.length
            : d.id === "fortran"
              ? poly.fortran.files.length
              : d.id === "pli"
                ? poly.pli.files.length
                : 0,
    examples: d.examples,
  }));
  return {
    schema: "kurahi.modernise-plan/1" as const,
    project: path.basename(index.root),
    note: "Facts from deterministic engines, each with path:line. Planned assistants are listed with the files they would cover; they analyse nothing and their absence of findings means nothing.",
    languages: engines.filter(
      (e) => e.detectedFiles > 0 || e.analysedFiles > 0 || e.status === "active",
    ),
    planned: engines
      .filter((e) => e.status === "planned")
      .map((e) => ({
        id: e.id,
        label: e.label,
        detectedFiles: e.detectedFiles,
        description: e.description,
      })),
    inventory: {
      cobol: {
        files: index.files.length,
        programs: index.programs.length,
        copybooks: index.copybooks.length,
        jobs: index.jobs.length,
        paragraphs: index.programs.reduce((k, p) => k + p.paragraphs.length, 0),
        statements: statements.length,
        sqlStatements: statements.filter((s) => s.sql).length,
      },
      java: {
        files: java.model.files.length,
        packages: new Set(types.map((t) => t.package ?? "")).size,
        types: sortedCounts(types.map((t) => t.kind)),
        methods: types.reduce((k, t) => k + t.methods.length, 0),
        fields: types.reduce((k, t) => k + t.fields.length, 0),
        entities: st("Entity"),
        repositories: types.filter((t) =>
          java.stereotypes[t.qualifiedName]?.some(
            (x) => x === "Repository" || x === "Spring Data repository",
          ),
        ).length,
        services: st("Service"),
        controllers: st("RestController") + st("Controller"),
        resolvedCalls: java.calls.length,
        unresolvedCalls: java.unresolved.length,
        tableAccesses: java.tableUses.filter((u) => u.kind === "access").length,
      },
      sql: {
        files: sql.files.length,
        statements: sql.files.reduce((k, f) => k + f.statements, 0),
        tables: sql.tables.filter((t) => t.kind === "table").length,
        views: sql.tables.filter((t) => t.kind === "view").length,
        columns: sql.tables.reduce((k, t) => k + (t.kind === "table" ? t.columns.length : 0), 0),
        indexes: sql.indexes.length,
        foreignKeys: sql.tables.reduce(
          (k, t) =>
            k +
            t.constraints.filter((c) => c.kind === "FOREIGN KEY").length +
            t.columns.filter((c) => c.references).length,
          0,
        ),
      },
      fortran: fortranInventory(poly),
      pli: pliInventory(poly),
    },
    tables,
    crossLanguage: {
      /** Tables read or written from more than one language (COBOL, Java, PL/I, JCL utilities). */
      shared: tables
        .filter((t) => new Set(t.accessors.map((a) => a.language)).size >= 2)
        .map((t) => t.table),
      accessedButNotDefined: tables
        .filter((t) => t.kind === "undefined" && t.accessors.length > 0)
        .map((t) => t.table),
      definedButNotAccessed: tables
        .filter((t) => t.kind !== "undefined" && t.accessors.length === 0)
        .map((t) => t.table),
      joinRule:
        "Tables are matched by unqualified name, case-insensitive (schema dropped); JPA names without @Table follow Spring Boot's default naming (camelCase to UPPER_SNAKE). Programs meet by name: a JCL EXEC PGM=, a COBOL CALL and a FORTRAN or PL/I CALL of the same name are one program.",
    },
    coverage: {
      cobol: {
        diagnostics: index.diagnostics.length,
        gaps: gapCount(cov),
        notAnalysedFiles: cov.notAnalysedTotal,
      },
      java: {
        gaps: javaGaps,
        unresolvedCalls: java.unresolved.length,
        unresolvedByReason: sortedCounts(
          java.unresolved.map((u) =>
            u.reason
              .replace(/^\S+ is not declared in \S+/, "(method) is not declared in (type)")
              .replace(/of (field|parameter) \S+( \([^)]*\))?/, "of $1 (name)"),
          ),
        ),
        partialSql,
      },
      sql: { gaps: sqlGaps, duplicates: sql.duplicates },
      fortran: {
        gaps: poly.fortran.gaps,
        unresolvedCalls: poly.fortran.calls.filter(
          (c) => c.resolution === "not in the FORTRAN sources",
        ),
        unresolvedIo: poly.fortran.unresolvedIo,
        missingIncludes: poly.fortran.includes.filter((i) => !i.resolved),
        commonLayoutsDiffer: poly.fortran.commons
          .filter((c) => c.layout !== "same")
          .map((c) => ({ block: c.name, layout: c.layout, users: c.users.map((u) => u.unit) })),
      },
      pli: {
        gaps: poly.pli.gaps,
        unresolvedCalls: poly.pli.calls.filter((c) => c.resolution === "not in the PL/I sources"),
        missingIncludes: poly.pli.includes.filter((i) => !i.resolved),
        undeclaredFiles: poly.pli.fileUses.filter((u) => !u.declared),
      },
      unreadFiles: poly.unread,
      scanPartial: poly.scan.partial,
    },
  };
}

function fortranInventory(poly: Polyglot) {
  const f = poly.fortran;
  const byId = new Map(f.units.map((u) => [u.id, u]));
  const implicitOf = (id: string | undefined): string | undefined => {
    const u = id ? byId.get(id) : undefined;
    return u?.implicit ?? (u?.host ? implicitOf(u.host) : undefined);
  };
  return {
    files: f.files.length,
    fixedForm: f.files.filter((x) => x.form === "fixed").length,
    freeForm: f.files.filter((x) => x.form === "free").length,
    includeFiles: f.includeFiles.length,
    units: sortedCounts(f.units.map((u) => u.kind)),
    commonBlocks: f.commons.length,
    resolvedCalls: f.calls.filter((c) => c.resolution !== "not in the FORTRAN sources").length,
    externalCalls: f.calls.filter((c) => c.resolution === "not in the FORTRAN sources").length,
    fileAccesses: f.fileUses.length,
    /** Units without IMPLICIT NONE (own or inherited from the host): implicit typing applies. */
    implicitTyping: f.units.filter((u) => u.kind !== "module" && implicitOf(u.id) !== "NONE")
      .length,
  };
}

function pliInventory(poly: Polyglot) {
  const p = poly.pli;
  return {
    files: p.files.length,
    includeFiles: p.includeFiles.length,
    procedures: p.procs.length,
    main: p.procs.filter((x) => x.main).length,
    internal: p.procs.filter((x) => x.parent).length,
    structures: p.structures.length,
    fileDeclarations: p.procs.reduce((k, x) => k + x.files.length, 0),
    calls: p.calls.length,
    sqlStatements: p.procs.reduce((k, x) => k + x.sql.length, 0),
    onUnits: p.procs.reduce((k, x) => k + x.onUnits.length, 0),
  };
}
