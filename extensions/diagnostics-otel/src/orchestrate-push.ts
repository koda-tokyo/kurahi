import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import type { DiagnosticsOtelOrchestrateConfig } from "../../../src/config/types.base.js";
import { createIbmIamTokenCache, IBM_IAM_TOKEN_URL } from "../../../src/providers/ibm-iam.js";
import { validateOrchestrateTraceUrl } from "./governance.js";

// Optional second trace pipeline that pushes governance spans (agent and autopilot runs only) to
// a watsonx Orchestrate trace intake: OTLP/HTTP to
//   https://<host>/instances/<instance-id>/v1/orchestrate/inject/traces
// with an IAM bearer token (the API key is exchanged and refreshed per export) or, for the
// legacy scheme, the key in x-api-key. The intake routes on the resource attributes tenant.id and
// deployment.environment. It has its own tracer provider so no other span reaches it.

export type OrchestratePush = { tracer: Tracer; shutdown: () => Promise<void> };

export type OrchestratePushDeps = {
  createExporter?: (opts: {
    url: string;
    headers: () => Promise<Record<string, string>>;
  }) => ConstructorParameters<typeof BatchSpanProcessor>[0];
  iam?: ReturnType<typeof createIbmIamTokenCache>;
};

export function resolveOrchestratePush(
  cfg: DiagnosticsOtelOrchestrateConfig | undefined,
  serviceName: string,
): { ok: true; url: string; apiKey: string } | { ok: false; reason: string } | null {
  if (!cfg?.enabled) {
    return null;
  }
  const url = validateOrchestrateTraceUrl(cfg.url);
  if (!url) {
    return {
      ok: false,
      reason:
        "orchestrate.url must be https://<host>/instances/<instance-id>/v1/orchestrate/inject/traces",
    };
  }
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, reason: "orchestrate.apiKey is missing (use a secret reference)" };
  }
  if (!cfg.tenantId?.trim()) {
    return { ok: false, reason: `orchestrate.tenantId is required (service ${serviceName})` };
  }
  return { ok: true, url, apiKey };
}

export function createOrchestratePush(
  cfg: DiagnosticsOtelOrchestrateConfig,
  resolved: { url: string; apiKey: string },
  serviceName: string,
  deps: OrchestratePushDeps = {},
): OrchestratePush {
  const iam = deps.iam ?? createIbmIamTokenCache();
  const iamUrl = cfg.iamUrl ?? IBM_IAM_TOKEN_URL;
  const headers = async (): Promise<Record<string, string>> =>
    cfg.auth === "api-key"
      ? { "x-api-key": resolved.apiKey }
      : { Authorization: `Bearer ${await iam.get(resolved.apiKey, iamUrl)}` };
  const exporter = deps.createExporter
    ? deps.createExporter({ url: resolved.url, headers })
    : new OTLPTraceExporter({ url: resolved.url, headers });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      "tenant.id": cfg.tenantId ?? "",
      "deployment.environment": cfg.environment?.trim() || "production",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  return {
    tracer: provider.getTracer("kurahi.governance"),
    shutdown: () => provider.shutdown().catch(() => undefined),
  };
}
