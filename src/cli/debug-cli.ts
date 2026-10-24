// `kurahi debug profile` — capture a CPU (and optionally sampling heap) profile of the running
// gateway through the admin-only `debug.profile` gateway method, and write it as
// .cpuprofile / .heapprofile (Chrome DevTools, speedscope) plus pprof (`go tool pprof`).
import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { DebugProfileResult } from "../gateway/server-methods/debug.js";
import {
  clampProfileSeconds,
  type CpuProfile,
  type HeapProfile,
} from "../infra/profiler/inspector-profile.js";
import { cpuProfileToPprof, heapProfileToPprof } from "../infra/profiler/pprof.js";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export type DebugProfileOpts = {
  seconds?: string;
  heap?: boolean;
  out?: string;
  samplingIntervalUs?: string;
  pprof?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
};

export type WrittenProfileFiles = {
  cpuprofile: string;
  cpuPprof?: string;
  heapprofile?: string;
  heapPprof?: string;
};

function stamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/** Decodes a `debug.profile` result and writes the profile files into `outDir`. */
export function writeDebugProfileFiles(
  result: DebugProfileResult,
  outDir: string,
  opts: { pprof?: boolean } = {},
): WrittenProfileFiles {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `gateway-${result.pid}-${stamp(result.startedAt)}`);
  const capturedAtMs = Date.parse(result.startedAt) || Date.now();
  const cpuJson = gunzipSync(Buffer.from(result.cpuProfileGzB64, "base64")).toString("utf8");
  const files: WrittenProfileFiles = { cpuprofile: `${base}.cpuprofile` };
  fs.writeFileSync(files.cpuprofile, cpuJson, { mode: 0o600 });
  if (opts.pprof !== false) {
    files.cpuPprof = `${base}.cpu.pb.gz`;
    fs.writeFileSync(
      files.cpuPprof,
      cpuProfileToPprof(JSON.parse(cpuJson) as CpuProfile, {
        capturedAtMs,
        samplingIntervalUs: result.samplingIntervalUs,
      }),
      { mode: 0o600 },
    );
  }
  if (result.heapProfileGzB64) {
    const heapJson = gunzipSync(Buffer.from(result.heapProfileGzB64, "base64")).toString("utf8");
    files.heapprofile = `${base}.heapprofile`;
    fs.writeFileSync(files.heapprofile, heapJson, { mode: 0o600 });
    if (opts.pprof !== false) {
      files.heapPprof = `${base}.heap.pb.gz`;
      fs.writeFileSync(
        files.heapPprof,
        heapProfileToPprof(JSON.parse(heapJson) as HeapProfile, {
          capturedAtMs,
          samplingIntervalBytes: result.heapSamplingIntervalBytes,
        }),
        { mode: 0o600 },
      );
    }
  }
  return files;
}

export async function runDebugProfile(opts: DebugProfileOpts): Promise<void> {
  const seconds = clampProfileSeconds(opts.seconds === undefined ? 10 : Number(opts.seconds));
  const samplingIntervalUs =
    opts.samplingIntervalUs !== undefined ? Number(opts.samplingIntervalUs) : undefined;
  if (samplingIntervalUs !== undefined && !(samplingIntervalUs > 0)) {
    defaultRuntime.error("kurahi debug profile: --sampling-interval-us must be a positive number");
    defaultRuntime.exit(2);
    return;
  }
  // The gateway answers after the capture, so the request must outlive it.
  const timeout = opts.timeout ?? String(seconds * 1000 + 60_000);
  if (!opts.json) {
    defaultRuntime.log(
      `Profiling the gateway for ${seconds}s${opts.heap ? " (CPU + heap)" : " (CPU)"}...`,
    );
  }
  const result = (await callGatewayFromCli(
    "debug.profile",
    { url: opts.url, token: opts.token, timeout, json: opts.json },
    {
      seconds,
      heap: opts.heap === true,
      ...(samplingIntervalUs ? { samplingIntervalUs } : {}),
    },
  )) as DebugProfileResult;
  const outDir = path.resolve(opts.out ?? ".");
  const files = writeDebugProfileFiles(result, outDir, { pprof: opts.pprof });
  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          ok: true,
          pid: result.pid,
          version: result.version,
          startedAt: result.startedAt,
          seconds: result.seconds,
          durationMs: result.durationMs,
          sampleCount: result.sampleCount,
          files,
        },
        null,
        2,
      ),
    );
    return;
  }
  defaultRuntime.log(
    [
      `Captured ${result.sampleCount} samples over ${(result.durationMs / 1000).toFixed(1)}s from gateway PID ${result.pid} (${result.version}).`,
      ...Object.values(files).map((f) => `  ${f}`),
      "Open .cpuprofile/.heapprofile in Chrome DevTools (Performance / Memory) or speedscope; the .pb.gz files with `go tool pprof`.",
    ].join("\n"),
  );
}

export function registerDebugCli(program: Command) {
  const debug = program.command("debug").description("Diagnostics for a running gateway");
  debug
    .command("profile")
    .description(
      "Capture a CPU (and optional heap) profile of the running gateway (admin; audited)",
    )
    .option("--seconds <n>", "Sampling duration in seconds (1-300)", "10")
    .option("--heap", "Also capture a sampling heap profile", false)
    .option("--out <dir>", "Directory for the profile files (default: current directory)")
    .option(
      "--sampling-interval-us <us>",
      "CPU sampling interval in microseconds (default 1000; 10000 on WSL)",
    )
    .option("--no-pprof", "Do not write pprof (.pb.gz) files")
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Request timeout in ms (default: seconds + 60 s)")
    .option("--json", "Output JSON", false)
    .action(async (opts: DebugProfileOpts) => {
      try {
        await runDebugProfile(opts);
      } catch (err) {
        defaultRuntime.error(`kurahi debug profile: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });
}
