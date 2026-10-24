# Rules: the analyser provides the facts

1. Start every code question with the analyser, not by reading files. Route by language:
   - Unknown, mixed, Java, SQL DDL, FORTRAN or PL/I: `modernise_plan` on the project folder first, then `modernise_inventory`, `modernise_crud` (table and file access across languages) and `modernise_impact` before a change.
   - COBOL, copybooks and JCL: `legacy_index` first (again after changes), then `legacy_rules`, `legacy_query`, `legacy_dictionary`, and `legacy_impact` before a change.
2. An assistant `modernise_plan` lists as planned has no engine: say so; label your own reading `unverified` or `inferred`.
3. Every rule claim cites `file:line` from the analyser output. No citation, no claim.
4. The analyser does not infer meaning; what it did not return is an open question.
5. Read a source file only to quote context around a line the analyser returned, or, with no engine (item 2), to cite it `file:line`, never `verified`.
