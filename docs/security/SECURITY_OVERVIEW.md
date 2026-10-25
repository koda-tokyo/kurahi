---
summary: "Security overview for an enterprise questionnaire: what leaves the machine, where secrets live, audit chain, integrity gate, bind policy, retention, wipe"
read_when:
  - Filling in a security questionnaire about Kurahi
  - Reviewing Kurahi before an evaluation
title: "Security Overview"
---

# Kurahi security overview

日本語版: [セキュリティ概要](/ja/security/SECURITY_OVERVIEW)

This page answers the questions a security review asks about a self-hosted Kurahi installation. Each statement names the mechanism and, where one exists, the command that verifies it. Version: this page describes Kurahi 2.0.0 and later; check `kurahi --version`.

## 1. Deployment model

- Kurahi is self-hosted software. One gateway process per identity runs on the evaluator's machine or server under the OS service manager (systemd user service, launchd agent, Windows Task Scheduler). There is no Kurahi-operated cloud component in the evaluation configuration.
- All state lives in one directory, `KOLO_HOME` (`~/.kolo` on Linux and macOS, `%LOCALAPPDATA%\KoLo` on Windows). Nothing is written elsewhere except the program files in the install prefix.
- Clients (terminal, web UI, paired devices, messaging channels) connect to the gateway over WebSocket and HTTP; the gateway makes outbound calls to the configured model provider and to any channel the operator enables.

## 2. What leaves the machine

| Flow                                            | Destination                                                                                                                   | Default                             | How to disable                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| Model requests (prompts, tool results, replies) | the provider configured by the operator (default profile: a Japan-hosted, OpenAI-compatible service; or a local model server) | only after a provider is configured | choose the `local` profile in `kurahi init` |
| Messaging channels                              | the channel operator's API (LINE, Telegram, etc.)                                                                             | none enabled                        | do not enable channels                      |
| Update check                                    | the package registry, version metadata only                                                                                   | on gateway start for npm installs   | `update.checkOnStart: false` in `kolo.json` |
| mDNS/Bonjour announcement                       | local network broadcast of the gateway name                                                                                   | minimal                             | `gateway.discovery.mdns.mode: "off"`        |
| Installer download                              | github.com (release bundle and SHA256SUMS.txt)                                                                                | at install time only                | offline install with `--bundle`             |

No telemetry, analytics, crash reporting or usage statistics are sent. The gateway does not contact Kurahi or its vendor at runtime. See [Privacy](/security/privacy) for the full statement.

## 3. Network exposure and bind policy

- Default bind is loopback (`127.0.0.1` / `::1`). Remote access requires an explicit `gateway.bind` setting (`lan`, `tailnet`, `custom`) and a token on every connection.
- Every HTTP route under `/api/*` and every WebSocket method requires a credential. The only open routes are `GET /health` and `GET /api/health`, which return status, version and uptime; readiness detail requires a credential.
- Credential attempts are rate limited per source address (20 per minute).
- The API is described by an OpenAPI 3.1 document (`GET /doc`, credential required); every operation declares its minimum scope.

## 4. Authentication and authorisation

- Gateway secret: a random 256-bit token generated at `kurahi init`, stored at `KOLO_HOME/secrets/gateway.token` with file mode 0600, never passed on the command line.
- Device pairing: one-shot invitations with a scope (`observe` < `attach` < `admin` < `owner`) and a minutes-scale expiry; the device proves possession of an Ed25519 key over a server nonce; it receives a short-lived access token and a rotating refresh token. Reuse of a retired refresh token revokes the whole token family. Devices can be revoked at any time (`kurahi pair revoke`). Re-consent is required after a configurable period (default 90 days).
- Session allowlists limit a credential to named sessions or agents.
- Tool execution for agents runs under the operator's exec approvals (`kurahi approvals`) and sandbox settings.

Verify: `kurahi pair list`, `kurahi pair invite --scope observe` followed by an attempt on an admin route (expect 403).

## 5. Secrets

- Provider keys and channel tokens are stored in the auth profile store and the encrypted secrets store under `KOLO_HOME` (`kurahi secrets list` shows the backend). Configuration files reference secrets by name; `kurahi secrets migrate` moves plaintext values out of `kolo.json`.
- Secrets are never printed by any command, never accepted as command-line arguments (use `--stdin` or the environment), and are redacted from logs by the log redactor.
- Importing credentials from other tools' credential files is opt-in (`kurahi doctor --verbose`), never automatic.

## 6. Audit log

- Every authentication, pairing, attach/detach, admin action and tool execution is appended to a hash-chained audit log under `KOLO_HOME/audit/` (one file per month; each entry carries the hash of the previous entry).
- `kurahi audit verify` recomputes the chain and reports the first break; `kurahi audit tail` shows recent entries. The log is append-only from the gateway's point of view; tampering is detectable, not preventable, unless the files are shipped to write-once storage.

## 7. Boot integrity gate

- `kurahi integrity init` records SHA-256 digests of the installation's protected policy files (agent instructions, policies). On every start the gateway re-verifies them; in `enforce` mode a mismatch refuses to boot (exit code 3), in `warn` mode it starts and reports `integrity: warn` on `/health`.
- Verify: change a registered file, restart, observe the refusal in `kurahi service logs`.

## 7a. Policy as code

