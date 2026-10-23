---
summary: "Secure defaults for new installations: credential isolation, the exec sandbox, exec approvals, the supply-chain lock for skills and plugins, memory quarantine, signed inter-agent messages, the destructive-command guard, budgets and job limits; how existing installs are warned instead of changed"
read_when:
  - Installing Kurahi for an evaluation or a production pilot
  - Upgrading an existing installation and reading a "secure defaults" warning
  - Answering OWASP Agentic Top 10 questions (ASI03, ASI04, ASI05, ASI06, ASI07, ASI08)
title: "Secure defaults"
---

# Secure defaults

New installations start secure. Existing installations keep the behaviour they were set up
with and are told, by `kurahi doctor` and at gateway startup, which settings still use an old
permissive default. Nothing changes silently and nothing crashes.

## What a new installation gets

`kurahi init`, `kurahi setup` and onboarding write these values when they create a fresh config
(`kurahi init --force` counts as fresh). They never override a value that is already set.

| Setting                           | Old default (still the fallback when unset)                                                 | New installations                                                                                                                                           | OWASP |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `auth.isolation`                  | `inherit`: every agent sees the main agent's credentials                                    | `explicit`; the identity agent `kurahi init` creates gets `auth.grants.<id>: ["*"]`, every other agent only what it is granted                              | ASI03 |
| `agents.defaults.sandbox.mode`    | `off`: no session runs in a container                                                       | `non-main` with `workspaceAccess: "rw"`: groups, channels, sub-agents and cron run in the container sandbox                                                 | ASI05 |
| `tools.exec.unsandboxed`          | `host`: where no sandbox is active, commands run on the host with no approvals              | `approve`: commands outside a sandbox go through exec approvals (allowlist, ask on miss)                                                                    | ASI05 |
| Policy file (budgets, job limits) | none: no budgets, no job limits                                                             | the starter policy, signed with a local owner key (`kurahi policy init`)                                                                                    | ASI08 |
| `integrity.supplyChain.mode`      | `warn`: unpinned or modified skills and plugins load with a warning                         | `enforce`: a non-bundled skill or plugin loads only when its SHA-256 is pinned in the signed lock ([details](/security/skill-integrity))                    | ASI04 |
| `memory.provenance.mode`          | `warn`: memory writes are tagged and flagged, but writes after untrusted input still land   | `enforce`: memory writes after untrusted input (or that look like injected instructions) are held for review, see [Memory provenance](memory-provenance.md) | ASI06 |
| `agents.messaging.signing.mode`   | `warn`: unsigned, forged, replayed or malformed inter-agent messages are delivered, flagged | `enforce`: they are rejected (see [Agent message signing](/security/agent-message-signing))                                                                 | ASI07 |
| `console.terminal`                | off: the console terminal methods refuse every request                                      | `enabled: true`, `actApprovals: "always"`: every act-mode command that is not read-only waits for an approval ([details](/security/terminal-broker))        | ASI05 |

Always on, for every installation: the destructive-command guard (below).

### Starter budgets and job limits

The starter policy (`<KOLO_HOME>/policy/policy.yaml`, source `src/policy/starter.ts`) sets:

| Limit                         | Value                     | On breach               |
| ----------------------------- | ------------------------- | ----------------------- |
| Concurrent jobs per agent     | 4                         | the next job is refused |
| Wall clock per job            | 30 minutes (1,800,000 ms) | the job is stopped      |
| Tool steps per job            | 200                       | the job is stopped      |
| Tokens per agent per day      | 5,000,000                 | pause                   |
| Tool calls per agent per hour | 1,200                     | pause                   |
| Fleet tokens per day          | 20,000,000                | pause                   |
| Fleet tool calls per hour     | 5,000                     | pause                   |

A pause holds new work for that agent (or the fleet) until the window resets, or until an
operator runs `kurahi policy release --agent <id>` (or `--all`). Change the numbers by editing
the policy and running `kurahi policy sign`; the gateway reloads it on save. Day windows reset at
`budgets.resetHourUtc` (00:00 UTC by default).

## When a protection needs something that is not installed

The sandbox needs a container runtime (Docker) and the sandbox image (`scripts/sandbox-setup.sh`).
When a session must be sandboxed and the container cannot start:

- the run continues; it does not fail;
- `exec` is refused with the reason and the fix (install Docker, or set
  `agents.defaults.sandbox.mode: off` to run commands on the host through approvals);
- file tools stay inside the agent workspace;
- browser host control is off.

Exec never falls back to running on the host unprotected. `kurahi init` and `kurahi doctor`
report a missing container runtime.

Project sessions (Desktop projects) are not put in the container: the project scope already
confines them (files only in the project folder, writes only to its writable folders, exec never
granted, see `src/projects/scope.ts`), and a container would hide the project folder.

## Destructive-command guard

Every path that turns agent output into a shell command checks it first against an
unconditional blocklist (`src/security/hardline-guard.ts`): recursive deletes of `/`, system
folders or the home folder, deleting `KOLO_HOME` or its vault, `mkfs`, `dd` or redirects to a
raw block device, fork bombs, `kill -1`, shutdown and reboot, `wsl --shutdown`, killing the
gateway, and `sudo -S` password guessing. The check normalises fullwidth characters, ANSI
escapes and shell escape tricks first.

A blocked command is refused, never queued for approval. No allowlist, approval, elevated mode
or `security: full` can run it. Every decision is written to the hash-chained audit log as
`exec.guard`, `denied` with the pattern, or `allowed` (`kurahi audit tail`).

Wired into: the `exec` tool (sandbox, gateway and node hosts), `process` write, send-keys and
paste, the `nodes` tool `run` action, `system.run` on node hosts, and the `lobster` plugin.

## Existing installations

An installation whose config predates these defaults keeps working exactly as before. It gets:

- a **Secure defaults** section in `kurahi doctor`, one item per unset setting with the fix;
- `secure-defaults.*`, `policy.present` and `supply-chain.lock` checks in `kurahi doctor --json`;
- `secure defaults:` warnings in the gateway log at startup;
- a one-time warning the first time exec runs on the host without a sandbox and without
  `tools.exec.unsandboxed` set.

A setting that is set explicitly, even to the old value (for example
`tools.exec.unsandboxed: "host"`), is treated as a decision and not warned about.

To adopt the secure defaults on an existing installation:

```bash
kurahi config set auth.isolation explicit
kurahi config set auth.grants.<your-agent-id> '["*"]'   # the owner's own agent keeps all credentials
kurahi config set agents.defaults.sandbox.mode non-main
kurahi config set agents.defaults.sandbox.workspaceAccess rw
kurahi config set tools.exec.unsandboxed approve
kurahi config set agents.messaging.signing.mode enforce
kurahi policy init                                        # signed starter policy
kurahi skills pin --all && kurahi plugins pin --all       # review first: this approves what is on disk
kurahi config set integrity.supplyChain.mode enforce
```

Grant every other agent the profile ids it needs in `auth.grants.<agent-id>` before switching
isolation on; an agent without a grant has no credentials under `explicit`.
