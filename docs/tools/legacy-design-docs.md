---
summary: "Design documents and a modernisation wave plan generated from COBOL, copybooks and JCL: deterministic, every fact line cites path:line, Japanese and English, with an honest coverage report"
read_when:
  - Producing design documents for a legacy system from its code
  - Planning the order of a COBOL modernisation
  - Explaining to a client what the generated documents can and cannot tell
title: "Legacy design documents and wave plan"
---

# Legacy design documents and wave plan

Two more tools of the [legacy analyser](/tools/legacy-analyzer) turn its fact index into documents
people can review:

| Tool                | Output                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `legacy_design_doc` | A design document in Markdown, Japanese (`lang: "ja"`, the default) or English (`en`)    |
| `legacy_wave_plan`  | A proposal for the order of migration waves, with the dependencies and metrics behind it |

Both are deterministic: the same sources give a byte-identical document (no dates, no absolute
paths, a stable order). Each document records a fingerprint of the sources it was made from.

## What the design document contains

1. **System overview**: inventory of programs, copybooks and jobs with line counts,
   and a Mermaid diagram of which job step runs which program and who calls whom.
2. **Job flow**: per JCL job a Mermaid diagram of steps and data sets, the steps with
   PARM and COND, every DD with its DISP and the program file (SELECT) it binds to, and the lineage
   of each data set (which programs write it, which read it).
3. **Program specifications**: per program its basic facts, inputs and outputs
   (files, EXEC SQL tables, EXEC CICS files), CALL relations in both directions, the PERFORM
   structure from the entry paragraph, and the business-rule candidates of the rules engine with
   the conditions they run under and the declared values of the constants they use.
4. **Data dictionary**: every copybook field with level, PIC, USAGE, bytes,
   position, OCCURS, REDEFINES, VALUE and 88 values, and the programs that copy it.
5. **CRUD matrix**: program × data set, SQL table or CICS file with C/R/U/D, and an evidence table
   with the statement and the DD behind every cell.
6. **Coverage and open questions**: the files analysed, the files not
   analysed and why, parser diagnostics, and every gap found in the code (CALL targets without
   source, dynamic CALLs with the initial VALUE as a hint, missing copybooks, steps that run
   utilities, EXEC blocks that are not modelled, SELECTs without a DD and DDs without a SELECT,
   programs nothing starts, paragraphs nothing performs), followed by the analyser's limits.

When the folder also has Java, FORTRAN, PL/I or SQL DDL sources, the document gains a section per
engine (by default only when the project has those sources):

- **Java class specifications**: classes, fields with their column mapping,
  methods with resolved calls and table access.
- **FORTRAN program units**: the unit list (kind, host, IMPLICIT rule,
  calls, COMMON blocks, files), the **COMMON block map** (each unit's
  member layout with types, explicit or implicit, and whether the layouts agree), then per unit
  its declaration, USE and INCLUDE, calls (call or function reference, and how each was resolved),
  declarations and file I/O with the binding of each unit number.
- **PL/I procedure specifications**: the procedure list, **structure
  definitions** (levels, attributes, BASED / DEFINED storage, initial values, members
  from `%INCLUDE` at their own lines), **file definitions** (attributes, DD name,
  operations), then per procedure its calls, EXEC SQL, file I/O and ON-units.
- **Table definitions**: DDL tables with columns and keys, and who accesses each
  table across COBOL, Java and PL/I.

Each of these sections ends with what its engine did not model.

Every fact line (each table row and list item) cites the source as `path:line`. What code cannot
tell is never filled in: a program's business purpose is **to confirm**, and so is
the business meaning of every rule candidate. A program's header comment is quoted as written,
labelled as unverified.