- One declarative policy per gateway, `KOLO_HOME/policy/policy.yaml`: per-agent tool allow/deny lists and permission globs, allowed providers, models and channels, budgets (tokens/day, cost/day, tool calls/hour, wall clock per job) with warn/pause/stop, a kill switch, tool classes that need a human approval, egress and MCP allow lists, paths never read or written, secret patterns, and HTTP/WebSocket operations refused per credential scope. `kurahi policy schema` prints the JSON Schema; see the policy page in the docs.
- Attested: the document is signed by an owner key (Ed25519) into `policy.yaml.sig`; the keys a signature may come from are pinned in `owners.json`. In `enforce` mode (default) an unsigned, altered or untrusted document is refused: at boot the gateway exits 3, at runtime the last accepted document stays active. `policy.mode: audit` loads it with a warning; the mode is configuration, never the document.
- Enforced at every tool call (core, MCP and Code Mode), every model request, every channel message in and out, every authenticated HTTP/WebSocket request and every job start; each decision is an audit entry with the id of the clause that decided. The policy files are protected files for the boot integrity gate.
- Kill switch: `kurahi policy kill --agent <id>|--all`, `POST /api/policy/kill`, WS `policy.kill` (owner or admin; `kill.mayFlip` can narrow it). Running jobs are aborted and new work refused within one event-loop tick; the state survives a restart until `release`.
- Verify: `kurahi policy init`, edit the file without re-signing, restart, observe the refusal in `kurahi service logs`; `kurahi policy kill --all` during a turn and watch the job end as `cancelled` in `kurahi api listJobs`. `pnpm policy:check` runs this end to end against a throwaway gateway.

## 8. Data at rest and retention

| Data                                                     | Location                          | Retention                                                            |
| -------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Configuration                                            | `KOLO_HOME/kolo.json`             | until changed or wiped                                               |
| Gateway token, secrets, device credentials (hashes only) | `KOLO_HOME/secrets/` (0600)       | until revoked or wiped                                               |
| Sessions and transcripts                                 | `KOLO_HOME/agents/<id>/sessions/` | kept until deleted (`kurahi sessions`, or wipe); no automatic upload |
| Agent workspace and memory                               | `KOLO_HOME/workspace/`            | until wiped                                                          |
| Logs                                                     | `KOLO_HOME/logs/`                 | rotated daily; delete freely                                         |
| Audit chain                                              | `KOLO_HOME/audit/`                | monthly files; keep as long as policy requires                       |
| Support bundles                                          | `KOLO_HOME/support/`              | created only by `kurahi support`; redacted                           |

Files are protected by OS permissions of the service user. Full-disk encryption of the host is recommended; Kurahi does not add its own disk encryption beyond the secrets store.

## 9. Wipe

```bash
kurahi service uninstall            # stop and remove the OS service
kurahi uninstall --all --yes        # remove KOLO_HOME (config, secrets, sessions, audit, logs) and the workspace
rm -rf <install prefix>           # ~/.local/share/kolo and ~/.local/bin/kolo, or %LOCALAPPDATA%\KoLo
```

`kurahi uninstall --all --yes --dry-run` lists what would be removed. Nothing remains outside those paths. Paired devices hold only tokens that the removed gateway issued; they become useless.

## 10. Software supply chain

- Release bundles are published with a `SHA256SUMS.txt` file; the installers refuse a download whose digest does not match.
- `pnpm release:check` proves the package contains every file its entry points import; `pnpm pack:check` installs the packed tarball into an empty directory and runs it in CI.
- Dependencies are pinned in `pnpm-lock.yaml`; CI runs a secret scanner on the source.
- Releases: SHA-256 sums, a CycloneDX SBOM and build provenance attestation are published with every release. Code signing of the macOS and Windows binaries is planned (see the public roadmap).

## 11. Vulnerability handling

Report to security@kodasoken.com. Acknowledgement within 3 working days, triage within 10, fixes for confirmed high or critical issues within 30 days, coordinated disclosure at most 90 days after the report. Details in the repository's `SECURITY.md`.

## 12. Licensing and provenance

Open core: MIT for the protocol, SDK, plugin API and CLI; Functional Source License (FSL-1.1-Apache-2.0) for the gateway runtime and its subsystems; a proprietary licence for the identity engine and enterprise features. Third-party components keep their licences (`NOTICE`, `ATTRIBUTION.md`). Evaluation terms: [Evaluation licence](/EVALUATION_LICENSE).

## 13. Agent-specific controls

Controls for the risks that are specific to agents, each on its own page with its modes and its
limits. New installations get them switched on; existing installations are told by `kurahi doctor`
which ones are still off ([Secure defaults](/security/secure-defaults)).

| Control                                                      | What it does                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [Supply-chain lock](/security/skill-integrity)               | Skills and plugins load only when their SHA-256 matches a pin in a lock signed by the owner key                              |
| [Memory provenance](/security/memory-provenance)             | Every memory write records who wrote it; writes after untrusted input are held for operator review                           |
| [Agent message signing](/security/agent-message-signing)     | Messages between agents are signed per agent and verified (sender, recipient, time, nonce, payload schema)                   |
| [Console terminal broker](/security/terminal-broker)         | The Work Console shell is owned by the gateway: each line gated, approvals, file diffs, audit                                |
| [Secure defaults](/security/secure-defaults)                 | Credential isolation, sandbox, exec approvals, budgets and the destructive-command guard on new installations                |
| [Attachment intake](/security/attachment-intake)             | Mail attachments are quarantined, checked by a static policy and malware-scanned (fail closed) before a Project stores them  |
| [Enterprise identity](/security/identity)                    | OIDC / SAML sign-in for people, SCIM provisioning, roles and org units, SSO required with audited break-glass                |
| [Autopilot watchdog and stop](/autopilot#behaviour-watchdog) | A routine whose run exceeds its baseline executes nothing and pauses; `autopilot.stopAll` and a STOP file stop every routine |

How these map to the OWASP Top 10 for Agentic Applications, with a rating per risk:
[OWASP Agentic Top 10](/security/owasp-agentic).
