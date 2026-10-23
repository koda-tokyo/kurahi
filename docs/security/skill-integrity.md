---
summary: "Supply-chain lock for skills and plugins: SHA-256 pins signed by the owner key, verified at load (off / warn / enforce), the pin-time static scan, and what it does not cover"
read_when:
  - Installing or updating a skill or plugin on an installation in enforce mode
  - Reading a "supply-chain" warning or a refused skill/plugin in the gateway log
  - Answering OWASP Agentic Top 10 questions (ASI04, agentic supply chain)
title: "Skill and plugin integrity"
---

# Skill and plugin integrity (supply-chain lock)

Skills (`SKILL.md` folders) and plugins (extension packages) are code and instructions the agent
runs with. Kurahi pins the exact content an operator approved and checks it again every time the
loader is about to read it. An unpinned or changed skill or plugin is refused (enforce) or loaded
with a warning (warn).

## The lock

`<KOLO_HOME>/integrity/supply-chain.lock.json` holds one entry per approved artifact, keyed by
`skill:<name>` or `plugin:<id>`:

```json
{
  "kind": "skill",
  "name": "weather",
  "path": "/home/me/.kolo/workspace/skills/weather",
  "sha256": "4bacdd590d00…",
  "files": 3,
  "bytes": 2210,
  "pinnedAt": "2026-10-22T14:00:00.000Z",
  "scan": { "findings": ["pipe-to-shell"], "forced": true }
}
```

- **Digest** (`src/integrity/supply-chain-hash.ts`): SHA-256 over one line per regular file,
  sorted by relative path: `<relPath>\0<sha256 of the file>\n`. `node_modules` and `.git` are
  skipped at any depth. Symlinks are followed. A one-file plugin digests as that file; a package
  plugin as its package folder. File modes, timestamps and empty folders are not included.
- **Signature**: the lock is signed with the local owner key (`<KOLO_HOME>/secrets/policy-owner.json`,
  the same Ed25519 key and `policy/owners.json` as the [policy attestation](/security/secure-defaults))
  under its own signing domain, into `supply-chain.lock.json.sig`. A lock signature can never
  pass as a policy signature, and the reverse is also true.
- **Trust**: signed by a pinned owner: trusted. No owner pinned at all: trusted, but reported as
  `unsigned`. Owners are pinned but the signature is missing, invalid or from another key:
  **untrusted**. Enforce then refuses every non-bundled skill and plugin until the operator
  re-pins with `--all`.
- **Write protection**: the lock is under `<KOLO_HOME>/integrity`, which the integrity write
  policy already denies to agent tools. `kurahi skills pin` and `kurahi plugins pin` are refused
  when an agent runs them through `exec` (`src/integrity/write-policy.ts`).

## Modes

`integrity.supplyChain.mode`:

| Mode                     | Unpinned, modified, unreadable, or lock untrusted                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `enforce` (new installs) | not loaded; gateway log warning; audit `supply-chain.refused` (`denied`)                                          |
| `warn` (fallback, unset) | loaded; log warning once per process; a modified artifact or untrusted lock also audits `supply-chain.unverified` |
| `off`                    | no check                                                                                                          |

Where the check runs:

- **Skills**: in the skill loader (`src/agents/skills/workspace.ts` → `src/agents/skills/integrity.ts`),
  on the merged set (workspace, managed, `skills.load.extraDirs`, plugin-provided skill folders)
  before any `SKILL.md` reaches a prompt, a snapshot or the sandbox copy. A refused skill is
  dropped. It does not fall back to a lower-precedence skill with the same name.
- **Plugins**: in `loadPluginCandidate` (`src/plugins/loader.ts`), after the enable checks and
  before the module is imported. A refused plugin is quarantined with the reason, like a plugin
  that fails to load. The same check runs on hot reload.

**Exempt**: bundled skills and bundled plugins, which ship inside the runtime package and have
the same trust as its code. A byte-identical copy of a bundled skill is also exempt (the sandbox
workspace holds copies).

## Pinning (review and approve)

```bash
kurahi skills verify                 # status of every skill and plugin against the lock
kurahi skills pin weather            # scan, then pin one skill
kurahi skills pin --all              # every non-bundled skill; drops entries that no longer exist
kurahi plugins pin my-plugin
kurahi plugins pin --all
kurahi skills pin risky --force      # pin even though the scan flagged it (recorded in the lock)
```

`--agent <id>` reads that agent's workspace instead of the default agent's workspace. `--json`
prints machine-readable output. Every pin writes a `supply-chain.pin` audit row. After
`kurahi plugins install`, the plugin is not approved yet: pin it after you have reviewed it.

### Pin-time static scan

Before pinning, `src/integrity/supply-chain-scan.ts` checks every text file (up to 1 MB each,
binary files are skipped) for:

| Rule              | Looks for                                                                  |
| ----------------- | -------------------------------------------------------------------------- |
| `pipe-to-shell`   | `curl`/`wget` piped into `sh`, `bash`, `zsh`, …                            |
| `base64-exec`     | `base64 -d … \| sh`, `eval(atob(…))`, `exec(b64decode(…))`                 |
| `shell-rc-write`  | `>>`, `>` or `tee` into `.bashrc`, `.zshrc`, `.profile`, …                 |
| `credential-path` | `~/.ssh`, `~/.aws`, `.aws/credentials`, `~/.gnupg`, `~/.kube`, `id_rsa`, … |
| `reverse-shell`   | `/dev/tcp/`, `nc -e`                                                       |

A finding blocks the pin and shows the file, line and text. Pass `--force` after reading it if
the content is intended. **This is a tripwire for obvious patterns, not a malware scanner.**
Obfuscated, split or binary payloads, prompt-injection text and malicious logic that looks
ordinary all pass it. A clean scan proves nothing. The review is still the operator's job.

## Existing installations

A config without `integrity.supplyChain.mode` behaves as `warn`, and it is reported by
`kurahi doctor` (Secure defaults), `kurahi doctor --json` (`secure-defaults.supply-chain`,
`supply-chain.lock`) and the gateway startup log. To move to enforce:

```bash
kurahi skills verify
kurahi skills pin --all
kurahi plugins pin --all
kurahi config set integrity.supplyChain.mode enforce
```

## What it does not cover

- **Bundled code** is not hashed. Its integrity is the integrity of the installed package.
- **Plugin dependencies** in `node_modules` are not in the digest. A one-file plugin's digest
  covers only that file, not the sibling files it imports.
- **Same-user attacker**: anyone who can write `<KOLO_HOME>` as the operator (including the
  owner key in `secrets/`) can re-pin. The lock defends against content changing under a pinned
  name (agent writes to workspace skills, a package update, a swapped folder), not against the
  operator's own account being compromised.
- **One namespace**: entries are keyed by name. Two agents with different workspace skills of
  the same name cannot both be pinned.
- **Time-of-check**: the check runs when the loader reads the skill or imports the plugin.
  A file changed after that is caught on the next load or reload, not mid-run. The digest cache
  uses size, mtime, ctime and inode, and never caches a tree changed in the last 3 seconds.
- **Not a provenance check**: there is no publisher signature or registry attestation. A pin
  records "the operator approved these bytes", not who wrote them.
