---
summary: "IBM watsonx.ai as a model provider: IAM API key exchanged for a refreshed bearer token, regional base URL (Tokyo by default), version date, project or space id, streaming text chat with tool calls, and the OpenAI-compatible model gateway for software installs"
read_when:
  - Your organisation runs models on watsonx.ai and wants Kurahi agents to use them
  - You are configuring the watsonx.ai project, region or version settings
title: "IBM watsonx.ai"
---

# IBM watsonx.ai

日本語: [IBM watsonx.ai](/ja/providers/watsonx)

Kurahi uses models hosted on watsonx.ai through its own adapter (model API `watsonx-chat`).
watsonx.ai is not an OpenAI-compatible endpoint: each call needs a `version` date, a project or
space id, `model_id` instead of `model`, a separate streaming path, and an IAM bearer token that
expires. The adapter handles all of that; the agent runtime sees an ordinary provider.

**Status: Preview.** Built on IBM's watsonx.ai API reference and the watsonx.ai Node SDK.

## What is used

| Item             | Value                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base URL         | Regional, default `https://jp-tok.ml.cloud.ibm.com` (Tokyo); for example `https://us-south.ml.cloud.ibm.com`                                                 |
| Chat (streaming) | `POST /ml/v1/text/chat_stream?version=<date>` (`event: message` SSE frames)                                                                                  |
| Body             | `model_id`, `project_id` or `space_id`, `messages`, `tools`, `max_tokens`, `temperature`                                                                     |
| Version          | `2024-03-14` by default (the active date IBM lists for `/ml/v1`); override per installation                                                                  |
| Authentication   | IBM Cloud API key exchanged at `https://iam.cloud.ibm.com/identity/token`; bearer refreshed before expiry                                                    |
| Tool calling     | `tools` sent in OpenAI function format; `tool_choice_option` is not sent (IBM documents `auto` as not yet supported), so the model decides. Model dependent. |
| Model list       | `GET /ml/v1/foundation_model_specs?version=2024-03-14&filters=function_text_chat` (used by `kurahi providers test`)                                          |
| Model gateway    | `POST /ml/gateway/v1/chat/completions` (OpenAI body) with `mode=gateway`                                                                                     |

## Configure

The endpoint settings are query parameters of the provider base URL, so no new configuration keys
exist. Give the project (or deployment space) id when you add the provider:

```bash
kurahi providers add watsonx \
  --base-url "https://jp-tok.ml.cloud.ibm.com?project_id=<project-id>" \
  --model ibm/granite-3-8b-instruct --api-key-stdin   # paste the IBM Cloud API key
kurahi providers test watsonx                          # exchanges the key, lists chat models
kurahi providers default watsonx --model ibm/granite-3-8b-instruct
```

The API key goes to the auth profile store (`watsonx:default`, file mode 0600 under `KOLO_HOME`),
never to `kolo.json`. `WATSONX_AI_APIKEY` is honoured as an alternative. Tokens are kept in memory
only, per key, and refreshed when less than five minutes remain. The model list differs per
region; take model ids from `kurahi providers test watsonx`.

Base URL parameters:

| Parameter                 | Meaning                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `project_id` / `space_id` | Where inference is billed and governed. One of them is required (not both) for chat mode. |
| `version`                 | API version date, `YYYY-MM-DD`. Default `2024-03-14`.                                     |
| `mode=gateway`            | Use the OpenAI-compatible model gateway instead of text chat.                             |
| `auth=bearer`             | The stored secret is already a bearer token; it is sent as-is (no IAM exchange).          |
| `iam_url`                 | Another IAM token endpoint (https only).                                                  |

## Software installs (Cloud Pak for Data, Software Hub)

IBM documents an OpenAI-compatible model gateway for the software edition at
`/ml/gateway/v1`. Point the base URL at the cluster with `mode=gateway`, and either keep IAM
exchange with `iam_url` set to the platform's token endpoint or store a platform bearer token with
`auth=bearer`:

```text
https://cpd.example.com?mode=gateway&auth=bearer
```

How the software edition issues tokens differs per installation (platform API keys, Zen API keys);
if yours issues them differently, store a platform bearer token with `auth=bearer` as above. On SaaS
in the Tokyo region, use text chat.

## Limits and what is not covered

- A run that lasts longer than the token's lifetime keeps working: each model call takes a token
  from the cache, which refreshes it.
- The autopilot reasoner does not use watsonx.ai yet. Its design admits only CLI backends whose
  tool-less mode is verified; an HTTP backend that sends no tools is planned, with its own run
  evidence, but is not part of this release.
- Deployments (`/ml/v1/deployments/{id}/text/chat`) and AI services are not wired.
- Image input is sent in OpenAI format when the model definition allows images; whether a given
  watsonx.ai model accepts it is model dependent.

Sources: [watsonx.ai API](https://cloud.ibm.com/apidocs/watsonx-ai),
[API key and bearer token](https://www.ibm.com/docs/en/DSXDOC/wsj/getting-started/wx-api-credentials.html),
[model gateway](https://www.ibm.com/docs/SSLSRPV_2.3.x/wsj/analyze-data/fm-model-gateway-use.html),
[regions](https://www.ibm.com/docs/en/SSYOK8/wsj/getting-started/regional-datactr.html),
[watsonx.ai Node SDK](https://github.com/IBM/watsonx-ai-node-sdk). Overview of the pack:
[IBM watsonx](/integrations/ibm-watsonx).
