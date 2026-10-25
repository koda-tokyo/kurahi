---
summary: "Governance evidence for IBM watsonx.governance: agent and autopilot run spans over OTLP/HTTP with Langfuse-compatible attributes (for the Langfuse or Arize integrations), an optional push to the watsonx Orchestrate trace intake with IAM, and no prompt or reply content unless an administrator opts in"
read_when:
  - Your AI governance team uses watsonx.governance and needs Kurahi agent activity in it
  - You are deciding what run data leaves Kurahi for monitoring
title: "watsonx.governance"
---

# IBM watsonx.governance

日本語: [watsonx.governance 連携](/ja/integrations/ibm-watsonx-governance)

watsonx.governance has no native OpenTelemetry intake for external agents. IBM's route for
agent observability is its Langfuse and Arize integrations, and watsonx Orchestrate accepts
OTLP/HTTP traces from external agents. Kurahi therefore exports its runs as OpenTelemetry spans
with the attribute names Langfuse maps, through the existing `diagnostics-otel` plugin:

- to a Langfuse (or Arize, or any OTLP) endpoint that the governance integration reads, and
- optionally, to the Orchestrate trace intake, so runs appear next to Orchestrate's own traces.

**Status: Preview.** Attribute names follow the Langfuse OpenTelemetry documentation and the
Orchestrate trace-intake documentation; see [References](#references).

## What is exported

Two span kinds, one span per finished run:

| Span                   | When                                               | Langfuse observation type |
| ---------------------- | -------------------------------------------------- | ------------------------- |
| `kurahi.agent.run`     | every embedded agent run (channels, A2A, sessions) | `agent`                   |
| `kurahi.autopilot.run` | every autopilot routine run                        | `chain`                   |

By default a span carries **ids, timings, decisions and counts only**:

- `langfuse.trace.name`, `langfuse.session.id` (the session id, or `autopilot:<project>:<routine>`),
  `langfuse.user.id` (default `usr_kurahi`), `langfuse.observation.level` (`ERROR` on failure,
  `WARNING` for an escalated or watchdog-held autopilot run).
- Agent runs: `gen_ai.system` (provider), `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `langfuse.observation.usage_details`, and metadata: run, agent,
  job and lane ids, outcome (`completed`, `error`, `aborted`, `timeout`), error kind, steps, tool
  calls, duration.
- Autopilot runs: project, routine, edition, area, autonomy level, trigger, status, reasoner
  backend and model and time, gather call count, work items created, decision counts
  (`decision_allow`, `decision_needs_person`, `decision_refuse`, `decision_allow_failed`), run
  counts, watchdog verdict, and the run's evidence root hash, which ties the span to the signed
  run evidence kept in Kurahi.

Never exported: prompts, replies, gathered data, tool arguments or results, error messages, and
names of people. Content is attached only when an administrator sets
`diagnostics.otel.captureContent: true`; then the agent run span also gets
`langfuse.observation.input` / `output` (and `input` / `output`), truncated to
`maxContentChars` (default 4000). Autopilot spans never carry content.

## Configure (Langfuse)

```json5
{
  plugins: { entries: { "diagnostics-otel": { enabled: true } } },
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "https://langfuse.example.com/api/public/otel", // traces go to /v1/traces
      headers: {
        Authorization: { $secret: "langfuse-otlp-basic" }, // "Basic <base64 public:secret>"
      },
      traces: true,
      metrics: false, // Langfuse accepts traces only
      // captureContent: false,  // the default; turn on only with a documented reason
    },
  },
}
```

Store the header value with `kurahi secrets set langfuse-otlp-basic`. Connect the Langfuse
project to watsonx.governance as IBM describes for its Langfuse integration.

## Push to the watsonx Orchestrate trace intake

```json5
{
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      orchestrate: {
        enabled: true,
        url: "https://<orchestrate-host>/instances/<instance-id>/v1/orchestrate/inject/traces",
        apiKey: { $secret: "orchestrate-api-key" }, // IBM Cloud API key
        tenantId: "<tenant id>",
        environment: "draft", // deployment.environment
        agentId: "<orchestrate agent id>", // agent.id on every span
        // auth: "api-key",   // legacy: key in x-api-key instead of an IAM bearer
        // userId: "usr_kurahi",
      },
    },
  },
}
```

- The push has its own tracer: only `kurahi.agent.run` and `kurahi.autopilot.run` reach it.
- The API key is exchanged at IBM Cloud IAM for a bearer token, cached and refreshed before it
  expires (`iamUrl` overrides the token endpoint).
- The resource carries `tenant.id` and `deployment.environment`, which the intake routes on; the
  spans carry `agent.id`, `langfuse.session.id` and `langfuse.user.id`, which it requires.
- The URL must be https and of the documented shape; anything else turns the push off with a
  warning in the gateway log.

## References

| Item                                                                                                                                         | Source                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Langfuse and Arize integrations in watsonx.governance                                                                                        | [IBM announcement](https://www.ibm.com/new/announcements/new-in-ibm-watsonx-governance-govern-ai-agents-as-you-build-expand-accountability-and-streamline-compliance) |
| No native OTel intake for external agents                                                                                                    | [IBM idea WGOV-I-268](https://ibm-data-and-ai.ideas.ibm.com/ideas/WGOV-I-268)                                                                                         |
| Langfuse attribute names, OTLP endpoint, Basic auth                                                                                          | [Langfuse OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry)                                                                                      |
| Orchestrate trace intake URL, IAM or x-api-key, `tenant.id`, `deployment.environment`, `agent.id`, `langfuse.session.id`, `langfuse.user.id` | [Orchestrate OTel export](https://developer.watson-orchestrate.ibm.com/traces/otel-export)                                                                            |
| External models evaluated through detached prompt templates (register Kurahi agents manually)                                                | [Detached prompt evaluation](https://www.ibm.com/docs/en/DSXDOC/wsj/model/wos-eval-detached-prompt-projects.html)                                                     |

Overview of the pack: [IBM watsonx](/integrations/ibm-watsonx). Other span and metric names:
[Logging](/logging#export-to-opentelemetry).
