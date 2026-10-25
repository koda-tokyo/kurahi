---
summary: "IBM watsonx interoperability pack: run Kurahi alongside watsonx Orchestrate, watsonx.ai, watsonx.governance, watsonx.data and Db2 without replacing them; what works today, what is unverified, and what is planned"
read_when:
  - Your organisation runs IBM watsonx products and is evaluating Kurahi next to them
  - You need the list of IBM integration points and their verification status
title: "IBM watsonx"
---

# IBM watsonx interoperability

日本語: [IBM watsonx 連携](/ja/integrations/ibm-watsonx)

Kurahi is built to work **alongside** an enterprise's IBM stack, not to replace it. Each piece
below uses an open protocol where IBM supports one (A2A, MCP, OpenAPI, OpenTelemetry, the
Presto/Trino client protocol) and a documented IBM REST API otherwise. Every piece is off by
default and needs an administrator to turn it on.

**Every integration is unverified until it has run against a live IBM service.** The pack is
built from IBM's public documentation and SDKs and is covered by conformance tests with recorded
request and response shapes; no IBM account was used to build it.

## What works today

| IBM product           | Direction                | Kurahi piece                                                          | Page                                                                                               | Status     |
| --------------------- | ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| watsonx Orchestrate   | Orchestrate calls Kurahi | A2A 0.3.0 server and Agent Card (`a2a` plugin), bearer or `X-API-Key` | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate)                                       | Unverified |
| watsonx Orchestrate   | Orchestrate calls Kurahi | Remote MCP toolkit: legacy analyser MCP server behind a TLS proxy     | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate#remote-mcp-toolkit)                    | Unverified |
| watsonx Orchestrate   | Orchestrate calls Kurahi | OpenAPI 3.0 ask endpoint (`server.rest`)                              | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate#openapi-tool-import)                   | Unverified |
| watsonx Orchestrate   | Kurahi calls Orchestrate | `orchestrate_agent_chat` (`watsonx-orchestrate` plugin)               | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate#call-an-orchestrate-agent-from-kurahi) | Unverified |
| watsonx.ai            | Kurahi uses models       | `watsonx` provider: IAM refresh, region, version, project or space    | [watsonx.ai](/providers/watsonx)                                                                   | Unverified |
| watsonx.governance    | Kurahi reports runs      | Governance spans over OTLP with Langfuse attributes; Orchestrate push | [watsonx.governance](/integrations/ibm-watsonx-governance)                                         | Unverified |
| watsonx.data          | Kurahi reads             | `watsonx_data_query` (`ibm-data` plugin), read-only, allowlisted      | [watsonx.data and Db2](/integrations/ibm-watsonx-data-db2)                                         | Unverified |
| Db2 for z/OS, Db2 LUW | Kurahi reads             | `db2_service_call` (`ibm-data` plugin), allowlisted REST services     | [watsonx.data and Db2](/integrations/ibm-watsonx-data-db2)                                         | Unverified |

## Rules that hold for every piece

- **IBM systems are untrusted callers and untrusted sources.** Requests from Orchestrate run in
  isolated sessions as untrusted content, without tools unless an administrator allows them, and
  never with a person's powers (approvals, decisions, autonomy levels, configuration). Replies and
  rows from IBM systems reach models inside untrusted-content markers.
- **Secrets stay in the secret store.** IBM Cloud API keys, Db2 passwords and tokens are given as
  `{ "$secret": "<name>" }` references; IAM bearer tokens are kept in memory only and refreshed
  before they expire.
- **Allowlists, not discovery.** Models name configured Orchestrate agents, Db2 services and
  watsonx.data catalogs; they never supply URLs or ids.
- **Ids and counts in audit and telemetry.** Prompt and reply content leaves Kurahi only when an
  administrator opts in (`diagnostics.otel.captureContent`).
- **Off by default, and outside the autopilot.** None of the new tools is in the autopilot's
  read-tool catalogue, and the autopilot reasoner keeps its verified tool-less CLI backends.

## Unverified or unknown

- Whether Orchestrate's `API_KEY` scheme sends `X-API-Key` to A2A agents (documented for
  chat-completions agents), the exact A2A request body Orchestrate sends, and Orchestrate support
  for A2A 1.0.
- Which Orchestrate connection kind sends `Authorization: Bearer` to a remote MCP server.
- The shape of a reply choice in Orchestrate's chat API.
- The OpenAI-compatible model gateway on watsonx.ai SaaS in Tokyo, and the token flow of software
  installs.
- Size limits and regional hosts of Orchestrate's trace intake.
- HTTP Basic auth to SaaS watsonx.data engines; the Db2 LUW REST service request shape.

## Planned

- **OpenShift:** a Helm chart for running Kurahi beside watsonx on Red Hat OpenShift, then Red Hat
  certification (chart-verifier), then an Operator.
- An autopilot reasoner backend that calls a model API with no tools (for example watsonx.ai),
  with its own run evidence.
- Registering Kurahi agents for evaluation in watsonx.governance through detached prompt
  templates.
- Live verification of each row above in an IBM environment provided for testing, after which the
  status column changes.
