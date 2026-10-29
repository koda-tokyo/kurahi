---
summary: "What Kurahi 2.3.0 includes today, what is licensed separately and what is research, with platforms and known limits"
read_when:
  - You are deciding what to evaluate, and need to know what ships in this release
  - You need to tell a stakeholder which capabilities are available, licensed separately or still research
title: "Capabilities in this release"
---

# Capabilities in this release

Release **Kurahi 2.3.0**, stable channel, release date 29 October 2026
([release notes](/releases/2.3.0), [downloads](https://kurahi.kodasoken.com/download/)). Platforms:
Linux x64, macOS arm64 and Windows x64. Verify downloads with `SHA256SUMS.txt`; builds are not
code-signed or notarised.

Status means:

- **Available**: ships in the open-core runtime in this release, documented, covered by the test
  suite that ran on all three platforms before the release was tagged.
- **Licensed separately**: part of the proprietary layer, delivered under written agreement
  (see [Licensing](https://github.com/koda-tokyo/kurahi/blob/main/LICENSING.md)).
- **Research**: not a product capability; published as research only.

## Runtime

| Capability                                                                                   | Status    | Known limits                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runs as an OS service (systemd, launchd, Task Scheduler)                                     | Available | Unsigned builds; macOS asks for confirmation on first run                                                                                                                            |
| Residents keep sessions, schedules and memory between client connections and across restarts | Available | Work continues only while the host machine is running. A job that was running when the gateway stopped is marked interrupted, not resumed automatically                              |
| [Runtime continuity conformance](/continuity) (C0 to C9)                                     | Available | Checks retained state, files, permissions and transcripts. It does **not** claim equivalent reasoning, tone or judgement across models, and interrupted jobs need not resume to pass |
| Model choice from the [provider registry](/providers/support)                                | Available | 18 curated providers, plus 192 catalogue entries with best-effort support                                                                                                            |
| [KODA tested benchmark](/providers/koda-tested)                                              | Available | One model benchmarked                                                                                                                                                                |
| Terminal UI with live reasoning view, web control UI                                         | Available |                                                                                                                                                                                      |

## Control and evidence

| Capability                                                                                                                            | Status              | Known limits                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Policy as code](/policy): signed policy, tool and model rules, budgets, kill switch                                                  | Available           |                                                                                                                                                    |
| Human approvals, in the terminal or over a chat channel                                                                               | Available           | Approval waits are bounded by the policy timeout                                                                                                   |
| [Evidence bundles](/evidence): signed record of every job, offline verify and replay                                                  | Available           | Replay reconstructs what the job recorded; it does not re-run the job under a different model or policy                                            |
| Hash-chained audit log and boot integrity gate                                                                                        | Available           |                                                                                                                                                    |
| [External agent CLIs](/agents/external-adapters) (Claude Code, Codex) under the tool capability                                       | Available           | Pre-execution restrictions are the CLI's own flags; custom CLIs are only checked after the run. See the compatibility contract                     |
| Credential isolation between agents (`auth.isolation: "explicit"`)                                                                    | Available           | Off by default (agents inherit the main agent's credentials unless set)                                                                            |
| [Context guard](/context-guard): personal data in tool results becomes placeholders                                                   | Available           | Images are not inspected; agent replies keep placeholders; detectors are patterns                                                                  |
| [Ransomware detection](/shield): decoy files and mass-encryption detection stop every agent                                           | Available           | Detection, not complete protection: files encrypted before a signal fires are damaged, and it stops agents, not the malware. No off-machine copies |
| [AI inventory](/inventory): signed list of agents, models, tools and policy                                                           | Available           |                                                                                                                                                    |
| [File snapshots](/tools/snapshots): undo and redo of agent edits; optional required snapshot for protected files                      | Available           | Covers the edit tools, not shell commands; not taken inside the sandbox                                                                            |
| [Enterprise identity](/security/identity): OIDC and SAML sign-in for people, SCIM 2.0, departments and roles                          | Available           | Off by default. Included in every plan, Free included ([Licensing](https://github.com/koda-tokyo/kurahi/blob/main/LICENSING.md))                   |
| [Attachment intake](/security/attachment-intake): quarantine, file policy, malware scan, isolated extraction                          | Available           | Needs ClamAV or Microsoft Defender on the host; with the default `requireScan`, attachments are refused when no scanner answers                    |
| [Data governance](/security/data-governance): retention, legal hold, eDiscovery export, My Number guard, data subject requests (APPI) | Available           | Signed evidence, audit rows and anything under a legal hold are retained, not deleted, by a data subject request                                   |
| [Enterprise profile](/security/enterprise-profile): enterprise package without consumer channels, runtime refusal of excluded plugins | Available           | Consumer channel modules built into the core still compile into the package; they stay inert without their plugins                                 |
| Audit export to external systems, air-gapped installation                                                                             | Licensed separately |                                                                                                                                                    |

## Integration

| Capability                                                                                                                                                                                                 | Status    | Known limits                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Channels](/channels): LINE, Slack, Teams, Telegram, WhatsApp, Discord, Signal, webhook and more                                                                                                           | Available | Each channel needs its own account or bot set up by you                                                                                                                   |
| [MCP servers](/cli/mcp) under the same policy                                                                                                                                                              | Available |                                                                                                                                                                           |
| [Autopilot](/autopilot): routines at autonomy levels L0 to L3 with standing approvals, triggers and a watchdog                                                                                             | Available | The reasoner runs without tools: a command-line model backend, or an OpenAI-compatible model API or local Ollama model (`backend: api`)                                   |
| [Business work queue](/business/work-queue): approval routes (稟議), delegation and its withdrawal, email intake, risk flags                                                                               | Available | See the page's limitations; approvals are workflow records, not legal signatures                                                                                          |
| [Linked cases](/business/work-queue#gateway-methods) across departments, [hand-off tracking](/business/work-queue#hand-offs-and-settlement) and [in-app notifications](/business/work-queue#notifications) | Available | Only a person can attest that a payment settled. Notifications are in the console only: no mail or chat delivery, and members known only through a group are not notified |
| [Quotations](/business/quotations) (見積管理) from CSV or Excel (.xlsx) price lists                                                                                                                        | Available | Tax-exclusive prices only; a person approves and sends every quotation                                                                                                    |
| [Supplier quote comparison and purchase-order drafts](/business/quotations#the-tool)                                                                                                                       | Available | Compares price only; a person chooses the supplier; a draft is not issued or sent                                                                                         |
| [Functional packs](/business/functional-packs): employee requests, spend, people operations, contracts, management oversight                                                                               | Available | Starter workflows with the limitations listed per pack, not complete business systems                                                                                     |
| [Business connectors](/connectors): Microsoft 365, Gmail, Entra ID, kintone, freee, Money Forward, SmartHR, LINE WORKS, Box                                                                                | Available | Off by default; an administrator turns each one on                                                                                                                        |
| [Office documents](/tools/office): PowerPoint, Word and Excel files from structured specs                                                                                                                  | Available | Off by default; writes only into the Project in act mode                                                                                                                  |
| [IBM watsonx](/integrations/ibm-watsonx): Orchestrate, watsonx.ai, governance traces, watsonx.data and Db2                                                                                                 | Available | Off by default; built on IBM's published APIs                                                                                                                             |
| HTTP API (88 operations) and WebSocket methods with a typed client                                                                                                                                         | Available |                                                                                                                                                                           |
| [Factory](/factory): spec to card to job to reviewed pull request                                                                                                                                          | Available |                                                                                                                                                                           |

## Licensed separately

| Capability                                                            | Status              |
| --------------------------------------------------------------------- | ------------------- |
| Identity and continuity engine for resident agents (Kurahi Residents) | Licensed separately |
| Role packs for industries                                             | Licensed separately |
| Sovereign models and adapters                                         | Licensed separately |
| Evaluation dashboard, enterprise support                              | Licensed separately |

## Research

| Topic                                                                           | Status                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Behavioural continuity across real model transitions (the F score)              | Research; see the KODA SōKEN benchmark registry |
| Encrypted, split copies of data across several locations with automatic restore | Research and design                             |
