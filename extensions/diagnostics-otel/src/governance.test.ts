import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { createIbmIamTokenCache } from "../../../src/providers/ibm-iam.js";
import {
  type AgentRunEvent,
  type AutopilotRunEvent,
  governanceSpanSpec,
  validateOrchestrateTraceUrl,
} from "./governance.js";
import { createOrchestratePush, resolveOrchestratePush } from "./orchestrate-push.js";

const agentRun = (over: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
  type: "agent.run",
  seq: 1,
  ts: 1_700_000_001_000,
  runId: "run-1",
  sessionId: "sess-1",
  agentId: "support",
  lane: "a2a",
  provider: "watsonx",
  model: "ibm/granite-3-8b-instruct",
  startedAt: 1_700_000_000_000,
  durationMs: 1200,
  outcome: "completed",
  steps: 2,
  toolCalls: 1,
  payloads: 1,
  usage: { input: 120, output: 30, total: 150 },
  ...over,
});

const autopilotRun = (over: Partial<AutopilotRunEvent> = {}): AutopilotRunEvent => ({
  type: "autopilot.run",
  seq: 2,
  ts: 1,
  runId: "ap-1",
  projectId: "p1",
  routineId: "inbox",
  edition: "business",
  area: "secretariat",
  level: "L1",
  trigger: "schedule",
  status: "ok",
  startedAt: 1_700_000_000_000,
  durationMs: 5000,
  reasoning: { backend: "codex-cli", model: null, ms: 3000 },
  counts: { items: 3, acted: 2, escalated: 1 },
  decisions: { allow: 2, needs_person: 1 },
  gatherCalls: 4,
  workItems: 1,
  watchdogTripped: false,
  evidenceRoot: "sha256:abc",
  ...over,
});

describe("governance spans", () => {
  it("maps an agent run to Langfuse attributes without content by default", () => {
    const spec = governanceSpanSpec(agentRun(), { orchestrateAgentId: "orc-agent-1" });
    expect(spec).toMatchObject({
      name: "kurahi.agent.run",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_001_200,
    });
    expect(spec.attributes).toMatchObject({
      "langfuse.trace.name": "kurahi.agent.run",
      "langfuse.observation.type": "agent",
      "langfuse.session.id": "sess-1",
      "langfuse.user.id": "usr_kurahi",
      "langfuse.observation.level": "DEFAULT",
      "gen_ai.request.model": "ibm/granite-3-8b-instruct",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "langfuse.observation.usage_details": '{"input":120,"output":30,"total":150}',
      "langfuse.observation.metadata.run_id": "run-1",
      "langfuse.observation.metadata.tool_calls": 1,
      "agent.id": "orc-agent-1",
    });
    const keys = Object.keys(spec.attributes);
    expect(keys.some((k) => /input$|output$/.test(k) && !k.includes("tokens"))).toBe(false);
    expect(spec.error).toBeUndefined();
  });

  it("adds content only when the event carries it (administrator opt-in)", () => {
    const spec = governanceSpanSpec(agentRun({ content: { input: "question", output: "answer" } }));
    expect(spec.attributes).toMatchObject({
      "langfuse.observation.input": '"question"',
      "langfuse.observation.output": '"answer"',
      input: "question",
      output: "answer",
    });
  });

  it("marks failed runs as errors with the outcome only", () => {
    const spec = governanceSpanSpec(agentRun({ outcome: "timeout" }));
    expect(spec.error).toBe("timeout");
    expect(spec.attributes["langfuse.observation.level"]).toBe("ERROR");
  });

  it("maps an autopilot run to decisions, counts and the evidence root", () => {
    const spec = governanceSpanSpec(autopilotRun({ status: "escalated" }));
    expect(spec.name).toBe("kurahi.autopilot.run");
    expect(spec.attributes).toMatchObject({
      "langfuse.observation.type": "chain",
      "langfuse.session.id": "autopilot:p1:inbox",
      "langfuse.observation.level": "WARNING",
      "langfuse.observation.metadata.decision_allow": 2,
      "langfuse.observation.metadata.decision_needs_person": 1,
      "langfuse.observation.metadata.count_items": 3,
      "langfuse.observation.metadata.evidence_root": "sha256:abc",
      "langfuse.observation.metadata.reasoner_backend": "codex-cli",
    });
    expect(governanceSpanSpec(autopilotRun({ status: "failed" })).error).toBeDefined();
  });
});

describe("watsonx Orchestrate trace push", () => {
  const URL_OK = "https://api.example.ibm.test/instances/abc-123/v1/orchestrate/inject/traces";

  it("accepts only the documented https intake path", () => {
    expect(validateOrchestrateTraceUrl(URL_OK)).toBe(URL_OK);
    expect(validateOrchestrateTraceUrl(URL_OK.replace("https", "http"))).toBeNull();
    expect(validateOrchestrateTraceUrl("https://x.example.com/v1/traces")).toBeNull();
    expect(validateOrchestrateTraceUrl(`${URL_OK}?x=1`)).toBeNull();
    expect(resolveOrchestratePush(undefined, "svc")).toBeNull();
    expect(
      resolveOrchestratePush({ enabled: true, url: URL_OK, tenantId: "t" }, "svc"),
    ).toMatchObject({ ok: false });
    expect(
      resolveOrchestratePush({ enabled: true, url: URL_OK, apiKey: "k", tenantId: "t" }, "svc"),
    ).toEqual({ ok: true, url: URL_OK, apiKey: "k" });
  });

  it("exports spans with tenant resource attributes and an IAM bearer header", async () => {
    const exported: ReadableSpan[] = [];
    let headersFn: (() => Promise<Record<string, string>>) | undefined;
    const exporter: SpanExporter = {
      export: (spans, done) => {
        exported.push(...spans);
        done({ code: 0 });
      },
      shutdown: async () => {},
    };
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "iam-tok", expires_in: 3600 })),
    );
    const push = createOrchestratePush(
      { enabled: true, tenantId: "tenant-9", environment: "draft" },
      { url: URL_OK, apiKey: "ibm-key" },
      "kurahi",
      {
        createExporter: ({ headers }) => {
          headersFn = headers;
          return exporter;
        },
        iam: createIbmIamTokenCache({ fetchFn: fetchFn as unknown as typeof fetch }),
      },
    );
    const spec = governanceSpanSpec(agentRun(), { orchestrateAgentId: "orc-1" });
    const span = push.tracer.startSpan(spec.name, {
      attributes: spec.attributes,
      startTime: spec.startTime,
    });
    span.end(spec.endTime);
    await push.shutdown();
    expect(exported).toHaveLength(1);
    expect(exported[0].name).toBe("kurahi.agent.run");
    expect(exported[0].attributes["agent.id"]).toBe("orc-1");
    expect(exported[0].resource.attributes).toMatchObject({
      "tenant.id": "tenant-9",
      "deployment.environment": "draft",
    });
    expect(await headersFn?.()).toEqual({ Authorization: "Bearer iam-tok" });
  });
});
