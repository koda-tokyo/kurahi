# Changelog

Docs: https://kurahi.kodasoken.com/docs

## 2.0.3 — 2026-10-19

- Docs: vendor-specific model and authentication recommendations removed (security guide, FAQ, getting started, wizard, authentication, models concept, provider list, Venice and local-model pages). Guidance is now neutral: prefer current, instruction-hardened models for agents with tools, check the provider's published safety evaluations, and see KODA-tested results.
- Docs: "Ransomware shield" is now named "Ransomware detection" in the documentation (the `/shield` page, policy key `shield` and CLI commands are unchanged).
- Docs: claims made precise — state persists across restarts but an interrupted job is not resumed; the ransomware shield is detection, not complete protection; evidence replay reconstructs a recorded job and does not re-run it; builds are unsigned (verify `SHA256SUMS.txt`); capabilities list external agent CLIs and credential isolation.
- Snapshots: `snapshots.required` (true, or a list of path globs) refuses an edit when its recovery snapshot cannot be captured (store failure, file too large or unreadable), with an evidence signal and an audit event. Default unchanged: a failed snapshot never blocks an edit.
- Security: enterprise credential isolation. `auth.isolation: "explicit"` with `auth.grants` (agent id → profile ids) stops agents inheriting, merging or falling back to the main agent's credentials; each agent sees only the profiles granted to it. The default stays `"inherit"` for compatibility.
- Security: external agent CLIs no longer run with their permission checks bypassed by default. `claude-cli` now runs with `--restricted` (host Claude Code settings and their allow rules are ignored), `--tools` limited to `allowedTools` (default `Read,Grep,Glob`; none and `--strict-mcp-config` for `tools: "none"`) and `--permission-mode dontAsk`; verified live that no file is written and no command runs, `codex-cli` with `--sandbox read-only` for `tools: "none"` and `workspace-write` for `tools: "native"`, plus `--ignore-user-config`, `--ignore-rules`, `/tmp` and `$TMPDIR` excluded from the writable roots (live test: plain workspace-write let commands write to temp folders outside the workspace) and, on Windows, `-c windows.sandbox=elevated`; `exec resume` now gets these flags before the subcommand, which rejects them after it. New backend options `allowedTools` and `disallowedTools`. Bypass flags in configured args are removed and audited (`cli.permissions`); bypass is available only with the explicit opt-in `unsafeSkipPermissions: true`, which is audited on every run. **Behaviour change:** a `claude-cli` agent that relied on the old bypass needs `allowedTools` (or the opt-in). The post-run tool check stays as a second, detective layer. New page: External agent adapters.
- Fixed: the continuity suite now detects an in-place gateway restart (attached mode). `/health` (with a credential) reports `startedAt`, which changes on every restart; previously an in-place restart kept the pid and process uptime and the suite reported C0 as failed although the gateway had restarted.
- Context guard: CSV and TSV tool results with a header row are masked by column when the header matches `data.redact.fields`.
- Docs: evaluation pack, capabilities in this release, deployment and data boundaries, provider support levels.

## 2.0.2

- Fixed: the product name in the CLI banner, chat `/status`, onboarding and the web control panel now reads Kurahi everywhere.
- Fixed: the hardline guard blocks `pkill`/`killall`/`pgrep` kills of the gateway under the `kurahi` name too; the port inspector recognises a `kurahi` gateway.
- Fixed: bundles ship the client library as `@kodasoken/kurahi-client`; release titles read Kurahi.

## 2.0.1

- The command is `kurahi`; `kolo` is installed as a short alias. Repository: github.com/koda-tokyo/kurahi. Docs: kurahi.kodasoken.com/docs. Installers: kodasoken.com/kurahi/install.sh and install.ps1.
- New: context guard (`data.redact` in the policy) masks personal data in tool results before the model sees it, with detectors for e-mail, phone numbers, My Number, CPF, CNPJ, card numbers and postal codes, field masking for JSON records, and restore only into tools the policy names. Masking is recorded in evidence bundles as counts, never values.
- New: ransomware shield. Decoy files in every watched folder and detection of mass encryption (text files rewritten into high-entropy content, extra-extension swaps, ransom notes) stop every agent through the policy kill switch and write the incident to the audit log. On by default; `shield` in the policy sets the mode, extra folders and thresholds.
- New: `kurahi inventory`, a signed AI inventory of every agent, model, tool, policy rule, MCP server and channel, with `export` (signed JSON or CSV) and offline `verify`.
- New: `KOLO_OAUTH_REFRESH=off` disables the OAuth refresher for deployments that share credential stores.
- Fixed: the ACP client's default server command now spawns `kurahi`; `--profile` is added to printed commands for both command names.

