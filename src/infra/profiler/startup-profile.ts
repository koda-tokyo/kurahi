// `kurahi gateway run --profile-startup <file>`: a CPU profile from process start to the moment
// the gateway serves. entry.ts starts sampling before the CLI modules are imported (most of a cold
// start is module loading); startGatewayServer stops it once it logs its startup timings and
// writes `<file>` (.cpuprofile JSON) and `<file>.pb.gz` (pprof).
import fs from "node:fs";
import path from "node:path";
import type { RunningProfile } from "./inspector-profile.js";

const FLAG = "--profile-startup";

type StartupProfileState = { file: string; running: RunningProfile; capturedAtMs: number };

// On globalThis: entry.ts and the gateway reach this module through the same loader, but a
// second copy (bundled entry, tests) must still find the profile the first one started.
const KEY = Symbol.for("kurahi.startupProfile");
type Holder = { [KEY]?: StartupProfileState | null };

/** The `--profile-startup` target in argv (gateway commands only), resolved against cwd. */
export function parseProfileStartupArg(argv: string[]): string | null {
  if (!argv.includes("gateway")) {
    return null;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === FLAG) {
      const next = argv[i + 1];
      return next && !next.startsWith("-") ? path.resolve(next) : null;
    }
    if (arg?.startsWith(`${FLAG}=`)) {
      const value = arg.slice(FLAG.length + 1);
      return value ? path.resolve(value) : null;
    }
  }
  return null;
}

export async function beginStartupProfile(file: string): Promise<boolean> {
  try {
    const { startInspectorProfile } = await import("./inspector-profile.js");
    const running = await startInspectorProfile({});
    (globalThis as Holder)[KEY] = { file, running, capturedAtMs: Date.now() };
    return true;
  } catch (err) {
    process.stderr.write(
      `[kurahi] --profile-startup: could not start the profiler: ${String(err)}\n`,
    );
    return false;
  }
}

export function hasStartupProfile(): boolean {
  return Boolean((globalThis as Holder)[KEY]);
}

/** Stops the startup profile (if one runs) and writes it; returns the files written. */
export async function finishStartupProfile(): Promise<string[] | null> {
  const holder = globalThis as Holder;
  const state = holder[KEY];
  if (!state) {
    return null;
  }
  holder[KEY] = null;
  const { cpuProfile } = await state.running.stop();
  const { cpuProfileToPprof } = await import("./pprof.js");
  fs.mkdirSync(path.dirname(state.file), { recursive: true });
  fs.writeFileSync(state.file, JSON.stringify(cpuProfile), { mode: 0o600 });
  const pprofFile = `${state.file}.pb.gz`;
  const { defaultSamplingIntervalUs } = await import("./inspector-profile.js");
  fs.writeFileSync(
    pprofFile,
    cpuProfileToPprof(cpuProfile, {
      capturedAtMs: state.capturedAtMs,
      samplingIntervalUs: defaultSamplingIntervalUs(),
    }),
    {
      mode: 0o600,
    },
  );
  return [state.file, pprofFile];
}
