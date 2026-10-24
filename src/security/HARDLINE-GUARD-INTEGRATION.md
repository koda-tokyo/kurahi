# Hardline Guard — Integration Note

## What was built

- **Module:** `src/security/hardline-guard.ts` — tested; wired through `src/security/exec-guard.ts`
- **Tests:** `src/security/hardline-guard.test.ts` — 110 tests, 0 failures
- **Status:** Wired into every agent exec path (2026-10-20); see "Where it is wired" below

## Architecture

```
detectHardlinePreExec(command)
  → detectHardlineCommand()  // hardline patterns (unconditional floor)
  → detectSudoStdin()         // sudo -S without SUDO_PASSWORD env
  → returns HardlineMatch | HardlinePass
```

**17 patterns total** (6 Kurahi-specific + 11 universal floor), compiled at module load.
**1 normalizer** (ANSI strip → null-byte strip → NFKC → backslash escape → empty-string escape → whitespace collapse).

## Kurahi-specific redlines

| Pattern            | Blocks                                                         |
| ------------------ | -------------------------------------------------------------- |
| `wsl-shutdown`     | `wsl --shutdown`, `wsl --terminate`                            |
| `pm2-gateway-kill` | `pm2 kill`, `pm2 stop kolo-gateway`, `pm2 delete kolo-gateway` |
| `rm-kolo-home`     | `rm -rf ~/.kolo`, `rm -rf ~/.kolo/*`                           |
| `rm-kolo-vault`    | `rm -rf ~/.kolo/vault`, `rm -rf ~/.kolo/vault/*`               |
| `kill-kolo-pgrep`  | `kill -9 $(pgrep -f kolo-gateway)`                             |
| `pkill-kolo`       | `pkill kolo-gateway`, `killall kolo-gateway`                   |

## Universal floor (from Hermes)

`rm -rf /`, system dirs (/home, /etc, /usr, ...), `rm -rf ~/$HOME`, `mkfs.*`, `dd of=/dev/sd*`, redirect to block device, fork bomb, `kill -1`, `shutdown`/`reboot`/`halt`/`poweroff`, `init 0/6`, `systemctl poweroff/reboot`

## Normalizer evasions caught

- Fullwidth Latin + fullwidth hyphen-minus (U+FF0D) + solidus (U+FF0F) → NFKC
- ANSI escape codes (color, cursor positioning)
- Shell backslash escapes (`r\m` → `rm`)
- Shell empty-string escapes (`r''m` → `rm`)
- Combinations of above

## Where it is wired

`enforceExecGuard` / `checkExecCommand` (`src/security/exec-guard.ts`) run the hardline check
and write an `exec.guard` entry to the hash-chained audit log (`denied` with the pattern, or
`allowed`). A blocked command is refused, never queued for approval.

| Entry point | File | Notes |
| --- | --- | --- |
| `exec` tool, all hosts (sandbox, gateway, node) | `src/agents/bash-tools.exec.ts` | First check after argument validation: before elevated mode, allowlists and approvals |
| `process` tool `write` / `send-keys` / `paste` | `src/agents/bash-tools.process.ts` | Text joined with the unterminated line typed before it; only refusals are audited |
| `nodes` tool `run` | `src/agents/tools/nodes-tool.ts` | Before `node.invoke system.run` leaves the gateway |
| `system.run` on a node host | `src/node-host/runner.ts` | Defence in depth for any caller; an `approvalDecision` in the request does not override it |
| `lobster` plugin `run` | `extensions/lobster/src/lobster-tool.ts` | Pipelines can contain shell steps |

Not wired, on purpose: the TUI `!` local shell (`src/tui/tui-local-shell.ts`, the operator's own
terminal, not agent output) and CLI backends (`claude-cli`, `codex-cli`), whose shell tools run
inside the external CLI; their default is read-only tools (`src/agents/cli-permissions.ts`).

Tests: `src/security/exec-guard.test.ts`, `src/agents/bash-tools.exec.hardline.test.ts`.

## What was NOT done (per scope)

- No dangerous-pattern check (medium-severity, allows yolo — separate module)
- No "unpaired door" audit (gating all write vectors symmetrically)
- No credential path confinement (separate borrow from report)

## Dependencies

- Zero external dependencies (pure TypeScript, no imports)
- Compatible with Kurahi's `.js` import convention
- Builds on existing `src/security/` module (alongside audit.ts, fix.ts)
