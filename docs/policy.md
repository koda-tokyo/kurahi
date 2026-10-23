---
summary: "Policy as code: one signed policy.yaml a security team can read, version and attest, enforced by the gateway for every resident"
read_when:
  - You need to say, in one file, what a fleet of residents may do, spend and reach
  - You are reviewing or attesting a policy change
  - You need to stop an agent or the whole fleet now
title: "Policy"
---

# Policy

A Kurahi gateway can carry one declarative policy: `<KOLO_HOME>/policy/policy.yaml`. The file is
signed by an owner key, loaded at boot and on every save, and enforced by the runtime at five
decision points. Every decision is written to the audit log with the id of the clause that made
it, so an audit line points back into the document that was signed.

New installations get the starter policy, signed, from `kurahi init` (budgets and job limits:
see [Secure defaults](/security/secure-defaults)). An installation without a policy has no
budgets or job limits; `kurahi doctor` and the gateway log say so.

```
kurahi policy init                 # starter policy, owner key, signature
kurahi policy validate             # schema and semantic checks
kurahi policy sign                 # attest the current bytes with the owner key
kurahi policy status               # mode, attestation, kill switch, pauses
kurahi policy kill --agent ops-bot # stop one agent now (or --all)
kurahi policy release --all
```

## Concepts

| Term            | Meaning                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy document | `policy/policy.yaml`, version 1. `kurahi policy schema` prints its JSON Schema.                                                                                                                                                                      |
| Attestation     | A detached Ed25519 signature over the exact bytes of the document (`policy.yaml.sig`), made by an owner key.                                                                                                                                         |
| Owners          | `policy/owners.json`: the public keys a signature must come from. `kurahi policy init` and `kurahi policy sign` pin the local owner key; a signed document may pin further owners through `attestation.owners` (key rotation).                       |
| Mode            | `enforce` (default): an unsigned or untrusted document is refused, at boot with exit code 3; `audit`: it loads with a warning; `off`: the engine is inert. The mode is `policy.mode` in the config or `KOLO_POLICY_MODE`, never the document itself. |
| Decision        | `allow`, `deny`, `ask` (a human is asked through the approval path) or `pause` (refused until release or the next budget window).                                                                                                                    |
| Rule id         | The path of the clause that decided: `agents[trading-*].tools.deny[0]`, `budgets.fleet.costPerDay`, `kill.fleet`, `config:agents.list[alice].permissions`, `default`.                                                                                |

## Where it is enforced

| Decision point             | Where                                                                   | What is checked                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool dispatch              | every agent tool call, including MCP tools and scripts run in Code Mode | kill switch, budget pause, `agents[].tools.allow/deny`, `network.mcp`, `data.neverRead/neverWrite`, `data.secretPatterns`, `data.redact` (the [context guard](/context-guard), on results), `network.egress`, `approvals.require`, `agents[].permissions`, then the config permissions |
| Model request              | before a model is resolved for a turn                                   | kill switch, budgets (tokens/day, cost/day), `agents[].providers`, `agents[].models`                                                                                                                                                                                                   |
| Channel                    | a message arriving for an agent, and a delivery leaving one             | kill switch, `agents[].channels`                                                                                                                                                                                                                                                       |
| HTTP and WebSocket request | after authentication, before the handler                                | kill switch on agent-driving operations, `requests.deny` by operation and credential scope                                                                                                                                                                                             |
| Job start                  | before a run is queued                                                  | kill switch, budgets, `agents[].limits.maxConcurrentJobs`; `wallClockPerJobMs` and `maxSteps` cap the run                                                                                                                                                                              |

A refusal is a tool error the model can read, a failed job (`denied`), a 403 with `rule` on HTTP, or
an `INVALID_REQUEST` with the rule in `details` on WebSocket.

## Precedence

```
policy document  >  agents.list[].permissions (config)  >  built-in defaults
```

