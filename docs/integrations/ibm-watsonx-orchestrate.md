---
summary: "IBM watsonx Orchestrate and Kurahi side by side: register Kurahi agents as external A2A 0.3.0 collaborators, import Kurahi MCP tools as a remote toolkit or an OpenAPI tool, and call allowlisted Orchestrate agents from Kurahi; Orchestrate is always an untrusted caller"
read_when:
  - You run watsonx Orchestrate and want its agents to call a Kurahi agent or Kurahi tools
  - You want a Kurahi agent to call an Orchestrate agent
  - You are reviewing what Orchestrate can and cannot reach in Kurahi
title: "watsonx Orchestrate"
---

# IBM watsonx Orchestrate

日本語: [watsonx Orchestrate 連携](/ja/integrations/ibm-watsonx-orchestrate)

Kurahi works next to an existing watsonx Orchestrate deployment; it does not replace it. The pack
uses open protocols where Orchestrate supports them and adds no IBM code to Kurahi:

| Direction             | How                                                                    | Kurahi side                                            |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Orchestrate to Kurahi | External agent, provider `external_chat/A2A/0.3.0` (JSON-RPC 2.0/HTTP) | [A2A plugin](/plugins/a2a) server                      |
| Orchestrate to Kurahi | Remote MCP toolkit (streamable HTTP)                                   | [Legacy analyser MCP server](/tools/legacy-mcp)        |
| Orchestrate to Kurahi | OpenAPI tool import                                                    | A2A plugin ask endpoint (`server.rest`)                |
| Kurahi to Orchestrate | `POST /v1/orchestrate/{agent_id}/chat/completions`                     | `watsonx-orchestrate` plugin, `orchestrate_agent_chat` |

**Status: Available.** Every path on this page follows IBM's published Orchestrate documentation and
is covered by Kurahi's conformance tests. See [References](#references).

## Orchestrate is an untrusted caller

Whatever path it uses, Orchestrate reaches Kurahi as an external client with its own token:

- Its requests run in an isolated session (`agent:<agentId>:a2a:<clientId>:<contextId>`), never
  an agent's main session, and are wrapped as untrusted external content.
- Tools are off unless the operator sets `allowTools: true` for that agent. When on, every call
  passes the same policy guard and approvals as any other session.
- It never holds a person's powers: it cannot approve or decide work items, clear flags, accept an
  autonomy level, change configuration or act as an operator. Those stay with people in Kurahi.
- Only ids, counts and outcomes are audited; message content is not.

## Register a Kurahi agent in Orchestrate (A2A 0.3.0)

Orchestrate calls external agents as collaborators of a native agent. It supports A2A 0.3.0 over
JSON-RPC 2.0 on HTTP (0.2.1 is deprecated). The Kurahi A2A server answers the 0.3 method names
(`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`) and serves a 0.3.0 Agent Card when
the request has no `A2A-Version` header.

### 1. Expose the agent

Orchestrate must reach the gateway over HTTPS. Put the gateway behind a TLS reverse proxy, list the
proxy in `gateway.trustedProxies`, and set `publicUrl` so the card carries the public URL:

```json5
{
  plugins: {
    entries: {
      a2a: {
        enabled: true,
        config: {
          server: {
            enabled: true,
            allowNonLoopback: true,
            publicUrl: "https://agents.example.com",
            defaultAgent: "procedures",
            apiKeyHeader: true, // only if Orchestrate uses auth_scheme API_KEY
            rest: true, // only for the OpenAPI import below
            agents: [
              {
                agentId: "support",
                slug: "procedures",
                name: "Procedures assistant",
                description: "Answers questions about internal procedures.",
                skills: [
                  {
                    id: "procedures",
                    name: "Procedures",
                    description: "Procedure questions",
                    tags: ["procedures"],
                  },
                ],
              },
            ],
            clients: [
              {
                id: "orchestrate",
                token: { $secret: "a2a-orchestrate-token" },
                agents: ["procedures"],
              },
            ],
          },
        },
      },
    },
  },
}
```

Generate a token of at least 32 characters and store it with `kurahi secrets set
a2a-orchestrate-token`. Give Orchestrate its own client entry so it can be revoked alone.

