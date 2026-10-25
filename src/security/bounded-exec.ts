// A child process with hard bounds, for the attachment pipeline (scanners, isolated text
// extraction): an explicit environment (never the gateway's), no stdin, capped output, a wall
// clock that SIGKILLs the child, and a result that says whether the clock fired. Callers treat
// anything but a clean, in-time exit as a failure (fail closed).

import { spawn } from "node:child_process";

export type BoundedExecResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output beyond the cap was dropped. */
  truncated: boolean;
};

export type BoundedExecOptions = {
  timeoutMs: number;
  /** The child's whole environment (nothing is inherited). */
  env: Record<string, string>;
  cwd?: string;
  /** Bytes kept per stream. Default 64 KiB. */
  maxOutputBytes?: number;
  /** Written to stdin, then closed; stdin is ignored when unset. */
  input?: string;
};

export type BoundedExec = (argv: string[], opts: BoundedExecOptions) => Promise<BoundedExecResult>;

export const runBounded: BoundedExec = (argv, opts) =>
  new Promise((resolve) => {
    const cap = opts.maxOutputBytes ?? 64 * 1024;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<BoundedExecResult, "stdout" | "stderr" | "timedOut" | "truncated">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut, truncated });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      stderr = String(err instanceof Error ? err.message : err);
      resolve({ code: null, signal: null, stdout, stderr, timedOut: false, truncated: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const take = (into: "out" | "err") => (d: Buffer) => {
      const cur = into === "out" ? stdout : stderr;
      if (cur.length >= cap) {
        truncated = true;
        return;
      }
      const next = cur + d.toString("utf8").slice(0, cap - cur.length);
      if (into === "out") {
        stdout = next;
      } else {
        stderr = next;
      }
    };
    child.stdout?.on("data", take("out"));
    child.stderr?.on("data", take("err"));
    child.on("error", (err) => {
      stderr = `${stderr}${String(err.message)}`.slice(0, cap);
      finish({ code: null, signal: null });
    });
    child.on("close", (code, signal) => finish({ code, signal }));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