Within the document, deny wins over ask, ask over pause, pause over allow. Every `agents` entry
whose glob matches the agent applies; an entry with `tools.allow` restricts to the union of the
allow lists. The M5 permission globs in the config remain one input: when the document has no
`permissions` for the agent, they decide; when it has, the config rules are not consulted.

## The document

```yaml
version: 1
name: fleet
agents:
  "*":
    tools: { deny: [process] }
    limits: { maxConcurrentJobs: 2, wallClockPerJobMs: 900000 }
  "trading-*":
    permissions: ["read:**", "write:/workspace/reports/**"]
    providers: [acme]
    models: ["acme/large-*"]
    channels: [slack]
budgets:
  currency: USD
  resetHourUtc: 0
  fleet: { tokensPerDay: 20000000, costPerDay: 400, onBreach: pause }
  agents:
    "*": { tokensPerDay: 2000000, toolCallsPerHour: 600, onBreach: warn }
kill:
  fleet: false
  agents: []
  mayFlip: [owner, admin]
approvals:
  channel: "slack:#ops-approvals"
  timeoutMs: 120000
  require:
    - { class: exec, agents: ["ops-*"] }
network:
  egress: { deny: ["169.254.169.254"] }
  mcp: { allow: [docs, tickets] }
data:
  neverRead: ["~/.ssh/**", "**/.env"]
  neverWrite: ["/etc/**"]
  secretPatterns: ["AKIA[0-9A-Z]{16}"]
  redact: { fields: ["@personal"], restoreTo: [message] }
shield: { mode: stop } # ransomware detection, see /shield
requests:
  deny:
    - { operations: [runCodeMode, "codeMode.*"], scopes: [attach] }
attestation:
  required: true
```

- **agents** — keyed by agent-id glob. `permissions` uses the `class:pattern` syntax of
  `agents.list[].permissions` (`read`, `write`, `exec`). `tools`, `providers`, `models`,
  `channels` are globs. `limits` tighten the run. `reasoning: { expose: false }` keeps the
  agent's reasoning on the gateway (no client sees it live or in history), whatever the config
  says; it only restricts, never widens.
- **budgets** — `tokensPerDay` and `costPerDay` over a day that starts at `resetHourUtc`;
  `toolCallsPerHour` over the current clock hour; `wallClockPerJobMs` per run. Cost uses the
  provider price tables in the config (`models.providers[].models[].cost`); a model without a
  price counts tokens only. `onBreach`: `warn` (allow, audit), `pause` (refuse until
  `kurahi policy release` or the window resets), `stop` (refuse). Meters persist in
  `<KOLO_HOME>/run/budgets.json`; `kurahi policy budget` shows them.
- **kill** — the document can stop agents (`fleet`, `agents`); the runtime switch
  (`kurahi policy kill`) is separate, written to `<KOLO_HOME>/run/policy-kill.json`, survives a
  restart and is cleared only by `release`. `mayFlip` says who may flip it.
- **approvals** — tool classes (`exec`, `write`, `read`, `network`, `mcp`, `messaging`,
  `tool:<glob>`) that need a human. The request goes through the gateway's approval path
  (`exec.approval.requested`), so the channels that already forward approvals (and attached
  operators) see it; `channel` is recorded with the request. No answer before `timeoutMs` is a
  refusal.
- **network** — `egress` hosts a tool call may reach (from `url`, `href`, `baseUrl`, `urls`
  arguments) and `mcp` server ids whose tools may run.
