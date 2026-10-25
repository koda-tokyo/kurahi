import { Type, type TSchema } from "@sinclair/typebox";
import {
  legacyCrossCrud,
  legacyCrossImpact,
  legacyInventory,
  legacyModernisePlan,
} from "../../packages/legacy-analyzer/src/index.js";
import { failure, result, str } from "./results.js";

// Modernisation-assistant tools of the plugin: the entry point (modernise_plan) and the
// cross-language CRUD, impact and inventory over COBOL/JCL, Java, SQL DDL, FORTRAN and PL/I.
// Read-only, like the legacy_* tools; the only writes are the analyser's index cache.

type Deps = {
  root: (params: Record<string, unknown>) => string;
  pathParam: TSchema;
  env: { stateDir: string };
};

export function moderniseTools({ root, pathParam, env }: Deps) {
  const run =
    (fn: (params: Record<string, unknown>) => unknown) =>
    async (_id: string, params: Record<string, unknown>) => {
      try {
        return result(fn(params));
      } catch (err) {
        return failure(err);
      }
    };
  return [
    {
      name: "modernise_plan",
      label: "Modernisation plan",
      description:
        "Start here for a legacy modernisation: detects the languages of a folder (extension and content), runs the " +
        "active engines (COBOL/JCL, Java, SQL DDL, FORTRAN, PL/I) and returns the combined inventory, the tables shared " +
        "across languages with their CRUD, coverage (constructs not modelled, calls not resolved, DDL statements skipped, " +
        "FORTRAN I/O units not bound and COMMON layouts that differ, PL/I macros) and the planned assistants (PLC " +
        "IEC 61131-3, batch schedulers, maintenance, cybersecurity) with the files they would cover. Planned assistants " +
        "analyse nothing: say so, never present their output as available.",
      parameters: Type.Object({ path: pathParam }),
      execute: run((p) => legacyModernisePlan(root(p), env)),
    },
    {
      name: "modernise_crud",
      label: "Cross-language CRUD",
      description:
        "CRUD of SQL tables across COBOL and PL/I (EXEC SQL), Java (JPA repositories, @Query, JDBC literals and " +
        "constants) and JCL utilities: one row per program or class and table, each operation with its evidence at " +
        "path:line; files lists the same for data sets and files (COBOL, FORTRAN, PL/I). Optional table (or file " +
        "name) and program (COBOL program, FORTRAN unit, PL/I procedure or Java class) filters.",
      parameters: Type.Object({
        path: pathParam,
        table: Type.Optional(Type.String()),
        program: Type.Optional(Type.String()),
      }),
      execute: run((p) =>
        legacyCrossCrud(
          root(p),
          { table: str(p.table) || undefined, program: str(p.program) || undefined },
          env,
        ),
      ),
    },
    {
      name: "modernise_impact",
      label: "Cross-language impact",
      description:
        "Impact of changing a table, a column (TABLE.COLUMN), a data set or file, a FORTRAN COMMON block (/NAME/) or " +
        "module, a Java class or a program (COBOL, FORTRAN, PL/I): who reads or writes it in any language, views, " +
        "foreign keys, indexes, JPA mappings and units sharing the COMMON block, SQL text naming the column, and " +
        "upstream Java callers, CALL callers in any language, job steps and jobs. Every entry carries path:line.",
      parameters: Type.Object({ path: pathParam, target: Type.String() }),
      execute: run((p) => legacyCrossImpact(root(p), str(p.target), env)),
    },
    {
      name: "modernise_inventory",
      label: "Java, SQL, FORTRAN, PL/I and PLC inventory",
      description:
        "Java types (kind java), SQL tables and views (kind sql), FORTRAN units and COMMON blocks (kind fortran) or " +
        "PL/I procedures and structures (kind pli) or PLC POUs and the I/O map (kind plc): the list, or with name one entry in full (Java: annotations, " +
        "fields, methods, calls, table access; SQL: columns with type, NULL, default and comment, constraints, " +
        "indexes; FORTRAN: declarations, COMMON layouts, calls and callers, file I/O; PL/I: declarations, files, " +
        "calls, EXEC SQL, ON-units; PLC: variables, instances, calls, writes, or a %I/%Q/%M address). " +
        "Every fact at path:line.",
      parameters: Type.Object({
        path: pathParam,
        kind: Type.String({ description: "java, sql, fortran, pli or plc" }),
        name: Type.Optional(Type.String()),
      }),
      execute: run((p) => {
        const kind = str(p.kind);
        if (
          kind !== "java" &&
          kind !== "sql" &&
          kind !== "fortran" &&
          kind !== "pli" &&
          kind !== "plc"
        ) {
          throw new Error('kind must be "java", "sql", "fortran", "pli" or "plc".');
        }
        return legacyInventory(root(p), kind, str(p.name) || undefined, env);
      }),
    },
  ];
}
