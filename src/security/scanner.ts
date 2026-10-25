// Malware scanning for inbound files (attachment intake, docs/security/attachment-intake.md).
//
// One interface, three adapters:
//   clamav    `clamdscan --fdpass` when the daemon client is installed, else `clamscan`
//             (exit 0 clean, 1 infected, anything else an error)
//   defender  Microsoft Defender `MpCmdRun.exe -Scan -ScanType 3 -File <path> -DisableRemediation`
//             on Windows, and from WSL through the Windows binary on the C: drive mount (WSL
//             automount root + c/Program Files/...) with the path
//             translated by `wslpath -w` (exit 0 clean, 2 threat, anything else an error)
//   none      no engine: every file is `unscanned`
//
// `auto` picks the first available in that order. Every scan has a bounded wall clock, runs with
// a minimal environment and FAILS CLOSED: a timeout, a crash, an unknown exit code or an
// unreadable verdict is `error`, never `clean`. Whether `unscanned` is acceptable is the caller's
// decision (`security.attachments.requireScan`, default true: refused).

import fs from "node:fs";
import path from "node:path";
import { runBounded, type BoundedExec } from "./bounded-exec.js";

export const SCANNER_NAMES = ["clamav", "defender", "none"] as const;
export type ScannerName = (typeof SCANNER_NAMES)[number];
export type ScannerChoice = ScannerName | "auto";

export type ScanVerdict = {
  verdict: "clean" | "infected" | "unscanned" | "error";
  scanner: ScannerName;
  /** Threat name when infected (from the engine's report). */
  signature: string | null;
  /** Why the scan failed (error) or did not run (unscanned); never a path. */
  detail: string | null;
  ms: number;
};

export interface FileScanner {
  readonly name: ScannerName;
  scan(file: string, opts: { timeoutMs: number }): Promise<ScanVerdict>;
}

/** What the adapters need from the host; tests pass fakes. */
export type ScannerHost = {
  platform: NodeJS.Platform;
  /** True on Linux under WSL (the Windows Defender binary may be reachable on the C: mount). */
  wsl: boolean;
  exec: BoundedExec;
  exists: (file: string) => boolean;
  /** Absolute path of an executable on PATH, or null. */
  which: (name: string) => string | null;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** The Defender binary inside WSL (default: from the automount root). */
  wslDefenderPath?: string;
};

export const DEFAULT_SCAN_TIMEOUT_MS = 120_000;
/** WSL's automount root (`[automount] root` in /etc/wsl.conf), default `/mnt/`. */
export function wslAutomountRoot(conf?: string): string {
  let text = conf;
  if (text === undefined) {
    try {
      text = fs.readFileSync("/etc/wsl.conf", "utf8");
    } catch {
      text = "";
    }
  }
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    const kv = /^root\s*=\s*"?([^"#]+?)"?\s*(?:#.*)?$/.exec(line);
    if (section === "automount" && kv && kv[1].startsWith("/")) {
      return kv[1];
    }
  }
  return "/mnt/";
}

/** Where the Windows Defender command line tool is from inside WSL. */
export function wslDefenderPath(root: string = wslAutomountRoot()): string {
  return path.posix.join(root, "c", "Program Files", "Windows Defender", "MpCmdRun.exe");
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

function whichOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function defaultScannerHost(): ScannerHost {
  return {
    platform: process.platform,
    wsl: isWsl(),
    exec: runBounded,
    exists: (f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    },
    which: (n) => whichOnPath(n, process.env),
    env: process.env,
    now: Date.now,
  };
}

/** The scanner's whole environment: enough to find system libraries, nothing else. */
function scanEnv(host: ScannerHost): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = host.env[k];
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  out.LANG = "C";
  out.LC_ALL = "C";
  return out;
}

function verdict(
  scanner: ScannerName,
  t0: number,
  host: ScannerHost,
  v: ScanVerdict["verdict"],
  extra: { signature?: string | null; detail?: string | null } = {},
): ScanVerdict {
  return {
    verdict: v,
    scanner,
    signature: extra.signature ?? null,
    detail: extra.detail ?? null,
    ms: Math.max(0, host.now() - t0),
  };
}

/** A threat name as an engine reports it, bounded and without paths. */
function cleanSignature(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().replace(/[^\w.:/!@-]+/g, "_");
  return s ? s.slice(0, 120) : null;
}

