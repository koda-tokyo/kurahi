# Changelog

Docs: https://kurahi.kodasoken.com/docs

## 2.5.0 — 2026-10-30

Kurahi 2.5 brings Super SSO: one company sign-in for every surface, passkeys built in, and a fresh
authentication for every important decision, recorded in the signed evidence.

### Identity
- **Passkeys and one-time codes built in (`gateway.identity.passkeys`):** a company without an
  external identity provider signs in with passkeys (WebAuthn: ES256, RS256, EdDSA; user
  verification required by default) or an authenticator app (TOTP, encrypted at rest). Free in
  every plan. People are enrolled by an identity admin's one-time link (only for a first
  authenticator) and add further devices themselves after a step-up. No new dependency.
- **Step-up for decisions (`gateway.identity.stepUp`, on by default when identity is configured):**
  approvals, raising autopilot levels and creating standing approvals, lifting the emergency stop,
  identity administration, authenticator changes and data governance actions need an
  authentication no older than `maxAgeSeconds` (300 s by default), optionally with given methods
  (`requireMethods`, RFC 8176). The re-authentication runs at the identity provider (OIDC
  `max_age=0` + `prompt=login` with `auth_time` required; SAML `ForceAuthn`) or with a passkey or
  one-time code, and never switches persons. Protective actions (stop, demote, revoke, send back,
  cancel) stay immediate. Each covered decision records `authn` (time, methods, context, protocol)
  in the work item, its sealed evidence and the audit log. The console asks "Confirm it's you" and
  retries.
- **Sessions record how and when the person authenticated:** OIDC `auth_time`, `amr`, `acr`; SAML
  `AuthnInstant` and `AuthnContextClassRef`.
- **Command line and desktop sign-in:** `kurahi login`, `kurahi logout` and `kurahi whoami` use the
  device authorization grant (RFC 8628): the person types the code on a page that names the app,
  the time and the address, and signs in with any provider, passkeys included. Native apps such as
  Kurahi Desktop sign in through the system browser with loopback redirects and PKCE (RFC 8252).
  Each device gets its own session, listed and revoked on its own, and never inherits the
  browser's authentication. Wrong-code limits count per person and per address.

## 2.4.0 — 2026-10-30

Kurahi 2.4 adds Kurahi Guardian to Kurahi Core, so every edition has it: the ransomware shield
over the company's own file shares, scheduled malware scans, nightly security checks, security
incident cases with signed evidence, SIEM export, JPCERT/CC and IPA advisories and Microsoft
Defender alerts. Detectors decide, the model only explains, and a check that cannot run is never
reported as passing.

### Kurahi Guardian
- **Ransomware shield over company shares:** `guardian.shares` puts the company's own folders under
  the shield (decoy files, entropy spikes, ransom notes), not only Kurahi's folders. A trip stops
  every agent and is recorded.
- **Share scans (`guardian_scan`):** incremental scans through ClamAV, Microsoft Defender or YARA
  (rules folder, named explicitly). A file counts as unchanged only when size, mtime, ctime and
  inode all match. Infected files become hashed quarantine copies with a sidecar; the original is
  moved only when `scan.quarantine.mode: move` is set, never across drives and never for a symbolic
  link. Kurahi never deletes files. A file too large for the run is reported and the walk goes on.
- **Posture checks:** `guardian_backup` (age), `guardian_restore_test` (restores one sample file
  from tar or zip archives and compares its hash, with limits against oversized members),
  `guardian_secrets`, `guardian_ports`, `guardian_integrity` and `guardian_credentials`. Missing
  configuration, a disabled Guardian, a timeout or an unreadable result is `ESCALATE`, never `OK`.
- **Security incident cases:** the `core-guardian` pack brings a Security incidents queue (IT),
  evidence and wording checks (no "removed", "restored" or "no risk" before a person confirms)
  and a route that adds a management stage for `high` and `urgent` cases. Routines
  `guardian-posture` and `guardian-shares` run nightly at L1. When a check escalates and no case
  cites it, the engine files the case itself; a clean share scan ends without a model call.
