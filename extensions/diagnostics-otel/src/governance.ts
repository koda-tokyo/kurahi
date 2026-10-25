import type {
  DiagnosticAgentRunEvent,
  DiagnosticAutopilotRunEvent,
  DiagnosticEventPayload,
} from "../../../src/infra/diagnostic-events.js";

// Governance spans: one span per finished agent run and per finished autopilot run, with
// attributes in the Langfuse OpenTelemetry mapping (langfuse.*, gen_ai.*) so a governance tool
// that ingests through Langfuse or Arize sees runs, sessions, models, usage and outcomes. By
// default a span carries ids, timings, decisions and counts; prompt and reply text appear only
// when the event carries them (diagnostics.otel.captureContent, set by an administrator).

export type AgentRunEvent = DiagnosticAgentRunEvent;
export type AutopilotRunEvent = DiagnosticAutopilotRunEvent;
export type GovernanceEvent = AgentRunEvent | AutopilotRunEvent;

export type GovernanceSpanSpec = {
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean>;
  /** Set when the run failed; becomes the span's error status message. */
  error?: string;
};

export type GovernanceSpanOptions = {
  /** langfuse.user.id (watsonx Orchestrate requires a usr_ prefix). */
  userId?: string;
  /** agent.id on the span (the Orchestrate agent the trace is filed under). */
  orchestrateAgentId?: string;
  environment?: string;
};

export const DEFAULT_GOVERNANCE_USER = "usr_kurahi";

export function isGovernanceEvent(evt: DiagnosticEventPayload): evt is GovernanceEvent {
  return evt.type === "agent.run" || evt.type === "autopilot.run";
}

type Attrs = GovernanceSpanSpec["attributes"];

function put(attrs: Attrs, key: string, value: string | number | boolean | null | undefined) {
  if (value !== undefined && value !== null && value !== "") {
    attrs[key] = value;
  }
}

function common(name: string, sessionId: string, opts: GovernanceSpanOptions): Attrs {
  const attrs: Attrs = {
    "langfuse.trace.name": name,
    "langfuse.session.id": sessionId,
    "langfuse.user.id": opts.userId ?? DEFAULT_GOVERNANCE_USER,
    "langfuse.trace.metadata.source": "kurahi",
  };
  put(attrs, "agent.id", opts.orchestrateAgentId);
  put(attrs, "langfuse.environment", opts.environment);
  return attrs;
}

export function governanceSpanSpec(
  evt: GovernanceEvent,
  opts: GovernanceSpanOptions = {},
): GovernanceSpanSpec {
  return evt.type === "agent.run" ? agentRunSpan(evt, opts) : autopilotRunSpan(evt, opts);
}

function agentRunSpan(evt: AgentRunEvent, opts: GovernanceSpanOptions): GovernanceSpanSpec {
  const name = "kurahi.agent.run";
  const attrs = common(name, evt.sessionId ?? evt.runId, opts);
  const failed = evt.outcome !== "completed";
  attrs["langfuse.observation.type"] = "agent";
  attrs["langfuse.observation.level"] = failed ? "ERROR" : "DEFAULT";
  put(attrs, "langfuse.observation.status_message", failed ? evt.outcome : undefined);
  attrs["langfuse.observation.model.name"] = evt.model;
  attrs["gen_ai.system"] = evt.provider;
  attrs["gen_ai.request.model"] = evt.model;
  const meta: Record<string, string | number | undefined> = {
    run_id: evt.runId,
    agent_id: evt.agentId,
    job_id: evt.jobId,
    lane: evt.lane,
    channel: evt.channel,
    outcome: evt.outcome,
    error_kind: evt.errorKind,
    steps: evt.steps,
    tool_calls: evt.toolCalls,
    payloads: evt.payloads,
    duration_ms: evt.durationMs,
  };
  for (const [k, v] of Object.entries(meta)) {
    put(attrs, `langfuse.observation.metadata.${k}`, v);
  }
  if (evt.usage) {
    put(attrs, "gen_ai.usage.input_tokens", evt.usage.input);
    put(attrs, "gen_ai.usage.output_tokens", evt.usage.output);
    const details = Object.fromEntries(
      Object.entries({
        input: evt.usage.input,
        output: evt.usage.output,
        cache_read: evt.usage.cacheRead,
        cache_write: evt.usage.cacheWrite,
        total: evt.usage.total,
      }).filter(([, v]) => typeof v === "number"),
    );
    if (Object.keys(details).length > 0) {
      attrs["langfuse.observation.usage_details"] = JSON.stringify(details);
    }
  }
  if (evt.content?.input !== undefined) {
    attrs["langfuse.observation.input"] = JSON.stringify(evt.content.input);
    attrs.input = evt.content.input;
  }
  if (evt.content?.output !== undefined) {
    attrs["langfuse.observation.output"] = JSON.stringify(evt.content.output);
    attrs.output = evt.content.output;
  }
  return {
    name,
    startTime: evt.startedAt,
    endTime: evt.startedAt + evt.durationMs,
    attributes: attrs,
    ...(failed ? { error: evt.errorKind ?? evt.outcome } : {}),
  };
}

function autopilotRunSpan(evt: AutopilotRunEvent, opts: GovernanceSpanOptions): GovernanceSpanSpec {
  const name = "kurahi.autopilot.run";
  const attrs = common(name, `autopilot:${evt.projectId}:${evt.routineId}`, opts);
  const failed = evt.status === "failed";
  attrs["langfuse.observation.type"] = "chain";
  attrs["langfuse.observation.level"] = failed
    ? "ERROR"
    : evt.watchdogTripped || evt.status === "escalated"
      ? "WARNING"
      : "DEFAULT";
  put(attrs, "langfuse.observation.status_message", evt.status);
  put(attrs, "gen_ai.request.model", evt.reasoning.model);
  const meta: Record<string, string | number | boolean | null | undefined> = {
    run_id: evt.runId,
    project_id: evt.projectId,
    routine_id: evt.routineId,
    edition: evt.edition,
    area: evt.area,
    level: evt.level,
    trigger: evt.trigger,
    status: evt.status,
    reasoner_backend: evt.reasoning.backend,
    reasoner_model: evt.reasoning.model,
    reasoner_ms: evt.reasoning.ms,
    reasoner_retried: evt.reasoning.retried === true,
    gather_calls: evt.gatherCalls,
    work_items: evt.workItems,
    watchdog_tripped: evt.watchdogTripped,
    evidence_root: evt.evidenceRoot,
    duration_ms: evt.durationMs,
  };
  for (const [k, v] of Object.entries(meta)) {
    put(attrs, `langfuse.observation.metadata.${k}`, v);
  }
  for (const [k, v] of Object.entries(evt.counts)) {
    put(attrs, `langfuse.observation.metadata.count_${k}`, v);
  }
  for (const [k, v] of Object.entries(evt.decisions)) {
    put(attrs, `langfuse.observation.metadata.decision_${k}`, v);
  }
  return {
    name,
    startTime: evt.startedAt,
    endTime: evt.startedAt + evt.durationMs,
    attributes: attrs,
    ...(failed ? { error: "autopilot run failed" } : {}),
  };
}

const ORCHESTRATE_PATH = /^\/instances\/[A-Za-z0-9-]{1,128}\/v1\/orchestrate\/inject\/traces$/;

/** The Orchestrate trace intake URL must be https and of the documented shape. */
export function validateOrchestrateTraceUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !ORCHESTRATE_PATH.test(url.pathname) || url.search) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
