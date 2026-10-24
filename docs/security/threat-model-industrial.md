---
summary: "Threat model for a Kurahi Industrial Edition deployment: assets, six trust boundaries (desktop to gateway, gateway to model providers, the legacy MCP editor server, the Work Console terminal, inter-agent messaging, business connectors), STRIDE per boundary with the controls in code, and the residual risks with severities"
read_when:
  - Preparing a security review or a customer questionnaire for an Industrial Edition deployment
  - Deciding which settings to change before a pilot on an engineering or plant network
  - Checking what a control in this release does and does not cover
title: "Industrial Edition threat model"
---

# Industrial Edition threat model

This page is the KODA SōKEN team's threat model for Kurahi 2.1.0 deployed as the Industrial
Edition: a Kurahi Desktop app (Tauri) on an engineer's computer, a gateway on the same computer,
and the agent runtime working on a modernisation Project. It is written from the code in this
release; every control below names the file that implements it. It is a self-assessment, not a
certification and not a third-party audit.

Severity scale used in this page:

- **High**: a realistic path to running code, reading credentials or changing Project sources
  without the person who is meant to decide.
- **Medium**: a path that needs a configuration choice, a person approving something they did not
  read in full, or a model following injected instructions.
- **Low**: needs local access the attacker would already be able to misuse, or only degrades
  availability or evidence quality.

The ratings assume the secure defaults written by `kurahi init`, `kurahi setup` and onboarding
(`applySecureDefaults` in `src/config/secure-defaults.ts`). An existing configuration keeps its
old values; `kurahi doctor` lists them (see [Secure defaults](/security/secure-defaults)).

## Deployment assumed

- One operating-system user runs the gateway, the CLI and Kurahi Desktop.
- The gateway listens on loopback (`gateway.bind` unset means `loopback`, `src/gateway/net.ts`
  `resolveGatewayBindHost`, around line 133).
- Project source, data and documentation are read-only to agents; drafts go to Project-controlled
  locations (see `apps/desktop/INDUSTRIAL_EDITION.md`).
- Business connectors (Microsoft 365, Gmail, Entra ID) are off until an administrator enables
  them with the customer's own app registration.

## Assets

| Asset                            | Where it lives                                                                                        | Why it matters                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Project sources and data         | the Project folder (COBOL/JCL, FORTRAN, PL/I, Java, schemas, PLC exports)                             | customer intellectual property; source of every evidence claim                  |
| Artifacts and evidence           | Project-controlled locations, hash-chained audit log                                                  | release decisions are made from them                                            |
| Gateway shared-secret token      | `<KOLO_HOME>/secrets/gateway.token`; copied into the OS keychain by Desktop                           | full operator access to the gateway                                             |
| Model-provider credentials       | per-agent `auth-profiles.json` (`src/agents/auth-profiles/store.ts`), secret store refs in the config | cost, data sent to providers                                                    |
| Secret store                     | OS keyring, or `<KOLO_HOME>/secrets/store.enc` with `.key` (`src/secrets/file-backend.ts`)            | connector OAuth tokens, header secrets                                          |
| Agent signing keys and owner key | `<KOLO_HOME>/secrets/agent-keys/*.json`, `<KOLO_HOME>/secrets/policy-owner.json`                      | identity of every inter-agent message; signature on the policy and key registry |
| Signed policy                    | policy file signed by the owner key (`src/policy/`)                                                   | tool allow/deny, egress, approvals, budgets                                     |
| Connector data                   | Microsoft Graph, Gmail API, Entra directory                                                           | personal data, mail, files of the customer                                      |
| Audit log                        | hash-chained log (`kurahi audit verify`)                                                              | accountability and after-the-fact detection                                     |
| Replay store                     | `<KOLO_HOME>/identity/agent-message-nonces.jsonl`                                                     | replay protection for inter-agent messages                                      |

## Adversaries considered

- Content an agent reads: a source comment, a document, an e-mail, a calendar invite, a file name
  or a directory display name written to steer the model (prompt injection).
- A web page or other local program trying to reach the loopback gateway or the legacy MCP
  server from the same computer.
