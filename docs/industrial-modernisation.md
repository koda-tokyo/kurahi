---
summary: "Industrial modernisation with Kurahi: deterministic analysers for COBOL/JCL, Java and SQL DDL, design documents (設計書) with path:line evidence, a wave plan proposal for human review, and the kurahi-legacy MCP server for engineers' editors"
read_when:
  - Evaluating Kurahi for a legacy modernisation project
  - Explaining what the analysers produce and what is still planned
  - Setting up the legacy analyser in an editor
title: "Industrial modernisation"
---

# Industrial modernisation

日本語: [産業向けモダナイゼーション](/ja/industrial-modernisation)

Modernising a legacy estate starts with knowing what the code does. Kurahi answers that from the
code itself: deterministic analysers produce the facts, every fact cites the file and line it came
from, and the agent explains those facts instead of guessing. What the code cannot tell, such as a
program's business purpose, is marked as needing confirmation and left for people to fill in.

This is the Analysis pack of the [Industrial Edition](/editions). Status as of 25 October 2026:
available in release 2.2.0.

## What is analysed

| Language or domain                        | Status  | What the analyser produces                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COBOL, copybooks and JCL                  | Active  | Paragraphs, PERFORM and CALL graphs, file, EXEC SQL and EXEC CICS access, data dictionary, rule candidates, impact                                                                                                                                                                                                                            |
| Java                                      | Active  | Classes, methods and fields with path:line, inheritance, statically resolvable calls, Spring, JPA and MyBatis mapper table access                                                                                                                                                                                                             |
| SQL DDL                                   | Active  | Tables, views and indexes, columns with types, nullability and defaults, keys and comments (ANSI, DB2, Oracle, PostgreSQL basics); stored procedures, functions and triggers with a `BEGIN ... END` body (DB2 SQL PL, Oracle PL/SQL): table access per statement, CALLs and trigger events                                                    |
| FORTRAN                                   | Active  | Program units, CALL and USE edges, COMMON blocks shared across units, INCLUDE, file I/O units bound through JCL, types and precision                                                                                                                                                                                                          |
| PL/I                                      | Active  | Procedures and CALL edges, %INCLUDE, DECLARE structures, files bound through JCL, EXEC SQL tables, ON-units                                                                                                                                                                                                                                   |
| PLC (IEC 61131-3 Structured Text)         | Active  | PROGRAM, FUNCTION_BLOCK and FUNCTION units, VAR sections, an I/O map of AT %I/%Q/%M addresses, addresses declared twice, function block instances, writes; PLCopen XML exports read the same way (Structured Text bodies; FBD/LD block calls and output/coil writes; IL/SFC bodies are gaps); vendor ladder exports are counted, not read yet |
| Batch schedulers                          | Planned | Job-definition exports are counted only                                                                                                                                                                                                                                                                                                       |
| Maintenance records, cybersecurity review | Planned | No engine                                                                                                                                                                                                                                                                                                                                     |

A planned entry never produces facts. It only reports which files it would cover, so a project
shows honestly what is outside the analysis.

Files are recognised by extension, or by content when the extension says nothing (`.txt`, no
extension, ...). A file recognised by content goes to one engine only: a COBOL program with an
embedded `EXEC SQL CREATE VIEW`, or a job with in-stream DDL under `SYSIN`, is read by the
COBOL/JCL engine, as it would be with a `.cbl` or `.jcl` extension, and not again as a DDL
script. The detection of the other engine reports these files as routed elsewhere.

Tables are one node across languages: a COBOL `EXEC SQL` table, a JPA `@Table` and a
`CREATE TABLE` of the same name are the same table, so CRUD and impact questions can be answered
across COBOL, Java and the database schema. Details and limits per language:
[Legacy analyser](/tools/legacy-analyzer).

## Design documents (設計書)

The analyser turns its facts into a design document in Japanese or English: system overview, job
flow, program specifications, data dictionary, CRUD matrix, and a coverage section with every gap
and open question. When the folder has Java or DDL, the document also gains Java class
specifications and table definitions, with a list of the stored routines whose body was read;
with PLC Structured Text, PLC program specifications with
the POU list, an I/O allocation table by %I/%Q/%M address and the variables of each POU.

