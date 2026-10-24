// `debug.profile` (admin): samples this gateway process with node:inspector for N seconds and
// returns the CPU profile (and optionally a sampling heap profile), gzip + base64 encoded so a
// long capture stays well under the WebSocket payload limit. `kurahi debug profile` writes them
// to disk as .cpuprofile / .heapprofile (Chrome DevTools) and pprof.
//
// Not listed in the observe/attach scope sets, so it needs admin (operator.admin or a pairing
// credential with admin scope). Every capture is audited, refused ones included.
import { gzipSync } from "node:zlib";
import type { GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import {
  captureInspectorProfile,
  clampProfileSeconds,
  defaultSamplingIntervalUs,
  DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES,
  ProfileBusyError,
} from "../../infra/profiler/inspector-profile.js";
import { VERSION } from "../../version.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export type DebugProfileResult = {
  pid: number;
  version: string;
  startedAt: string;
  seconds: number;
  durationMs: number;
  samplingIntervalUs: number;
  heapSamplingIntervalBytes?: number;
  sampleCount: number;
  /** gzip(JSON .cpuprofile), base64. */
  cpuProfileGzB64: string;
  /** gzip(JSON .heapprofile), base64; only with `heap: true`. */
  heapProfileGzB64?: string;
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export const debugHandlers: GatewayRequestHandlers = {
  "debug.profile": async ({ params, client, respond }) => {
    const identity = client?.pairing ? `device:${client.pairing.fingerprint}` : "owner:ws";
    const seconds = clampProfileSeconds(params.seconds);
    const heap = params.heap === true;
    const samplingIntervalUs =
      positiveNumber(params.samplingIntervalUs) ?? defaultSamplingIntervalUs();
    const heapSamplingIntervalBytes = heap
      ? (positiveNumber(params.heapSamplingIntervalBytes) ?? DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES)
      : undefined;
    const startedAt = new Date().toISOString();
    try {
      const result = await captureInspectorProfile({
        seconds,
        heap,
        samplingIntervalUs,
        heapSamplingIntervalBytes,
      });
      const cpuProfileGzB64 = gzipSync(JSON.stringify(result.cpuProfile)).toString("base64");
      const heapProfileGzB64 = result.heapProfile
        ? gzipSync(JSON.stringify(result.heapProfile)).toString("base64")
        : undefined;
      void auditSafe({
        identity,
        action: "debug.profile",
        outcome: "ok",
        source: "gateway.ws",
        detail: {
          seconds,
          heap,
          samplingIntervalUs,
          bytes: cpuProfileGzB64.length + (heapProfileGzB64?.length ?? 0),
        },
      });
      const payload: DebugProfileResult = {
        pid: process.pid,
        version: VERSION,
        startedAt,
        seconds,
        durationMs: Math.round(result.durationMs),
        samplingIntervalUs,
        ...(heapSamplingIntervalBytes ? { heapSamplingIntervalBytes } : {}),
        sampleCount: result.cpuProfile.samples?.length ?? 0,
        cpuProfileGzB64,
        ...(heapProfileGzB64 ? { heapProfileGzB64 } : {}),
      };
      respond(true, payload, undefined);
    } catch (err) {
      const busy = err instanceof ProfileBusyError;
      void auditSafe({
        identity,
        action: "debug.profile",
        outcome: busy ? "denied" : "failed",
        source: "gateway.ws",
        detail: { seconds, heap, error: String(err) },
      });
      respond(
        false,
        undefined,
        errorShape(busy ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE, String(err)),
      );
    }
  },
};