## 2.0.0

Kurahi 2.0: a resident agent runtime you install once, own end to end and can prove. This is the first release on semantic versions; earlier releases used calendar versions (2026.2.1-kolo.1), and an installed calendar-versioned build sees 2.0.0 as an update.

### Highlights

- Install and run (M1, M2): self-contained bundles for Linux, macOS and Windows with their own Node.js runtime and checksums; `install.sh` / `install.ps1`; `kurahi service` over systemd, launchd and Task Scheduler; `kurahi update` for verified, atomic updates. `kurahi init` is the single first-run command, all state lives under `KOLO_HOME`, policy files are integrity-checked at boot and the audit log is hash-chained.
- Five minutes to your phone (M16): `kurahi init` ends with an optional "Connect your phone" step, also `kurahi connect <channel>`: WhatsApp QR, Telegram and LINE with secrets in the store and an add-friend QR, or a phone-browser pairing link. The first message with a one-time code binds you as owner (audited, revocable with `kurahi connect --unbind`). Replies to you are always delivered; proactive messages follow `channels.delivery.policy` (new `replies-only`).
- Pairing, sessions and channels (M3, M14): scoped device pairing with short-lived tokens, `kurahi attach` from another terminal or machine, chat conversations mapped to the resident's session, conversation commands (`/status /jobs /cancel /evidence /pause /resume`) and approvals from any channel, a per-channel outbound queue with retry and dead letters.
- A described API (M4): OpenAPI 3.1 at `/doc`, the generated `@kodasoken/kolo-client` and `kurahi api <operation>`; CI fails on drift.
- Tools (M5, M6): MCP servers with `kurahi mcp add|list|remove|test`, under the same policy and audit as core tools; Code Mode runs one agent-written script that calls many tools in a sandbox with time, memory and call limits.
- Operations (M7, M8): in-process health watchdog, log rotation, self-check and proactive triggers; every agent run is a job you can list and cancel; a step cap and loop detector stop runaway runs.
- Terminal and editor parity (M9, M10): `kurahi tui` with a session switcher, diff view, themes, configurable keys and leader chords, slash commands, `/undo` / `/redo` file snapshots, `/export`, `@path` file references; language-server diagnostics after edits; formatters on edit; `kurahi providers` and `kurahi models list --live`.
- Reasoning view: reasoning streams live (redacted, opt-in per agent and policy) and shows in `kurahi tui` as its own "Thinking" block above the answer, collapsed by default (Ctrl+O expands, `/reasoning on|off|collapsed|expanded`), and under the same headers in `kurahi attach` and the dashboard; evidence bundles can record it.
- Proven continuity (M11): `kurahi continuity run|verify|badge` proves the resident (identity, memory, permissions, jobs, sessions, audit chain) is the same after a model swap, a restart, a state move and a session close.
- Evidence and replay (M12): every job leaves a signed, hash-chained evidence bundle that verifies offline; `kurahi evidence list|show|export|verify|replay`.
- Policy as code (M13): one signed `policy/policy.yaml` per gateway enforced at tool dispatch, model requests, channels, HTTP/WS and job start, with budgets per agent and fleet and a kill switch that stops running jobs within one tick (`kurahi policy ...`).
- The factory (M15): boards of cards with an audited state machine from inbox to merged, run by a headless build engine as jobs with evidence, opening pull requests and merging only with the card's policy; `kurahi factory`, a Kanban view at `/factory`.
- KODA tested models: `kurahi models bench` runs a resident benchmark (tool use, coding, continuity, policy, language) and writes a signed report; the published catalogue (`docs/providers/koda-tested.md`) and a `koda-tested` profile in `kurahi init` start you on models that passed it.

### Fixes

- Version ordering: calendar versions (2026.x) rank below every product version, so `kurahi update`, update notices and the config "written by a newer Kurahi" warning treat 2.0.0 as newer than 2026.2.1-kolo.1.
- `read` and `edit` accept the `file_path` alias without failing validation.

## 2026.2.1-kolo.1

Kurahi 2.0 integration release: the resident agent runtime, packaged and documented as one product.

