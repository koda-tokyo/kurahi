---
summary: "What Kurahi 2.1.0 includes today, what is licensed separately, what is in preview and what is research, with platforms and known limits"
read_when:
  - You are deciding what to evaluate, and need to know what ships in this release
  - You need to tell a stakeholder which capabilities are available, licensed separately or still research
title: "Capabilities in this release"
---

# Capabilities in this release

Release **Kurahi 2.1.0**, stable channel, published 24 October 2026
([release notes](/CHANGELOG), [downloads](https://kurahi.kodasoken.com/download/)). Platforms:
Linux x64, macOS arm64 and Windows x64. Builds are not yet code-signed or notarised.

Status means:

- **Available**: ships in the open-core runtime in this release, documented, covered by the test
  suite that ran on all three platforms before the release was tagged.
- **Licensed separately**: part of the proprietary layer, delivered under written agreement
  (see [Licensing](https://github.com/koda-tokyo/kurahi/blob/main/LICENSING.md)).
- **Preview**: usable, but its interface or behaviour may still change.
- **Research**: not a product capability; published as research only.

## Runtime

| Capability                                                                                   | Status    | Known limits                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runs as an OS service (systemd, launchd, Task Scheduler)                                     | Available | Unsigned builds; macOS asks for confirmation on first run                                                                                                                            |
| Residents keep sessions, schedules and memory between client connections and across restarts | Available | Work continues only while the host machine is running. A job that was running when the gateway stopped is marked interrupted, not resumed automatically                              |
| [Runtime continuity conformance](/continuity) (C0 to C9)                                     | Available | Checks retained state, files, permissions and transcripts. It does **not** claim equivalent reasoning, tone or judgement across models, and interrupted jobs need not resume to pass |
| Model choice from the [provider registry](/providers/support)                                | Available | 17 curated providers; 192 catalogue entries are listed, not tested                                                                                                                   |
| [KODA tested benchmark](/providers/koda-tested)                                              | Preview   | One model benchmarked so far; ten more pending                                                                                                                                       |
| Terminal UI with live reasoning view, web control UI                                         | Available |                                                                                                                                                                                      |

## Control and evidence

| Capability                                                                                                       | Status              | Known limits                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Policy as code](/policy): signed policy, tool and model rules, budgets, kill switch                             | Available           |                                                                                                                                                    |
| Human approvals, in the terminal or over a chat channel                                                          | Available           | Approval waits are bounded by the policy timeout                                                                                                   |
| [Evidence bundles](/evidence): signed record of every job, offline verify and replay                             | Available           | Replay reconstructs what the job recorded; it does not re-run the job under a different model or policy                                            |
| Hash-chained audit log and boot integrity gate                                                                   | Available           |                                                                                                                                                    |
| [External agent CLIs](/agents/external-adapters) (Claude Code, Codex) under the tool capability                  | Available           | Pre-execution restrictions are the CLI's own flags; custom CLIs are only checked after the run. See the compatibility contract                     |
| Credential isolation between agents (`auth.isolation: "explicit"`)                                               | Available           | Off by default (agents inherit the main agent's credentials unless set)                                                                            |
| [Context guard](/context-guard): personal data in tool results becomes placeholders                              | Available           | Images are not inspected; agent replies keep placeholders; detectors are patterns                                                                  |
| [Ransomware detection](/shield): decoy files and mass-encryption detection stop every agent                      | Available           | Detection, not complete protection: files encrypted before a signal fires are damaged, and it stops agents, not the malware. No off-machine copies |
| [AI inventory](/inventory): signed list of agents, models, tools and policy                                      | Available           |                                                                                                                                                    |
| [File snapshots](/tools/snapshots): undo and redo of agent edits; optional required snapshot for protected files | Available           | Covers the edit tools, not shell commands; not taken inside the sandbox                                                                            |
| Audit export to external systems, SSO, air-gapped installation                                                   | Licensed separately |                                                                                                                                                    |

## Integration

| Capability                                                                                       | Status    | Known limits                                            |
| ------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------- |
| [Channels](/channels): LINE, Slack, Teams, Telegram, WhatsApp, Discord, Signal, webhook and more | Available | Each channel needs its own account or bot set up by you |
| [MCP servers](/cli/mcp) under the same policy                                                    | Available |                                                         |
| HTTP API (65 operations) and WebSocket methods with a typed client                               | Available |                                                         |
| [Factory](/factory): spec to card to job to reviewed pull request                                | Preview   |                                                         |

## Licensed separately

| Capability                                                            | Status              |
| --------------------------------------------------------------------- | ------------------- |
| Identity and continuity engine for resident agents (Kurahi Residents) | Licensed separately |
| Role packs for industries                                             | Licensed separately |
| Sovereign models and adapters                                         | Licensed separately |
| Evaluation dashboard, enterprise support                              | Licensed separately |

## Research

| Topic                                                                           | Status                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| Behavioural continuity across real model transitions (the F score)              | Research; see the KodaSōken benchmark registry |
| Encrypted, split copies of data across several locations with automatic restore | Research and design; planned after 2.0         |