- A gateway client or plugin with a valid but limited credential trying to act as an agent or
  as another operator.
- A malicious or compromised MCP server, skill or plugin (supply chain; see
  [Skill and plugin integrity](/security/skill-integrity)).
- An operator who approves something without reading it.

Out of scope: an attacker who already runs code as the gateway's operating-system user (that is
the gateway's own trust domain, see Boundary 2 and the summary), physical access, and the security
of the model providers themselves.

## Boundary 1: Desktop (Tauri) to the loopback gateway

The desktop webview loads only bundled files and talks to the gateway over loopback WebSocket and
HTTP. Native commands are the app's own, listed in one capability.

Controls in code:

- **Capabilities.** `apps/desktop/src-tauri/capabilities/main.json` grants the main window only
  the app's commands (status, gateway URL, service control, local token import, language, secret
  get/set/delete, audit fetch). No shell, filesystem, HTTP, opener or updater plugin permission;
  `Cargo.toml` enables no Tauri plugins.
- **CSP and webview hardening.** `apps/desktop/src-tauri/tauri.conf.json`: `script-src 'self'`,
  `object-src 'none'`, `frame-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`,
  `connect-src` limited to `'self'`, IPC and loopback (`127.0.0.1`, `localhost`, `[::1]`, any
  port); `withGlobalTauri: false`, `freezePrototype: true`.
- **Loopback-only gateway URL.** `apps/desktop/src-tauri/src/gateway_url.rs` `parse_gateway_url`
  (line 48): `ws`/`http` only, host must be `127.0.0.1`, `::1` or `localhost` (pinned to
  127.0.0.1, never resolved), no credentials, query, fragment or path; TLS URLs are refused.
- **Token handling.** `apps/desktop/src-tauri/src/secrets.rs`: only four allow-listed keys
  (`ALLOWED_KEYS`, line 17) go to the OS keychain, 8 KiB cap, memory-only fallback when no keychain
  answers, never a plain file. `import_local_token` (`lib.rs`, line 292) copies
  `gateway.token` into the keychain without returning it. In the browser build the UI uses
  `localStorage`; in Desktop a keychain backend is installed first (`ui/src/ui/secret-storage.ts`,
  `apps/desktop/web/keychain-storage.ts`).
- **Fixed native actions.** Service control runs the CLI with one of three fixed argument vectors
  (`apps/desktop/src-tauri/src/cli.rs` `service_args`, `run_service` line 108); the CLI is found
  through `KURAHI_CLI` (absolute file only) or absolute `PATH` entries (`locate_cli_in`, line 46).
  The audit view is fetched natively with whitelisted query parameters (`audit.rs`).
- **Gateway authentication.** `src/gateway/auth.ts` `authorizeGatewayConnect` (line 260): token or
  password is required for every connection, loopback included, compared with `safeEqual`; the
  gateway refuses to start in token mode without a token (`assertGatewayAuthConfigured`). Failed
  attempts are rate-limited (`authAttemptLimiter`, `src/gateway/server/ws-connection/message-handler.ts`
  around line 587). Paired devices get scoped credentials (`src/gateway/scopes.ts`).

| STRIDE                 | Threat                                                              | Control                                                              | Residual                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A local web page or program connects to the gateway as the operator | token on every connection, rate limiter                              | no `Origin` allowlist on the gateway WebSocket: the origin is logged, not checked (`src/gateway/server/ws-connection.ts` line 73). The token is the only barrier.            |
| Tampering              | Desktop pointed at a different gateway                              | `parse_gateway_url` loopback-only                                    | any process on the computer can listen on a loopback port first; Desktop then sends it the token.                                                                            |
| Repudiation            | Operator actions not attributable                                   | hash-chained audit log, per-identity scopes                          | the shared owner token identifies "the owner", not a person.                                                                                                                 |
| Information disclosure | Gateway token read from the webview or from disk                    | keychain storage, CSP, no remote content                             | `secret_get_all` returns the token to the webview (it needs it to connect); script running in the webview has full admin. The token file on disk is readable by the OS user. |
| Denial of service      | Flooding the loopback gateway                                       | auth rate limiter, per-feature limits                                | a local process can still exhaust the port or CPU.                                                                                                                           |
| Elevation of privilege | Webview content gains native access                                 | capability lists only the app's commands; no shell/fs/opener plugins | `style-src 'unsafe-inline'` (and `dangerousDisableAssetCspModification` for styles) allows CSS injection; `connect-src` allows every loopback port, not only the gateway's.  |

