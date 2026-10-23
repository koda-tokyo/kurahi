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
| `modernise_crud`      | CRUD of SQL tables across COBOL EXEC SQL, Java (JPA, @Query, JDBC) and JCL utilities, with evidence                          |
| `modernise_impact`    | What a change to a table, column, Java class or program reaches across languages, schema objects and callers                 |
| `modernise_inventory` | Java types or SQL tables: the list, or one entry in full                                                                     |

Every fact carries `file` and `line`. Business meaning is never inferred.

The same analyser runs in engineers' own editors and IDEs as an MCP server, one project per
server: see [Legacy analyser in your editor (MCP)](/tools/legacy-mcp).

## Modernisation assistant (COBOL, Java, SQL DDL)

`modernise_plan` detects the languages of a folder (extension, then content of the first bytes),
runs every active engine and says which assistants are only planned. Active: COBOL/JCL, Java, SQL
DDL. Planned (files are counted, nothing is analysed): FORTRAN, PL/I, PLC IEC 61131-3 (Structured
Text, ladder exports), batch schedulers, maintenance records, cybersecurity review.

Tables are one node in the knowledge graph across languages, matched by unqualified name,
case-insensitive: a COBOL `EXEC SQL` table, a JPA `@Table` and a `CREATE TABLE` of the same name
are the same table. The design document gains Java class specifications and table definitions when
the folder has Java or DDL.

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
- **COBOL**: as above; table access comes from `EXEC SQL` text.

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
