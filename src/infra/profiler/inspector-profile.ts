// In-process CPU and sampling-heap profiles through node:inspector (no debugger port is opened;
// the session talks to this isolate's own inspector backend). Used by the admin-only
// `debug.profile` gateway method and by `kurahi gateway run --profile-startup`.
//
// Note: V8's sampling profiler interrupts the main thread with a signal every interval. On WSL2
// some network syscalls (os.networkInterfaces / getifaddrs, bind, UDP setup) take longer than a
// 1 ms interval and restart when interrupted, so with the usual 1 ms interval they slow down by
// two to three orders of magnitude (measured: 20 networkInterfaces() calls 0.2 s -> 155 s; a
// gateway start 5 s -> 100 s). On WSL the default interval is therefore 10 ms; the profile is
// coarser but the process behaves. Elsewhere it stays 1 ms.

import type { Session } from "node:inspector/promises";
import os from "node:os";

export const PROFILE_MIN_SECONDS = 1;
export const PROFILE_MAX_SECONDS = 300;
export const DEFAULT_CPU_SAMPLING_INTERVAL_US = 1000;
export const WSL_CPU_SAMPLING_INTERVAL_US = 10_000;
export const DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES = 32 * 1024;

/** A `.cpuprofile` document (Chrome DevTools / V8 `Profiler.Profile`). */
export type CpuProfile = {
  nodes: Array<{
    id: number;
    callFrame: {
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
    hitCount?: number;
    children?: number[];
  }>;
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

/** A `.heapprofile` document (V8 `HeapProfiler.SamplingHeapProfile`). */
export type HeapProfile = {
  head: HeapProfileNode;
  samples?: Array<{ size: number; nodeId: number; ordinal: number }>;
};

export type HeapProfileNode = {
  callFrame: CpuProfile["nodes"][number]["callFrame"];
  selfSize: number;
  id: number;
  children: HeapProfileNode[];
};

export type ProfileCaptureResult = {
  cpuProfile: CpuProfile;
  heapProfile?: HeapProfile;
  durationMs: number;
};

let busy = false;

export function isWsl(release: string = os.release(), platform = process.platform): boolean {
  return platform === "linux" && /microsoft|wsl/i.test(release);
}

/** 1 ms, or 10 ms on WSL (see the note at the top); `KOLO_PROFILE_SAMPLING_INTERVAL_US` overrides. */
export function defaultSamplingIntervalUs(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.KOLO_PROFILE_SAMPLING_INTERVAL_US);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return isWsl() ? WSL_CPU_SAMPLING_INTERVAL_US : DEFAULT_CPU_SAMPLING_INTERVAL_US;
}

export class ProfileBusyError extends Error {
  constructor() {
    super("a profile is already being captured in this process");
    this.name = "ProfileBusyError";
  }
}

export function clampProfileSeconds(value: unknown, fallback = 10): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(PROFILE_MAX_SECONDS, Math.max(PROFILE_MIN_SECONDS, n));
}

async function openSession(): Promise<Session> {
  const inspector = await import("node:inspector/promises");
  const session = new inspector.Session();
  session.connect();
  return session;
}

export type RunningProfile = {
  /** Stops sampling and returns the profiles; safe to call once. */
  stop: () => Promise<ProfileCaptureResult>;
  /** Stops sampling and discards the result. */
  cancel: () => Promise<void>;
};

/**
 * Starts sampling now and returns a handle to stop it. Only one capture may run per process at a
 * time (two would share the isolate's single profiler), so a second call throws ProfileBusyError.
 */
export async function startInspectorProfile(
  opts: {
    heap?: boolean;
    samplingIntervalUs?: number;
    heapSamplingIntervalBytes?: number;
  } = {},
): Promise<RunningProfile> {
  if (busy) {
    throw new ProfileBusyError();
  }
  busy = true;
  let session: Session | null = null;
  try {
    session = await openSession();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", {
      interval: Math.max(10, Math.round(opts.samplingIntervalUs ?? defaultSamplingIntervalUs())),
    });
    if (opts.heap) {
      await session.post("HeapProfiler.enable");
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: Math.max(
          1024,
          Math.round(opts.heapSamplingIntervalBytes ?? DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES),
        ),
      });
    }
    await session.post("Profiler.start");
  } catch (err) {
    busy = false;
    session?.disconnect();
    throw err;
  }
  const started = performance.now();
  const active = session;
  let done = false;
  const finish = async (): Promise<ProfileCaptureResult> => {
    if (done) {
      throw new Error("profile already stopped");
    }
    done = true;
    try {
      const { profile } = (await active.post("Profiler.stop")) as { profile: CpuProfile };
      let heapProfile: HeapProfile | undefined;
      if (opts.heap) {
        const res = (await active.post("HeapProfiler.stopSampling")) as { profile: HeapProfile };
        heapProfile = res.profile;
      }
      return { cpuProfile: profile, heapProfile, durationMs: performance.now() - started };
    } finally {
      active.disconnect();
      busy = false;
    }
  };
  return {
    stop: finish,
    cancel: async () => {
      if (!done) {
        await finish().catch(() => undefined);
      }
    },
  };
}

/** Samples for `seconds` (clamped to 1–300) and returns the profiles. */
export async function captureInspectorProfile(opts: {
  seconds: number;
  heap?: boolean;
  samplingIntervalUs?: number;
  heapSamplingIntervalBytes?: number;
}): Promise<ProfileCaptureResult> {
  const seconds = clampProfileSeconds(opts.seconds);
  const running = await startInspectorProfile(opts);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return await running.stop();
}