Config-dependent: `gateway.bind` `lan`, `tailnet` or `custom` exposes the gateway beyond loopback
over plain `ws` unless a TLS proxy is put in front; `gateway.controlUi.allowInsecureAuth` and
`gateway.controlUi.dangerouslyDisableDeviceAuth` (`message-handler.ts` around line 385) weaken
Control UI authentication and must stay unset in Industrial deployments.

## Boundary 2: Gateway to model providers

The gateway process calls model providers over HTTPS with the credentials of the agent that runs.

Controls in code:

- **Credential isolation per agent.** New installations get `auth.isolation: explicit`
  (`src/config/secure-defaults.ts`); an agent only sees the profiles granted to it.
- **Credential files.** `auth-profiles.json` is written by `saveJsonFile`
  (`src/infra/json-file.ts`, line 16): folder 0700, file `chmod` 0600 after the write. Config values
  can be `{"$secret": "<name>"}` references resolved from the secret store and restored on write
  (`src/secrets/resolve.ts`).
- **Secret store.** OS keyring when available, otherwise AES-256-GCM in `store.enc` with a scrypt
  key from `KOLO_SECRETS_KEY` or `<KOLO_HOME>/secrets/.key` (`src/secrets/file-backend.ts`).
- **Egress for tools.** The signed policy's `network.egress` allow/deny lists are checked against
  hosts found in tool arguments (`src/policy/decisions.ts`, around line 270). The starter policy
  denies cloud metadata endpoints only (`src/policy/starter.ts`, line 58); `allow` is commented out.
- **Budgets.** Token and tool-call budgets per agent and fleet in the starter policy
  (`src/policy/budgets.ts`).

| STRIDE                 | Threat                                               | Control                                            | Residual                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A fake provider endpoint                             | HTTPS with system trust store                      | a provider base URL in the config is trusted as written.                                                                                                                                                                                                                                                                                             |
| Tampering              | Responses altered in transit                         | TLS                                                | none beyond TLS; model output is treated as untrusted by the tool guards, not verified.                                                                                                                                                                                                                                                              |
| Repudiation            | Which agent spent which tokens                       | budgets and audit per agent                        | provider-side logs are outside Kurahi.                                                                                                                                                                                                                                                                                                               |
| Information disclosure | Project source and connector data sent to a provider | operator chooses providers; context guard (opt-in) | everything in the model context leaves the computer. The PII placeholder guard (`data.redact`) is commented out in the starter policy. Credential files are readable by the OS user (plaintext JSON for auth profiles; the file-backend `.key` sits next to `store.enc`). On Windows `chmod` has no effect and protection relies on the profile ACL. |
| Denial of service      | Runaway spend                                        | budgets, job limits, kill switch                   | budgets cap cost, not data volume.                                                                                                                                                                                                                                                                                                                   |
| Elevation of privilege | An agent uses another agent's credentials            | `auth.isolation: explicit`                         | an agent granted `*` keeps every credential; legacy configs run as `inherit`.                                                                                                                                                                                                                                                                        |

Not covered: policy egress applies to tool arguments, not to the gateway's own provider, connector
or MCP connections, and with no `allow` list it is a denylist. Restricting outbound traffic for an
Industrial host needs an operating-system or network firewall.

## Boundary 3: Legacy analyser MCP editor server

`kurahi legacy mcp --root <dir>` serves the read-only legacy analyser to VS Code, Eclipse-based
IDEs and other MCP clients (stdio, or HTTP on loopback). It needs no gateway and shares nothing
with a running Kurahi service. Details: [Legacy analyser in your editor](/tools/legacy-mcp).