- **SIEM export:** `guardian.siem` sends audit entries the gateway appends and every Guardian
  result as syslog (RFC 5424 or CEF) over TLS, TCP or UDP, redacted and never blocking the
  gateway. Plain TCP and UDP log a warning at start.
- **Advisories (`guardian_advisories`):** JPCERT/CC and IPA feeds from fixed URLs (no redirects),
  matched against `advisories.products`.
- **Microsoft Defender alerts (`m365_security_alerts`):** Microsoft Graph Security `alerts_v2`,
  read only, when the Microsoft 365 connector option `security.alerts` is on.
- All Guardian paths in the configuration must be absolute.

### Autopilot
- Engine checks can be asynchronous. Fact values are always one line, so a file name cannot add a
  verdict line.
- Work items filed by Autopilot carry their priority in `source.fields`, so routes can use it.

## 2.3.0 — 2026-10-29

Kurahi 2.3 turns the Business edition into functional packs over your existing systems, adds
quotations and purchasing, cases that span departments and data governance, and lets Autopilot
reason with any OpenAI-compatible model API or a local model, so routines can run without a
command-line model and without content leaving the network.

### Autopilot
- **Reasoning through a model API (`backend: api`):** a routine names `<provider>/<model>` from the
  registry or `models.providers` (Sakura AI Engine, a Qwen endpoint, IBM watsonx.ai through an
  OpenAI-compatible gateway, a local Ollama …). The call carries no tools; a reply with tool calls,
  cut off at the token limit, stopped by a content filter or refused is discarded with the reason.
  HTTPS is required except for a model on this machine or a private network; redirects are
  refused and API keys never reach run reasons.
- **Local models on modest hardware:** a local Ollama model is asked for a context that fits the
  gathered content, and an answer whose prompt filled the context is discarded instead of resting
  on half of the evidence. Calls wait as long as the routine's `timeoutSeconds` allows (up to 900 s),
  not a fixed 300 s.
- A routines file that names a reasoning backend the engine cannot run, or `api` without a
  `<provider>/<model>`, is refused when it is loaded, not at the first run.

### Business edition
- **Quotations (見積管理):** quotation requests become cases with a 見積書 in Word and Excel.
  Unit prices come from the company price list (CSV, UTF-8 or Shift_JIS); Kurahi computes every
  amount and the consumption tax per rate, rounded once per rate per document (インボイス制度).
  Items not in the price list are 【要確認】. A quotation with open items can be released only as a
  provisional estimate (御見積書（暫定）); a final quotation needs every item priced or explicitly
  taken out of scope with a reason. Revisions (R2, R3 …) name the version they supersede, and
  approval is bound to the exact files. Sending is always a person's action. Price lists can also
  be Excel workbooks (.xlsx, read with a strict XML parser); a price list older than the company's
  limit is flagged and needs a person's recorded confirmation.
- **Purchasing:** keep a case's supplier quotes, compare them, record a person's supplier
  choice (passing over the lowest quote needs a reason) and draft each chosen supplier's purchase
  order once. Supplier quotation sheets (CSV or .xlsx under quotes/) are read into the comparison,
  and each recorded quote and purchase order keeps the sheet it came from.
- **Functional packs:** Employee requests, Contracts and obligations, People operations
  and Management oversight join the Sales quotation pack, each with forms, routes, checks and
  JA/EN guidance. A published catalogue lists every pack's status and limits.
- **Cases across departments:** a linked case plans steps in several departments (for example
  onboarding), tracks dependencies and completion, and escalates stuck cases. A pack's worksheet
  can be started as a linked case from the console, with every step and dependency shown first.
- **Hand-offs to other systems:** each hand-off of an approved case is tracked from approval to
  confirmation, reconciliation and closure, with evidence at every step; closure says what was
  achieved (for example, hand-off completed and payment not verified). Only a person can attest
  that a payment settled, under separation of duties.
- **Notifications:** people are notified in the console when a case newly concerns them
  (awaiting their decision, delegated, escalated, a linked step opened); the morning brief counts
  unread notices.
