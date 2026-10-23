---
summary: "OWASP Top 10 for Agentic Applications (ASI01-ASI10): how Kurahi addresses each risk today, with an honest rating per item and links to the mechanism"
read_when:
  - Answering a security questionnaire that refers to the OWASP Agentic Top 10
  - Deciding which secure defaults to adopt on an existing installation
  - Reviewing what Kurahi does not yet cover for agent-specific risks
title: "OWASP Agentic Top 10"
---

# OWASP Agentic Top 10: where Kurahi stands

日本語版: [OWASP Agentic Top 10 への対応](/ja/security/owasp-agentic)

This page maps the OWASP Top 10 for Agentic Applications (risks ASI01 to ASI10) to the controls
Kurahi ships. It is a self-assessment by the KODA SōKEN team, written from the mechanism pages
linked below. It is not a certification and not a third-party audit.

**Status as of 23 October 2026: 4 addressed, 6 partly addressed, 0 not addressed.**

What the ratings mean:

- **Addressed**: a dedicated control exists in the runtime, is on (`enforce`) for new
  installations, is audited, and its limits are documented. Addressed does not mean the risk is
  gone; read the limits on each linked page.
- **Partly addressed**: controls reduce the risk, but an important part depends on configuration,
  on the operator's review, or on the model following instructions it may not follow.
- **Not addressed**: no control.

Existing installations keep their old settings until the operator changes them; `kurahi doctor`
lists every protection that is still on an old permissive default (see
[Secure defaults](/security/secure-defaults)). The ratings below assume the secure defaults.

## Summary

| Risk                                       | Rating           | Main controls                                                                                    |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| ASI01 Agent goal hijack                    | Partly addressed | Untrusted-content markers, policy, approvals, memory quarantine                                  |
| ASI02 Tool misuse and exploitation         | Partly addressed | Signed policy (tool allow/deny, budgets), exec approvals, sandbox                                |
| ASI03 Identity and privilege abuse         | Partly addressed | Credential isolation per agent, scoped pairing, session allowlists                               |
| ASI04 Agentic supply chain vulnerabilities | Addressed        | [Supply-chain lock](/security/skill-integrity) for skills and plugins                            |
| ASI05 Unexpected code execution            | Addressed        | Destructive-command guard, sandbox, exec approvals, [terminal broker](/security/terminal-broker) |
| ASI06 Memory and context poisoning         | Addressed        | [Memory provenance and quarantine](/security/memory-provenance)                                  |
| ASI07 Insecure inter-agent communication   | Addressed        | [Signed agent messages](/security/agent-message-signing)                                         |
| ASI08 Cascading failures                   | Partly addressed | Budgets and job limits, kill switch, loop guard                                                  |
| ASI09 Human-agent trust exploitation       | Partly addressed | On-screen approvals, voice never approves, risk preview                                          |
| ASI10 Rogue agents                         | Partly addressed | Kill switch, hash-chained audit log, boot integrity gate                                         |

## Addressed

### ASI04 Agentic supply chain vulnerabilities

Skills and plugins are pinned by SHA-256 in a lock signed by the owner key. In `enforce` mode
(new installations) a non-bundled skill or plugin loads only when its content matches its pin;
pinning runs a static scan first. Limits: bundled code and plugin dependencies are not hashed, and
a pin records that the operator approved the bytes, not who wrote them.
Details: [Skill and plugin integrity](/security/skill-integrity).

### ASI05 Unexpected code execution

Every path that turns agent output into a shell command passes an unconditional
destructive-command guard that no approval can override. Groups, channels, sub-agents and cron run
in the container sandbox on new installations; commands outside a sandbox go through exec
approvals. The Work Console terminal gates every line, asks for approval for anything that is not
read-only, and records diffs and audit entries. Limits: an approved program runs with the rights
of the operating-system user unless the sandbox is used.
Details: [Secure defaults](/security/secure-defaults), [Console terminal broker](/security/terminal-broker).

### ASI06 Memory and context poisoning

Every memory write is tagged with who wrote it and the trust of what the agent had read. In
`enforce` mode, writes made after untrusted input, or that look like injected instructions, are
held for operator review; recalled memory is marked by trust. Limits: marking tells the model what
is untrusted but cannot make it obey; writes outside agent tools are recalled as `unverified`.
Details: [Memory provenance](/security/memory-provenance).

### ASI07 Insecure inter-agent communication

Messages between agents carry an envelope signed with a per-agent Ed25519 key, checked against an
owner-signed key registry, with recipient, timestamp, nonce and payload schema verified. In
`enforce` mode unsigned, forged, replayed or malformed messages are rejected. Limits: code running
as the gateway user can read the keys; a pinned owner is needed for a fixed trust anchor.
Details: [Agent message signing](/security/agent-message-signing).

## Partly addressed

### ASI01 Agent goal hijack

Content from outside (web pages, remote agents, channel messages) reaches the model inside
untrusted-content markers, memory writes after such input are quarantined, and consequential
actions need a policy decision or a person's approval. The markers reduce prompt injection; they
do not prevent it. What remains depends on keeping tools narrow for agents that read untrusted
input. See the [security guide](/gateway/security).

### ASI02 Tool misuse and exploitation

The signed policy sets per-agent tool allow and deny lists, tool classes that need approval,
egress and MCP allow lists, and budgets, enforced at every tool call (see [Policy](/policy)).
What remains: a tool that is allowed can still be used badly within its scope, and the risk
preview for an approval is a hint, not a guarantee.

### ASI03 Identity and privilege abuse

New installations isolate credentials per agent (`auth.isolation: explicit`); paired devices
have scopes and short-lived, rotating tokens; session allowlists narrow a credential. What
remains: everything running as the gateway's operating-system user shares one trust domain on the
host, and an agent granted `*` keeps every credential.

### ASI08 Cascading failures

The starter policy sets job limits (concurrent jobs, wall clock, tool steps) and token and tool-call
budgets per agent and for the fleet; the kill switch stops one agent or all of them within one
event-loop tick; the [loop guard](/agents/loop-guard) caps steps and detects repeated calls. What
remains: there is no automatic isolation of an agent whose outputs are wrong but within budget.

### ASI09 Human-agent trust exploitation

Approvals are explicit on-screen confirmations; no approval can be given by voice; an
unanswered terminal approval counts as denied. What remains: a person can still be persuaded to approve. The risk
preview and the diff help the approver; they do not decide for them.
See [Voice](/tools/voice) and [Console terminal broker](/security/terminal-broker).

### ASI10 Rogue agents

Every tool execution and decision is written to a hash-chained audit log (`kurahi audit verify`);
the boot integrity gate refuses to start when protected policy files change; the kill switch stops
agents at once. What remains: detection is after the fact; there is no behavioural anomaly
detection that stops an agent on its own.

## Not addressed

None as of 23 October 2026.

## Related

- [Security overview](/security/SECURITY_OVERVIEW)
- [Secure defaults](/security/secure-defaults)
- [Privacy](/security/privacy)