Controls in code (`extensions/legacy-analyzer/mcp/`):

- **Root confinement.** `root-guard.ts` `openProjectRoot` (line 36) resolves the root to its real
  path; every `path` argument is checked lexically and on its real path; `_answer-keys`, `.git`,
  `node_modules` and `.kurahi` are refused.
- **Read-only tools.** Tools parse source text, never run repository code or JCL and never call the
  network; the only writes are the cache and `audit.jsonl` under `.kurahi/legacy-mcp/` (0700,
  refuses symbolic links).
- **HTTP transport.** `http.ts`: listens on `127.0.0.1` only (line 81); bearer token of at least 16
  characters, compared in constant time over SHA-256 digests (lines 29 to 49); `Host` must be
  `127.0.0.1:<port>` or `localhost:<port>` and a present `Origin` must match (DNS rebinding,
  lines 36 to 46); `POST` only; requests over 1 MiB by `Content-Length` refused (line 57).

| STRIDE                 | Threat                                                 | Control                                    | Residual                                                                                                                     |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A web page calls the HTTP server through DNS rebinding | `Host`/`Origin` checks, bearer token       | a generated token is printed to stderr; anything that can read the client's config or terminal can reuse it.                 |
| Tampering              | Forged index cache planted in the Project              | cache fingerprint                          | someone with write access to the Project can plant a cache that matches; `legacy_index_build` rebuilds from sources.         |
| Repudiation            | Calls not attributable                                 | `audit.jsonl` (tool, argument hash, size)  | append-only by the server, not hash-chained, not rotated; anyone who can write the Project can edit it.                      |
| Information disclosure | Reading outside the root                               | root guard on real paths                   | the analyser returns exact source text by design; whatever the MCP client forwards to its own model leaves Kurahi's control. |
| Denial of service      | Large requests or huge trees                           | 1 MiB `Content-Length` check, response cap | a chunked request has no `Content-Length` and falls through to the MCP library's own body limit; indexing is synchronous.    |
| Elevation of privilege | Repository content runs code                           | tools never execute repository content     | none identified.                                                                                                             |

HTTP has no TLS: do not forward the port.

## Boundary 4: Work Console terminal broker

A gateway-owned shell bound to one Project, reached through `terminal.*` gateway methods. The
desktop webview has no shell. Full description: [Console terminal broker](/security/terminal-broker).

Controls in code (`src/console/terminal/`):

- **Who.** All methods need `operator.admin`; a session answers only to the identity that opened
  it; the policy kill switch refuses `terminal.open` and `terminal.input`.
- **Defaults.** Off when unset (`settings.ts` `resolveTerminalSettings`, line 27); new installations
  get `enabled: true, actApprovals: "always"` (`src/config/secure-defaults.ts`, around line 87).
- **Line gate.** `gate.ts` `decideLine` (line 66), per submitted line: project mode re-read; the
  hardline guard (`src/security/exec-guard.ts`); classification (`classify.ts`) that refuses
  privilege elevation, detaching, substitution, here-documents, dynamic program names and
  interactive programs; the path guard (`path-guard.ts`); then the mode decision. Only lines
  classified read-only run without approval (`gate.ts` lines 110 to 115); read-only means a
  program on the fixed list (`command-tables.ts` `READ_ONLY_PROGRAMS`, line 6), no flag from
  `READ_ONLY_FLAG_EXCEPTIONS` (line 78), and no risk (`classify.ts`, line 355).
- **Approvals default to deny.** `session.ts` (lines 298 to 309): only `allow-once` or
  `allow-always` runs the line; a timeout (`approvalTimeoutMs`, default 120,000 ms), a cancel or a
  closed session is a denial and is audited. The line is checked again after the approval.
- **Execution.** Each approved line runs as `bash --noprofile --norc -c` in a fresh PTY with an
  allow-listed environment (gateway tokens and API keys are not inherited); output is redacted
  (`redact.ts`); every command, approval, exit and diff is in the audit log.

