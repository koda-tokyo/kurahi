---
summary: "Legacy analyser tools (COBOL, copybooks, JCL, Java, SQL DDL): enabled per project by the industry/legacy template, read-only, every fact with file:line"
read_when:
  - Working on a legacy modernisation project
  - Enabling the legacy analyser outside a project
title: "Legacy analyser"
---

# Legacy analyser

Read-only tools over deterministic analysers for COBOL, copybooks and JCL, Java and SQL DDL
(`packages/legacy-analyzer`, plugin `extensions/legacy-analyzer`). The analysers provide the
facts; the model explains them. Overview: [Industrial modernisation](/industrial-modernisation).

| Tool                  | What it returns                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `legacy_index`        | Parses the sources under `path` and builds the fact index; counts and diagnostics                                            |
| `legacy_query`        | Structure: callers, callees, file access, data references, job steps, paragraphs, perform graph, data sets                   |
| `legacy_rules`        | Rule candidates: conditions, arithmetic with constants, rounding, 88-level values, numeric constants, literal assignments    |
| `legacy_dictionary`   | Copybook data dictionary: level, PIC, usage, length, offset, positions, OCCURS, REDEFINES, values                            |
| `legacy_impact`       | What a change to a data item reaches, with the fact that links each entry                                                    |
| `legacy_design_doc`   | Design document (設計書) from the code, Japanese or English: see [design documents and wave plan](/tools/legacy-design-docs) |
| `legacy_wave_plan`    | Modernisation wave proposal from dependencies and metrics: see [design documents and wave plan](/tools/legacy-design-docs)   |
| `modernise_plan`      | Entry point for mixed projects: detected languages, inventory per engine, shared tables, coverage, planned assistants        |
| `modernise_crud`      | CRUD of SQL tables (COBOL and PL/I EXEC SQL, Java JPA/@Query/JDBC, JCL utilities) and of files, with evidence                |
| `modernise_impact`    | What a change to a table, column, file, COMMON block, Java class or program reaches across languages and callers             |
| `modernise_inventory` | Java types, SQL tables, FORTRAN units and COMMON blocks, or PL/I procedures: the list, or one entry in full                  |

Every fact carries `file` and `line`. Business meaning is never inferred.

The same analyser runs in engineers' own editors and IDEs as an MCP server, one project per
server: see [Legacy analyser in your editor (MCP)](/tools/legacy-mcp).

## Modernisation assistant (COBOL, Java, SQL DDL, FORTRAN, PL/I)

`modernise_plan` detects the languages of a folder (extension, then content of the first bytes),
runs every active engine and says which assistants are only planned. Active: COBOL/JCL, Java, SQL
DDL, FORTRAN, PL/I. Planned (files are counted, nothing is analysed): PLC IEC 61131-3 (Structured
Text, ladder exports), batch schedulers, maintenance records, cybersecurity review.

Tables are one node in the knowledge graph across languages, matched by unqualified name,
case-insensitive: a COBOL or PL/I `EXEC SQL` table, a JPA `@Table` and a `CREATE TABLE` of the
same name are the same table. Programs meet by name the same way: a JCL `EXEC PGM=`, a COBOL
`CALL` and a FORTRAN or PL/I `CALL` of one name are one program, so a PL/I batch calling a COBOL
routine, or a step running a FORTRAN program, is one path in the graph. The design document gains
Java class specifications, FORTRAN program units (with the COMMON block map), PL/I procedure
specifications and table definitions when the folder has those sources.

FORTRAN `INCLUDE` and PL/I `%INCLUDE` members are looked up among all files of the folder by file
or member name, case-insensitive, the including file's folder first.

Limits:

- **Java**: declarations are parsed without a compiler. Calls are linked only when the receiver's
  declared type is in the sources (same class, supertypes, static imports, fields, parameters,
  type names, fully qualified names); calls on local variables, expressions and library types are
  listed as unresolved, overloads are matched by argument count only. Anonymous and local classes,
  initializer blocks and enum constant bodies are reported, not modelled. SQL is read from string
  literals, text blocks and `String` constants; SQL built from variables is marked partial. JPA
  names without `@Table` / `@Column` follow Spring Boot's default naming (camelCase to UPPER_SNAKE).
  No annotation processing, Lombok, XML mappings (MyBatis, `orm.xml`); JPQL path joins (`JOIN e.dept d`) are
  not mapped to tables.
- **SQL DDL**: CREATE TABLE / VIEW / INDEX, ALTER TABLE ADD, COMMENT ON, DB2 LABEL ON; ANSI, DB2,
  Oracle and PostgreSQL basics. Stored procedures, triggers, sequences, grants, partitioning and
  storage clauses are listed as not modelled. Names lose their schema, so two schemas with the same
  table name are merged (the second definition is reported as a duplicate). Quoted identifiers are
  folded to upper case.
