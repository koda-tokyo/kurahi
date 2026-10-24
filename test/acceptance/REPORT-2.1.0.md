# Kurahi 2.1.0 Industrial Edition: acceptance report

- Generated: 2026-10-24T05:46:34.147Z
- Product build under test: kurahi 2.1.0 (dist/, commit 4375a0f27c)
- Host: linux x64, node v22.18.0
- Test: test/acceptance/industrial-edition.e2e.test.ts (scripts/acceptance-industrial.sh)
- Result: 6/6 steps passed

| Step | Result | Time |
| --- | --- | --- |
| 1. Install: kurahi init (secure defaults), Industrial edition, gateway start | PASS | 8.8 s |
| 2. Industrial project from the legacy modernisation template, plan mode (計画) | PASS | 26 ms |
| 3. Analyser tools (MCP stdio + agent tool layer; /tools/invoke probed): citations, five languages, determinism | PASS | 10.0 s |
| 4. Design document saved as an Artifact, exported, .sha256 sidecar verified | PASS | 52 ms |
| 5. Terminal broker: plan/act/read modes, approvals, file.diff, audit chain | PASS | 4.8 s |
| 6. Security defaults and family-internal check on the built dist | PASS | 9.7 s |

## Step 1: Install: kurahi init (secure defaults), Industrial edition, gateway start

Result: **PASS** (8.8 s)

- `kurahi init --non-interactive --name acme` exit 0; 9 secure defaults applied, 0 legacy: auth.grants.acme=["*"], auth.isolation=explicit, agents.defaults.sandbox.mode=non-main, tools.exec.unsandboxed=approve, integrity.supplyChain.mode=enforce, memory.provenance.mode=enforce, agents.messaging.signing.mode=enforce, console.terminal.enabled=true, console.terminal.actApprovals=always
- gateway token file created with mode 600; signed starter policy installed
- edition manifest `industrial` (sku kurahi-industrial) → workspace `industrial` (navigation: overview, estate, modernize, operate, timeline, artifacts); packs: analysis, modernisation, controls, maintenance, cybersecurity
- gateway listening on 127.0.0.1:18960 after 3.5 s; /health status `healthy`, version 2.1.0
- gateway log: `policy gate: starter loaded (signed, mode enforce)`
- operator connected over WebSocket with the gateway token
- authenticated /health: status `healthy`, auth `ok` (local model ollama/qwen2.5:1.5b, no credential needed), readiness `gateway_ready`, integrity "ok"

## Step 2: Industrial project from the legacy modernisation template, plan mode (計画)

Result: **PASS** (26 ms)

- source tree materialised from payroll-poly + sci-batch fixtures: .cbl×3, .jcl×2, .sql×2, .ddl×1, .java×7, .f90×3, .st×1, .txt×1, .f×2, .cmn×1, .pli×1, .plinc×1
- template `industry-legacy-modernisation` (産業：システム刷新 / Industrial: system modernisation) → project p3jh862q69u, mode `plan` (計画), plugins [legacy-analyzer], folders plans/ and output/ created

## Step 3: Analyser tools (MCP stdio + agent tool layer; /tools/invoke probed): citations, five languages, determinism

Result: **PASS** (10.0 s)

- gateway `POST /tools/invoke` modernise_plan with the project session key: HTTP 404 (Tool not available: modernise_plan)
- `kurahi legacy mcp --root <project>` (stdio, built CLI) lists 12 tools: legacy_index_status, legacy_index_build, legacy_query, legacy_rules, legacy_dictionary, legacy_impact, legacy_design_doc, legacy_wave_plan, modernise_plan, modernise_crud, modernise_impact, modernise_inventory
- `modernise_plan`: 1 page(s), 12724 bytes, 21 distinct path:line citations, byte-identical across two server processes (sha256 49b33fba0e32), 47 ms
- `legacy_design_doc` {"lang":"ja"}: 2 page(s), 60894 bytes, 220 distinct path:line citations, byte-identical across two server processes (sha256 9fc9923b8db2), 69 ms
- `legacy_design_doc` {"lang":"en"}: 2 page(s), 69234 bytes, 220 distinct path:line citations, byte-identical across two server processes (sha256 da5f758a4b32), 59 ms
- `legacy_wave_plan` {"lang":"en"}: 1 page(s), 12816 bytes, 23 distinct path:line citations, byte-identical across two server processes (sha256 f4d82e94eac6), 7 ms
- `modernise_crud`: 1 page(s), 8113 bytes, 25 distinct path:line citations, byte-identical across two server processes (sha256 397f0eb2c9fe), 9 ms
- `modernise_impact` {"target":"EMPLOYEE"}: 1 page(s), 5258 bytes, 17 distinct path:line citations, byte-identical across two server processes (sha256 a316e3a61a59), 8 ms
- modernise_plan languages: cobol=active(5 files), java=active(7 files), sql-ddl=active(3 files), fortran=active(5 files), pli=active(2 files), plc-iec61131=planned; coverage keys: cobol, java, sql, fortran, pli, unreadFiles, scanPartial
- legacy_design_doc ja: 10 sections (overview, jobs, programs, java, fortran, pli, dictionary, tables, crud, coverage), 58788 chars, 0 uncited fact lines; coverage section 2028 chars
- legacy_design_doc en: 10 sections (overview, jobs, programs, java, fortran, pli, dictionary, tables, crud, coverage), 67100 chars, 0 uncited fact lines; coverage section 3044 chars
- legacy_wave_plan en: 1 wave(s), "Proposal for human review" banner present
- modernise_crud: 14 rows over 7 tables, languages COBOL, Java, PL/I; every row carries path:line evidence
- modernise_impact EMPLOYEE: found, 8 accessors across COBOL, JCL, Java, SQL
- agent tool layer (createKoLoCodingTools, project session key, plan mode): all 11 analyser tools present; modernise_plan languages match the MCP server's