Arguments: `path` (the folder), `lang` (`ja` or `en`), `section` (comma list of `overview`, `jobs`,
`programs`, `java`, `fortran`, `pli`, `dictionary`, `tables`, `crud`, `coverage`) and `program`
(one program's specification). The
tool returns the Markdown and also saves it in the analyser's cache folder
(`output/.legacy-index/design-doc-<lang>.md` in a project).

## The wave plan

`legacy_wave_plan` is labelled as a proposal for human review. It computes:

- **Dependencies**: A depends on B when A CALLs B (static CALL, or CICS LINK/XCTL with a literal
  program) or reads a data set B writes, directly or through utility steps without source such as
  SORT.
- **Cycles**: strongly connected components of the dependencies; their programs move together.
- **Waves**: a program with no dependency on other analysed programs is in wave 1, any other
  program is one wave after the latest one it depends on. Inside a wave, lower risk comes first.
- **Risk**: a points formula printed in the plan (size, decision points, GO TO, ALTER, dynamic
  and unresolved CALLs, fan-in, outputs read by other programs, SQL, CICS, missing copybooks),
  each factor with the source lines behind it. Bands: 0-3 low, 4-7 medium, 8 and above high.
- **Clusters and coupling**: programs connected by dependencies, and pairwise coupling through
  CALL sites, data sets passed and shared copybooks.

The plan does not know business priorities, team capacity, cut-over windows or the migration
approach. It also lists what is outside the plan (programs without source, dynamic CALL targets)
and the open questions that can hide a dependency.

## Knowledge graph queries

The graph behind both documents is available through `legacy_query`:

- `graph-neighbours` `{node, direction?: in|out}`: the edges of a program, data set, table,
  copybook, job or step, each with `file` and `line`.
- `call-chains` `{program, direction?: down|up}`: every CALL path from (or to) a program; a repeat
  is marked as a cycle.
- `lineage` `{dataset}`: the producers upstream and the consumers downstream of a data set, SQL
  table or CICS file, through utility steps.

## Word output

`legacy_design_doc` takes `output_format: "md" | "docx"` (default `md`). With `docx` the same
Markdown is also converted, deterministically, into a Word document: headings, paragraphs, block
quotes, bullet and numbered lists, tables (cell line breaks kept), and Mermaid diagrams as
preformatted source; Japanese or English by `lang`, with Japanese fonts and proofing language for
`ja`. The file is written into the Project's `output/design-docs/` as `design-doc_<YYYYMMDD>.docx`
(Japanese: `設計書_<YYYYMMDD>.docx`), never over an existing file: a taken name gets `-2`,
`-3` and so on. The tool result names the file (`details.path`).

The Word file needs a Project session in Plan or Act mode and follows the
[office tools](/tools/office)' path guards (a folder the mode makes writable, no symbolic links,
nothing outside the Project). Both use one shared renderer (`src/office/`), so Word output works
without the office plugin being enabled.

## Command line

```bash
node --import tsx packages/legacy-analyzer/src/cli.ts design-doc <folder> --lang ja --out design-doc.ja.md
node --import tsx packages/legacy-analyzer/src/cli.ts wave-plan <folder> --lang en --out wave-plan.en.md
```

Without `--out` the Markdown goes to standard output. `--section` and `--program` narrow the
design document.

## Samples

Generated from the fictional payroll demo pack (4 programs, 2 copybooks, 1 job) and committed
unchanged: `packages/legacy-analyzer/examples/payroll-demo/` holds `design-doc.ja.md`,
`design-doc.en.md`, `wave-plan.ja.md` and `wave-plan.en.md`.

## Limits

The documents are only as complete as the static analysis. They say so in their coverage section;
in short:

- **Static only.** Run-time values are unknown: the target of a dynamic CALL (the data item's
  initial VALUE is shown as a hint only), data set names built at run time, PARM values.
- **COBOL dialects.** Fixed and free format COBOL-85 with common later extensions. Vendor-specific
  syntax, `REPLACE` and conditional compilation are analysed as written or reported in the
  diagnostics. Lengths ignore SYNCHRONIZED alignment; OCCURS DEPENDING ON uses the maximum.
- **EXEC SQL.** Table names and the first keyword only (SELECT/DECLARE/FETCH = R, INSERT = C,
  UPDATE = U, DELETE = D). Dynamic SQL targets are unknown; `EXEC SQL INCLUDE` members are not
  expanded and are listed as not modelled. EXEC SQL in the DATA DIVISION (DECLARE TABLE, INCLUDE)
  is reported, not analysed.
- **EXEC CICS.** File commands with a literal FILE or DATASET, and LINK/XCTL with a literal
  PROGRAM. BMS maps, queues, START/RETURN TRANSID and channels are not modelled; a command with a
  variable FILE or PROGRAM is listed as an open question.
- **JCL.** JOB, EXEC, DD, SET, PROC/PEND and symbols. JCL IF/THEN/ELSE, INCLUDE, cataloged
  procedures without source and scheduler dependencies between jobs are not analysed. A step that
  runs a program without source gets its CRUD from DISP alone, and DISP=OLD is shown as `?`.
- **CRUD from statements.** A file that is only OPENed, never read or written, does not appear in
  the matrix (its OPEN mode is in the program specification).
- **Not analysed:** IMS DL/I, assembler, REXX/CLIST, utility control statements, scheduler
  definitions. The limits of the Java, SQL DDL, FORTRAN and PL/I engines are in
  [the legacy analyser](/tools/legacy-analyzer).
- **Diagrams.** Mermaid source is generated from the graph; each arrow is also listed with its
  source lines in a table next to it.
