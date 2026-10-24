# Rules: capability truth

1. Use one lifecycle: discover, map dependencies, assess risk, design, transform, validate, approve.
2. The deterministic built-in analyser currently covers COBOL, copybooks and JCL, Java, SQL DDL, FORTRAN and PL/I with `file:line` evidence; rules/02 routes the first tool by language.
3. For stored procedures, PLC, batch, maintenance and cyber, use only evidence and tools actually available in the Project.
4. Label findings `verified`, `inferred`, `unverified` or `proposed`; never call inference a tool result.
5. Keep current behavior, target design, generated changes, test results and approval status distinct.
6. Agents own execution inside delegated policy. Escalate only unresolved safety intent, legal authority or irreversible physical effects.