### 2. Discover or import it

With the card public (`publicCard: true`, the default):

```bash
orchestrate agents discover -u https://agents.example.com/a2a/procedures
```

`discover` reads `<url>/.well-known/agent-card.json`. The card of `defaultAgent` is also served at
`https://agents.example.com/.well-known/agent-card.json`. With `publicCard: false`, pass a
connection that holds the token with `-a <connection>`.

Or write the external agent spec yourself and import it with `orchestrate agents import -f`:

```yaml
spec_version: v1
kind: external
name: procedures_assistant
title: Procedures assistant
nickname: procedures_assistant
provider: external_chat/A2A/0.3.0
description: Answers questions about internal procedures.
api_url: "https://agents.example.com/a2a/procedures"
auth_scheme: BEARER_TOKEN
auth_config:
  token: "<the client token>"
chat_params:
  sendHistory: false
  stream: true
  pushNotifications: false
```

Then add it as a collaborator of a native Orchestrate agent.

### Settings that matter

| Orchestrate setting             | Use                       | Why                                                                                                                  |
| ------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `auth_scheme: BEARER_TOKEN`     | Recommended               | Sent as `Authorization: Bearer`.                                                                                     |
| `auth_scheme: API_KEY`          | With `apiKeyHeader: true` | Kurahi accepts the token in `X-API-Key`. If your tenant does not send that header to A2A agents, use `BEARER_TOKEN`. |
| `auth_scheme: NONE`             | Not supported             | Every Kurahi A2A call needs a client token.                                                                          |
| `app_id` (on-behalf-of token)   | Not supported             | Kurahi does not validate identity-provider JWTs on A2A; the static client token identifies Orchestrate.              |
| `chat_params.stream`            | `true` or `false`         | `true` uses `message/stream` (SSE), `false` uses `message/send`. Both are supported.                                 |
| `chat_params.pushNotifications` | `false`                   | Kurahi does not send push notifications; the card says so.                                                           |
| `chat_params.sendHistory`       | `false`                   | Kurahi keeps the conversation in its own session per `contextId`.                                                    |

Context variables and correlation ids that Orchestrate sends in `metadata` are accepted and
ignored: they never reach the model.

## Remote MCP toolkit

Orchestrate imports remote MCP servers over streamable HTTP or SSE and waits at most 30 seconds
for the tool list; any 4xx fails the import. The [legacy analyser MCP server](/tools/legacy-mcp)
speaks streamable HTTP in stateless mode with JSON responses and answers the tool list without
indexing the project first.

It binds `127.0.0.1` only. Put a TLS reverse proxy on the same host and list its public host name:

```bash
KURAHI_LEGACY_MCP_TOKEN='<token>' \
  kurahi legacy mcp --root /srv/project --http 7465 --allow-host mcp.example.com
```

Then, in Orchestrate (connection commands vary by ADK version; check `orchestrate connections
--help`):

```bash
orchestrate connections add -a kurahi_legacy
orchestrate connections configure -a kurahi_legacy --env draft --kind bearer --type team
orchestrate connections set-credentials -a kurahi_legacy --env draft --token '<token>'
orchestrate toolkits add --kind mcp --name kurahi_legacy \
  --description "Read-only legacy code analysis" \
  --url "https://mcp.example.com/mcp" --transport "streamable_http" \
  --tools "*" --app-id kurahi_legacy
```

IBM's toolkit page lists `key_value` as the connection kind for `--app-id` and also lists bearer
tokens among remote MCP authentication options. Choose the connection kind that sends
`Authorization: Bearer` to a remote server on your ADK version. In stateless mode the server answers
`GET /mcp` with 405, which the MCP specification allows for servers without a server-initiated
stream.

## OpenAPI tool import

With `server.rest: true`, each agent also has `POST /a2a/<slug>/ask` and an OpenAPI 3.0 document
at `GET /a2a/<slug>/openapi.json`. It meets the documented import rules: OpenAPI 3.0, exactly one
server URL without variables, an `operationId` and a description on the operation, JSON in and out.