### Changes

- M1 Packaging and service: self-contained bundles per OS (own Node.js runtime, `bundle-manifest.json`, `SHA256SUMS`), `install.sh`/`install.ps1` with checksum verification, one `kurahi service` command over systemd, launchd and Task Scheduler, `kurahi update` for verified atomic bundle updates.
- M2 State and integrity: every path resolved through `KOLO_HOME`; `kurahi init` as the single first-run command with a bind policy (`loopback|lan|tailnet|custom|remote`); boot integrity gate over protected policy files (`kurahi integrity`), hash-chained audit log, non-loopback serving gated by `gateway.remote.enabled`.
- M3 Pairing and sessions: scoped device pairing (`kurahi pair invite|approve|revoke`) with short-lived access tokens, session discovery and attach from another terminal or machine (`kurahi attach`).
- M4 Described API: OpenAPI 3.1 at `/doc` (43 operations with auth kind and minimum scope), the generated `@kodasoken/kolo-client`, and `kurahi api <operation>` for anything the gateway can do; CI fails on drift.
- M5 MCP: `kurahi mcp add|list|remove|test`; MCP tools surface as `mcp:<server>:<tool>` under the same policy and audit as core tools.
- M6 Code Mode: one agent-written script calls many tools in a sandboxed worker (`code_mode_run`, `POST /api/code-mode/run`) with wall-clock, heap and tool-call limits.
- M7 Ops plugins: health watchdog, log rotation, self-check, circadian and proactive triggers, memory boot inject, all in-process, config-driven and off by default except the health watchdog.
- M8 Jobs and loop guard: every agent run is a job (`listJobs`, `getJob`, `cancelJob`); a step cap and doom-loop detector stop runaway runs and audit `agent.loop_stopped`.
- M9 Parity: `kurahi tui` session switcher (agent, last activity, new session), unified diff view for file-edit tools, slash commands `/sessions /attach /jobs /cancel /clear /theme`, one-line status line, themes (`tui.theme`), configurable keys (`tui.keybinds`), reconnect banner with backoff, coalesced rendering; language servers (`lsp.servers.<lang>`, defaults for TypeScript, Python, Go, Rust, Java) with `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover` and diagnostics appended to write, edit and apply_patch results; provider registry with `kurahi providers list|add|test|remove|default` and `kurahi models list --live`; issue, pull request and discussion forms, `ROADMAP.md`, `GOVERNANCE.md`, `docs/comparison.md`.
- M10 Parity, second pass: file snapshots before every tool edit with `/undo`, `/redo`, `/snapshots` and `GET/POST /api/sessions/{id}/snapshots[/restore]` (45 operations, audited, `snapshots.*`); `/export` (Markdown or JSON, secrets redacted) and `/editor` (`$VISUAL`/`$EDITOR`); eight built-in themes and JSON theme files (`tui.theme` as a path, `kurahi tui themes list|export|check`); a key and a leader chord for every TUI action (`tui.keybinds.leader`, `/keys`); formatters after edits (`format.onEdit`: prettier, biome, ruff, black, gofmt, rustfmt on `PATH`); provider catalogue generated from a public registry (`pnpm providers:sync|check`, 209 entries, curated first); `@path` file references attached to the message.
- M11 Proven continuity: `kurahi continuity run|verify|badge` and `pnpm continuity:check` prove that a resident (identity files, memory, role and permissions, jobs, sessions, transcripts, audit chain) is the same after a model swap, a gateway restart, a state-dir move and a session close; signed hash-chained manifests (`getContinuityManifest`), deterministic memory recall (`recallMemory`), audit chain head and anchors (`getAuditChain`); a job found running after a restart is reported as interrupted instead of staying `running`; invariants C0–C9 in `docs/continuity-spec.md`.
- M12 Evidence bundles and replay: every job records a hash-chained event log (model turns, tool calls, file snapshots, permission decisions, loop-guard verdicts, audit links) signed at job end with the continuity key; `kurahi evidence list|show|export|verify|replay|prune`, bundles (`manifest.json`, `events.jsonl`, `audit-slice.jsonl`, `snapshots/`, `REPORT.md`) that verify offline, a replay stepper in the CLI and the TUI (`/evidence <jobId>`), `getJobEvidence`, `listJobEvidenceEvents`, `exportJobEvidence` and the read-only `GET /evidence/{id}` view (52 operations); `evidence.*` config with caps and retention; `pnpm evidence:check` in CI.
- M13 Policy as code: one declarative `policy/policy.yaml` per gateway (agents, budgets, kill, approvals, network, data, requests, attestation; `kurahi policy schema` exports the JSON Schema), signed by an owner key and refused unsigned in enforce mode (`policy.mode`, `KOLO_POLICY_MODE`); enforced at tool dispatch (core, MCP, Code Mode), model requests, channel in/out, HTTP/WS requests and job start with every decision audited with its rule id (`policy.decision`); budgets per agent and fleet (tokens/day, cost/day from the provider price tables, tool calls/hour, wall clock per job) with warn/pause/stop; a kill switch that aborts running jobs within one tick (`kurahi policy kill|release`, `POST /api/policy/kill|release`, WS `policy.kill|release`, `GET /api/policy/status`, TUI banner); `kurahi policy show|validate|sign|verify|diff|apply|status|kill|release|budget|init`; hot reload of the policy files; `pnpm policy:check` in CI; `docs/policy.md` with hospital-safe, trading-desk and manufacturing-floor starter policies.
- M14 Channel-native residents: `channels.sessionMode` (per-conversation | shared) maps every chat conversation to the resident's session; inbound messages appear live in `kurahi attach` and the TUI with channel and sender; per-channel `identities` (owner/admin/attach) and `locale` (en/ja/pt); attachments copied to `KOLO_HOME/inbox/<channel>/`; conversation commands `/status /jobs /cancel /evidence /pause /resume /help` from any channel; approval asks with approve/deny answers over channels; per-channel outbound queue with retry, dedupe, dead letters and a human-triggered policy (`kurahi channels status`, `GET /api/channels/status`); built-in generic webhook channel; `pnpm channels:check`.
- M15 The factory: boards of cards under `KOLO_HOME/factory` with an audited state machine (inbox → spec → build → review → ready → merged, failed → inbox); a `FactoryRunner` that runs a card on the KIP headless engine as a job of kind `factory`, streams the engine's events into the card timeline and the job's evidence log, moves the card as the engine reports, opens a pull request with `gh` (`factory.github`) or leaves the ready branch, and merges only with the card's `autoMerge` policy and the merge permission; `factory_card_create|move|comment` tools under `exec:factory_card:*`; `GET /factory` Kanban with live `factory.card` events and evidence links; `listFactoryBoards`, `listFactoryCards`, `createFactoryCard`, `getFactoryCard`, `moveFactoryCard`, `runFactoryCard`, `cancelFactoryCard` (60 operations); `kurahi factory boards|cards|create|show|move|run|cancel`; TUI `/factory`; `factory.*` config; `pnpm factory:check` in CI; `docs/factory.md`.
- Voice: `docs/CLI_STYLE.md` governs every user-facing string; documented exit codes (0, 1, 2, 3, 4); no secrets on argv (`kurahi logs` no longer takes `--token`).
- Support: `kurahi support` writes a redacted diagnostics bundle; support@kodasoken.com.
- Packages renamed: `@kodasoken/kolo` (bin `kolo`) and `@kodasoken/kolo-client`.

### Fixes

- OAuth refresh lock: release unlinks the lock and empty, unparseable, expired or orphaned lock content is treated as stale; the old release wrote an empty file that blocked every later refresh in every process.
- The gateway starts its OAuth refresher only for OAuth-kind auth profiles configured under `KOLO_HOME` (or sources from the `oauth-sources` operator overlay) and is silent otherwise. Readers of other programs' credential stores are no longer in the product tree.
- `KOLO_HOME` is the whole state space: the shared root (canvas root, device identity, exec approvals, workspaces) is `KOLO_HOME` when it is set; a test boots a gateway under a temp `KOLO_HOME` and asserts nothing is written outside it.
- `kurahi support` derives the service identity from the state root (`KOLO_SERVICE_ID`, `service/service.json`, the default agent from `kurahi init`) instead of reporting `default`.
- `install.ps1` adds the bin directory to the user PATH only when it is absent, comparing entries case-insensitively without trailing separators.

### Removed

- The npm `beta`/`dev` update channels, the alternative-runtime install path and the upstream deploy templates.

## Earlier releases

Entries before Kurahi 2.0 are not published in this repository. The upstream project's changelog (see `ATTRIBUTION.md`) covers the pre-fork history.
