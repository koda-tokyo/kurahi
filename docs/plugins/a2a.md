---
summary: "a2a plugin: expose listed agents as Agent2Agent (A2A) servers on the gateway, and call allowlisted remote A2A agents with a2a_send / a2a_get_task"
read_when:
  - You want another A2A-speaking agent (any vendor) to call one of your agents
  - You want your agent to call a remote A2A agent
  - You are reviewing what an A2A caller can and cannot reach
title: "A2A Plugin"
---

# A2A (bundled plugin, off by default)

日本語: [A2A（Agent2Agent）連携](/ja/plugins/a2a)

[Agent2Agent (A2A)](https://a2a-protocol.org) is an open protocol (Linux Foundation) for
agents to discover each other through an **Agent Card** and exchange messages and tasks over
JSON-RPC. The plugin has two independent halves:

- **Server:** publishes the agents you list as A2A agents on the gateway HTTP server.
- **Client:** the optional tools `a2a_send` and `a2a_get_task` call the remote agents you list,
  by name.

This is separate from the internal agent-to-agent tools (`sessions_send` and the rest), which
connect agents inside one gateway. A2A is for agents you do not run.

## Protocol versions

The server speaks both versions on the same endpoint. Each call's method name picks the version:

|              | v1.0 (current spec)                  | v0.3 (widely deployed)             |
| ------------ | ------------------------------------ | ---------------------------------- |
| Send         | `SendMessage`                        | `message/send`                     |
| Stream (SSE) | `SendStreamingMessage`               | `message/stream`                   |
| Get          | `GetTask`                            | `tasks/get`                        |
| Cancel       | `CancelTask`                         | `tasks/cancel`                     |
| Enums        | `TASK_STATE_COMPLETED`, `ROLE_AGENT` | `completed`, `agent`               |
| Send result  | `{ "task": { ... } }`                | the Task itself (`"kind": "task"`) |

The Agent Card comes in the v1.0 shape (`supportedInterfaces`, `securityRequirements`) when the
request has `A2A-Version: 1.0`. Without the header it comes in the v0.3 shape (`url`,
`protocolVersion`, `security`), because the spec reads a missing header as 0.3. Any other
`A2A-Version` value gets `VersionNotSupportedError` (-32009).

The client fetches the card with `A2A-Version: 1.0`. It uses v1.0 when the card lists a v1.0
JSON-RPC interface and v0.3 otherwise.

## Server

```json5
{
  plugins: {
    entries: {
      a2a: {
        enabled: true,
        config: {
          server: {
            enabled: true,
            // publicUrl: "https://agents.example.com",   // used on the card; needed behind a proxy
            // allowNonLoopback: false,                   // default: loopback callers only
            defaultAgent: "helpdesk", // also served at /.well-known/agent-card.json
            agents: [
              {
                agentId: "support", // internal id, never published
                slug: "helpdesk", // public path: /a2a/helpdesk
                name: "Helpdesk",
                description: "Answers questions about our products.",
                skills: [
                  {
                    id: "faq",
                    name: "Product FAQ",
                    description: "Product questions",
                    tags: ["support"],
                  },
                ],
                allowTools: false, // default: a model-only reply
                timeoutSeconds: 300,
              },
            ],
            clients: [
              // One entry per calling party. Store the token in the secrets store:
              //   kurahi secrets set a2a-partner-token   (or `kurahi secrets migrate`)
              { id: "partner", token: { $secret: "a2a-partner-token" }, agents: ["helpdesk"] },
            ],
          },
        },
      },
    },
  },
}
```

Endpoints for each listed agent:

- `GET <basePath>/<slug>/.well-known/agent-card.json` returns the Agent Card. `basePath`
  defaults to `/a2a`.
- `POST <basePath>/<slug>` is the JSON-RPC 2.0 endpoint. `message/stream` and
  `SendStreamingMessage` answer with `text/event-stream`.
- `GET /.well-known/agent-card.json` serves the card of `defaultAgent`, when one is set.

### How a request runs

1. The **network gate** comes first. A caller whose address is not loopback gets 403 unless
   `allowNonLoopback` is set. `X-Forwarded-For` is honoured only from `gateway.trustedProxies`.
2. **Bearer auth:** every JSON-RPC call needs `Authorization: Bearer <token>` matching one
   client. Tokens must be at least 32 characters and no two clients may share one. Tokens are
   hashed at startup and compared in constant time. A failure returns 401 with
   `WWW-Authenticate: Bearer` and writes an `a2a.server.auth_failed` audit row. The token is
   never logged or audited. After 10 failures in a minute, an address gets 429 for the rest of
   that minute.
3. **Per-client allowlist:** a client reaches only the slugs it lists. Any other slug returns
   403 and writes `a2a.server.forbidden`.
4. **Limits:** `requestsPerMinute` per client (429 + `Retry-After`), `maxBodyBytes` (413),
   `maxParts`, `maxInputChars`, `maxConcurrentTasks` (503 + `Retry-After`), and `maxTasks` held
   in memory for `taskTtlMinutes`.
5. **Isolated session:** the task runs as a turn of
   `agent:<agentId>:a2a:<clientId>:<contextId>`. It never uses the agent's main session, and
   two clients never share a session, even when they send the same `contextId`. A follow-up
   message in the same `contextId` continues that session.
6. **Untrusted content:** the inbound text is wrapped in the
   `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers, with the standard warning and source "A2A
   Agent". Markers spoofed inside the text are neutralised. A system note tells the agent the
   request is untrusted and must not reveal internals. Suspicious patterns are counted in an
   `a2a.task.suspicious_input` audit row.
7. **Tools:** by default the run has no tools (`allowTools: false`). With `allowTools: true`,
   the agent gets its normal tool set, and every call passes the policy guard
   (`policy > agents.list[].permissions > defaults`), approvals included, as in any other
   session. The A2A client tools are never offered inside an A2A session, so an inbound request
   cannot be relayed to another A2A agent. CLI-backed providers are refused for A2A sessions
   because their tools run outside the guarded tool set.
8. **No delivery:** the reply becomes the task result (an artifact plus the final status
   message). Nothing is sent to a channel.
9. **Audit:** each task writes `a2a.task.submitted` and then one of `a2a.task.completed`,
   `a2a.task.failed` or `a2a.task.canceled`, with client, slug, task and context ids and
   character counts. Message content is not audited.

Task lifecycle: `submitted`, then `working`, then one of `completed`, `failed` or `canceled`.
A send waits for the result unless the caller asks it not to (`configuration.blocking: false` in
v0.3, `returnImmediately: true` in v1.0). In that case the caller polls with `tasks/get` /
`GetTask`. A task is visible only to the client that created it. Any other client gets
`TaskNotFoundError`.

### Agent Card contents

The card is built only from the config you write: `name`, `description`, `version`, `skills`,
optional `provider`, and the endpoint URL. The internal agent id, workspace, model, provider,
tool list and `instructions` never appear on it. The URL on the card comes from `publicUrl`.
Without `publicUrl`, the URL comes from a loopback `Host` header, and failing that, from
`http://127.0.0.1:<gateway port>`. A non-loopback `Host` header is never echoed onto the card.

Cards are public by default (`publicCard: true`) so peers can discover them, but they still sit
behind the network gate. Set `publicCard: false` to require a client token for the card too.

### Error codes

| Code   | Meaning                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| -32700 | Invalid JSON                                                                                                                                      |
| -32600 | Not a JSON-RPC 2.0 request; batches and notifications are not supported; 413 for oversize bodies                                                  |
| -32601 | Unknown method                                                                                                                                    |
| -32602 | Invalid params (missing `message`, bad ids, role not user, input too long)                                                                        |
| -32603 | Internal error (details stay in the gateway log)                                                                                                  |
| -32001 | Task not found (also for another client's task)                                                                                                   |
| -32002 | Task not cancelable (already terminal)                                                                                                            |
| -32003 | Push notifications not supported                                                                                                                  |
| -32004 | Unsupported operation (resubscribe, ListTasks, extended card, a message to an existing task, a second task in a busy context, streaming disabled) |
| -32005 | Content type not supported (file parts)                                                                                                           |
| -32009 | `A2A-Version` not supported                                                                                                                       |

## Client tools

```json5
{
  plugins: {
    entries: {
      a2a: {
        enabled: true,
        config: {
          client: {
            agents: [
              {
                name: "travel",
                cardUrl: "https://travel.example.com/.well-known/agent-card.json",
                token: { $secret: "a2a-travel-token" },
                // rpcUrl: "https://rpc.travel.example.com/a2a",  // only if the endpoint is on another origin
              },
            ],
          },
        },
      },
    },
  },
  // Optional tools: allow them per agent.
  agents: { list: [{ id: "main", tools: { allow: ["a2a_send", "a2a_get_task"] } }] },
}
```

- `a2a_send { agent, message, contextId?, taskId? }` sends a text message and waits for the
  result.
- `a2a_get_task { agent, taskId }` fetches a task's state and result.

Safety rules:

- The model passes a **configured name**, never a URL.
- `cardUrl`, the card's endpoint and `rpcUrl` must be **HTTPS**. Plain HTTP is allowed only for
  loopback hosts. URLs with embedded credentials are refused.
- The endpoint on a card must have the **same origin as the card**, unless you set `rpcUrl`
  yourself. A card cannot redirect your token to another host.
- HTTP **redirects are refused**. Requests time out after `timeoutMs`. Responses over
  `maxResponseBytes` are dropped, and outgoing messages over `maxMessageChars` are refused.
- Cards are cached for `cardTtlSeconds`.
- Everything the remote returns, error text included, reaches the model **inside the
  untrusted-content markers**. Only the task state and ids that match a strict pattern appear
  outside them.
- Each call writes an `a2a.client.send` or `a2a.client.get` audit row: agent name, task id,
  state, character counts and outcome (`denied` for config or HTTPS refusals). Tokens are never
  in audit rows, logs or tool output.

## Security notes

- Everything is off until you set it: the plugin (bundled, disabled by default),
  `server.enabled`, at least one agent and one client, and `allowNonLoopback` for remote
  callers.
- To accept remote callers, put the gateway behind TLS (a reverse proxy, or Tailscale Serve) and
  set `publicUrl` to the HTTPS URL. A bearer token sent over plain HTTP across a network can be
  read on the way.
- Give each calling party its own client and token, so you can revoke one without the others and
  the audit rows name who called.
- With `allowTools: true`, an outside party can make your agent act. Keep `allowTools` off unless
  you need it. When you turn it on, give that agent a narrow `tools.allow` list and policy rules
  that `ask` for anything with side effects. The untrusted-content markers reduce prompt
  injection; they do not prevent it.

## Not implemented

- Push notifications (`tasks/pushNotificationConfig/*`, `*TaskPushNotificationConfig`).
- `tasks/resubscribe` / `SubscribeToTask`, `ListTasks`, and the authenticated extended card.
- File parts (inbound requests are refused with -32005; in client replies they show as
  `[file part omitted]`).
- The `input-required` and `auth-required` states. Agents never pause for input, so a message
  that references an existing task is refused.
- Incremental streaming. SSE delivers the initial task, then one artifact with the full reply,
  then the final status. Partial tokens are not streamed. Closing the stream does not cancel the
  task.
- gRPC and HTTP+JSON (REST) bindings. Only JSON-RPC is served.
- OAuth2, OpenID Connect, mTLS, API-key schemes and signed Agent Cards. Only bearer tokens are
  supported.
- Persistence. Tasks live in memory and are lost on a gateway restart or plugin reload, and
  running tasks are aborted on unload. The agent session transcripts do persist.
- Multi-tenant `tenant` fields are ignored.
- The client tools do not stream and do not poll: `a2a_send` waits for a blocking reply, and
  `a2a_get_task` polls once.
