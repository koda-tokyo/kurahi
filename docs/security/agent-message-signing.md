---
summary: "Signed inter-agent messages: per-agent Ed25519 keys, an owner-signed key registry, envelope verification (sender, signature, recipient, timestamp, nonce), payload schema validation and how received content is marked"
read_when:
  - Enabling agent-to-agent messaging (tools.agentToAgent) or sub-agents across agent ids
  - Reading an "inter-agent message rejected" error or an agent.message.verify audit entry
  - Answering OWASP Agentic Top 10 questions (ASI07 Insecure Inter-Agent Communication)
title: "Agent message signing"
---

# Agent message signing

Agents talk to each other through the gateway `agent` method: `sessions_send`, its reply
ping-pong and announce steps, `sessions_spawn` (parent to sub-agent) and the sub-agent announce
(sub-agent back to its parent, sent directly or after waiting in the announce queue). Every one
of these messages is signed by the sending agent and verified by the gateway before the
recipient's run starts. Peer chat (`sibling.send`) uses the same envelope; see
[sibling.send](#siblingsend).

Access control still comes first: cross-agent sends need `tools.agentToAgent.enabled` and an
allowlist entry, sandboxed sessions only see sessions they spawned, and the ping-pong is capped
at `session.agentToAgent.maxPingPongTurns`. The sending tool checks this, and the gateway checks
it again on receipt (see [Receiver-side access check](#receiver-side-access-check)).

## Modes

```json5
{
  agents: {
    messaging: {
      signing: {
        mode: "enforce", // off | warn | enforce
        maxAgeSeconds: 300, // accepted message age and clock skew
        maxPayloadBytes: 262144, // message plus A2A context
      },
    },
  },
}
```

| Mode      | Sender        | Gateway on a failed check                                   |
| --------- | ------------- | ----------------------------------------------------------- |
| `enforce` | signs         | rejects the request (`inter-agent message rejected: ...`)   |
| `warn`    | signs         | delivers it, marked `UNVERIFIED`, and flags it in the audit |
| `off`     | does not sign | no checks, content is delivered unchanged                   |

New installations (`kurahi init`, `kurahi setup`, onboarding) get `enforce`. A config without
the key runs as `warn` and gets a `secure-defaults.agent-message-signing` warning from
`kurahi doctor` and at gateway startup (see [Secure defaults](/security/secure-defaults)).

## Keys and the registry

| File                                          | Contents                                              |
| --------------------------------------------- | ----------------------------------------------------- |
| `<KOLO_HOME>/secrets/agent-keys/<agent>.json` | the agent's Ed25519 key pair (file 0600, folder 0700) |
| `<KOLO_HOME>/identity/agent-keys.json`        | agent id to public key, signed by the owner key       |

An agent's key is created the first time it sends an inter-agent message, in the same format
as device identities. The key is then added to the registry, and the registry is re-signed with
the policy owner key (`<KOLO_HOME>/secrets/policy-owner.json`, the key `kurahi policy sign`
uses). Private keys never leave the key file and are never logged.

The gateway trusts the registry only when its signature verifies and the signer is a pinned
policy owner (`<KOLO_HOME>/policy/owners.json`). When no owner is pinned yet, the local owner
key is the trust anchor. When owners are pinned and the local key is not one of them, the
local key cannot sign the registry and messages go out unsigned, which `enforce` rejects.

Source: `src/agents/messaging/keys.ts`.

## The envelope

The sending code (never the model) attaches `agentEnvelope` to the `agent` request:

| Field                 | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `senderAgentId`       | the sending agent                                             |
| `senderSessionKey`    | the sending session (optional)                                |
| `recipientSessionKey` | the session the message is for                                |
| `nonce`               | 18 random bytes, base64url                                    |
| `timestamp`           | milliseconds since the epoch                                  |
| `payloadSha256`       | SHA-256 of the message and the A2A context                    |
| `keyId`, `signature`  | sender key id and the Ed25519 signature over all fields above |

The gateway checks, in order: envelope shape (zod, no extra fields), registry signature, sender
registered with this key, signature, payload hash, recipient equals the delivery session (raw
or canonical key), timestamp within `maxAgeSeconds` either way, nonce not seen before, and the
sender/recipient pair allowed by the configuration.

## Replay protection across restarts

Accepted nonces are kept in memory and mirrored to `<KOLO_HOME>/identity/agent-message-nonces.jsonl`
(file 0600, folder 0700). Each accepted nonce is appended and synced to disk before the message is
accepted. On the first check after a start the file is read back and entries whose window has
passed are dropped, so a message captured before a restart is still a replay afterwards. The store
holds at most 20,000 live entries (oldest dropped first) and the file is rewritten with only the
live entries whenever it grows past twice that. The `agent` method and `sibling.send` share it.

If the file cannot be written, the gateway logs one warning and keeps the in-memory guard: replays
are still refused until the next restart.

Source: `src/agents/messaging/nonce-store.ts`.

## Receiver-side access check

For a message between two different agents, the gateway re-checks the configuration the sending
tool applied, using the sender from the envelope (and, for sub-agents, the signed sender session
key). The pair is allowed when one of these holds:

- `tools.agentToAgent.enabled` is true and both agents match `tools.agentToAgent.allow`;
- the recipient is a sub-agent session and the sender's `subagents.allowAgents` names the
  recipient agent (a `sessions_spawn`);
- the sender is a sub-agent session and the recipient's `subagents.allowAgents` names the sender
  agent (the sub-agent announcing back to its parent).

Otherwise the reason is `not-allowed: ...`. It follows the signing mode like every other reason:
`enforce` rejects, `warn` delivers flagged and audits. With `off` nothing is checked, because the
gateway cannot know the sender.

Source: `src/agents/messaging/access.ts`.

A request counts as an inter-agent message when it carries an envelope, runs on the nested
(A2A) lane, or its context starts with an `Agent-to-agent ...` header. Such a request without
an envelope is `unsigned`. Requests from the operator, channels and `/subagents send` are not
inter-agent messages and are not affected.

Source: `src/agents/messaging/envelope.ts`, `src/agents/messaging/inbound.ts`, wired into
`src/gateway/server-methods/agent.ts`.

## sibling.send

`sibling.send` is the peer chat between agents on one gateway (TUI side panel, `sibling` event).
Without signing, its sender is whatever the connecting client's declared id says. A signing client
attaches `agentEnvelope` with:

- `recipientSessionKey`: `sibling:<to>` (an envelope for one peer, or one made for the `agent`
  method, does not verify for another);
- the payload hash over the text, plus `sibling-attachments-sha256:<hex>` of the attachments when
  there are any;
- no `senderSessionKey`.

The gateway verifies it with the same registry and the shared replay store. When it verifies, the
signer's agent id is the sender, whatever the client id claims. Unsigned or failing sends follow
the mode: `enforce` rejects (`sibling message rejected ...`), `warn` delivers with the client-declared
sender, `off` does no checks. Each send writes a `sibling.message.verify` audit entry (outcome
`ok`, `flagged` or `denied`, with the claimed sender), and the `sibling` event carries
`verified: true|false`.

Signing needs the agent's private key, so only a client on the gateway host, running as the gateway
user, can sign: `GatewayChatClient.sendSiblingMessage({ ..., fromAgentId })`
(`src/tui/gateway-chat.ts`). A remote client cannot sign and is refused in `enforce` mode.

Payload schema validation (below) is not applied to `sibling.send`; it keeps its own 4 KB text
limit and rate limit.

Source: `src/agents/messaging/sibling.ts`, wired into `src/gateway/server-methods/sibling.ts`.

## Sub-agent announces that wait

When the parent session is busy, a sub-agent announce is queued or steered
(`src/agents/subagent-announce-delivery.ts`):

- Queued announces are signed when they are finally sent (so the timestamp is fresh after the
  wait) with the child session's key, and verified like a direct announce. In `collect` mode a
  batch only merges announces from one child session; a queue with several children is sent one by
  one.
- The overflow summary the queue writes when it drops announces ("N announces dropped", built from
  several children's labels) is not signed. Without an envelope it is not an inter-agent message
  and is delivered unmarked, as before.
- Steered announces are injected into the active run inside the gateway process and never reach
  the `agent` method, so there is no signature to check. When the child is another agent, the
  text is wrapped in the untrusted-content boundary naming the child, with
  `Trust: sub-agent announce steered into the active run in-process (not signature-checked)`.
  Announces from the parent's own sub-agents are not wrapped, as with verified same-agent
  messages.

## Payload validation

Every inter-agent payload is validated with a zod schema (`src/agents/messaging/payload.ts`):

- only `message` and the A2A context; the message must not be empty;
- message plus context at most `maxPayloadBytes`;
- no control characters (C0 other than tab, newline and carriage return; DEL; C1);
- no chat-template role tokens (`<|im_start|>`, `<|start_header_id|>`, `[INST]`, `<<SYS>>`,
  `<start_of_turn>` and similar);
- no role marker (`system:`, `assistant:`, `developer:`, `user:`, `tool:`) at the start of a
  line that is hidden or broken up by zero-width, bidi or other invisible characters. A plain
  `System:` line is allowed.

## How received content is marked

When the sender is another agent, or the message is not verified, the gateway wraps the
message with the same untrusted-content boundary used for email and web content
(`src/security/external-content.ts`), naming the sender and the trust level:

```
<<<EXTERNAL_UNTRUSTED_CONTENT>>>
Source: Another agent
From: agent "main" (session agent:main:main)
Trust: signature verified
---
...message...
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>
```

It also appends a provenance note to the run's system context, written by the gateway and not
by the sender. A verified message between sessions of the same agent (for example a parent
and its own sub-agent) is not wrapped; it only gets the provenance note.

## Audit

Every inter-agent message writes one `agent.message.verify` entry to the hash-chained audit log
(`kurahi audit tail`): outcome `ok`, `flagged` (warn mode) or `denied` (enforce mode), the sender
as identity, the recipient session as scope, and the mode, reasons, key id and nonce.
`sibling.send` writes `sibling.message.verify` entries with the same fields plus `claimedFrom`.

## Limits

- The keys protect against forged, altered, misdirected and replayed messages from anything that
  does not hold the private key: gateway clients, plugins calling the `agent` method, injected
  payloads, sandboxed sessions (the sandbox mounts the workspaces and configured `binds`, not
  `<KOLO_HOME>/secrets`; do not bind it). Code running as
  the gateway user on the host can read the keys and the owner key; that is the same trust
  domain as the gateway itself.
- Replay protection survives restarts only while the nonce file can be written; after a write
  failure it lasts until the next restart (logged once). The store is bounded (20,000 live entries);
  a flood of valid signed messages can evict live nonces, and an evicted nonce could be replayed
  inside its window. Deleting the file while the gateway is stopped removes the restart protection
  for messages still inside `maxAgeSeconds`.
- `sibling.send` can only be signed by a client on the gateway host that can read the agent key.
  In `warn` mode an unsigned send is still delivered with the sender the client declares (flagged
  and audited); in `off` mode nothing is checked. No product client sets `fromAgentId` yet: the
  TUI peer-chat view takes it as an optional constructor argument.
- The queue's overflow summary is sent unsigned and unmarked, and steered announces are marked but
  not signed (see [Sub-agent announces that wait](#sub-agent-announces-that-wait)).
- The receiver-side access check only runs when the sender is known: in `off` mode, and for
  unsigned messages in `warn` mode (where the sender is only the one the envelope claims, or
  unknown), it cannot stop a sender that is not allowed. Use `enforce`.
- The registry trust anchor falls back to the local owner key when no owner is pinned (trust on
  first use). Pin owners with `kurahi policy` for a fixed anchor.
