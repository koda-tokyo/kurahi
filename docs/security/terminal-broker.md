---
summary: "The Work Console terminal: a gateway-owned shell broker bound to one project, with line-by-line gating, approvals, file diffs, audit and limits; threat model and what it does not protect against"
read_when:
  - Enabling or reviewing `console.terminal`
  - Answering a security review question about the Work Console terminal
  - Building a client for the `terminal.*` gateway methods
title: "Console terminal broker"
---

# Console terminal broker

The Work Console terminal gives an operator a shell inside one project. The shell is owned by
the gateway, not by the desktop app: the Tauri webview has no shell, filesystem or process
permission (`apps/desktop/src-tauri/capabilities/main.json`), and every keystroke goes through
the gateway's `terminal.*` methods. This page describes what the broker enforces, the limits of
that enforcement, and the protocol.

## Turning it on

| Key                                      | Unset (legacy)     | New installations | Meaning                                                                               |
| ---------------------------------------- | ------------------ | ----------------- | ------------------------------------------------------------------------------------- |
| `console.terminal.enabled`               | `false` (off)      | `true`            | Master switch. Off: every `terminal.*` request is refused with code `disabled`.       |
| `console.terminal.actApprovals`          | `"policy"`         | `"always"`        | Act-mode rule, see below. Enabled without this key: `kurahi doctor` warns.            |
| `console.terminal.sandbox`               | `"off"`            | `"off"`           | `"required"`: every session runs in the container sandbox.                            |
| `console.terminal.allowInteractive`      | `[]`               | `[]`              | Program names allowed to run interactively (editors, REPLs). Names only, never paths. |
| `console.terminal.maxSessionsPerProject` | 3                  |                   | Open sessions per project.                                                            |
| `console.terminal.maxSessionsPerUser`    | 4                  |                   | Open sessions per operator identity.                                                  |
| `console.terminal.idleTimeoutMs`         | 1,800,000 (30 min) |                   | A session with no input or output (and no command running) is closed.                 |
| `console.terminal.maxLineLength`         | 4096               |                   | Characters accepted at the prompt.                                                    |
| `console.terminal.outputBytesPerSecond`  | 524,288            |                   | Output beyond this per second is dropped; a notice says how many bytes.               |
| `console.terminal.approvalTimeoutMs`     | 120,000            |                   | An unanswered approval counts as denied (never as allowed).                           |

## What is enforced

**Who.** All seven methods need `operator.admin` (paired credentials: scope `admin`). A session
answers only to the identity that opened it (owner token, device or paired credential); another
admin gets `forbidden`, and the attempt is audited. `terminal.event` is sent only to the owner's
admin connections. The policy kill switch (`kurahi policy kill`) refuses `terminal.open` and
`terminal.input`.

**Where.** A session is bound to one project. The working directory starts at the project root
and the shell's `HOME` is the root, so `~` and a bare `cd` stay inside it. Opening is refused when
the project is in read mode (参照). Every path a command line names is resolved (lexically, then
through symlinks for whatever exists) and must stay inside the root; `cd` is tracked through the
line, and a `cd` that might or might not run is checked both ways. Paths with `$` expansions,
`~user`, and the projects' excluded folders are refused. When the project's terminal profile is
client-isolated or `sandbox` is `"required"`, the session runs in the container sandbox with only
the project folder mounted; if the container cannot start the session is refused, it never falls
back to the host.

**What runs.** The broker owns the prompt. Keystrokes are edited by the broker and never reach a
shell until Enter. Each submitted line is then, in order:

1. checked against the project's current mode (re-read for every line);
2. checked by the hardline guard (`src/security/exec-guard.ts`); a match is refused, never queued;
3. classified (`src/console/terminal/classify.ts`): refused outright for privilege elevation
   (`sudo`, `su`, `doas`, …), detaching (`setsid`, `at`, `crontab`, …), command or process
   substitution, here-documents, dynamic program names, and interactive programs (editors, pagers,
   REPLs, shells without a script) unless `allowInteractive` names them;
