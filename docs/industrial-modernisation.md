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

This is the Analysis pack of the [Industrial Edition](/editions). Status as of 23 October 2026:
in the development line after release 2.0.3, not yet in a published release.


## What is analysed

| Language or domain                                | Status  | What the analyser produces                                                                                                        |
| ------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| COBOL, copybooks and JCL                          | Active  | Paragraphs, PERFORM and CALL graphs, file, EXEC SQL and EXEC CICS access, data dictionary, rule candidates, impact                |
| Java                                              | Active  | Classes, methods and fields with path:line, inheritance, statically resolvable calls, Spring and JPA annotations, table access    |
| SQL DDL                                           | Active  | Tables, views and indexes, columns with types, nullability and defaults, keys and comments (ANSI, DB2, Oracle, PostgreSQL basics) |
| FORTRAN                                           | Planned | Files are counted only; nothing is analysed                                                                                       |
| PL/I                                              | Planned | Files are counted only; nothing is analysed                                                                                       |
| PLC (IEC 61131-3 Structured Text, ladder exports) | Planned | Files are counted only; nothing is analysed                                                                                       |
| Batch schedulers                                  | Planned | Job-definition exports are counted only                                                                                           |
| Maintenance records, cybersecurity review         | Planned | No engine                                                                                                                         |

A planned entry never produces facts. It only reports which files it would cover, so a project
shows honestly what is outside the analysis.

Tables are one node across languages: a COBOL `EXEC SQL` table, a JPA `@Table` and a
`CREATE TABLE` of the same name are the same table, so CRUD and impact questions can be answered
across COBOL, Java and the database schema. Details and limits per language:
[Legacy analyser](/tools/legacy-analyzer).

## Design documents (設計書)

The analyser turns its facts into a design document in Japanese or English: system overview, job
flow, program specifications, data dictionary, CRUD matrix, and a coverage section with every gap
and open question. When the folder has Java or DDL, the document also gains Java class
specifications and table definitions.

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

In the Industrial Edition, the analysis runs inside a Project. The Project's folder is the
permission boundary, the Project's mode (read 参照, plan 計画, act 実行) limits what agents may do,
and a Project can require an approval before an artifact the agents produce counts. Commands and
other consequential actions go through the same approvals as everywhere in Kurahi
([Secure defaults](/security/secure-defaults)).

