# Process: extracting business rules

1. `legacy_index` with `path` = the project folder. Check the counts and the diagnostics.
2. `legacy_rules` with `program` (for example `PAYCALC`): the conditions, constants and arithmetic, each with `file` and `line`.
3. `legacy_query` `paragraphs` / `perform-graph` for the program, and `data-refs` for the fields in the rules, to see where each rule runs.
4. Note dates in the header and change log that change behaviour (a constant moved by a dated `IF` is two rules, one per period).
5. Write each rule as: condition, result, constants, `file:line` from step 2 or 3.
6. List open questions separately instead of guessing.