4. checked by the path guard;
5. decided by mode:
   - 計画 plan: read-only lines run; everything else waits for an approval;
   - 実行 act, `actApprovals: "always"`: the same;
   - 実行 act, `actApprovals: "policy"`: the exec-approvals file of the default agent decides
     (security, ask, allowlist, as for the exec tool); lines with a risk beyond "runs a program"
     (deletes, overwrites, moves, permissions, git history, network, packages, process control,
     nested commands, background jobs) always ask.

An approval is an ordinary exec-approval record: it is broadcast as `exec.approval.requested`
(session key `terminal:<sessionId>`) and answered with `exec.approval.resolve`. Channel forwarding
is not used for terminal approvals. `allow-always` is treated as `allow-once`. After an approval
the line is checked again (mode, paths, guard) before it runs. Each approved line runs as its own
`bash --noprofile --norc -c <line>` in a fresh PTY: no rc files, aliases or functions, and an
environment built from an allowlist (the gateway's tokens and API keys are not inherited; pagers
are `cat`, editors are `false`, git never prompts). Cancel and close signal the command's whole
process group (SIGTERM, then SIGKILL after 1.5 s; immediately on gateway shutdown).

**What is shown and kept.** Output is redacted before it is stored or sent: the secret patterns
used by the logs and the audit log, the exact values of the gateway's secret-named environment
variables, and, for lines that print the environment (`env`, `printenv`, `export -p`), every
variable's value. A command line that contains a secret is redrawn redacted on Enter. Every open,
command (with its decision and risk codes), approval, exit, cancel and close is written to the
hash-chained audit log with the command's `runId`; command text in the audit log is the redacted
line (first 400 characters plus its SHA-256).

**File diffs.** Before and after each command that is not read-only, the broker snapshots the
project's files (regular files, not following symlinks, skipping `.git`, `node_modules`, other
hidden directories and excluded folders; up to 5,000 files; files over 1 MiB are compared by size
and mtime only). Changes arrive as a `file.diff` event with a summary and a `diffId`;
`terminal.diff` returns the unified diff, 200 files per page, redacted, with secret-looking files
(`.env`, keys, credentials) listed without content.

## What it does not protect against

Read this before enabling the terminal on the gateway host without the sandbox.

- **The line is not the program.** The gate classifies the words of the line. A script, a Makefile
  target, `npm run`, an interpreter's code or a downloaded tool can read, write, delete or send
  anything the operating-system user can. Such lines are never read-only ("runs-program") and ask
  in plan mode and under `"always"`, but once approved they run with the user's full rights. On the
  host the path guard does not confine an approved program; only the container sandbox does.
- **Input to a running program is not gated.** While an approved command runs, keystrokes go to it
  (that is how prompts and `y/n` questions work). A program that reads commands from its input can
  be driven through it. Shells and REPLs are refused unless allowed by `allowInteractive`; allowing
  one gives the operator an ungated shell inside that program.
- **Repository and tool configuration can run code.** `git` is never classified read-only, because
  repository config (`core.fsmonitor`, filters, textconv, hooks) can run programs even for
  `git status`. Similar mechanisms exist in other tools (npm lifecycle scripts, Python `.pth`
  files, direnv, editor modelines).
- **Detection by name.** Classification uses program basenames and flags. A renamed or wrapped
  binary inside the project (`./rm-alias`) is "runs-program", not "deletes-files": the risk
  preview is a hint for the approver, not a guarantee.
- **Processes that leave the group.** Cancel and close kill the command's process group. A program
  that creates its own session (`setsid()` in code, a daemonising server) survives that; the named
  detach tools are refused, the system call is not. If the gateway process is killed without a
  graceful shutdown, running commands receive SIGHUP from the closed PTY and most exit; ones that
  ignore it keep running.
- **Redaction is pattern-based.** Secrets that match no pattern and are not a gateway environment
  value are shown. A secret split across an output flush (a partial line held for more than 30 ms)
  can escape the patterns. Environment values are blanked only for the listed printers; `cat` of a
  file that contains `KEY=value` lines is redacted only by the secret patterns.