- **Delegation:** an approver can withdraw a delegation before the delegate uses it.
- **Document previews:** reviewers can read the text of attached PDF and Office documents; the
  text is dropped if the file changes.
- **Faster work queues:** lists and statistics read an index instead of every item, for large
  queues.
- Overrides of checks marked "provisional" release a provisional result only, never a final
  approval.

### Data governance
- Retention sweeper with signed manifests, legal holds, eDiscovery export, a My Number (マイナンバー)
  guard on outbound tools, and data subject requests (APPI).

### Console
- Business notifications panel, supplier-quote review, evidence verification beside every history
  event, Autopilot writes kept safe across navigation, and Industrial readiness wording, in English
  and Japanese.

### Fixes
- Project files reached through a symlinked folder (macOS /var, /tmp) are accepted when their real
  path is inside the Project.
- Price lists refuse oversized cells and duplicated item codes instead of guessing.

### Detailed changes

- Business: supplier quote comparison and purchase order drafting accept up to 20 suppliers and 200 items, the same as a stored procurement case; a case refuses item codes, descriptions and supplier names longer than those tools accept, so every recorded case can be drafted.

- Business: add a bilingual People operations closure worksheet covering every required task, exception decisions and re-review after checklist changes; reviewer notes retain policy and source versions. This is a manual workflow.

- Business: require a human-supplied source version for Contracts register and review requests, with bilingual decision and re-review guidance. This starter does not verify document versions or migrate existing Project policies.

- Console: review persisted supplier quotes and explicitly record a supplier choice with revision checks, a reason for higher quotes, and English/Japanese refusal guidance.

- Console: show more retained notifications in batches of 50 and keep loaded rows visible during refresh; confirmed read acknowledgements survive refresh failures, with stale actions disabled.

- Console: open a notification’s item without marking it read or changing department filters; pending edits and writes block navigation.

- Console: add a Project-wide Business notification panel with unread counts, English/Japanese reasons and explicit mark-read actions; stale or unavailable inboxes never appear empty.

- Console: distinguish unavailable linked-case snapshots from confirmed empty lists in the morning brief; truncated empty lists no longer claim there are no cases (English and Japanese).

- Work queue: a stored in-app notification with a missing or malformed field (read time, reason, revision, ids, times) now makes the inbox unreadable instead of silently dropping out of the unread count; the morning brief reports it as unavailable.
- Work queue: a linked case step reaching done or cancelled notifies the parent's requester in-app when it opens the next step, completes the case or blocks it (`linked_step_ready`, `linked_case_complete`, `linked_case_blocked`, with `childId`, and `stepKey` for the step that opened). Two steps finishing at the same moment report a complete or blocked case, or the step they both opened, once, and never miss it.
- Console: show unread in-app notification counts in the morning brief in English and Japanese; distinguish unavailable snapshots from zero without marking notifications read.

- Work queue: every transition stores in-app notification records for the people it newly concerns (awaiting, delegated, delegation withdrawn, escalated, decided), readable through `workitems.notifications.list` and marked read explicitly with `workitems.notifications.markRead`. Ids and reasons only; members known only through a group are not notified yet; no mail or chat delivery.

- Work queue: an approver can withdraw their own delegation on the current stage before the delegate uses it (`workitems.withdrawDelegation`, person only, audited with evidence; refusals `no_delegation`, `already_approved`).

- Console: use heading punctuation consistently for the Japanese unavailable-page title.

- Console: describe current page, file and export availability without outdated release promises in English and Japanese; refresh Industrial payroll captures.

- Console: align artifact version and comparison selectors with displayed content on initial render.

- Industrial: explain analysis availability and setup requirements in English and Japanese; add fictional payroll visual examples and bilingual page-copy handoff.

- Business: add a Management oversight starter with bilingual manual workload, exception and outcome report worksheets and precise statistics definitions.

- Console: explain Autopilot writes still awaiting confirmation after 30 seconds in English and Japanese, keeping duplicate changes blocked across navigation.

- Console: keep Autopilot writes locked through navigation and reconnects until they settle, then refresh the current view without restoring stale notices or drafts.

