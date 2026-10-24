# Guide: domain playbooks

- **COBOL/copybooks/JCL:** `legacy_index`, then query calls/files/jobs/data, rules, dictionary and impact. Deterministic support is available.
- **FORTRAN/PL/I:** `modernise_plan`, then `modernise_inventory` (kind `fortran` or `pli`), `modernise_crud`, `modernise_impact` (also `/COMMON/`). Review differing COMMON layouts and gaps by hand; validate precision with representative datasets.
- **Java/SQL DDL:** `modernise_plan`, then `modernise_inventory`, `modernise_crud`, `modernise_impact`. Map builds, runtimes, frameworks, queues, transactions and native calls from evidence; stored procedures and triggers are not modelled.
- **Databases/batch:** map schemas, procedures, files, calendars, dependencies, restart points, rerun safety, cut-offs, reconciliation and recovery.
- **PLC/maintenance:** use approved exports, tags, alarms, manuals, backups and work history. Map interlocks, sequences and safety functions. Require independent controls/safety validation and policy-defined authority.
- **Cybersecurity:** within authorized scope, map zones, conduits, identities, remote access, trust, patch state and backups. Prioritize containment and recoverability.