| STRIDE                 | Threat                                      | Control                                                              | Residual                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spoofing               | Another admin drives someone else's session | session bound to the opening identity; `forbidden` is audited        | anyone with `operator.approvals` can answer a terminal approval.                                                                                                                                                                                                   |
| Tampering              | A command changes files outside the Project | path guard, sandbox when `sandbox: "required"`                       | on the host an approved program runs with the OS user's full rights; `sandbox` defaults to `"off"`. Symlink swaps between check and run and hard links are not caught.                                                                                             |
| Repudiation            | Who ran or approved a line                  | audit entries with `runId`, approver identity, redacted command text | the person at the terminal usually approves their own line.                                                                                                                                                                                                        |
| Information disclosure | Secrets printed to the terminal             | pattern and environment-value redaction                              | secrets that match no pattern are shown; a secret split across an output flush can escape the patterns.                                                                                                                                                            |
| Denial of service      | Output floods, idle sessions                | output rate cap, session limits, idle timeout                        | a process that calls `setsid()` survives cancel and close.                                                                                                                                                                                                         |
| Elevation of privilege | A "read-only" line that writes or runs code | fixed read-only list, flag exceptions, `git` never read-only         | classification is by program name and flags; input typed to an approved running program is not gated. Legacy configs that enable the terminal without `actApprovals` use `"policy"`, where the exec-approvals file can let non-read-only lines run without asking. |

Platform note: the broker needs bash and a POSIX PTY. A gateway running natively on Windows refuses
to open sessions.

## Boundary 5: Inter-agent messages (`agent` method and `sibling.send`)

Agents in an Industrial engagement (estate mapper, analysts, transformation, validation) exchange
work through the gateway. Details: [Agent message signing](/security/agent-message-signing).

Controls in code (`src/agents/messaging/`):

- **Signed envelope.** Per-agent Ed25519 keys and an owner-signed key registry (`keys.ts`);
  `envelope.ts` `verifyAgentMessage` (line 139) checks shape, registry signature, sender key,
  signature, payload hash, recipient, age and nonce. New installations run `enforce`
  (`src/config/secure-defaults.ts`, around line 134); an unset key runs as `warn` and is reported.
- **Persistent replay store.** `nonce-store.ts` `PersistentNonceCache`: each accepted nonce is
  appended to `<KOLO_HOME>/identity/agent-message-nonces.jsonl` and `fsync`ed before the message
  is accepted (`append`, lines 143 to 160); on first use after a start the file is read back and
  expired entries dropped (`load`, lines 90 to 123); 20,000 live entries; file 0600, folder 0700.
  One store is shared by the `agent` method and `sibling.send` (`sharedReplayGuard`, line 203).
- **Receiver-side access check (`agent` method).** `inbound.ts` `checkInboundAgentMessage`
  (line 71) re-checks `tools.agentToAgent.allow` and `subagents.allowAgents` for the verified
  sender (lines 129 to 141, `access.ts` `checkInterAgentAccess`); a denial follows the mode.
- **Payload validation (`agent` method).** `payload.ts`: size cap, control characters, chat-template
  tokens, hidden role markers.
- **Marking.** Cross-agent or unverified content is wrapped in the untrusted-content boundary with
  sender and trust, plus a gateway-written provenance note (`inbound.ts` lines 178 to 207).
- **`sibling.send`.** `sibling.ts` `checkSiblingSend` (line 99): when signed, the signer is the
  sender whatever the client id says; `enforce` refuses unsigned or failing sends; every send is
  audited as `sibling.message.verify`. The handler (`src/gateway/server-methods/sibling.ts`) checks
  that sender and recipient are configured agents (`validateSiblingName`, line 74), a 4 KB text cap
  and a rate limit. The file-inbox copy keeps the client's idempotency key out of the file name
  (only `[A-Za-z0-9_-]`) and quotes it in the front matter, and records `verified:` for the
  envelope (`writeToFileInbox`).