- Console: distinguish verified Autopilot evidence deletion records from live evidence, with English/Japanese notices and safe verification failures.

- Console: show verification results beside each Business history event, including verified deletion records and failed or unavailable evidence, in English and Japanese.

- Console: open originating Autopilot runs from Business items, verify linked item membership, and distinguish verified deletion records from available event evidence in English and Japanese.

- Business: let authorized people report serious errors directly from routine-created item details, with explicit reasons and English/Japanese guidance.

## 2.2.0 — 2026-10-25

The Business Edition and Autopilot release: 稟議 approval routes and business connectors, routines that carry repetitive work end to end in every edition, deeper Industrial analysis, a Scholars research workspace, enterprise identity and the enterprise package. Upgrade notes: [Kurahi 2.2.0](https://docs.kodasoken.com/releases/2.2.0).

### Business Edition

- Departments: 15 department workspaces and six SME groups with scoped queue navigation, server-side search and status filters; the Company operations template provides every department queue. Department conversations open from the console into agent chat with persistent context and safe session switching.
- Approval routes (稟議): ordered stages with role, named or department approvers, minimum approvals, due hours, send-back behaviour, conditional stages, delegation and escalation (audited, with evidence). Requester ownership, `mine` and `awaitingMe` views, safe document previews, draft version diffs and queue statistics (`workitems.delegate|document|draftDiff|stats`). Templates gain a three-stage finance route and a three-quote procurement option.
- Control UI: create, edit and submit expense requests with pinned revisions and duplicate-save protection; approve, send back and cancel with written reasons; preview the exact pinned draft (Project, version and SHA-256 checked); verify evidence on request; staged route progress with deadlines and overdue and escalation markers (Japanese and English).
- Email intake: a mail message becomes a work item by reference (connector, message id, bounded headers; never the body), idempotent per message. Risk flags: `suspected_fraud` (also raised for a proposed bank-detail change) and `malicious_attachment` block approval and completion until a person clears the flag with a written reason.
- Connectors, all off by default: kintone, freee 会計, マネーフォワード クラウド請求書, SmartHR, LINE WORKS and Box (read-only, or read-only by default), with API-token, assertion and confidential OAuth client credentials in the connector kit. Microsoft 365 adds draft-only Outlook replies, Project files attached to drafts, uploads to the OneDrive app folder and a Graph delta-query mail watcher for triggers. The catalogue shows a connector as Active once its connection probe succeeds.
- Office documents: the bundled `office` plugin (off by default, Project-scoped; enabled by the Business templates) writes PowerPoint, Word and Excel files from structured specs into the Project, with native editable charts, speaker notes and a 20 MB cap. No new dependencies.

### Autopilot

- Routines engine for every edition (`autopilot.yaml` per Project, fail closed): gather through declared read tools, reason with a tool-less model backend, act only through the engine's authorization. Autonomy levels L0 (observe), L1 (prepare), L2 (act internal) and L3 (act externally within policy). L3 sends need a person-made standing approval that is scoped to recipients and template, expires and has a daily maximum; it is verified again at send time. Every run is a job with a signed evidence bundle. Starter routines ship for every edition.
- Triggers: work item, deadline, file and mail events next to schedules, with debounce, an hourly cap, one queued follow-up and a loop guard.
- Behaviour watchdog (runs above baseline, refusal bursts, unexpected actions or repeated tool calls pause the routine and escalate) and a global stop (`autopilot.stopAll` / `autopilot.startAll`, person only, and the `<KOLO_HOME>/autopilot/STOP` file).
- Earned autonomy: the engine proposes a level per routine from recorded corrections; a person accepts or declines with a written reason, never above the routine file's level and never to L3 without a standing approval. A watchdog trip or a reported serious error demotes the routine one level. Every change is audited and sealed as evidence.
- Morning brief: a per-person brief from recorded data only (work handled, documents, decisions, flags the person may clear, proposals, commitments, problems), in the console and as an Outlook draft or a file. Never sent automatically.
- Routines may read approved company knowledge from read-only folders, write Office documents and attach them to reply drafts; a message any work item already covers is never acted on twice.

### Industrial Edition

- Java and databases: JPA mapping in depth (relationships and join tables compared with DDL keys, inheritance strategies, secondary tables, embedded and mapped-superclass fields, element collections, map keys and order columns, enumerated and temporal storage), MyBatis mapper XML as table access, schema-qualified tables kept apart.
- Stored procedures: DB2 SQL PL and PL/SQL routine bodies, PL/SQL package bodies split into member routines, and calls linked to routine nodes from Java, Oracle calls without `CALL`, `@NamedStoredProcedureQueries`, and COBOL and PL/I `EXEC SQL CALL`, so table impact reaches their callers.
- PLC engine: IEC 61131-3 Structured Text, and FBD and LD networks in PLCopen XML exports, with a POU and I/O inventory and a PLC section in the design document. IL and SFC bodies and vendor ladder exports are listed as not read. Source text only; never touches a controller.
- Change detection: `legacy_changes` compares the fact index with a stored baseline (programs, copybooks, jobs, tables, columns, routines and their edges, with `path:line` evidence); `legacy_baseline_advance` promotes it. The nightly starter routine runs only when something changed and also after a new source drop.
- Design documents (設計書) as Word files (`output_format: "docx"`), never overwriting an earlier one. The Industrial template gains analysis, design-document, modernisation and quality work queues.

### Scholars

- New bundled `scholar-sources` plugin (off by default, enabled by the Research & academic template): search, records, citation check, open-access PDF fetch through the attachment intake and grant deadlines over arXiv, OpenAlex, Crossref, PubMed and doi.org, keyless and within each provider's rate limits.
- The template becomes a working research workspace: work queues for literature, writing, grants and data, profile and grant forms, and three L1 routines: a weekly literature watch with a Word digest, a citation check of drafts and grant deadline reminders. A missing fact is marked 【要確認】 in place, never invented.

### Security

- Enterprise identity: OIDC (authorization code with PKCE; Entra ID, Google, Okta, Keycloak) and SAML 2.0 (signed assertions, audience, recipient, time window, replay and signature-wrapping checks) sign-in for people, SSO sessions with lifetime, idle timeout and logout, SCIM 2.0 provisioning (deactivation ends sessions at once), departments and teams, eight roles mapped to gateway scopes and IdP group mappings. `ssoRequired` refuses token logins of people except an audited break-glass. Hardened after three rounds of adversarial security review: personhood from the authenticated credential only, account linking by verified e-mail within one provider, fail closed when the configuration does not load, no session token in URLs, periodic re-evaluation of SSO sockets, Project access applied to evidence reads. **Off by default** (`gateway.identity`).
- Attachment intake: quarantine, a static policy (executables, scripts, macros, encrypted files, nested archives, zip bombs, document allow-list), a malware scan with ClamAV or Microsoft Defender that fails closed (`security.attachments.requireScan`, on by default) and text extraction in a bounded child process. Refusals are audited and sealed as evidence.
- Enterprise profile: every extension is classified enterprise (23), optional (11) or excluded (25) in `src/packaging/profiles/enterprise.json`. The enterprise package ships enterprise-tier extensions only; under `KURAHI_PROFILE=enterprise` or `profile: "enterprise"` the loader refuses excluded plugins, requires an explicit opt-in for optional and unclassified ones and audits `plugin.refused`; Slack defaults to an allow-list; enterprise installs update only to `-enterprise` assets.
- Console responses carry a Content-Security-Policy (per-response nonce, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- Gateway: the client address is resolved from the right of `X-Forwarded-For` past trusted proxies only; a refused shared secret no longer leaves an owner principal; a config that fails to load answers 503 instead of crashing; tools invoked through the gateway get the Project's scope and path checks; device pairing approvals and token rotation cannot grant more than the approver holds.

### IBM watsonx interoperability (Preview)

- watsonx Orchestrate can call Kurahi (A2A 0.3.0 server with `X-API-Key`, an OpenAPI 3.0 ask endpoint, the legacy analyser as a remote MCP toolkit behind a TLS proxy) and Kurahi can call allow-listed Orchestrate agents (`watsonx-orchestrate` plugin). `watsonx` model provider with IAM token refresh (Tokyo region by default). Governance spans over OpenTelemetry for agent and autopilot runs. Read-only watsonx.data SQL and allow-listed Db2 REST services (`ibm-data` plugin).
- Everything follows IBM's published APIs and is off by default and outside the autopilot. See [IBM watsonx](https://docs.kodasoken.com/integrations/ibm-watsonx).

### Packaging

- Enterprise runtime bundles per OS (`kolo-2.2.0-<target>-enterprise.*`) and an enterprise npm tarball for private registries next to the standard packages; optional plugins as separate archives (`kurahi-<id>-2.2.0.tgz`, WhatsApp as before).
- No tag without a green CI run on Windows, macOS and Linux for the exact commit; CI builds and checks the enterprise bundle on all three.
- Extension directories with content but no plugin manifest are flagged; default exports of shimmed modules are read from the syntax tree.

### Fixes and other changes

- Packaged installs now load every bundled plugin (Microsoft 365, Gmail, Entra ID, A2A, legacy analyser and others).
- Ransomware detection: a ransom-note name on a change event counts as a note (macOS coalesces create and write events).
- Legacy MCP server: refuses a symlinked audit file on Windows too.
- OpenTelemetry diagnostics: the exporter's resource is built with the current OpenTelemetry API (`new Resource(...)` no longer exists as a value in `@opentelemetry/resources` 2.x).
- Connectors: a sign-in whose redirect port is taken names the port; `KURAHI_DEBUG_CONNECTORS=1` shows the raw error on the administrator's own terminal.
- Work queue: the intake tool stays remote when `gateway.mode` is `remote`.
- Control UI: distinct, localised accessible names for Industrial assessment and pack buttons.
- Docs (English and Japanese): Autopilot, Business work queue and 稟議, business connectors, Office documents, attachment intake, enterprise identity, enterprise profile, Scholars and IBM watsonx.

## 2.1.0 — 2026-10-24

The Industrial Edition release. Kurahi Desktop 0.4.0 ships with it.

### Breaking: WhatsApp is a separately installed plugin

- The WhatsApp channel is no longer in the default npm package, prebuilt bundles or installers: its WhatsApp Web library depends on `libsignal`, which is GPL-3.0. Install it with `kurahi plugins install kurahi-whatsapp-2.1.0.tgz` (attached to the release; the install fetches its dependencies with npm), pin it, enable it and restart the gateway; see the WhatsApp channel page. Without it the runtime starts normally, WhatsApp commands say the plugin is not installed, and existing `channels.whatsapp` settings load unchanged. The release SBOM shows the default runtime without `libsignal`.

### Industrial Edition

- Legacy analyser (deterministic, no model in the loop): COBOL with copybooks and JCL, Java (classes, methods, inheritance, resolvable calls, Spring and JPA annotations, table access), SQL DDL (tables, views, indexes, columns, keys; ANSI, DB2, Oracle and PostgreSQL basics), FORTRAN (fixed and free form, COMMON, INCLUDE, calls, file I/O) and PL/I (procedures, structures, files, EXEC SQL, ON-units). Every fact carries `path:line`; what the analyser cannot read is reported as a gap, never dropped silently.
- Cross-program knowledge graph across languages: CRUD facts per table, call and data impact, graph queries.
- Design documents (設計書) generated from code, with Java and SQL sections, and a modernisation wave plan proposed for human review.
- `kurahi legacy mcp --root <project>`: the analyser as an MCP server for the engineer's own editor (VS Code, Eclipse-based tools), read-only and scoped to one folder.
- Modernisation tools in the legacy-analyzer plugin, enabled per Project rather than for the whole gateway; the Industrial Project template routes each language to its engine.
- Industrial workbench in Kurahi Desktop: Projects with permission modes (参照 read / 計画 plan / 実行 act), engineering and industrial capability packs, an outputs (成果物) panel with verifiable export hashes, and a connector catalogue that shows only what is really connected.
- Project-scoped plugins: a plugin can be enabled for one Project only.
- Document requests: in an Industrial Project, the Assets view prepares a design document (設計書) or wave plan request as a chat draft for that Project, in Japanese or English, for the operator to review and send; workspace manifests point at the shipped Industrial, Business, Research, Education and Professional templates.

### Work Console

- Governed terminal: a gateway-owned terminal per Project, off by default. Each line is checked before it runs (Project mode, destructive-command guard, path guard, risky-construct classifier); plan mode and act mode with the new-installation setting wait for an explicit approval; approved lines run in a clean shell without inherited tokens; every command produces a diff and an audit entry. Folders a Project marks read-only cannot be changed from the terminal in any mode. Optional container sandbox (`console.terminal.sandbox: "required"`).
- The desktop terminal connects to the broker with once-only approvals, bounded output, replay on reconnect and recovery of lost sessions.
- Push-to-talk voice (Japanese and English), off by default and local-first: the transcript lands in the composer for the operator to edit and send. Consequential actions are never approved by voice. Gateway methods `voice.start|audio|stop|speak|cancel`.

### Business Edition (preview)

- Governed work queue: work items with policy checks, approval records, history and evidence (`workitems.*` gateway methods and the `workitems.changed` event), and a read-only review view in the Control UI (Japanese and English).
- Business connectors for Microsoft 365, Gmail and Microsoft Entra ID, off by default (OAuth with PKCE or device code, sanitized read-only status in `connectors.status`). The catalogue shows a connector as Active only after a live probe succeeds.
- Business Project templates: 総務, 人事, 経理, 購買.

### Security

- Path checks for the memory provenance store, integrity-protected folders and project folders now resolve symlinks through the nearest existing folder, so protected locations reached through a symlinked path (for example macOS temporary or home folders) are recognised.
- Supply-chain lock for skills and plugins: signed lock file, digests and a pin-time scan, verified at load. `kurahi skills pin|verify` and `kurahi plugins pin|verify`; agents cannot pin. Enforced on new installations.
- Memory provenance: memory written by agents is tagged with its origin, untrusted writes are quarantined, and recalled memory is marked by trust. `memory.provenance` (`off|warn|enforce`) and `kurahi memory quarantine list|show|approve|reject`.
- Signed agent messages: per-agent Ed25519 keys and an owner-signed key registry; inter-agent messages, `sibling.send` and queued sub-agent announces are signed and verified, with persistent replay protection and an access re-check on receipt. `agents.messaging.signing` (`off|warn|enforce`).
- Secure defaults for new installations (credential isolation, exec sandbox, exec approvals, supply-chain lock, memory quarantine, message signing); existing installations keep their settings and get a warning from `kurahi doctor` and at startup.
- Exec: the destructive-command guard covers every exec path; exec never runs unprotected when a sandbox is required, and a sandbox failure refuses the command; the exec host comes from configuration, never from the model.
- Release check: the build fails if identifiers of a private deployment would ship in the package.
- Policy path rules: `~/` in `data.neverRead` / `data.neverWrite` now means the operating-system user's home (it was matched against the state directory, so the starter's `~/.ssh/**` did not protect `~/.ssh`); calls that use the `file_path` alias of `read`, `write` and `edit` are checked like `path`; the starter policy written by `kurahi init` / `kurahi policy init` keeps file tools out of `<KOLO_HOME>/secrets` and away from writing `policy/`, `kolo.json` and `audit/`. Existing policies keep their lists: add the entries and run `kurahi policy sign` (see Secure defaults).
- `sibling.send` keeps file-inbox writes inside `sibling-chat/`; the idempotency key can no longer steer the file name or add front-matter fields, and the inbox file records whether the sender's signature was verified.
- Dependency updates for advisories in production dependencies (`pnpm audit --prod`: 258 findings to 15, none critical in the gateway's own request paths): tar 7.5.22, ws 8.22, undici 7.30, hono 4.13, @hono/node-server 1.19.15, axios 1.20, protobufjs 7.6, @modelcontextprotocol/sdk 1.32, sharp 0.35.5 (libvips, libheif and librsvg fixes), markdown-it 14.3.3, yaml 2.9, dompurify 3.4, fast-xml-parser 5.7, proxy-addr 2.0.8, qs 6.16 and others; tokio 1.54.1 in Kurahi Desktop.
- Release artefacts carry a CycloneDX SBOM for the runtime and the desktop app (`pnpm sbom`).
- Docs: OWASP Agentic Top 10 status page and agent-specific controls in the security overview.

### Interop

- Agent2Agent (A2A) protocol plugin: a server (off by default) and client tools; content received over A2A is labelled as external.

### Fixes and other changes

- CLI: options given after a `kurahi gateway` subcommand reach that subcommand. `kurahi gateway run --port 18995` was ignored when the config set `gateway.port` (the parent `gateway` command consumed `--port`); the same applied to `--bind`, `--force`, `--token` and `--password` on `run`, `install`, `status`, `probe` and `call`.
- Startup: a fresh gateway starts in about 5 seconds (channel SDK modules and protocol validators load on first use, plugins share the plugin SDK natively); the gateway logs startup phase timings, and `kurahi debug profile` captures a CPU or heap profile of a running gateway (admin only, audited).
- Gateway: a WebSocket connection over the per-address limit is closed with 1013 and a reason ("retry in Ns") instead of a bare disconnect.
- Gateway health: an installation that uses only local models is no longer reported as missing a credential.
- Cron: deterministic pre-step for isolated agent turns (`payload.preExec`, with `pinHead`), per-job system prompt mode (`payload.promptMode`), `postToMainMode: "none"`, and timed-out or aborted turns are reported as errors.
- Evidence: logs left running by a stopped process are sealed as interrupted, under a per-job lock with an owner-checked release.
- Voice: a cancelled or timed-out stop always ends the session; engine writes are serialized and lost audio is never acknowledged.
- Terminal: a replay cursor newer than the session's last event is refused.
- Skills: `allowBundled: []` now allows no bundled skill (it allowed all); a snapshot built under another skills configuration is rebuilt.
- Compaction: the reserve is clamped to half of the context window, and `kurahi doctor` warns about larger settings.
- Legacy analyser: never reads Kurahi's own `.kurahi` state folder; a commented `END` no longer closes a routine; `ALTER TABLE` edge cases (guards, duplicates, rejected actions) are handled without partial effects.
- Gateway: the experimental `gateway.v3.biology` flag is removed. Configs that still set it load unchanged and the key has no effect; `/metrics` no longer has `biology_*` gauges, `kurahi health --json` no longer has a `body` field, and the Control UI overview no longer shows the "Human Prompts" card. With `gateway.v3.health`, `/health` reports `readiness: "consciousness_ready"` only when v3 dispatchers are registered, and the `v3` block carries `dispatchers.count`.
- Control UI: the unmeasured 99.99% availability headline now reads "Not yet measured".
- Eval: scorecard version 3 records the subject and judge models.
- Docs: Editions, Industrial modernisation, Work Console, voice, A2A, connectors and the Business work queue (English and Japanese).

## 2.0.3 — 2026-10-19

- Evidence: `approval` events (every human approval decision, with the approver), policy and inventory digests in `job.start`, declared outputs and a cost snapshot in `job.end`.
- Workflow Evaluator (preview): signed acceptance specs, deterministic checks with security gates kept out of the quality score, offline replay with simulated tools, signed scorecards (`kurahi eval spec|run|report`), reliability across repeated runs (`--repeat k`: pass^k headline, pass@k, gates in all attempts) and failure taxonomy tags. Bundled example with fictional data.
- Workflow Evaluator: correction effort. `kurahi eval review <run> --task <id> --minutes-review N --minutes-fix M --accepted <as-is|edited|rejected> [--diff-from <file> --diff-to <file>]` records reviewer, review and fix minutes, a line-level diff size and the verdict, and re-signs the scorecard (superseded version kept under `revisions/`). Scorecards report correction effort per task and per run (median and p90 minutes, share accepted unchanged) next to pass^k; specs can set `humanReview.targets`. Scorecard version 2; version 1 scorecards still verify.
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
