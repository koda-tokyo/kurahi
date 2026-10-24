// Modernisation-assistant tools of the kurahi-legacy MCP server, appended to LEGACY_TOOLS. They
// read the same project scope as the COBOL tools: the fresh COBOL/JCL index of the scope, plus the
// Java, SQL DDL, FORTRAN and PL/I engines run on the scope's files. Reads only; nothing from the
// repository is run.

import { z } from "zod";
import type { LegacyToolContext, LegacyToolDef } from "./tools.js";
import {
  crossCrud,
  crossImpact,
  inventory,
  modernisePlan,
  polyglotOf,
} from "../../../packages/legacy-analyzer/src/index.js";

// The same shape as tools.ts `defineTool`, kept local so the two modules do not import each other.
function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  run(ctx: LegacyToolContext, args: z.infer<z.ZodObject<S>>): unknown;
  summarize(result: unknown, args: z.infer<z.ZodObject<S>>): string;
}): LegacyToolDef {
  return def as unknown as LegacyToolDef;
}

const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export const MODERNISE_TOOLS: LegacyToolDef[] = [
  tool({
    name: "modernise_plan",
    title: "Modernisation plan",
    description:
      "Entry point of the modernisation assistant: detects the languages of the project (or path), runs the " +
      "active engines (COBOL/JCL, Java, SQL DDL, FORTRAN, PL/I) and returns the combined inventory, the tables " +
      "shared across languages, coverage (what each engine did not model or resolve: FORTRAN preprocessor, " +
      "computed GO TO, ENTRY, unbound I/O units, COMMON layouts that differ; PL/I macros, FETCH, dynamic SQL) " +
      "and the planned assistants (PLC IEC 61131-3, batch schedulers, maintenance, cybersecurity) with the files " +
      "they would cover. Planned assistants analyse nothing.",
    input: {},
    run(ctx) {
      const { poly, graph } = polyglotOf(ctx.index().index);
      return modernisePlan(poly, graph);
    },
    summarize: (r: {
      languages: Array<{
        id: string;
        status: string;
        analysedFiles: number;
        detectedFiles: number;
      }>;
      crossLanguage: { shared: string[] };
    }) =>
      `Languages: ${r.languages.map((l) => `${l.id} (${l.status}, ${l.status === "active" ? l.analysedFiles : l.detectedFiles} files)`).join(", ")}. ` +
      `Tables shared across languages: ${r.crossLanguage.shared.join(", ") || "none"}.`,
  }),
  tool({
    name: "modernise_crud",
    title: "Cross-language CRUD",
    description:
      "CRUD of SQL tables across COBOL and PL/I (EXEC SQL), Java (JPA repositories, @Query, JDBC literals) and " +
      "JCL utilities: one row per program or class and table, with the evidence of each operation at path:line. " +
      "files: the same for data sets and files (COBOL, FORTRAN OPEN FILE= and FTnnF001 units, PL/I files " +
      "through their DD).",
    input: {
      table: z.string().max(128).optional().describe("Only this table (unqualified name)."),
      program: z
        .string()
        .max(256)
        .optional()
        .describe("Only this program (COBOL, FORTRAN unit, PL/I procedure) or Java class."),
    },
    run(ctx, a) {
      const { poly, graph } = polyglotOf(ctx.index().index);
      return crossCrud(poly, graph, { table: opt(a.table), program: opt(a.program) });
    },
    summarize: (r: { rows: unknown[]; tables: string[]; files: unknown[] }) =>
      `${r.rows.length} accessor rows over ${r.tables.length} tables; ${r.files.length} file rows.`,
  }),
  tool({
    name: "modernise_impact",
    title: "Cross-language impact",
    description:
      "Impact of changing a table, a column (TABLE.COLUMN), a data set or file, a FORTRAN COMMON block (/GRID/) " +
      "or module, a Java class or a program (COBOL, FORTRAN, PL/I): who reads or writes it across languages, " +
      "views, foreign keys, indexes, entity mappings and units sharing the COMMON block, SQL text naming the " +
      "column, and upstream callers, job steps and jobs, each with path:line.",
    input: {
      target: z
        .string()
        .min(1)
        .max(256)
        .describe(
          "EMPLOYEE, EMPLOYEE.BASE_PAY, /GRID/, SCI.HEAT.STEPLOG, PayrollService or PAYCALC.",
        ),
    },
    run(ctx, a) {
      const { poly, graph } = polyglotOf(ctx.index().index);
      return crossImpact(poly, graph, a.target);
    },
    summarize: (r: {
      query: string;
      found: boolean;
      accessors: unknown[];
      schema: unknown[];
      callers: unknown[];
      languages: string[];
    }) =>
      r.found
        ? `Impact of ${r.query}: ${r.accessors.length} accesses, ${r.schema.length} schema links, ` +
          `${r.callers.length} upstream callers (${r.languages.join(", ")}).`
        : `${r.query}: no table, column, data set, COMMON block, module, Java type or program of that name.`,
  }),
  tool({
    name: "modernise_inventory",
    title: "Java, SQL, FORTRAN and PL/I inventory",
    description:
      "Java types (kind java), SQL tables (kind sql), FORTRAN units and COMMON blocks (kind fortran) or PL/I " +
      "procedures and structures (kind pli): the list, or with name one entry in full (Java: fields, methods, " +
      "calls, table access; SQL: columns, constraints, indexes, comments; FORTRAN: declarations, COMMON " +
      "layouts, calls and callers, file I/O; PL/I: declarations, files, calls, EXEC SQL, ON-units). Every fact " +
      "at path:line.",
    input: {
      kind: z.enum(["java", "sql", "fortran", "pli"]).describe("java, sql, fortran or pli."),
      name: z
        .string()
        .max(256)
        .optional()
        .describe("A Java type, a table, a FORTRAN unit or /COMMON/ block, or a PL/I procedure."),
    },
    run: (ctx, a) => inventory(polyglotOf(ctx.index().index).poly, a.kind, opt(a.name)),
    summarize: (
      r: {
        types?: unknown[];
        tables?: unknown[];
        type?: { qualifiedName: string };
        table?: { name: string };
        units?: unknown[];
        unit?: { id: string };
        common?: { name: string };
        procedures?: unknown[];
        procedure?: { qualified: string };
      },
      a,
    ) =>
      r.type
        ? `Java type ${r.type.qualifiedName}.`
        : r.table
          ? `Table ${r.table.name}.`
          : r.unit
            ? `FORTRAN unit ${r.unit.id}.`
            : r.common
              ? `COMMON block /${r.common.name}/.`
              : r.procedure
                ? `PL/I procedure ${r.procedure.qualified}.`
                : a.kind === "java"
                  ? `${r.types?.length ?? 0} Java types.`
                  : a.kind === "fortran"
                    ? `${r.units?.length ?? 0} FORTRAN units.`
                    : a.kind === "pli"
                      ? `${r.procedures?.length ?? 0} PL/I procedures.`
                      : `${r.tables?.length ?? 0} tables and views.`,
  }),
];
