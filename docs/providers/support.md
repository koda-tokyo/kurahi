---
summary: "Which model providers are curated, which are only listed from the public catalogue, and which have KODA tested results"
read_when:
  - You need to know whether a provider is supported, tested, or merely listed
  - You are choosing a provider for data that must stay in a region
title: "Provider support"
---

# Provider support

The provider registry has **209 entries**. They are not all equal.

| Level           | What it means                                                                                                                                                                 | Count in 2.1.0      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Curated**     | Configuration written and maintained by KODA: endpoint, authentication, region note, defaults, list prices where published. Supported: we fix problems with these.            | 17                  |
| **Catalogue**   | Imported from a public provider catalogue so you can try them. Listed, not tested; best effort only.                                                                          | 192                 |
| **KODA tested** | A curated provider and model that passed the [KODA tested benchmark](/providers/koda-tested) as a resident: tool use, policy adherence, continuity and Japanese instructions. | 1 model; 10 pending |

## Curated providers

| Provider                             | Where requests are processed (provider's own statement) |
| ------------------------------------ | ------------------------------------------------------- |
| Sakura AI Engine (default profile)   | Japan                                                   |
| Ollama                               | Your machine                                            |
| Any OpenAI-compatible endpoint       | Wherever that endpoint is hosted                        |
| Azure OpenAI                         | The region you choose per resource                      |
| Mistral AI                           | European Union                                          |
| OpenAI                               | Global, US by default                                   |
| Anthropic                            | Global, US by default                                   |
| Google Gemini API                    | Global; region not selectable on this API               |
| Groq, Together AI, Fireworks AI, xAI | Global, US by default                                   |
| OpenRouter                           | Depends on the upstream model                           |
| DeepSeek, Moonshot AI, Z.AI          | China (international endpoints for some)                |
| MiniMax                              | Singapore                                               |

Region statements come from each provider's documentation and are recorded in the registry with
their source. Check your contract with the provider before sending regulated data; for personal
data, turn on the [context guard](/context-guard) and prefer a provider in your own jurisdiction or
a local model.

## What we test before a release

Every release runs the full test suite on Linux, macOS and Windows. Provider adapters are tested
with simulated responses; live provider accounts are not part of release testing. Live benchmark runs are added to the
[KODA tested](/providers/koda-tested) catalogue as they complete, with a signed report.
