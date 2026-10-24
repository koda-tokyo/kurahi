---
summary: "CLI reference for `kurahi debug profile` (CPU / heap profile of a running gateway)"
read_when:
  - A gateway is slow or busy and you need to see where its time goes
  - You want a profile of gateway startup
title: "debug"
---

# `kurahi debug`

Diagnostics for a running gateway.

## `kurahi debug profile`

Samples the running gateway for a number of seconds through the admin-only `debug.profile`
gateway method (node:inspector inside the gateway process; no debugger port is opened) and
writes the result next to you:

- `gateway-<pid>-<time>.cpuprofile`: open in Chrome DevTools (Performance) or speedscope
- `gateway-<pid>-<time>.cpu.pb.gz`: the same profile for `go tool pprof`
- with `--heap`, `.heapprofile` (DevTools Memory) and `.heap.pb.gz` from a sampling heap profile

Every capture is written to the audit log (`debug.profile`), refused ones included. Only one
capture runs at a time per gateway.

```bash
kurahi debug profile                       # 10 s CPU profile into the current directory
kurahi debug profile --seconds 30 --heap --out ./profiles
kurahi debug profile --url wss://gateway.example.com:18789 --json
```

Options:

- `--seconds <n>`: sampling duration, 1-300 (default 10)
- `--heap`: also capture a sampling heap profile
- `--out <dir>`: output directory (default: current directory)
- `--sampling-interval-us <us>`: CPU sampling interval (default 1000, 10000 on WSL)
- `--no-pprof`: skip the pprof files
- `--url`, `--token`, `--timeout <ms>` (default: duration + 60 s), `--json`

## Startup profile

`kurahi gateway run --profile-startup <file>` samples from process start until the gateway
serves and writes `<file>` (`.cpuprofile`) and `<file>.pb.gz`. Each start also logs one
`startup: …` line with per-phase timings (`startupPhases` in the JSON log).

Sampling interrupts the main thread with a signal every interval. On WSL2, network syscalls
(interface enumeration, binds) restart when interrupted and become two to three orders of
magnitude slower at a 1 ms interval, so on WSL the default interval is 10 ms. Set
`KOLO_PROFILE_SAMPLING_INTERVAL_US` to override it for `--profile-startup`. Their time in a
profile can still be inflated.
