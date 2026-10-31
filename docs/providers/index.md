---
summary: "Model providers (LLMs) supported by Kurahi"
read_when:
  - You want to choose a model provider
  - You need a quick overview of supported LLM backends
title: "Model Providers"
---

# Model Providers

Kurahi can use many LLM providers. Pick a provider, authenticate, then set the
default model as `provider/model`.

Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? See [Channels](/channels).

## Default for evaluations: Sakura AI Engine

Japan-hosted, OpenAI-compatible, with a free tier of 3,000 chat requests a month. `kurahi init` offers it first.

- Default: `sakura/gpt-oss-120b`
- Also in the preset: `sakura/llm-jp-3.1-8x13b-instruct`, `sakura/Kimi-K2.6` (public preview)

See [Sakura AI Engine](/providers/sakura) (also available in [Japanese](/ja/providers/sakura)).

## Quick start

1. Authenticate with the provider (`kurahi init` on a new installation, `kurahi onboard` later).
2. Set the default model:

```json5
{
  agents: { defaults: { model: { primary: "sakura/gpt-oss-120b" } } },
}
```

## Provider docs

- [Sakura AI Engine](/providers/sakura)
- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, privacy-focused)](/providers/venice)
- [Ollama (local models)](/providers/ollama)

## Transcription providers

- [Deepgram (audio transcription)](/providers/deepgram)

## Community tools

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Use Claude Max/Pro subscription as an OpenAI-compatible API endpoint

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