A stored procedure, function or trigger with a balanced `BEGIN ... END` body becomes a routine in
the graph: each static statement links it to the tables it names (so the CRUD matrix and a table's
impact include the routine), a `CALL` links it to the routine it calls (a name with no definition
is kept and marked as not defined), and a trigger is linked from its table with its events. Dynamic
SQL (`EXECUTE IMMEDIATE`, `PREPARE`, `EXEC(...)`) and DDL inside a body are listed as gaps, never
guessed. An Oracle package body is split into its members, each a routine named
`PACKAGE.MEMBER` (`CALL pkg.member`, and a bare `CALL` to a sibling inside the package, link to
it); package-level cursors, the initialisation block and external members are gaps, and a package
whose member declares a nested subprogram stays one gap. PostgreSQL dollar-quoted bodies, package
specifications, bodies without `BEGIN` and unbalanced bodies stay one gap naming the tables they
mention. Static calls into routines from Java (JDBC, JPA, MyBatis) and from COBOL and PL/I
(`EXEC SQL CALL`) are linked too, so a table's impact reaches those callers through the routine.

When two schemas define the same table name (`HR.EMPLOYEE`, `PAYROLL.EMPLOYEE`), each schema's
table is its own node (`table:HR.EMPLOYEE`) with its own columns, under the bare-name node
`table:EMPLOYEE`. A reference that names the schema (a JPA `@Table(schema = ...)`, qualified SQL in
Java or a routine body) is linked to that schema's table; a bare reference stays on the bare-name
node, which says the name is ambiguous. The same holds for foreign keys, view sources and indexes
that name the schema, and an ALTER or COMMENT naming it changes that schema's table. The impact of one schema's table lists only its own
accessors; the impact of the bare name lists them all. Tables only one schema defines keep a
single node.

A JPA `@ManyToOne` or `@OneToOne` (the owning side, not `mappedBy`) is a `JOIN` edge from the
entity's table to the target entity's table, with its join columns (`@JoinColumn`, each column of
`@JoinColumns`, or JPA's default `FIELD_` + the target's `@Id` column). It is the mapping's claim,
compared with the DDL: a join whose owning table is in the DDL but has no matching foreign key
says "no foreign key in the DDL", and a foreign key on a table an entity maps that no relationship
uses is listed as unused by the mapping. Columns compare as a set. A unidirectional `@OneToMany`
with `@JoinColumn` joins from the target's table to the owner's. A join table (`@ManyToMany`, or
`@OneToMany` with `@JoinTable` or no join column) is two `JOIN` edges, to the owner
(`joinColumns`) and to the target (`inverseJoinColumns`), with JPA's default names when the
mapping names none (`OWNER_TARGET`; the inverse field or the owner's entity name + `_` + its `@Id`
column; `FIELD_` + the target's `@Id` column); its foreign keys are judged like an entity table's.
`mappedBy` sides add nothing: the owning side carries the join. `@SecondaryTable`, `@Inheritance`
and `@Embedded` are not modelled yet.

- **Every fact line cites `path:line`.** A reviewer can check any row against the source.
- **Nothing is invented.** A program's business purpose, and the business meaning of each rule
  candidate, are marked 要確認 (needs confirmation).
- **Deterministic.** The same sources give a byte-identical document, with a fingerprint of the
  sources it was made from.

Contents, samples and limits: [Design documents and wave plan](/tools/legacy-design-docs).

## Wave plan: a proposal for human review

The wave plan proposes an order for migrating COBOL programs: dependencies from CALLs and from data
sets passed between programs, cycles that must move together, waves, and a risk score whose formula
and source lines are printed in the plan. It is labelled as a proposal. It does not know business
priorities, team capacity, cut-over windows or the migration approach; people decide those.

## In the engineer's editor: kurahi-legacy MCP server

`kurahi legacy mcp --root <project>` serves the same analyser to VS Code, Eclipse-based mainframe
IDEs and any client that speaks the Model Context Protocol (MCP). It reads one project folder and
nothing else, is read-only, needs no running gateway, and returns facts with `path:line`. The
design document, the wave plan and the cross-language tools (`modernise_plan`, `modernise_crud`,
`modernise_impact`, `modernise_inventory`) are available there too.

Setup: [Legacy analyser in your editor (MCP)](/tools/legacy-mcp).

## How it fits the workbench

In the Project's Assets view, **Prepare design document request** and **Prepare wave plan request**
open a chat draft for the selected project in Japanese or English. Review and send the request to
run the analyser. These actions require a gateway connection, a project folder, and the
`legacy-analyzer` plugin enabled for that project. A project's explicit plugin list overrides its
template, including an empty list.

Generation writes the latest report to the analyser cache; it does not automatically create an
artifact version. Use **Save as output** on the response to preserve a draft artifact. To retain
revisions of an existing artifact, open it and save a new version. Review and approval remain
separate steps; a migration wave plan is a proposal, not permission to change the system.

In the Industrial Edition, the analysis runs inside a Project. The Project's folder is the
permission boundary, the Project's mode (read 参照, plan 計画, act 実行) limits what agents may do,
and a Project can require an approval before an artifact the agents produce counts. Commands and
other consequential actions go through the same approvals as everywhere in Kurahi
([Secure defaults](/security/secure-defaults)).