- **data** — path globs no tool reads or writes (`~/` is the state owner's home), and regular
  expressions over the tool arguments that refuse a call.
- **requests** — HTTP `operationId`s and WebSocket methods refused for a credential scope.
- **attestation** — `required: false` lets an unsigned document load in enforce mode (for a
  development gateway); `owners` pins further owner keys once this document is accepted.

## Kill switch

`kurahi policy kill --agent <id>` or `--all`, `POST /api/policy/kill`, or WebSocket `policy.kill`
(owner or admin credential; `kill.mayFlip` can narrow it to owner). Within one event-loop tick:
running jobs of the target are aborted through their cancel handles, new jobs, model calls,
tool calls and channel deliveries are refused, agent-driving HTTP and WebSocket operations get a
403 with `rule: kill.fleet` (fleet) or are refused by the job gate (agent), attached TUIs show a
banner, and `policy.kill` is in the audit log. `release` reverses it. `GET /api/policy/status`
and `kurahi policy status` show the state.

## Attestation and the integrity gate

`kurahi policy sign` hashes the document bytes, signs `sha256 + signedAt` with the owner key
(`<KOLO_HOME>/secrets/policy-owner.json`, 0600) and pins that key in `owners.json`. The gateway
verifies the signature against the bytes on disk and the pinned owners on every load; a byte
changed after signing is `invalid`, a signature by a key that is not pinned is `untrusted`. The
three files are protected files for the boot integrity gate: `kurahi integrity init` registers
them, and `kurahi policy sign|apply` re-registers them so an intended change does not trip the
gate.

To review a change: `kurahi policy diff candidate.yaml`, then `kurahi policy apply candidate.yaml`
with the candidate's `.sig` next to it (signed on another machine by a pinned owner) or `--sign`
to sign the installed copy locally. The running gateway reloads the files on save; a document
that fails attestation never replaces the active one.

## Hospital-safe, trading-desk, manufacturing-floor

Three starter policies live in `docs/policy/examples/`. Copy one to `<KOLO_HOME>/policy/policy.yaml`,
edit the agent ids, then `kurahi policy validate && kurahi policy sign`.

- [hospital-safe.yaml](/policy/examples#hospital-safe) — no execution, no egress beyond the
  record systems, patient data paths never read by tools, every message to a care channel
  approved by a person, tight daily spend with `pause`.
- [trading-desk.yaml](/policy/examples#trading-desk) — one provider and model family, the
  order-execution MCP server behind an approval, a hard `stop` on cost, kill switch flippable by
  owner only, Code Mode denied to attached devices.
- [manufacturing-floor.yaml](/policy/examples#manufacturing-floor) — line agents limited to the
  historian and ticketing servers, no writes outside the shift workspace, short jobs, wall-clock
  caps, egress denied to the control network.

## Audit

Every decision is one entry: `policy.decision` with `point`, `effect`, `rule`, `reason` and the
context (tool, provider/model, channel, operation). Allowed HTTP and WebSocket requests are not
logged twice (the transport logs them). Operator actions are `policy.init`, `policy.sign`,
`policy.apply`, `policy.kill`, `policy.release`, `policy.budget.reset`; loads and refused reloads
are `policy.load`; budget warnings are `policy.budget`. `kurahi audit tail --action policy.decision`
follows them.

## CLI

| Command                                           | Does                                              |
| ------------------------------------------------- | ------------------------------------------------- |
| `kurahi policy init [--force]`                    | starter policy, owner key, owners.json, signature |
| `kurahi policy show [file]`                       | print with attestation; `--json` for machines     |
| `kurahi policy validate [file]`                   | schema + semantic checks; exit 1 on errors        |
| `kurahi policy sign [file] [--key f]`             | attest; pins the key as an owner                  |
| `kurahi policy verify [file]`                     | attestation state; exit 1 unless `signed`         |
| `kurahi policy diff <file>`                       | path-level changes against the active policy      |
| `kurahi policy apply <file> [--sign]`             | install candidate + signature; audited            |
| `kurahi policy status [--local]`                  | from the gateway when reachable                   |
| `kurahi policy kill\|release --agent <id>\|--all` | the runtime switch                                |
| `kurahi policy budget [--agent id] [--reset]`     | meters vs limits                                  |
| `kurahi policy schema`                            | JSON Schema                                       |

Exit codes: 0 ok, 1 the command ran and failed, 2 usage. `pnpm policy:check` runs the end-to-end
conformance gate (throwaway gateway, deterministic provider, no network).
