# Security Policy

## Reporting a vulnerability

Report privately to **security@kodasoken.com**. Do not open a public issue for anything that could be a security problem.

Include:

- the version (`kurahi --version`) and OS,
- reproduction steps or a minimal proof of concept,
- the impact as you understand it,
- whether the issue is already public anywhere.

If you prefer encrypted mail, say so in a first plain message and a key will be sent back.

## What to expect

| Step                                                    | Target                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Acknowledgement                                         | within 3 working days                                                                                            |
| Triage and severity                                     | within 10 working days                                                                                           |
| Fix or mitigation for confirmed high or critical issues | within 30 days, earlier when exploitation is likely                                                              |
| Public disclosure                                       | coordinated with the reporter after a fix is available; at most 90 days after the report unless agreed otherwise |

Credit is given in the release notes unless you ask not to be named. There is no paid bounty programme at this time.

## Supported versions

Security fixes are released for the latest stable release and the latest beta. Older releases are not patched; upgrade with `kurahi update`.

| Version                                         | Security fixes |
| ----------------------------------------------- | -------------- |
| 2.1.x (includes the Industrial Edition)         | Yes            |
| Kurahi Desktop 0.3.x (ships with 2.1.x)         | Yes            |
| Latest beta of the next release                 | Yes            |
| 2.0.x and earlier, Kurahi Desktop 0.2 and older | No: upgrade    |

## Scope

In scope: the gateway, the CLI, the service supervisor, pairing, the secrets store, the audit log and integrity gate, the policy engine, the web UI, Kurahi Desktop, the Work Console terminal broker, the business connectors (Microsoft 365, Gmail, Entra ID), the legacy analyser MCP server, channel extensions in this repository, the install scripts.

Out of scope: exposing the gateway to the public internet without the documented remote bind and token setup; prompt injection against a model you chose to connect; vulnerabilities in third-party services you connect through channels; issues that require an attacker to already hold the owner token or local shell access as the service user.

## Security properties you can rely on

- The gateway binds to loopback by default. A remote bind requires an explicit opt-in and a token.
- Every `/api/*` route and every WebSocket method requires a credential; the only open routes are `/health` and `/api/health`, which return status, version and uptime without authentication and full detail only with a credential.
- Credential attempts are rate limited per source.
- Pairing uses one-shot invitations with a scope, device-key proofs over a server nonce, short-lived access tokens and rotating refresh tokens; reuse of a retired refresh token revokes the whole family.
- Secrets live in an encrypted store under `KOLO_HOME/secrets` (file mode 0600); tokens are never read from the command line.
- The audit log is append-only and hash-chained; `kurahi audit verify` detects truncation or edits.
- The boot integrity gate refuses to start the gateway when a registered file has changed.

The security guide for operators is at https://kodasoken.com/kolo/security.

## Runtime requirements

Kurahi requires Node.js 22.12.0 or later, which carries the current security patches for the runtime. Check with `node --version`.

## Software bill of materials

Each release can be described with CycloneDX SBOMs for the runtime (production npm dependencies) and for Kurahi Desktop (Rust crates and the bundled frontend), with licences:

```bash
pnpm sbom    # writes release-out/sbom/kurahi-runtime.cdx.json, kurahi-desktop.cdx.json, licence-flags.md
```

## Secret scanning

CI runs `detect-secrets` against `.secrets.baseline`. Run it locally with:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
