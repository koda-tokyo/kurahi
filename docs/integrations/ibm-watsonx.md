---
summary: "IBM watsonx interoperability pack: run Kurahi alongside watsonx Orchestrate, watsonx.ai, watsonx.governance, watsonx.data and Db2 without replacing them; what works today, setup notes, and what is not included"
read_when:
  - Your organisation runs IBM watsonx products and is evaluating Kurahi next to them
  - You need the list of IBM integration points and their status
title: "IBM watsonx"
---

# IBM watsonx interoperability

日本語: [IBM watsonx 連携](/ja/integrations/ibm-watsonx)

Kurahi is built to work **alongside** an enterprise's IBM stack, not to replace it. Each piece
below uses an open protocol where IBM supports one (A2A, MCP, OpenAPI, OpenTelemetry, the
Presto/Trino client protocol) and a documented IBM REST API otherwise. Every piece is off by
default and needs an administrator to turn it on.

The pack is available. It follows IBM's published documentation and SDKs, and
every piece is covered by Kurahi's conformance tests.

## What works today

| IBM product           | Direction                | Kurahi piece                                                          | Page                                                                                               | Status    |
| --------------------- | ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| watsonx Orchestrate   | Orchestrate calls Kurahi | A2A 0.3.0 server and Agent Card (`a2a` plugin), bearer or `X-API-Key` | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate)                                       | Available |
| watsonx Orchestrate   | Orchestrate calls Kurahi | Remote MCP toolkit: legacy analyser MCP server behind a TLS proxy     | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate#remote-mcp-toolkit)                    | Available |
| watsonx Orchestrate   | Orchestrate calls Kurahi | OpenAPI 3.0 ask endpoint (`server.rest`)                              | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate#openapi-tool-import)                   | Available |
| watsonx Orchestrate   | Kurahi calls Orchestrate | `orchestrate_agent_chat` (`watsonx-orchestrate` plugin)               | [watsonx Orchestrate](/integrations/ibm-watsonx-orchestrate#call-an-orchestrate-agent-from-kurahi) | Available |
| watsonx.ai            | Kurahi uses models       | `watsonx` provider: IAM refresh, region, version, project or space    | [watsonx.ai](/providers/watsonx)                                                                   | Available |
| watsonx.governance    | Kurahi reports runs      | Governance spans over OTLP with Langfuse attributes; Orchestrate push | [watsonx.governance](/integrations/ibm-watsonx-governance)                                         | Available |
| watsonx.data          | Kurahi reads             | `watsonx_data_query` (`ibm-data` plugin), read-only, allowlisted      | [watsonx.data and Db2](/integrations/ibm-watsonx-data-db2)                                         | Available |
| Db2 for z/OS, Db2 LUW | Kurahi reads             | `db2_service_call` (`ibm-data` plugin), allowlisted REST services     | [watsonx.data and Db2](/integrations/ibm-watsonx-data-db2)                                         | Available |

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
  read-tool catalogue, and the autopilot reasoner keeps its tool-less CLI backends.

## Setup notes

- **A2A authentication:** `BEARER_TOKEN` is the recommended Orchestrate scheme. Kurahi also
  accepts `X-API-Key` (`apiKeyHeader: true`) for tenants that use `API_KEY`. Kurahi serves
  A2A 0.3.0.
- **Remote MCP toolkit:** choose the Orchestrate connection kind that sends
  `Authorization: Bearer` on your ADK version.
- **watsonx.ai:** on SaaS in the Tokyo region, use text chat; on software installs, store the
  platform's bearer token with `auth=bearer` if your installation issues tokens differently.
- **Trace intake:** set the Orchestrate intake URL of your region.
- **watsonx.data and Db2:** see the [setup notes](/integrations/ibm-watsonx-data-db2#references)
  for engine authentication and Db2 LUW REST services.

## Not included

- **OpenShift:** there is no Helm chart, Red Hat certification (chart-verifier) or Operator for
  running Kurahi beside watsonx on Red Hat OpenShift.
- The autopilot reasoner does not call watsonx.ai's own chat API. The `api` reasoning backend
  covers OpenAI-compatible providers such as Sakura AI Engine, Qwen endpoints and a local Ollama.
- Kurahi agents are not registered for evaluation in watsonx.governance through detached prompt
  templates.
