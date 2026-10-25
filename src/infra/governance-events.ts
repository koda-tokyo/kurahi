import type { EmbeddedPiRunResult } from "../agents/pi-embedded-runner/types.js";
import type { RunRecord } from "../autopilot/types.js";
// Governance evidence events: one diagnostic event per finished agent run and per finished
// autopilot run, for export to an AI-governance tool through OpenTelemetry (the
// diagnostics-otel plugin turns them into spans). By default they carry ids, timings, decisions
// and counts only. Prompt and reply text is attached only when an administrator sets
// diagnostics.otel.captureContent, and then truncated.
import type { KoLoConfig } from "../config/config.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "./diagnostic-events.js";

export const DEFAULT_CONTENT_CHARS = 4000;
const MAX_CONTENT_CHARS = 100_000;

export function contentCapture(cfg: KoLoConfig | undefined): number | null {
  const otel = cfg?.diagnostics?.otel;
  if (otel?.captureContent !== true) {
    return null;
  }
  const n = otel.maxContentChars;
  return typeof n === "number" && Number.isInteger(n) && n > 0
    ? Math.min(n, MAX_CONTENT_CHARS)
    : DEFAULT_CONTENT_CHARS;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…[truncated]` : text;

export type AgentRunInfo = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  jobId?: string;
  lane?: string;
  channel?: string;
  provider: string;
  model: string;
  prompt?: string;
};

/** Emit `agent.run` when the run settles; returns the same promise. */
export function observeAgentRun(
  cfg: KoLoConfig | undefined,
  info: AgentRunInfo,
  run: Promise<EmbeddedPiRunResult>,
  now: () => number = Date.now,
): Promise<EmbeddedPiRunResult> {
  if (!isDiagnosticsEnabled(cfg)) {
    return run;
  }
  const startedAt = now();
  const base = {
    type: "agent.run" as const,
    runId: info.runId,
    ...(info.sessionId ? { sessionId: info.sessionId } : {}),
    ...(info.sessionKey ? { sessionKey: info.sessionKey } : {}),
    ...(info.agentId ? { agentId: info.agentId } : {}),
    ...(info.jobId ? { jobId: info.jobId } : {}),
    ...(info.lane ? { lane: info.lane } : {}),
    ...(info.channel ? { channel: info.channel } : {}),
    startedAt,
  };
  const max = contentCapture(cfg);
  run.then(
    (result) => {
      const meta = result.meta;
      const outcome = meta.timedOut
        ? "timeout"
        : meta.aborted
          ? "aborted"
          : meta.error || (result.payloads ?? []).some((p) => p.isError)
            ? "error"
            : "completed";
      const output = (result.payloads ?? [])
        .filter((p) => !p.isError && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n\n");
      emitDiagnosticEvent({
        ...base,
        provider: meta.agentMeta?.provider ?? info.provider,
        model: meta.agentMeta?.model ?? info.model,
        durationMs: Math.max(0, now() - startedAt),
        outcome,
        ...(meta.error ? { errorKind: meta.error.kind } : {}),
        ...(typeof meta.steps === "number" ? { steps: meta.steps } : {}),
        ...(typeof meta.toolCalls === "number" ? { toolCalls: meta.toolCalls } : {}),
        payloads: result.payloads?.length ?? 0,
        ...(meta.agentMeta?.usage ? { usage: { ...meta.agentMeta.usage } } : {}),
        ...(max !== null
          ? {
              content: {
                ...(info.prompt ? { input: clip(info.prompt, max) } : {}),
                ...(output ? { output: clip(output, max) } : {}),
              },
            }
          : {}),
      });
    },
    (err: unknown) => {
      emitDiagnosticEvent({
        ...base,
        provider: info.provider,
        model: info.model,
        durationMs: Math.max(0, now() - startedAt),
        outcome: "error",
        // The error class only: messages can quote content.
        errorKind: err instanceof Error ? err.name : "error",
        ...(max !== null && info.prompt ? { content: { input: clip(info.prompt, max) } } : {}),
      });
    },
  );
  return run;
}

/** Emit `autopilot.run` for a recorded run. Never carries gathered data or reasoning text. */
export function emitAutopilotRun(cfg: KoLoConfig | undefined, record: RunRecord): void {
  if (!isDiagnosticsEnabled(cfg)) {
    return;
  }
  const startedAt = Date.parse(record.startedAt);
  const endedAt = Date.parse(record.endedAt);
  const decisions: Record<string, number> = {};
  for (const action of record.actions) {
    const key = action.decision === "allow" && !action.executed ? "allow_failed" : action.decision;
    decisions[key] = (decisions[key] ?? 0) + 1;
  }
  emitDiagnosticEvent({
    type: "autopilot.run",
    runId: record.id,
    projectId: record.projectId,
    routineId: record.routineId,
    edition: record.edition,
    area: record.area,
    level: record.level,
    trigger: record.trigger,
    status: record.status,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    durationMs:
      Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : 0,
    reasoning: {
      backend: record.reasoning.backend,
      model: record.reasoning.model,
      ms: record.reasoning.ms,
      ...(record.reasoning.retried ? { retried: true } : {}),
    },
    counts: { ...record.counts },
    decisions,
    gatherCalls: record.gather.reduce((n, g) => n + g.calls, 0),
    workItems: record.workItems.length,
    watchdogTripped: record.watchdog?.tripped === true,
    evidenceRoot: record.evidence?.root ?? null,
  });
}