- **Shell state does not persist.** Only the working directory carries over between lines (a line
  that is only `cd <dir>`). Variables, `export`, functions and aliases last for one line. This is
  deliberate (nothing earlier can redefine what a later word means) but differs from a normal shell.
- **Check-then-run races and hard links.** Paths are checked when the line is submitted and again
  after an approval, not while the command runs: a symlink swapped in between (for example by an
  agent working in the same project) is followed. A hard link inside the project to a file outside
  it looks like an ordinary project file.
- **Approval is confirmation, not two-person control by default.** Any operator with
  `operator.approvals` can answer a terminal approval (it is an ordinary exec-approval record and
  is broadcast as `exec.approval.requested`, with the redacted command). Usually the person at the
  terminal approves their own line: that stops accidents and surprises, not a determined operator.
- **POSIX only.** The broker needs bash and a POSIX PTY; Windows gateways refuse to open sessions.
- **Diffs are bounded and in memory.** The newest 200 diffs (64 MiB) are kept in gateway memory and
  are gone after a restart; the audit log keeps each diff's summary (files, +/−) with the runId for
  as long as the audit log is retained. Changes outside the snapshot bounds are not shown (the
  event says `truncated`).
- **The sandbox mounts what the sandbox config mounts.** The project folder is mounted read-write
  at the sandbox workdir; extra `agents.defaults.sandbox.docker.binds` are mounted too.

## Protocol

Methods (all `operator.admin`):

| Method            | Params                          | Result                                                                           |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `terminal.open`   | `{projectId, name}`             | `{sessionId, projectId, name, mode, sandboxed, cwd, seq, limits}`                |
| `terminal.input`  | `{sessionId, data}`             | `{ok}`                                                                           |
| `terminal.resize` | `{sessionId, cols, rows}`       | `{ok}`                                                                           |
| `terminal.cancel` | `{sessionId}`                   | `{ok}`: denies a pending approval, kills the running command, or clears the line |
| `terminal.close`  | `{sessionId}`                   | `{ok}`                                                                           |
| `terminal.replay` | `{sessionId, afterSeq, limit?}` | `{events, truncated, hasMore, lastSeq}` (200 per page)                           |
| `terminal.diff`   | `{diffId, cursor?}`             | `{diffId, sessionId, runId, projectId, files, totals, nextCursor}`               |

Errors carry a stable code in `details.code`: `disabled`, `project-not-found`, `read-mode`,
`project-folder-missing`, `session-limit`, `sandbox-unavailable`, `backend-unavailable`,
`not-found`, `closed`, `forbidden`, `cursor-ahead` (`terminal.replay` with an `afterSeq` newer than
the session's last event; `seq` never resets within a session, so the cursor belongs to another
session or is corrupt: reopen or replay from 0).

Event `terminal.event` (`TerminalEvent` in the generated client types): `{sessionId, seq, ts,
type, runId?, …}` with `type` one of `stdout`, `stderr`, `exit`, `approval.requested`,
`approval.resolved`, `file.diff`, `notice`. `seq` increases by one per event within a session.
Each session keeps the newest 5,000 events and at most 10 MB; a replay that starts before the
oldest kept event reports `truncated: true`. A closed session stays replayable by its owner until
32 newer sessions have closed. Events carry stable codes and safe parameters only (counts,
program names); the UI owns all Japanese and English text:

- `approval.requested`: `approvalId`, `command` (redacted), `cwd`, `risk` (most severe) and
  `risks`, each `{code, params?}`, for example `{code: "deletes-files", params: {count: 12}}`.
- `notice`: `code` such as `ready`, `path-escape`, `interactive-refused`, `approval-denied`,
  `output-rate-limited` (`{droppedBytes}`), `idle-timeout`.
- One `runId` (UUID) per submitted line, carried by the approval, the exit, the diff and the
  audit entries.

The PTY merges standard output and standard error; command output arrives as `stdout`. `stderr`
is reserved.