```bash
curl -s https://agents.example.com/a2a/procedures/openapi.json -o procedures.openapi.json
orchestrate tools import -k openapi -f procedures.openapi.json -a kurahi_ask
```

`kurahi_ask` is a bearer (or API key, with `apiKeyHeader`) connection holding the client token.
The ask endpoint runs exactly like `message/send`.

Do not import the gateway's own OpenAPI document (`openapi/kolo-gateway.openapi.json`). It
describes the operator API, uses OpenAPI 3.1 with a server variable, and would hand operator
powers to Orchestrate.

## Call an Orchestrate agent from Kurahi

Orchestrate agents are callable from outside only through its own REST API,
`POST /v1/orchestrate/{agent_id}/chat/completions` (bearer token, optional `X-IBM-THREAD-ID`).
The `watsonx-orchestrate` plugin (off by default) wraps it in one optional tool,
`orchestrate_agent_chat`.

```json5
{
  plugins: {
    entries: {
      "watsonx-orchestrate": {
        enabled: true,
        config: {
          instanceUrl: "https://api.<region>.watson-orchestrate.cloud.ibm.com/instances/<instance-id>",
          apiKey: { $secret: "orchestrate-api-key" }, // IBM Cloud API key
          // auth: "bearer",  // the stored value is already a bearer token (e.g. issued another way)
          agents: [
            { name: "it-helpdesk", agentId: "<orchestrate agent id>", description: "IT requests" },
          ],
        },
      },
    },
  },
  // The tool is optional: allow it for the agents that may use it.
  agents: { list: [{ id: "main", tools: { allow: ["orchestrate_agent_chat"] } }] },
}
```

- **Allowlist:** the model names a configured agent; it never supplies a URL or an agent id.
- **Auth:** the API key is exchanged at IBM Cloud IAM and the bearer token is cached and refreshed
  before it expires; after a 401 the plugin exchanges once more and retries once. Instances
  hosted outside IBM Cloud use a different token service; store a token obtained there with
  `auth: "bearer"`.
- **Threads:** the reply carries a `threadId`; pass it back to continue the same Orchestrate
  thread (`X-IBM-THREAD-ID`).
- **Untrusted:** the reply and any error text Orchestrate wrote reach the model inside the
  untrusted-content markers. Responses are bounded (`maxResponseBytes`, `timeoutMs`), redirects
  are refused.
- **Audit:** `orchestrate.chat` rows carry the agent name and id, thread id, outcome, status and
  character counts. Message text is not audited.
- **Not a gather tool:** Orchestrate agents can act on other systems, so the tool is not in the
  autopilot's read-tool catalogue and a routine cannot call it to gather. Exposing it to the
  autopilot would make it an `external` action that needs a standing approval; that is not part
  of this release. It is also never offered to sessions serving inbound A2A callers, so an inbound
  request cannot be relayed to Orchestrate.
- **Replies:** the text is read from an OpenAI-style `message.content` (a string or content
  items).

## References

| Item                                                       | IBM documentation                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider `external_chat/A2A/0.3.0`, JSON-RPC 2.0 over HTTP | [Connect external agents](https://developer.watson-orchestrate.ibm.com/agents/connect_agent)                           |
| `auth_scheme` BEARER_TOKEN, API_KEY, NONE; `chat_params`   | same                                                                                                                   |
| `agents discover -u` reads `/.well-known/agent-card.json`  | same                                                                                                                   |
| API_KEY and `X-API-Key`                                    | [Onboard external agents](https://connect.watson-orchestrate.ibm.com/agent/onboard-external) (chat-completions agents) |
| Remote MCP: transports, 30 s tool-list timeout, 4xx fails  | [Remote MCP toolkits](https://developer.watson-orchestrate.ibm.com/tools/toolkits/remote_mcp_toolkits)                 |
| OpenAPI import rules                                       | [Create OpenAPI tools](https://developer.watson-orchestrate.ibm.com/tools/create_openapi_tool)                         |
| Chat with agents API                                       | [Chat with agents](https://developer.watson-orchestrate.ibm.com/apis/orchestrate-agent/chat-with-agents)               |

Overview of the whole pack: [IBM watsonx](/integrations/ibm-watsonx).
