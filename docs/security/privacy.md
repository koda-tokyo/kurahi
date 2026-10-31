---
summary: "Privacy statement: what leaves the machine, what is stored, how long, how to switch each flow off, how to wipe"
read_when:
  - Answering a data-protection question about Kurahi
  - Configuring Kurahi for an environment with network restrictions
title: "Privacy"
---

# Privacy statement

Also available in [Japanese](/ja/security/privacy).

Kurahi is self-hosted. It runs on your machine, stores its data under one directory you control, and sends data only where you configure it to. This page is the complete list.

## What leaves the machine, and how to stop it

| Flow                       | Content                                                               | Destination                                | On by default                     | Off switch                                                                       |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------- |
| Model requests             | the conversation (prompts, tool results) and the agent's instructions | the model provider you configured          | no provider until you choose one  | pick the `local` profile (a model server on this machine) or remove the provider |
| Messaging channels         | messages you exchange through the channel                             | that channel's service (LINE, Telegram, …) | none enabled                      | leave channels disabled                                                          |
| Update check               | version metadata only (no identifiers beyond the HTTP request)        | the package registry                       | on gateway start for npm installs | `update.checkOnStart: false`                                                     |
| Local network announcement | the gateway's name over mDNS/Bonjour                                  | your LAN                                   | minimal                           | `gateway.discovery.mdns.mode: "off"`                                             |
| Installer                  | downloads the release bundle and checksums                            | github.com                                 | at install only                   | offline install (`--bundle`)                                                     |

There is no telemetry, no analytics, no crash reporting, no usage statistics and no "phone home". Kurahi does not transmit anything to its vendor at runtime. Support bundles (`kurahi support`) are written locally and sent only if you attach them to a ticket.

A configuration with every outbound flow off:

```json5
{
  update: { checkOnStart: false },
  gateway: { bind: "loopback", discovery: { mdns: { mode: "off" } } },
  agents: { defaults: { model: { primary: "ollama/<local model>" } } },
}
```

## What is stored, where, for how long

All of it is under `KOLO_HOME` (`~/.kolo`; Windows `%LOCALAPPDATA%\KoLo`), owned by the service user.

| Data                                       | Path                                                 | Retention                                              | Contains personal data?                                                                                |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Configuration                              | `kolo.json`                                          | until changed                                          | names and identifiers you enter                                                                        |
| Gateway token, secrets, device credentials | `secrets/` (mode 0600; credentials stored as hashes) | until revoked or wiped                                 | no                                                                                                     |
| Conversations                              | `agents/<id>/sessions/`                              | until you delete them; never uploaded                  | yes, whatever you typed                                                                                |
| Workspace and memory                       | `workspace/`                                         | until wiped                                            | possibly, if the agent stored it                                                                       |
| Logs                                       | `logs/`                                              | daily files; delete freely; secrets redacted           | message metadata, not bodies by default                                                                |
| Audit chain                                | `audit/`                                             | monthly files; keep per your policy                    | identities and actions, not message bodies                                                             |
| Evidence logs                              | `evidence/<jobId>/`                                  | `evidence.retentionDays` (30); `kurahi evidence prune` | digests of prompts and replies, redacted and bounded tool arguments and results, file paths; see below |
| Evidence exports                           | `evidence-exports/`                                  | until you delete them                                  | a copy of one job's evidence as a bundle                                                               |
| Support bundles                            | `support/`                                           | only when you run `kurahi support`                     | redacted config and log tail                                                                           |

Model providers and channel services keep their own copies under their own terms; read theirs before sending regulated data.

## Evidence bundles

Every agent job records a hash-chained event log ([evidence](/evidence)) so that what an agent did can
be shown and verified later. By default a bundle contains:

- job identity: agent id, session key, kind, start and end time, outcome, the provider and model
  profile requested;
- for each model turn: token counts, a SHA-256 digest and the length of the assistant text, and a
  redacted excerpt of at most 512 bytes;
- for each tool call: the tool name, a digest of the arguments, the arguments and the result text after
  secret redaction and cut to `evidence.maxEventBytes` (8 KiB), duration and error flag;
- the paths and pre-edit contents of files that edit tools changed (the same snapshots `/undo` uses);
- permission decisions, loop-guard verdicts, and the sequence numbers of related audit entries;
- the audit entries written for the job's session during the job.

A bundle never contains: gateway tokens, pairing credentials, provider API keys or the signing private
key (the manifest carries only the public key); values under secret-looking keys or matching token
patterns (replaced by `[redacted]`); the raw prompt or the full assistant text unless
`evidence.includePrompts` is `true`; conversations of other sessions; anything a tool did not pass
through the runtime.

Evidence stays under `KOLO_HOME` until `evidence.retentionDays` elapse (`kurahi evidence prune`
applies it on demand) and is never uploaded. `evidence.enabled: false` turns recording off. Tool
arguments and results can hold personal data the agent handled; treat exported bundles as you treat
the conversations they come from.

## Access

- Only the service user can read `KOLO_HOME`; secrets are 0600.
- Every network route requires a credential except the liveness probe (`/health`: status, version, uptime).
- Devices you pair get a scoped, revocable credential; `kurahi pair list` shows them, `kurahi pair revoke <id>` removes one.
- Every access is recorded in the audit chain (`kurahi audit tail`).

## Deleting data

- One conversation: delete its file under `agents/<id>/sessions/` while the gateway is stopped, or use `kurahi sessions` to find it.
- Everything: `kurahi uninstall --all --yes` removes `KOLO_HOME` and the workspace; remove the install prefix to delete the program. `--dry-run` shows the list first.
- Paired devices: revoke them before wiping if you want the audit record of the revocation; after a wipe their tokens are void anyway.

## Questions

Privacy and security questions: security@kodasoken.com. Vulnerability reports follow the process in the repository's `SECURITY.md`.
