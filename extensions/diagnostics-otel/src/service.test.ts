import { beforeEach, describe, expect, test, vi } from "vitest";

const registerLogTransportMock = vi.hoisted(() => vi.fn());

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const tracer = {
    startSpan: vi.fn((_name: string, _opts?: unknown) => ({
      end: vi.fn(),
      setStatus: vi.fn(),
    })),
  };
  const meter = {
    createCounter: vi.fn((name: string) => {
      const counter = { add: vi.fn() };
      counters.set(name, counter);
      return counter;
    }),
    createHistogram: vi.fn((name: string) => {
      const histogram = { record: vi.fn() };
      histograms.set(name, histogram);
      return histogram;
    }),
  };
  return { counters, histograms, tracer, meter };
});

const sdkStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sdkShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  trace: {
    getTracer: () => telemetryState.tracer,
  },
  SpanStatusCode: {
    ERROR: 2,
  },
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = sdkStart;
    shutdown = sdkShutdown;
  },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class {},
  LoggerProvider: class {
    addLogRecordProcessor = vi.fn();
    getLogger = vi.fn(() => ({
      emit: logEmit,
    }));
    shutdown = logShutdown;
  },
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: class {},
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  ParentBasedSampler: class {},
  TraceIdRatioBasedSampler: class {},
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: (value: unknown) => ({ attributes: value }),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  SemanticResourceAttributes: {
    SERVICE_NAME: "service.name",
  },
}));

vi.mock("KoLo/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("KoLo/plugin-sdk")>("KoLo/plugin-sdk");
  return {
    ...actual,
    registerLogTransport: registerLogTransportMock,
  };
});

import { emitDiagnosticEvent } from "KoLo/plugin-sdk";
import { createDiagnosticsOtelService } from "./service.js";

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
    logEmit.mockClear();
    logShutdown.mockClear();
    registerLogTransportMock.mockReset();
  });

  test("records message-flow metrics and spans", async () => {
    const registeredTransports: Array<(logObj: Record<string, unknown>) => void> = [];
    const stopTransport = vi.fn();
    registerLogTransportMock.mockImplementation((transport) => {
      registeredTransports.push(transport);
      return stopTransport;
    });

    const service = createDiagnosticsOtelService();
    await service.start({
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf",
            traces: true,
            metrics: true,
            logs: true,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
      updateType: "telegram-post",
    });
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
      updateType: "telegram-post",
      durationMs: 120,
    });
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      queueDepth: 2,
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 55,
    });
    emitDiagnosticEvent({
      type: "queue.lane.dequeue",
      lane: "main",
      queueSize: 3,
      waitMs: 10,
    });
    emitDiagnosticEvent({
      type: "session.stuck",
      state: "processing",
      ageMs: 125_000,
    });
    emitDiagnosticEvent({
      type: "run.attempt",
      runId: "run-1",
      attempt: 2,
    });

    expect(telemetryState.counters.get("KoLo.webhook.received")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("KoLo.webhook.duration_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("KoLo.message.queued")?.add).toHaveBeenCalled();
    expect(telemetryState.counters.get("KoLo.message.processed")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("KoLo.message.duration_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.histograms.get("KoLo.queue.wait_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("KoLo.session.stuck")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("KoLo.session.stuck_age_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("KoLo.run.attempt")?.add).toHaveBeenCalled();

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("KoLo.webhook.processed");
    expect(spanNames).toContain("KoLo.message.processed");
    expect(spanNames).toContain("KoLo.session.stuck");

    expect(registerLogTransportMock).toHaveBeenCalledTimes(1);
    expect(registeredTransports).toHaveLength(1);
    registeredTransports[0]?.({
      0: '{"subsystem":"diagnostic"}',
      1: "hello",
      _meta: { logLevelName: "INFO", date: new Date() },
    });
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.();
  });

  test("turns agent and autopilot runs into governance spans", async () => {
    const service = createDiagnosticsOtelService();
    await service.start({
      config: {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true, metrics: false } },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    emitDiagnosticEvent({
      type: "agent.run",
      runId: "run-9",
      provider: "watsonx",
      model: "m",
      startedAt: 1000,
      durationMs: 50,
      outcome: "completed",
    });
    emitDiagnosticEvent({
      type: "autopilot.run",
      runId: "ap-9",
      projectId: "p",
      routineId: "r",
      edition: "business",
      area: "a",
      level: "L1",
      trigger: "manual",
      status: "ok",
      startedAt: 1000,
      durationMs: 10,
      reasoning: { backend: "codex-cli", model: null, ms: 5 },
      counts: {},
      decisions: {},
      gatherCalls: 0,
      workItems: 0,
      watchdogTripped: false,
      evidenceRoot: null,
    });
    const calls = telemetryState.tracer.startSpan.mock.calls;
    const agent = calls.find((c) => c[0] === "kurahi.agent.run");
    expect(agent?.[1]).toMatchObject({
      startTime: 1000,
      attributes: { "langfuse.observation.type": "agent", "langfuse.session.id": "run-9" },
    });
    expect(calls.map((c) => c[0])).toContain("kurahi.autopilot.run");
    await service.stop?.();
  });
});