- **FORTRAN**: fixed form (FORTRAN 66/77, columns 1-72, DEC tab format) and free form (Fortran 90
  and later). Units, USE, INCLUDE (one level: an include inside an include is not followed),
  COMMON, EQUIVALENCE (listed), declarations with `REAL*8` / `KIND` types and the IMPLICIT rule
  (the default I-N rule when none is written). COMMON layouts are compared across units by type
  and size (`DOUBLE PRECISION` equals `REAL*8`, dimensions given by PARAMETER constants compare by
  value; other KIND values and default sizes are compiler-specific and compared as written). A
  name with an argument list is a function reference only when a FUNCTION of that name is in
  scope and the name is not an array or character variable of the unit; statement functions and
  generic interfaces are not resolved. I/O units are bound to the `FILE=` literal of an `OPEN` on
  the same unit number (the same unit, else the only one in the project); without `OPEN`, to the
  mainframe DD name `FTnnF001` of the steps whose program reaches the unit through static calls.
  Units in variables, `FILE=` expressions and units opened with several files are listed as
  unresolved. Not modelled, reported: preprocessor lines (`#ifdef`: every branch is read),
  computed and assigned `GO TO`, arithmetic `IF`, `ENTRY` (calls to the entry name are linked to
  its unit), alternate returns, Cray pointers, `EXEC SQL`, `SUBMODULE`. Interface blocks and
  derived type definitions are skipped; type-bound procedures, `BLOCK` constructs and coarrays are
  not analysed.
- **PL/I**: procedures with `OPTIONS(MAIN)` and nested internal procedures, END matching over
  DO / BEGIN / SELECT groups (END with a label closes the inner groups). DECLARE: levels,
  factored names, data attributes, BASED / DEFINED / STATIC / CONTROLLED, INIT; FILE and ENTRY
  declarations. CALL is resolved to internal procedures in scope, external procedures of the PL/I
  sources, then by name to any program of the project; CALL through ENTRY variables and function
  references are not resolved. Record and stream I/O bind to the DD named by the `OPEN` TITLE
  literal, else the file name (names longer than 8 characters are not truncated). `EXEC SQL`
  tables per procedure; cursors through `DECLARE CURSOR`. Sequence numbers in columns 73-80 are
  detected and ignored. Not modelled, reported: macro statements (`%IF`, `%DO`, `%DECLARE`, `%name
=`: not evaluated, the code of every branch is read), `FETCH` / `RELEASE`, secondary `ENTRY`
  points, `EXEC CICS` / `EXEC DLI`, dynamic SQL, `EXEC SQL INCLUDE` other than SQLCA / SQLDA.
  LIKE, DEFAULT and `%INCLUDE` inside an include member are not expanded.
- **COBOL**: as above; table access comes from `EXEC SQL` text. A FORTRAN include stored with a
  `.inc` extension is also read by the COBOL index as a copybook.

## Enabled per project, not for the gateway

The plugin is off for the gateway. Projects made from the **Industry: legacy modernisation**
template get it for that project only: the template lists `"plugins": ["legacy-analyzer"]`, the
project records it, and the tools are added to that project's sessions alone (a private plugin
registry, `loadScopedKoLoPlugins` in `src/plugins/loader.ts`). Projects made from that template
before projects carried a plugin list get it from their template.

Only bundled plugins whose manifest says `"projectScope": true` can be enabled this way, and only
tool-only plugins. A config that blocks the plugin (`plugins.enabled: false`, `plugins.deny`, an
allowlist without it, `plugins.entries.legacy-analyzer.enabled: false`) wins over the template.
A tool profile with an allowlist (`tools.profile`) filters these tools like any plugin tool; add
them with `tools.alsoAllow`.

To use the analyser outside projects, enable it for the gateway:
`kurahi config set plugins.entries.legacy-analyzer.enabled true`.

## Modes and scope

The tools are reads: the project guard classifies each call as a read of its `path`. They are
available in all three project modes (参照 Read, 計画 Plan, 実行 Act), reach only the project
folder, and never an excluded folder such as `_answer-keys` (the indexer also never enters it).
The analyser's only write is its own cache folder, `output/.legacy-index/` inside the project: the
index, and the latest design document and wave plan.
Pass the project folder as an absolute `path`; relative paths resolve against the agent workspace,
the same directory the guard uses.

## How the agent is told to use it

The template's engineering pack (`templates/projects/packs/industry-legacy-modernisation/`) and
the project context make the order explicit: `legacy_index` on the project folder first, then
`legacy_query` and `legacy_rules` (and `legacy_dictionary`, `legacy_impact`), and every rule claim
cites `file:line` from the analyser output.

Test: `pnpm exec vitest run --config vitest.e2e.config.ts src/projects/legacy-template.e2e.test.ts`
(creates a project from the template against a temporary copy of the demo pack and checks the
PAYCALC overtime constants come back with `file:line`; skipped when the pack is not present).
