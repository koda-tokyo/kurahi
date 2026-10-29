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

| Tool                      | What it returns                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `legacy_index`            | Parses the sources under `path` and builds the fact index; counts and diagnostics                                            |
| `legacy_query`            | Structure: callers, callees, file access, data references, job steps, paragraphs, perform graph, data sets                   |
| `legacy_rules`            | Rule candidates: conditions, arithmetic with constants, rounding, 88-level values, numeric constants, literal assignments    |
| `legacy_dictionary`       | Copybook data dictionary: level, PIC, usage, length, offset, positions, OCCURS, REDEFINES, values                            |
| `legacy_impact`           | What a change to a data item reaches, with the fact that links each entry                                                    |
| `legacy_design_doc`       | Design document (設計書) from the code, Japanese or English: see [design documents and wave plan](/tools/legacy-design-docs) |
| `legacy_wave_plan`        | Modernisation wave proposal from dependencies and metrics: see [design documents and wave plan](/tools/legacy-design-docs)   |
| `legacy_changes`          | What changed since the stored baseline, with path:line evidence: see [change detection](#change-detection)                   |
| `legacy_baseline_advance` | Moves the change-detection baseline forward (or resets it): see [change detection](#change-detection)                        |
| `modernise_plan`          | Entry point for mixed projects: detected languages, inventory per engine, shared tables, coverage, planned assistants        |
| `modernise_crud`          | CRUD of SQL tables (COBOL and PL/I EXEC SQL, Java JPA/@Query/JDBC, JCL utilities) and of files, with evidence                |
| `modernise_impact`        | What a change to a table, column, file, COMMON block, Java class or program reaches across languages and callers             |
| `modernise_inventory`     | Java types, SQL tables, FORTRAN units and COMMON blocks, or PL/I procedures: the list, or one entry in full                  |

Every fact carries `file` and `line`. Business meaning is never inferred.

The same analyser runs in engineers' own editors and IDEs as an MCP server, one project per
server: see [Legacy analyser in your editor (MCP)](/tools/legacy-mcp).

## Modernisation assistant (COBOL, Java, SQL DDL, FORTRAN, PL/I, PLC)

`modernise_plan` detects the languages of a folder (extension, then content of the first bytes),
runs every active engine and lists the assistants that have no engine. Active: COBOL/JCL, Java,
SQL DDL, FORTRAN, PL/I, PLC IEC 61131-3 (Structured Text sources and PLCopen XML exports; vendor
ladder exports are counted, not read). No engine (files are counted, nothing is analysed): batch
schedulers, maintenance records, cybersecurity review.

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
  names without `@Table` / `@Column` follow Spring Boot's default naming (camelCase to UPPER*SNAKE).
  MyBatis mapper XML (DOCTYPE or `<mapper namespace>`) is read: each `<select>` / `<insert>` /
  `<update>` / `<delete>` gives table access at its own line, bound to the method of the same name
  of the namespace interface, so callers inherit it; every dynamic branch is read (the tables are
  the union), `<include>` is expanded from `<sql>` fragments of the same file, and a `${...}`
  substitution or a fragment from another file makes the fact partial. Statements whose
  interface or method is not in the sources are listed as unbound. MyBatis annotations
  (`@Select`), `resultMap` columns and `orm.xml` are not read. No annotation processing, Lombok;
  JPQL path joins (`JOIN e.dept d`) are not mapped to tables. The owning side of `@ManyToOne` /
  `@OneToOne` (`targetEntity` or the field type) is `JavaAnalysis.relations` and a `JOIN` edge
  owner table -> target table (detail `COLS -> TARGET(REFS)`, via `@ManyToOne Type.field`; the
  target's schema as the edge's `schema`). Join columns come from `@JoinColumn` / `@JoinColumns`,
  else JPA's default `FIELD*`+ the target's single`@Id` column (`ID`when unknown), and are the
entity's column mappings too;`mappedBy`fields have no column.`compareJoinKeys`(jpa-keys.ts)
lists a join with no matching DDL foreign key (owning table in the DDL; the edge detail ends`; no foreign key in the DDL`) and a foreign key no relationship uses (table mapped by an entity
or a join table). `@OneToMany`+`@JoinColumn` is a relation on the target's table to the owner;
a join table (`@ManyToMany`, `@OneToMany`with`@JoinTable`or no join column; target from`targetEntity`or the collection's last type argument) is two relations with`joinTable: true`,
`joinColumns`to the owner and`inverseJoinColumns`to the target (JPA default names otherwise;
edge detail adds`(join table)`). Nested annotations carry the named `element`they are the
value of.`mappedBy`collections add nothing. A`@SecondaryTable`(each one in`@SecondaryTables`) is an entity table use (`via: "@SecondaryTable"`) and a relation of kind `SecondaryTable`(empty`field`) from the secondary table to the primary on its `pkJoinColumns`(default: the primary's`@Id`column, implicit); a`@Column`/`@JoinColumn`with`table =`maps that column to the secondary table. Inheritance follows the root's`@Inheritance` strategy (`SINGLE*TABLE`when not given): a`SINGLE_TABLE` subclass maps to the root's table (`via: "@Inheritance(SINGLE_TABLE) Root"`; its own `@Table` does not apply) and the root's table gets the discriminator column (`@DiscriminatorColumn`, default `DTYPE`; `discriminator: true`, empty `field`); a `JOINED`subclass keeps its own table and is a relation of kind`Inheritance`to its superclass's table on its`@PrimaryKeyJoinColumn`s (default: the superclass's `@Id`column, implicit), with a discriminator column only when`@DiscriminatorColumn`is written; every entity of a hierarchy with a discriminator column has `discriminator` on its entity table use (`root`, `column`, and `value`: its `@DiscriminatorValue`, else the entity name for a `STRING`discriminator with`implicit: true`, none for `CHAR`/`INTEGER`whose default is provider-specific;`duplicate: true` when another entity of the hierarchy has the same value, a finding in the design document); a`TABLE_PER_CLASS`subclass's table also maps its superclasses' columns. A subclass inherits the`@Id`column for default join column names. A`@MappedSuperclass`has no table: its fields,`@Id` and relationships map on each entity subclass's own table (`type`is the entity),`@AttributeOverride(s)` on the entity rename those columns, and an entity superclass above a mapped superclass is still the subclass's parent for inheritance. An embedded field (`@Embedded`, `@EmbeddedId`, or a field whose type is `@Embeddable`) maps no column itself: the embeddable's fields are the owner table's columns with `field` as a path (`location.floor`), nested embeddables recurse, `@AttributeOverride(s)` on the field or by path on the entity rename them (the outermost wins), and a to-one relation inside it is the entity's relation (`field`the path); collections inside an embeddable are not modelled. `@AssociationOverride(s)`on the entity (a mapped superclass's to-one field) or on an embedded or element-collection field (by path; the outermost wins) replace a to-one relation's join columns with its`joinColumns`; on the entity, its `joinTable` replaces a mapped superclass's to-many join table (and the key / order columns go there). An`@ElementCollection` is an entity table use of its collection table (`via: "@CollectionTable"`, or `"@ElementCollection (default name)"`for JPA's`ENTITY_FIELD`) and a relation of kind `ElementCollection`from that table to the entity's on its`joinColumns`(default:`ENTITY*`+ the entity's`@Id` column, implicit); its columns are the element's (`@Column`, else the field name; an `@Embeddable`element's fields by path), a`Map`'s `@MapKeyColumn`(default`FIELD_KEY`; for an entity key, `@MapKeyJoinColumn`, default `FIELD_KEY`, also a relation of kind `MapKey`to the key entity's table, as on a to-many`Map`'s join table) and an `@OrderColumn`(default`FIELD_ORDER`); a to-many's `Map`key and`@OrderColumn`columns map the same way on the table holding its rows (the join table, or the target's for a join-column`@OneToMany`). The design document's table definitions list every relation with the
  foreign key it matches (cited), the finding, or why it is not judged, then the foreign keys no
  mapping uses.
- **SQL DDL**: CREATE TABLE / VIEW / INDEX, ALTER TABLE ADD, COMMENT ON, DB2 LABEL ON; ANSI, DB2,
  Oracle and PostgreSQL basics. Stored procedures, triggers, sequences, grants, partitioning and
  storage clauses are listed as not modelled. Tables join across languages by bare name. When two
  explicit schemas define the same name (`HR.EMPLOYEE`, `PAYROLL.EMPLOYEE`) the bare-name table is
  modelled from the first, the second is a gap saying the name is ambiguous, not a duplicate, and
  each schema's definition is also its own graph node `table:SCHEMA.NAME` (columns
  `column:SCHEMA.NAME.COL`, a `SCHEMA` edge from the bare-name node, listed in the SQL model's
  `schemaTables`); an edge whose `schema` is one of those schemas is bound to that node. An ALTER or
  COMMENT naming one of those schemas applies to that schema's definition (the first schema's is
  also the bare-name table); one naming no schema for such a table is a gap and is never applied.
  Foreign keys (`REFERENCES PAYROLL.EMPLOYEE`), view sources and `CREATE INDEX ... ON` that name a
  schema carry it as the edge's `schema` (the SQL model keeps it as `references.schema`,
  `sourceSchemas` and `tableSchema`), so they bind to that schema's node too; the second schema's
  definition gets its own FK and VIEW edges. Such names are listed in the SQL model's `ambiguous`, and their
  graph table node carries `ambiguousSchemas` (`HR,PAYROLL`), so a COBOL, Java or PL/I edge to it
  reads as "one of these", never as a certain join. A Java edge whose source names the schema
  carries it as the edge's `schema`: `@Table(schema = "payroll")` or `@Table(name =
"payroll.employee")` on the entity (and so its repository, derived queries and JPQL), or
  `payroll.employee` in JDBC, native `@Query`, constant or MyBatis SQL when every reference to the
  table in that statement names the same schema. A bare reference has no `schema`. An unqualified
  and a qualified definition of one name are still one table (a duplicate). Quoted identifiers are folded to upper case.
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

## Change detection

`legacy_changes` `{path, since?: "baseline", limit?}` compares the current fact index with a
stored **baseline** snapshot of the same folder and reports:

- COBOL programs, copybooks, JCL jobs, SQL DDL tables, their columns and stored routines that were
  **added**, **removed** or **changed**. Programs compare by structure (paragraphs and their
  statements without comments, data items, files, COPY members), copybooks by file hash, jobs by
  their steps and DD statements, tables and columns by their definition, routines by their
  source text with whitespace normalised. A line shift alone is not a change. A changed program
  lists the paragraphs added and removed and its statement count; a changed table its columns.
- **Edges** added or removed: `CALL`, `PERFORM`, `EXEC SQL` (table and operation) and JCL `STEP`
  (`EXEC PGM=`).
- `path:line` evidence on every entry: the current source for added and changed entries, the
  baseline's (marked `(baseline)`) for removed ones. Changed and added programs carry their
  impact: callers, job steps that run them and tables they touch.

Counts are complete; the entry lists are bounded by `limit` (default 40, at most 200) with
`omitted` saying how many were left out, in a fixed order (kind, then added, removed, changed,
then name). Java, FORTRAN, PL/I and PLC sources are not compared yet.

The first run finds no baseline, creates it from the current sources and returns
`status: "baseline_created"` with the totals: nothing is reported as a change. Later runs return
`changed` or `unchanged` and `current.digest`, the snapshot they compared.

The snapshots live in the analyser cache folder, `output/.legacy-index/baseline/` of the project
(the state directory outside a project), never in the client's sources: `baseline-<id>.json`
(what the next comparison is against) and `candidate-<id>.json` (what the last comparison
computed).

The baseline moves only with `legacy_baseline_advance` `{path, snapshot?}`, which promotes the
last compared snapshot (when `snapshot` is given it must be that `current.digest`, else the call
is refused because the sources were compared again since). A change that lands between the
comparison and the advance is therefore still reported next time. The autopilot's
`legacy.baseline_advance` action calls it after the night's work item is filed
([Autopilot](/autopilot#industrial)). To reset, a person calls
`legacy_baseline_advance {path, rebuild: true}` (the baseline becomes the current sources), or
deletes `output/.legacy-index/baseline/` so the next run creates a new baseline.

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
