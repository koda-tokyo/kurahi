// Malware scanning for inbound files (attachment intake, docs/security/attachment-intake.md).
//
// One interface, four adapters (also used by Guardian share scans, src/guardian/scan.ts):
//   clamav    `clamdscan --fdpass` when the daemon client is installed, else `clamscan`
//             (exit 0 clean, 1 infected, anything else an error)
//   defender  Microsoft Defender `MpCmdRun.exe -Scan -ScanType 3 -File <path> -DisableRemediation`
//             on Windows, and from WSL through the Windows binary on the C: drive mount (WSL
//             automount root + c/Program Files/...) with the path
//             translated by `wslpath -w` (exit 0 clean, 2 threat, anything else an error)
//   yara      `yara --no-warnings -a <secs> <rule files...> <path>` with every *.yar/*.yara under
//             the configured rules folder (exit 0 with no match lines clean, match lines infected
//             with the rule names, anything else an error; no rule files is an error)
//   none      no engine: every file is `unscanned`
//
// `auto` picks the first available of clamav and defender; yara runs only when named. Every scan
// has a bounded wall clock, runs with a minimal environment and FAILS CLOSED: a timeout, a crash,
// an unknown exit code or an unreadable verdict is `error`, never `clean`. Whether `unscanned` is
// acceptable is the caller's decision (`security.attachments.requireScan`, default true: refused).

import fs from "node:fs";
import path from "node:path";
import { runBounded, type BoundedExec } from "./bounded-exec.js";

export const SCANNER_NAMES = ["clamav", "defender", "yara", "none"] as const;
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
  /** The rule files of a YARA rules folder (default: collectYaraRules). */
  yaraRules?: (dir: string) => string[] | null;
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

/** Rule files a rules folder holds, at most this many (a rules folder is not a file share). */
export const YARA_MAX_RULE_FILES = 1000;

/**
 * Every *.yar / *.yara under `dir` (recursive, symlinks not followed), sorted so the command line
 * is stable. Null when the folder cannot be read or holds more than YARA_MAX_RULE_FILES.
 */
export function collectYaraRules(dir: string): string[] | null {
  const out: string[] = [];
  const stack = [dir];
  try {
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && /\.(yar|yara)$/i.test(e.name)) {
          out.push(full);
          if (out.length > YARA_MAX_RULE_FILES) {
            return null;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return out.toSorted();
}

/** One `yara` match line: `<RuleName> <path>` (no tags, no metadata: those flags are not passed). */
const YARA_MATCH_RE = /^([A-Za-z_][A-Za-z0-9_]{0,127}) \S/;

export function createYaraScanner(host: ScannerHost, rulesDir: string): FileScanner | null {
  const yara = host.which("yara");
  if (!yara) {
    return null;
  }
  return {
    name: "yara",
    async scan(file, { timeoutMs }) {
      const t0 = host.now();
      const rules = (host.yaraRules ?? collectYaraRules)(rulesDir);
      if (!rules || rules.length === 0) {
        return verdict("yara", t0, host, "error", {
          detail: rules ? "no YARA rule files in the rules folder" : "YARA rules folder unreadable",
        });
      }
      // yara's own timeout (whole seconds) a little inside ours, so a slow rule set reports.
      const secs = Math.max(1, Math.floor(timeoutMs / 1000) - 1);
      const r = await host.exec([yara, "--no-warnings", "-a", String(secs), ...rules, file], {
        timeoutMs,
        env: scanEnv(host),
      });
      if (r.timedOut) {
        return verdict("yara", t0, host, "error", { detail: "scan timed out" });
      }
      if (r.code !== 0) {
        // Rule compile errors, unreadable files and yara's own timeout all exit non-zero.
        return verdict("yara", t0, host, "error", {
          detail: `yara exit ${r.code ?? r.signal ?? "?"}`,
        });
      }
      const lines = r.stdout
        .replace(/\r/g, "")
        .split("\n")
        .filter((l) => l.trim() !== "");
      if (lines.length === 0) {
        return r.truncated
          ? verdict("yara", t0, host, "error", { detail: "yara output truncated" })
          : verdict("yara", t0, host, "clean");
      }
      const names = new Set<string>();
      for (const line of lines) {
        const m = YARA_MATCH_RE.exec(line);
        if (!m) {
          return verdict("yara", t0, host, "error", { detail: "unreadable yara output" });
        }
        names.add(m[1]);
      }
      return verdict("yara", t0, host, "infected", {
        signature: [...names].toSorted().join(",").slice(0, 120),
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
  opts: { yaraRules?: string } = {},
): FileScanner {
  const unavailable = (name: ScannerName, detail?: string): FileScanner => ({
    name,
    async scan() {
      return {
        verdict: "error",
        scanner: name,
        signature: null,
        detail: detail ?? `${name} is configured but not installed on this host`,
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
  if (choice === "yara") {
    // YARA without a rules folder cannot decide anything: every scan fails closed.
    if (!opts.yaraRules) {
      return unavailable("yara", "yara is configured without a rules folder");
    }
    return createYaraScanner(host, opts.yaraRules) ?? unavailable("yara");
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
