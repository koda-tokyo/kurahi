// Process backends for the console terminal. Each approved command line runs as its own
// `bash --noprofile --norc -c <line>` in a fresh pseudo-terminal: the PTY child is a session and
// process-group leader, so cancel and close signal the whole group (`kill -<pgid>`). No rc files
// run (no aliases or functions can change what a classified word means), and the environment is
// built from an allowlist: the gateway's own variables (tokens, API keys) never reach the shell.
//
// The sandbox backend runs the same line with `docker exec -it` in a container that mounts only
// the project folder. When the sandbox is required and the container cannot start, the session is
// refused; there is no fallback to the host.

import { spawn as spawnChild } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type PtyExit = { exitCode: number | null; signal: string | null };

export type PtyProcess = {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  /** Signal the whole process group of the command. */
  kill(signal: NodeJS.Signals): void;
};

export type SpawnRequest = {
  runId: string;
  line: string;
  /** Absolute host path of the working directory (inside the project root). */
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};

export interface ShellBackend {
  readonly sandboxed: boolean;
  spawn(req: SpawnRequest): PtyProcess;
  dispose?(): void;
}

const SIGNALS: Record<number, string> = Object.fromEntries(
  Object.entries(os.constants.signals).map(([name, num]) => [num, name]),
);

/** Environment for the shell: an allowlist, never the gateway's own environment. */
export function buildShellEnv(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const pathEntries = (base.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .filter((p) => p && path.isAbsolute(p));
  let user = "user";
  try {
    user = os.userInfo().username;
  } catch {
    // keep the placeholder
  }
  const env: Record<string, string> = {
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    HOME: root,
    USER: user,
    LOGNAME: user,
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: base.LANG || "C.UTF-8",
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    SYSTEMD_PAGER: "cat",
    EDITOR: "false",
    VISUAL: "false",
    GIT_EDITOR: "false",
    GIT_SEQUENCE_EDITOR: "false",
    GIT_TERMINAL_PROMPT: "0",
    HISTFILE: "/dev/null",
    KURAHI_TERMINAL: "1",
  };
  for (const key of ["LC_ALL", "LC_CTYPE", "TZ"]) {
    const value = base[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

type NodePty = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void;
};
type NodePtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => NodePty;

async function loadNodePty(): Promise<NodePtySpawn> {
  const mod = (await import("@lydell/node-pty")) as unknown as {
    spawn?: NodePtySpawn;
    default?: { spawn?: NodePtySpawn };
  };
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (!spawn) {
    throw new Error("PTY support is unavailable (node-pty spawn not found)");
  }
  return spawn;
}

function wrapPty(pty: NodePty, killGroup: (signal: NodeJS.Signals) => void): PtyProcess {
  return {
    pid: pty.pid,
    write: (data) => pty.write(data),
    resize: (cols, rows) => {
      try {
        pty.resize(cols, rows);
      } catch {
        // the process may have exited
      }
    },
    onData: (listener) => pty.onData(listener),
    onExit: (listener) =>
      pty.onExit((e) =>
        listener({
          exitCode: typeof e.exitCode === "number" ? e.exitCode : null,
          signal: e.signal ? (SIGNALS[e.signal] ?? String(e.signal)) : null,
        }),
      ),
    kill: killGroup,
  };
}

/** Commands on the gateway host, in a PTY, one process group per command. */
export async function createHostBackend(): Promise<ShellBackend> {
  if (process.platform === "win32") {
    throw new Error(
      "the console terminal needs a POSIX shell; Windows hosts are not supported yet",
    );
  }
  const spawn = await loadNodePty();
  return {
    sandboxed: false,
    spawn(req) {
      const pty = spawn("/bin/bash", ["--noprofile", "--norc", "-c", req.line], {
        name: "xterm-256color",
        cols: req.cols,
        rows: req.rows,
        cwd: req.cwd,
        env: req.env,
      });
      return wrapPty(pty, (signal) => {
        try {
          process.kill(-pty.pid, signal);
        } catch {
          try {
            pty.kill(signal);
          } catch {
            // already gone
          }
        }
      });
    },
  };
}

/**
 * Commands in a sandbox container that mounts the project folder at `containerRoot`. The command
 * records its pid inside the container so cancel can signal its process group there (killing the
 * `docker exec` client alone would leave the command running in the container).
 */
export async function createSandboxBackend(opts: {
  containerName: string;
  hostRoot: string;
  containerRoot: string;
}): Promise<ShellBackend> {
  const spawn = await loadNodePty();
  const pidFile = (runId: string) =>
    `/tmp/kurahi-terminal-${runId.replace(/[^a-f0-9-]/gi, "")}.pid`;
  return {
    sandboxed: true,
    spawn(req) {
      const rel = path.relative(opts.hostRoot, req.cwd).split(path.sep).join("/");
      const workdir = rel ? path.posix.join(opts.containerRoot, rel) : opts.containerRoot;
      const envArgs = Object.entries({
        ...req.env,
        HOME: opts.containerRoot,
        SHELL: "/bin/sh",
      }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const script = `echo $$ > ${pidFile(req.runId)}; exec sh -c "$1"`;
      const pty = spawn(
        "docker",
        [
          "exec",
          "-it",
          "-w",
          workdir,
          ...envArgs,
          opts.containerName,
          "sh",
          "-c",
          script,
          "kurahi",
          req.line,
        ],
        {
          name: "xterm-256color",
          cols: req.cols,
          rows: req.rows,
          cwd: opts.hostRoot,
          env: buildShellEnv(opts.hostRoot),
        },
      );
      return wrapPty(pty, (signal) => {
        const sig = signal.replace(/^SIG/, "");
        const file = pidFile(req.runId);
        const child = spawnChild(
          "docker",
          [
            "exec",
            opts.containerName,
            "sh",
            "-c",
            `p=$(cat ${file} 2>/dev/null) && { kill -${sig} -- -$p 2>/dev/null || kill -${sig} $p; }`,
          ],
          { stdio: "ignore" },
        );
        child.on("error", () => undefined);
        try {
          process.kill(-pty.pid, signal);
        } catch {
          // already gone
        }
      });
    },
  };
}