| STRIDE                 | Threat                                                | Control                                                 | Residual                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A client or plugin sends as another agent             | Ed25519 envelope, owner-signed registry                 | code running as the gateway user can read every agent key and the owner key. With no pinned owner the local owner key is trusted on first use. In `warn`, an unsigned `sibling.send` is delivered with the client-declared sender. |
| Tampering              | Message altered or redirected                         | payload hash, recipient binding                         | none identified for signed messages.                                                                                                                                                                                               |
| Repudiation            | Sender denies a message                               | `agent.message.verify` / `sibling.message.verify` audit | none identified; the file-inbox copy records `verified:`.                                                                                                                                                                          |
| Information disclosure | An agent messages an agent it is not allowed to reach | receiver-side allowlist on the `agent` method           | `sibling.send` does not apply `tools.agentToAgent.allow`: any registered signer can reach any configured agent, and with an empty `agents.list` any well-formed id.                                                                |
| Denial of service      | Replay or flood                                       | persistent nonces, rate limit, payload cap              | the store is bounded (a flood of valid signed messages can evict live nonces); if the file cannot be written, restart protection is lost until the next restart (logged once).                                                     |
| Elevation of privilege | Injected instructions in a peer's message             | untrusted-content wrapping and provenance note          | `sibling.send` text is written to the recipient's file inbox as plain Markdown, without the untrusted-content boundary; a reader that loads the inbox into a model sees it unmarked.                                               |

## Boundary 6: Business connectors (Microsoft 365, Gmail, Entra ID)

Bundled plugins on a shared connector core (`src/connectors/business/`), off by default, with no
tools until an administrator supplies the customer's own app registration. Reads are the default
scopes; writes (`m365_mail_send`, `m365_calendar_create_event`, `gmail_send`) are separate opt-ins.

Controls in code:

- **Sign-in.** Authorization code with PKCE S256 and `state` on a one-shot `127.0.0.1` listener
  with a bounded wait (`oauth.ts`, `loopback.ts` lines 48 to 71); device code as an alternative.
  Entra OIDC validation accepts RS256 only, checks issuer, audience, time claims and nonce
  (`oidc.ts`). ID tokens are never stored.
- **Token storage.** One secret per connector, `connector.<id>.token`, in the secret store;
  single-flight refresh (`token-store.ts`).
- **Untrusted-content wrapping.** `guardrails.ts` `wrapUntrusted` (line 146) wraps through
  `src/security/external-content.ts` `wrapExternalContent` (line 185), which also neutralises
  boundary markers (including full-width look-alikes) inside the content (`replaceMarkers`,
  line 114). Every read tool wraps provider text: mail lists and bodies
  (`extensions/microsoft-365/src/mail.ts` lines 63 and 179; `extensions/gmail/src/tools.ts` lines
  54 and 176), calendar lists and events (`calendar.ts` lines 60 and 140), file lists, file text
  and SharePoint sites (`files.ts` lines 51, 139 and 175), directory users and groups
  (`extensions/entra/src/directory.ts` lines 54 and 69).
- **Memory provenance.** All agent tools, plugin tools included, are wrapped by the memory guard
  (`src/agents/pi-tools.ts`, line 590). A result that carries the untrusted marker lowers the
  turn's trust to `external` (`src/memory/provenance-guard.ts` `externalInputReason`, line 286),
  and in `enforce` a later memory write is held in quarantine
  (see [Memory provenance](/security/memory-provenance)).
- **Writes need a person.** `requireWriteApproval` (`guardrails.ts`, line 119) asks through
  `askViaGateway` (`src/policy/guard.ts`, line 70) as an exec-approval record; anything but
  `allow-once`/`allow-always`, a timeout or an error is a denial. Writes also refuse without the
  granted scope.
- **Audit.** Connector calls write ids and counts only, never content (`guardrails.ts` `audited`).

