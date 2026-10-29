# Kurahi Industrial Edition

Status: first product configuration, 2026-10-23

## Product model

Kurahi Industrial Edition begins with one Project-scoped assistant role: **Industrial Modernization
Engineer**. The role covers COBOL/JCL, FORTRAN, PL/I, Java, databases, PLC code, batch scheduling,
maintenance and cybersecurity through one controlled lifecycle:

`discover -> map dependencies -> assess risk -> design target -> transform -> validate -> approve`

This is one model experience operating an agent workforce through multiple scoped sessions and
evidence adapters. Agents perform the work: discovery, analysis, transformation, testing,
documentation, operation, monitoring and rollback. Deterministic tools, compilers, databases,
schedulers, PLC exports, maintenance systems and approved security scanners provide domain facts.
The UI always distinguishes model inference from tool-verified evidence.

## Autonomy objective

Industrial Edition is built to replace routine human execution with accountable agent operation.
People define objectives, legal authority, safety intent, risk budgets and acceptance criteria.
Agents own the workflow inside those boundaries and escalate only when evidence is insufficient or
a policy, law, safety case or irreversible physical effect requires a named authority.

The operating target is **99.99% agent execution of eligible workflow actions**. This is a target,
not a launch claim. Kurahi calculates it from signed timeline events and shows the measured value,
excluded actions and human interventions. Safety, legal and irreversible authority gates are
classified separately rather than hidden to improve the percentage.

The same model can run several isolated roles under one coordinator:

1. Estate mapper
2. Dependency and business-rule analyst
3. Transformation engineer
4. Data and batch migration engineer
5. Controls and maintenance engineer
6. Cybersecurity engineer
7. Independent validation and release agent

No role can approve its own evidence. The independent validation agent checks provenance, tests,
policy, risk and rollback before autonomous release within the delegated envelope.

## First configuration

The existing Project template id `industry-legacy-modernisation` is retained for compatibility and
presented as `Industrial: system modernisation` / `産業：システム刷新`.

- Project source, data and documentation remain read-only.
- Draft plans and outputs are written only to Project-controlled locations.
- Artifacts require independent agent validation; policy can require a named authority.
- Project mode is visible as Read / Plan / Act.
- Consequential operations require on-screen approval with impact, validation and rollback.
- No AI vendor or foundation-model name appears in product copy.

## Capability truth at first release

| Domain                | Initial status                   | Evidence path                                                                                         |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| COBOL, copybooks, JCL | Deterministic analyser available | `legacy_index`, `legacy_query`, `legacy_rules`, `legacy_dictionary`, `legacy_impact` with `file:line` |
| FORTRAN               | Deterministic analyser available | `modernise_plan`, `modernise_inventory`, `modernise_crud`, `modernise_impact` with `file:line`        |
| PL/I                  | Deterministic analyser available | `modernise_plan`, `modernise_inventory`, `modernise_crud`, `modernise_impact` with `file:line`        |
| Java                  | Deterministic analyser available | `modernise_plan`, `modernise_inventory`, `modernise_crud`, `modernise_impact` with `file:line`        |
| Databases             | Evidence-led workflow            | approved schema, query plans, procedures, reconciliation output                                       |
| Batch scheduling      | Evidence-led workflow            | approved job definitions, calendars, dependencies and run history                                     |
| PLC code              | Controlled-validation workflow   | approved exports, tag/alarm data, manuals and offline validation                                      |
| Maintenance           | Evidence-led workflow            | approved work orders, manuals, history and condition data                                             |
| Cybersecurity         | Authorized-scope workflow        | approved configuration, inventory, findings and remediation evidence                                  |

The product must not label an evidence-led workflow as deterministic or operationally connected.
Each connector and analyser reports `Active`, `Configured, not verified`, `Disabled`, `Planned` or
an equally explicit capability status.

## Primary screens

1. **Estate** — systems, applications, jobs, databases, assets and their evidence freshness.
2. **Dependencies** — calls, data flows, job chains, interfaces, equipment and trust boundaries.
3. **Workbench** — chat, Project terminal, files, voice and specialized domain presets.
4. **Timeline** — commands, tools, evidence collection, delegation, approvals and failures.
5. **Artifacts** — inventories, rule catalogues, dictionaries, dependency maps, risk assessments,
   target designs, transformations, tests, runbooks and approved exports.
6. **Assurance** — validation coverage, equivalence results, cyber findings, open risks and release
   approvals.

## Required Artifact chain

Every modernization engagement should be able to produce this ordered set:

1. Estate inventory and capability/evidence coverage
2. Current-state dependency map
3. Business-rule and operational-constraint catalogue
4. Risk and criticality assessment
5. Target architecture and migration waves
6. Transformation drafts and compatibility contracts
7. Equivalence, reconciliation, performance, recovery and security evidence
8. Approved release and rollback record

Each Artifact retains its Project, version, producing agent, independent validator, authority status,
source evidence, timestamp and export hash.

## Autonomy levels

| Level | Agent authority |
| --- | --- |
| Observe | Read and map evidence; no changes |
| Plan | Produce plans, simulations and Artifacts |
| Execute | Apply reversible changes inside the Project boundary and validate them |
| Operate | Run approved workflows, monitor results and roll back automatically |
| Controlled | Cross a legal, safety or irreversible physical boundary after required authorization |

Kurahi itself is the first production user. The internal adoption and validation sequence is defined
in `AUTONOMY_DOGFOOD_PLAN.md`.

## Release-one boundary

Release one delivers the Industrial configuration, the common modernization lifecycle, the
COBOL/JCL deterministic path, truthful presets for the other domains, Project terminal, run
timeline, Artifacts and JA/EN push-to-talk controls. Additional deterministic analysers arrive as
separate adapters and must pass domain fixtures before their status becomes Active.