export function createClamavScanner(host: ScannerHost): FileScanner | null {
  const clamd = host.which("clamdscan");
  const clam = clamd ?? host.which("clamscan");
  if (!clam) {
    return null;
  }
  return {
    name: "clamav",
    async scan(file, { timeoutMs }) {
      const t0 = host.now();
      const argv = clamd
        ? [clam, "--fdpass", "--no-summary", "--infected", file]
        : [clam, "--no-summary", "--infected", file];
      const r = await host.exec(argv, { timeoutMs, env: scanEnv(host) });
      if (r.timedOut) {
        return verdict("clamav", t0, host, "error", { detail: "scan timed out" });
      }
      if (r.code === 0) {
        return verdict("clamav", t0, host, "clean");
      }
      if (r.code === 1) {
        // "<path>: <Signature> FOUND"
        const m = /:\s*([^\s:]+)\s+FOUND\s*$/m.exec(r.stdout);
        return verdict("clamav", t0, host, "infected", {
          signature: cleanSignature(m?.[1]) ?? "unknown",
        });
      }
      return verdict("clamav", t0, host, "error", {
        detail: `clamav exit ${r.code ?? r.signal ?? "?"}`,
      });
    },
  };
}

/** The MpCmdRun.exe to run and whether paths must be translated from WSL. */
export function defenderBinary(host: ScannerHost): { exe: string; wsl: boolean } | null {
  if (host.platform === "win32") {
    const base = host.env.ProgramFiles ?? host.env.PROGRAMFILES ?? "C:\\Program Files";
    const exe = path.win32.join(base, "Windows Defender", "MpCmdRun.exe");
    return host.exists(exe) ? { exe, wsl: false } : null;
  }
  const wslExe = host.wslDefenderPath ?? wslDefenderPath();
  if (host.platform === "linux" && host.wsl && host.exists(wslExe)) {
    return { exe: wslExe, wsl: true };
  }
  return null;
}

export function createDefenderScanner(host: ScannerHost): FileScanner | null {
  const bin = defenderBinary(host);
  if (!bin) {
    return null;
  }
  return {
    name: "defender",
    async scan(file, { timeoutMs }) {
      const t0 = host.now();
      let target = file;
      if (bin.wsl) {
        const tr = await host.exec(["wslpath", "-w", file], {
          timeoutMs: Math.min(timeoutMs, 10_000),
          env: scanEnv(host),
        });
        const win = tr.stdout.trim();
        if (tr.timedOut || tr.code !== 0 || !win || win.includes("\n")) {
          return verdict("defender", t0, host, "error", { detail: "wslpath failed" });
        }
        target = win;
      }
      const r = await host.exec(
        [bin.exe, "-Scan", "-ScanType", "3", "-File", target, "-DisableRemediation"],
        { timeoutMs, env: scanEnv(host) },
      );
      if (r.timedOut) {
        return verdict("defender", t0, host, "error", { detail: "scan timed out" });
      }
      const out = r.stdout.replace(/\r/g, "");
      if (r.code === 0 && /found no threats/i.test(out)) {
        return verdict("defender", t0, host, "clean");
      }
      if (r.code === 2) {
        const m = /^\s*Threat\s*:\s*(.+)$/m.exec(out);
        return verdict("defender", t0, host, "infected", {
          signature: cleanSignature(m?.[1]) ?? "unknown",
        });
      }
      // Exit 0 without the "no threats" line (or any other code) is not a verdict.
      return verdict("defender", t0, host, "error", {
        detail: `defender exit ${r.code ?? r.signal ?? "?"}`,
      });
    },
  };
}

export function createNoneScanner(): FileScanner {
  return {
    name: "none",
    async scan() {
      return {
        verdict: "unscanned",
        scanner: "none",
        signature: null,
        detail: "no malware scanner is configured",
        ms: 0,
      };
    },
  };
}

/**
 * The scanner for a configured choice. An explicit engine that is not installed is an error
 * scanner (every scan fails closed), never a silent fallback to `none`.
 */
export function resolveScanner(
  choice: ScannerChoice,
  host: ScannerHost = defaultScannerHost(),
): FileScanner {
  const unavailable = (name: ScannerName): FileScanner => ({
    name,
    async scan() {
      return {
        verdict: "error",
        scanner: name,
        signature: null,
        detail: `${name} is configured but not installed on this host`,
        ms: 0,
      };
    },
  });
  if (choice === "clamav") {
    return createClamavScanner(host) ?? unavailable("clamav");
  }
  if (choice === "defender") {
    return createDefenderScanner(host) ?? unavailable("defender");
  }
  if (choice === "none") {
    return createNoneScanner();
  }
  return createClamavScanner(host) ?? createDefenderScanner(host) ?? createNoneScanner();
}

/** Run a scanner with the wall clock enforced here too (an adapter that hangs is an error). */
export async function scanWithDeadline(
  scanner: FileScanner,
  file: string,
  timeoutMs: number,
): Promise<ScanVerdict> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ScanVerdict>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          verdict: "error",
          scanner: scanner.name,
          signature: null,
          detail: "scan timed out",
          ms: Date.now() - t0,
        }),
      timeoutMs + 1000,
    );
  });
  try {
    return await Promise.race([
      scanner.scan(file, { timeoutMs }).catch(
        (err: unknown): ScanVerdict => ({
          verdict: "error",
          scanner: scanner.name,
          signature: null,
          detail: `scanner failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
          ms: Date.now() - t0,
        }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