| STRIDE                 | Threat                                                          | Control                                        | Residual                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A forged ID token or OAuth redirect                             | RS256-only OIDC checks, PKCE, `state`          | device-code sign-in can be phished like any device-code flow; the person must check the code they enter.                                                                                                                         |
| Tampering              | Injected instructions in mail, events, files or directory names | untrusted-content boundary, memory quarantine  | the boundary tells the model what is untrusted; it cannot make the model ignore it.                                                                                                                                              |
| Repudiation            | Who sent a message as the customer                              | approval record with approver, connector audit | the audit stores ids and counts, not the sent body.                                                                                                                                                                              |
| Information disclosure | Exfiltration through an approved send                           | approval with recipients and subject           | the approver sees at most the first 200 characters of the body (`bodyStart`, `mail.ts` line 224, `gmail/src/tools.ts` line 218) inside a 400-character preview (`src/policy/guard.ts` line 78). Data beyond that is sent unseen. |
| Denial of service      | Provider throttling, large files                                | retry with back-off, size cap before download  | provider quotas are shared with the customer's tenant.                                                                                                                                                                           |
| Elevation of privilege | Agent uses broader Graph or Gmail scopes than intended          | per-feature scopes, writes off by default      | `Files.Read.All`, `Sites.Read.All` and `Directory.Read.All` are tenant-wide when granted; scope is set by the app registration, not by Kurahi.                                                                                   |

## Agent file tools and the state directory

The default agent runs on the host (`agents.defaults.sandbox.mode: "non-main"` sandboxes groups,
channels, sub-agents and cron, not the main agent). Its `read`, `write`, `edit` and `apply_patch`
tools are rooted at the workspace but not confined to it; what keeps them away from credentials is
the signed policy's `data.neverRead` and `data.neverWrite` lists, checked at every call
(`src/policy/decisions.ts` `toolDecision`, through `src/policy/guard.ts`). Exec is covered by
approvals (`tools.exec.unsandboxed: "approve"`), not by these lists.

Fixed in this release:

- The starter policy written by `kurahi init` / `kurahi policy init` is generated for its state
  directory (`src/policy/starter.ts` `starterPolicyYaml`): `neverRead` adds `<KOLO_HOME>/secrets/**`
  and `neverWrite` adds `secrets/**`, `policy/**`, `kolo.json` and `audit/**`. Before, an agent's
  file tools could read the gateway token and the owner signing key without an approval.
- `~/` in those lists is the operating-system user's home (`src/policy/engine.ts`). Before, it was
  matched against the state directory, so `~/.ssh/**` did not protect the real `~/.ssh`.
- The policy and M5 path rules classify the `file_path` alias that the file tools accept
  (`src/agents/permissions.ts` `classifyToolCall`). Before, a call using `file_path` had no target
  and skipped the lists.

Still open: existing installations keep their old policy until the operator adds these entries
and re-signs it; the lists match the resolved path text, so a symbolic link inside the workspace
that points into the state directory is not caught; tools other than the file tools and the
legacy analyser (for example `image`, browser downloads) are not classified by path; a fresh
`kurahi init` grants the default agent every credential (`auth.grants.default: ["*"]`).

## Related gaps outside the six boundaries

- **MCP client tool results are not wrapped.** Results from MCP servers the gateway connects to
  (`src/mcp/client/`) reach the model without the untrusted-content boundary. They do lower memory
  trust (`provenance-guard.ts` line 268), and the system prompt names tool and MCP output as
  untrusted data (`src/prompt/koloPrompt.ts`).
- **Channel messages are not wrapped.** Messages from channel users reach the model as user
  messages; their memory writes are tagged `channel`, which the default `quarantineTrust`
  (`["external"]`, `src/memory/provenance.ts` line 33) does not hold. Webhook-triggered external
  hooks (for example Gmail hooks) are wrapped (`src/cron/isolated-agent/run.ts`).

## Residual-risk summary

