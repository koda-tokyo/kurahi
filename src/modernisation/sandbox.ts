// Process isolation for the local runner (KIMS-014). What it is, stated plainly:
//
//   - every compile and execution runs in a fresh scratch folder under the OS temp dir, with a
//     fixed minimal environment (no inherited variables, LC_ALL=C, TZ=UTC);
//   - a wall-clock timeout and output caps (stdout, stderr, each output file); the whole process
//     group is killed on timeout, cap or cancellation;
//   - when `prlimit` exists: CPU seconds, file size and open-file limits on executions;
//   - when unprivileged user namespaces work (`unshare -rn`): executions run in an empty network
//     namespace (no interfaces up), so they cannot reach the network.
//
// It is NOT a container or VM: the program runs as the same OS user and can read anything that
// user can read. Treat only trusted or synthetic source this way, or run Kurahi in a container.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Isolation } from "./types.js";

export const RUN_ENV: Record<string, string> = { LC_ALL: "C", TZ: "UTC" };
const PRLIMIT = "/usr/bin/prlimit";
const UNSHARE = "/usr/bin/unshare";

let probed: { prlimit: boolean; netns: boolean } | null = null;

/** Which isolation features work on this host (probed once per process). */
export function probeIsolation(): { prlimit: boolean; netns: boolean } {
  if (probed) {
    return probed;
  }
  const prlimit = process.platform === "linux" && fs.existsSync(PRLIMIT);
  let netns = false;
  if (process.platform === "linux" && fs.existsSync(UNSHARE)) {
    const r = spawnSync(UNSHARE, ["-rn", "true"], { timeout: 5000, env: {} });
    netns = r.status === 0;
  }
  probed = { prlimit, netns };
  return probed;
}

export function describeIsolation(opts: { allowNetns?: boolean } = {}): Isolation {
  const p = probeIsolation();
  const netns = p.netns && opts.allowNetns !== false;
  const parts = [
    "scratch folder per run",
    "fixed minimal environment",
    "wall-clock timeout and output caps",
    p.prlimit ? "rlimits (cpu, fsize, nofile)" : "no rlimits (prlimit unavailable)",
    netns ? "empty network namespace" : "network NOT isolated (user namespaces unavailable)",
    "same OS user (not a container)",
  ];
  return {
    level: parts.join("; "),
    network: netns ? "namespace" : "not-isolated",
    rlimits: p.prlimit,
    env: { ...RUN_ENV },
  };
}

export type SpawnResult = {
  status: "ok" | "timeout" | "cancelled" | "output-capped" | "spawn-error";
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  ms: number;
};

export type SpawnSpec = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: Buffer;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Executions: apply rlimits and the network namespace when available. */
  confine?: { cpuSeconds: number; isolation: Isolation };
};

function wrap(spec: SpawnSpec): string[] {
  if (!spec.confine) {
    return spec.argv;
  }
  const out: string[] = [];
  if (spec.confine.isolation.rlimits) {
    out.push(
      PRLIMIT,
      `--cpu=${spec.confine.cpuSeconds}`,
      `--fsize=${spec.maxOutputBytes}`,
      "--nofile=64",
      "--",
    );
  }
  if (spec.confine.isolation.network === "namespace") {
    out.push(UNSHARE, "-rn", "--");
  }
  return [...out, ...spec.argv];
}

/** Run one process to completion under the spec's limits. Never throws. */
export function runConfined(spec: SpawnSpec): Promise<SpawnResult> {
  const argv = wrap(spec);
  const started = Date.now();
  return new Promise((resolve) => {
    if (spec.signal?.aborted) {
      resolve({
        status: "cancelled",
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        ms: 0,
      });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        status: "spawn-error",
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(String(err)),
        ms: Date.now() - started,
      });
      return;
    }
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let reason: SpawnResult["status"] | null = null;
    const kill = (why: SpawnResult["status"]) => {
      reason ??= why;
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => kill("timeout"), spec.timeoutMs);
    const onAbort = () => kill("cancelled");
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > spec.maxOutputBytes) {
        kill("output-capped");
      } else {
        out.push(d);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      errBytes += d.length;
      if (errBytes > spec.maxOutputBytes) {
        kill("output-capped");
      } else {
        errs.push(d);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(spec.stdin ?? Buffer.alloc(0));
    child.on("error", (err) => {
      reason ??= "spawn-error";
      errs.push(Buffer.from(String(err)));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({
        status: reason ?? "ok",
        exitCode: code,
        signal: sig,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errs),
        ms: Date.now() - started,
      });
    });
  });
}
