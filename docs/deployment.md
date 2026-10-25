---
summary: "The four deployment configurations, and exactly which data leaves the host in each"
read_when:
  - Security or legal asks what leaves the machine
  - You are choosing between a local model, a Japan-hosted model and an external provider
title: "Deployment and data boundaries"
---

# Deployment and data boundaries

![Where data goes in each deployment](assets/deployment-boundaries.svg)

Whatever you choose, the runtime's own records stay on the host that runs it: configuration,
policy, memory, sessions, evidence bundles, the audit log and secrets. Two kinds of traffic can
leave, and both are under your control:

1. **Model requests.** The prompt, the conversation so far and tool results go to the model you
   configure. With a local model they never leave the host. With the
   [context guard](/context-guard) on, personal data in tool results is replaced with placeholders
   before it is sent.
2. **Channel messages.** If you connect LINE, Slack, Teams or another channel, messages to and
   from people pass through that service.

| Configuration                           | Model runs                                          | Leaves the host                                                      | Typical fit                                           |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| 1. Fully local                          | On the host, through Ollama or another local server | Nothing, unless you connect a channel                                | Regulated records, sites without internet, evaluation |
| 2. Japan-hosted model (default profile) | Sakura AI Engine, in Japan                          | Model requests, to Japan                                             | Japanese enterprises that need domestic processing    |
| 3. External provider                    | Any [curated provider](/providers/support)          | Model requests, to that provider's region                            | Non-personal data, or where your contract allows it   |
| 4. Air-gapped (licensed separately)     | A model server on the isolated network              | Nothing; installation and updates arrive as verified offline bundles | Government, defence, plant networks                   |

You can mix them per agent: one agent on a local model for HR records, another on a hosted model
for public research. The [policy](/policy) can restrict which providers and models each agent may
call (`agents.<id>.providers`, `agents.<id>.models`), so a mistake in configuration cannot send an
agent's data somewhere the policy does not allow.

Check the region and retention terms of any hosted provider against your own obligations; the
region notes in the registry quote each provider's documentation, not a contract.

Each release publishes `SHA256SUMS.txt` and a build provenance attestation; verify the download
against them before installing on a managed host (builds are not code-signed or notarised).