| #   | Boundary        | Residual risk                                                                                                                                | Severity                    | Depends on                                       |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| 1   | All             | Any process running as the gateway's OS user can read the gateway token, agent and owner keys, auth profiles and the file-backend secret key | High                        | inherent; use a dedicated OS user per gateway    |
| 2   | Terminal        | An approved program on the host runs with the OS user's full rights; the sandbox is off by default                                           | High                        | `console.terminal.sandbox: "required"`           |
| 3   | Connectors      | Approved sends show only the first 200 characters of the body; injected content can exfiltrate data through an approved message              | Medium                      | write tools are opt-in                           |
| 4   | Connectors, all | Untrusted-content markers reduce prompt injection but do not prevent it                                                                      | Medium                      | keep tools narrow for agents that read mail      |
| 5   | Inter-agent     | `sibling.send` does not apply `tools.agentToAgent.allow` (roster check only)                                                                 | Medium                      | code change needed                               |
| 6   | Inter-agent     | `sibling.send` file-inbox copies are written without the untrusted-content boundary (the `verified:` flag is recorded)                       | Medium                      | code change needed                               |
| 7   | Inter-agent     | Registry trust on first use when no owner is pinned; `warn` mode on legacy configs delivers unsigned messages                                | Medium                      | pin owners; `signing.mode: "enforce"`            |
| 8   | Model providers | Policy egress covers tool arguments only and is a denylist by default; provider, connector and MCP traffic is not filtered                   | Medium                      | OS or network firewall; `network.egress.allow`   |
| 9   | Model providers | Project source and connector data in the model context leave the computer; PII placeholders are off in the starter policy                    | Medium                      | provider choice; `data.redact`                   |
| 10  | Desktop         | The gateway token is held by the webview; script in the webview would have full operator access                                              | Medium                      | CSP `script-src 'self'` limits this              |
| 11  | Terminal        | Approval is confirmation by the same person, not two-person control                                                                          | Medium                      | process; separate approver identities            |
| 12  | Gaps            | MCP client results and channel messages are not wrapped; channel-trust memory writes are not quarantined by default                          | Medium                      | `memory.provenance.quarantineTrust`              |
| 13  | Desktop         | No `Origin` allowlist on the gateway WebSocket; `connect-src` allows every loopback port                                                     | Low                         | token and rate limiter remain                    |
| 14  | Desktop         | Any local process that binds the configured loopback port first receives the token from Desktop                                              | Low                         | local code execution                             |
| 15  | Desktop         | Service control trusts `KURAHI_CLI` or the first `kurahi` on `PATH`                                                                          | Low                         | writable `PATH` entries                          |
| 16  | Legacy MCP      | HTTP without TLS; generated token printed to stderr; body cap by `Content-Length` only; audit file not tamper-evident                        | Low                         | stdio transport avoids most of these             |
| 17  | Inter-agent     | Bounded replay store; write failure drops restart protection until next restart                                                              | Low                         | disk health                                      |
| 18  | Model providers | Credential files rely on 0600 (set after the write) or, on Windows, on the profile ACL                                                       | Low                         | OS account hygiene                               |
| 19  | All             | `gateway.bind` beyond loopback serves plain `ws`; Control UI insecure-auth switches weaken authentication                                    | High if set, otherwise none | keep `bind: loopback`; leave the switches unset  |
| 20  | File tools      | Installations created before 2.1.0 keep a starter policy without the state-directory entries; the main agent's file tools can read secrets   | High on old installs        | add the entries and `kurahi policy sign`         |
| 21  | File tools      | Path lists match resolved text, not real paths: a symbolic link into the state directory is not caught; non-file tools are not path-checked  | Medium                      | sandbox the main agent; keep links out           |
| 22  | File tools      | A fresh `kurahi init` grants the default agent every credential (`auth.grants.default: ["*"]`)                                               | Low on one-agent installs   | narrow grants when adding agents                 |
| 23  | All             | `<KOLO_HOME>/logs` is created 0755 with 0644 log files, readable by other local users                                                        | Low                         | dedicated OS user; tighten permissions           |
| 24  | Supply chain    | 15 dependency advisories remain after this release's updates (none in the gateway's request handling); see the release notes                 | Low to Medium               | planned upgrades of `pi-coding-agent` and others |

## Related

- [Security overview](/security/SECURITY_OVERVIEW)
- [Secure defaults](/security/secure-defaults)
- [OWASP Agentic Top 10](/security/owasp-agentic)
- [Console terminal broker](/security/terminal-broker)
- [Agent message signing](/security/agent-message-signing)
- [Memory provenance](/security/memory-provenance)
- [Legacy analyser in your editor](/tools/legacy-mcp)