## Step 4: Design document saved as an Artifact, exported, .sha256 sidecar verified

Result: **PASS** (52 ms)

- artifacts.save → a84d06730844d v1 draft, 70352 bytes, stored sha256 f186653ff25c8ada = sha256 of the tool output
- draft → review by the author; approval by the author refused ("approval needs a different user"); approved by a second device identity
- exported 設計書-payroll-estate-(ja)-v1.md (70489 bytes) + 設計書-payroll-estate-(ja)-v1.md.sha256; `sha256sum -c`: 設計書-payroll-estate-(ja)-v1.md: OK
- after appending a line to the export, `sha256sum -c` fails (exit 1)

## Step 5: Terminal broker: plan/act/read modes, approvals, file.diff, audit chain

Result: **PASS** (4.8 s)

- terminal.open in plan mode → session 36e7b800…, mode plan, sandboxed false
- plan: `ls source` ran without approval, exit 0, output lists cobol/ …, no file.diff
- plan: `touch output/plan-note.txt` → approval.requested (risk {"code":"writes-files","params":{"count":1}}), exec.approval.requested broadcast; denied via exec.approval.resolve → approval.resolved deny, nothing ran, file not created
- plan: `touch source/cobol/NEW.cbl` (template read-only folder) → refused (read-only-path)
- act: `rm output/old-report.txt` → approval.requested (risks deletes-files); after 1 s the file still exists and no exit event
- approved (allow-once) via exec.approval.resolve; ran in 54 ms, exit 0, file removed; file.diff 58678045…: output/old-report.txt deleted -2; terminal.diff returns the removed lines
- audit log: terminal.command (decision approve) → terminal.approval ok allow-once → terminal.exit ok with diff, the plan-mode deny recorded as denied, project.mode → act; 29 entries; `kurahi audit verify` exit 0
- read mode: terminal.open refused ("the project is in read mode (参照); terminals need plan or act mode")

## Step 6: Security defaults and family-internal check on the built dist

Result: **PASS** (9.7 s)

- resolved from the installed config by the product's own resolvers: supply chain `enforce`, memory provenance `enforce` (agent acme), message signing `enforce`
- `kurahi skills verify --json`: mode enforce, ok, 121 artifacts (exempt 121)
- gateway `agent` with an unsigned nested (agent-to-agent) message → rejected: "inter-agent message rejected (agents.messaging.signing.mode=enforce): unsigned: inter-agent message has no envelope"
- `kurahi doctor --json`: ok true; supply-chain.lock "mode enforce; lock missing, 0 pinned (`kurahi skills verify` for details)"; no secure-defaults.* warnings; gateway.reachable ok
- `node scripts/family-internal-check.mjs` over src/ and the built dist/: exit 0 (family-internal-check: clean (6338 path(s), src + built dist).)

## Notes

- Edition selection is presentation-only: the Control UI reads `edition`/`workspace` from its saved settings (localStorage `KoLo.control.settings.v1`, default industrial/industrial). No gateway config key selects an edition, so step 1 checks the manifest resolution the UI uses.
- Finding (not fixed): `POST /tools/invoke` does not expose project-scoped plugin tools. With the project session key (`agent:<id>:proj-<projectId>-<chat>`) the legacy analyser tools answer 404 "Tool not available", because src/gateway/invocable-tools.ts builds the list with createKoLoTools() and never adds the project's template plugins or the project permission guard that src/agents/pi-tools.ts applies for the embedded agent. Agents on the embedded runner are not affected; a CLI-bridged backend that reaches tools through /tools/invoke would not see the analyser in an Industrial project. Fixing it means porting the project scoping and guard into the shared resolver (a security-relevant change), so it is reported rather than patched here; step 3 uses the product's MCP server (`kurahi legacy mcp --root`), the other supported path.
- Regression guards in this test (bugs found and fixed on branch kolo-2-rel-accept): byte-identical analyser output across two `kurahi legacy mcp` processes (the analyser counted the MCP server's own `.kurahi/` call log as a source-tree file); authenticated /health `healthy` for a `kurahi init --provider local` installation (it reported auth `missing` / `degraded` for ever); the legacy template promising FORTRAN and PL/I, which modernise_plan reports active (its description and agent instruction said they were not covered).
