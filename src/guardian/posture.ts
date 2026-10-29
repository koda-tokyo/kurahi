// Guardian posture checks (docs/security/guardian.md), John's nightly look at the host: backup
// freshness and a test restore, secrets left in files, unexpected listening ports, Kurahi's own
// integrity and credentials about to expire.
//
// Every check is deterministic and returns `facts` plus `findings`; no finding means OK. Each is
// bounded (files walked, bytes read, a wall clock on child processes) and FAILS CLOSED: a folder
// that cannot be read, a tool that times out or output that cannot be parsed is a finding, never
// a pass. Secret values are never returned: a secret finding is path, line and detector name.
// Nothing here writes outside a temporary folder it creates and removes (the restore test).

import JSZip from "jszip";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { GuardianBackupCheck } from "../config/types.guardian.js";
import { withTimeout } from "../infra/archive.js";
import { type IntegrityLocations, verifyRegistry } from "../integrity/registry.js";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import { type BoundedExec, runBounded } from "../security/bounded-exec.js";
import { sha256OfFile } from "./scan.js";

export type PostureFinding = {
  /** The check's name, e.g. `backup`, `secrets`. */
  check: string;
  /** What it is about: a path, `path:line`, a port, a profile id. Never a secret value. */
  subject: string;
  detail: string;
};

export type PostureFacts = Record<string, string | number | boolean>;

export type PostureResult = { facts: PostureFacts; findings: PostureFinding[] };

export const DEFAULT_BACKUP_MAX_AGE_HOURS = 26;
export const DEFAULT_CREDENTIAL_WARN_DAYS = 14;
/** Entries walked under one backup folder when looking for the newest file. */
const BACKUP_WALK_MAX = 200_000;
/** Largest single file a restore test copies (a test, not a full restore). */
const RESTORE_FILE_MAX_BYTES = 256 * 1024 ** 2;
/** Largest zip a restore test opens (JSZip reads the whole archive). */
const RESTORE_ZIP_MAX_BYTES = 512 * 1024 ** 2;
const RESTORE_TIMEOUT_MS = 5 * 60_000;
/** After a timeout, how long the aborted restore may take to stop before its folder is removed. */
const RESTORE_SETTLE_MS = 10_000;

const errCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? "error";

// ---- backup freshness ------------------------------------------------------------------------

/** Newest regular-file mtime at or under `p` (a file is itself), bounded. */
export function newestMtime(
  p: string,
  maxEntries = BACKUP_WALK_MAX,
): {
  newestMs: number | null;
  newestPath: string | null;
  files: number;
  truncated: boolean;
} {
  const st = fs.statSync(p);
  if (st.isFile()) {
    return { newestMs: st.mtimeMs, newestPath: p, files: 1, truncated: false };
  }
  let newestMs: number | null = null;
  let newestPath: string | null = null;
  let files = 0;
  let walked = 0;
  const stack = [p];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++walked > maxEntries) {
        return { newestMs, newestPath, files, truncated: true };
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        files += 1;
        const m = fs.lstatSync(full).mtimeMs;
        if (newestMs === null || m > newestMs) {
          newestMs = m;
          newestPath = full;
        }
      }
    }
  }
  return { newestMs, newestPath, files, truncated: false };
}

export function checkBackupFreshness(
  backups: GuardianBackupCheck[],
  now: number = Date.now(),
): PostureResult {
  const findings: PostureFinding[] = [];
  let fresh = 0;
  let oldestAgeH = 0;
  if (backups.length === 0) {
    findings.push({
      check: "backup",
      subject: "guardian.posture.backups",
      detail: "no backup paths are configured",
    });
  }
  for (const b of backups) {
    const maxAge = b.maxAgeHours ?? DEFAULT_BACKUP_MAX_AGE_HOURS;
    let r: ReturnType<typeof newestMtime>;
    try {
      r = newestMtime(b.path);
    } catch (err) {
      findings.push({ check: "backup", subject: b.path, detail: `unreadable (${errCode(err)})` });
      continue;
    }
    if (r.newestMs === null) {
      findings.push({
        check: "backup",
        subject: b.path,
        detail: r.truncated ? "no file found within the walk limit" : "no backup files",
      });
      continue;
    }
    const ageH = Math.max(0, (now - r.newestMs) / 3_600_000);
    oldestAgeH = Math.max(oldestAgeH, ageH);
    if (ageH > maxAge) {
      findings.push({
        check: "backup",
        subject: b.path,
        detail: `newest backup file is ${ageH.toFixed(1)} h old (maximum ${maxAge} h)${
          r.truncated ? "; walk limit reached" : ""
        }`,
      });
    } else {
      fresh += 1;
    }
  }
  return {
    facts: { backups: backups.length, fresh, oldestNewestAgeHours: oldestAgeH.toFixed(1) },
    findings,
  };
}

// ---- restore test ----------------------------------------------------------------------------

export type RestoreOutcome =
  | { status: "ok"; member: string; sha256: string; bytes: number }
  | { status: "failed" | "unsupported"; detail: string };

/** Newest regular file under a folder that a restore test may copy. */
function pickRestoreFile(dir: string): string | null {
  let best: { p: string; m: number } | null = null;
  let walked = 0;
  const stack = [dir];
  while (stack.length > 0 && walked < BACKUP_WALK_MAX) {
    const cur = stack.pop()!;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      walked += 1;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        const st = fs.lstatSync(full);
        if (st.size > 0 && st.size <= RESTORE_FILE_MAX_BYTES && (!best || st.mtimeMs > best.m)) {
          best = { p: full, m: st.mtimeMs };
        }
      }
    }
  }
  return best?.p ?? null;
}

/** A member name safe to extract under a temporary folder (no absolute path, no `..`). */
function safeMember(name: string): boolean {
  if (!name || name.endsWith("/") || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    return false;
  }
  return !name.split(/[\\/]/).includes("..");
}

async function restoreFromFolder(dir: string, tmp: string): Promise<RestoreOutcome> {
  const file = pickRestoreFile(dir);
  if (!file) {
    return { status: "failed", detail: "no restorable file in the backup folder" };
  }
  const expected = await sha256OfFile(file);
  const target = path.join(tmp, "restored");
  await fs.promises.copyFile(file, target);
  const actual = await sha256OfFile(target);
  if (actual !== expected) {
    return { status: "failed", detail: "restored copy differs from the backup file" };
  }
  return {
    status: "ok",
    member: path.relative(dir, file),
    sha256: actual,
    bytes: fs.statSync(target).size,
  };
}

async function restoreFromTar(archive: string, tmp: string): Promise<RestoreOutcome> {
  // Pass 1 lists the archive and hashes the first regular member as stored; pass 2 extracts
  // only that member, which must hash the same.
  let member: string | null = null;
  let expected: string | null = null;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry: (entry) => {
      if (
        member === null &&
        entry.type === "File" &&
        entry.size > 0 &&
        entry.size <= RESTORE_FILE_MAX_BYTES &&
        safeMember(entry.path)
      ) {
        member = entry.path;
        const h = createHash("sha256");
        entry.on("data", (d: Buffer) => h.update(d));
        entry.on("end", () => {
          expected = h.digest("hex");
        });
      } else {
        entry.resume();
      }
    },
  });
  if (member === null || expected === null) {
    return { status: "failed", detail: "no restorable member in the archive" };
  }
  const chosen: string = member;
  await tar.x({ file: archive, cwd: tmp, strict: true, filter: (p) => p === chosen });
  const out = path.join(tmp, chosen);
  if (!fs.existsSync(out)) {
    return { status: "failed", detail: "member was not extracted" };
  }
  const actual = await sha256OfFile(out);
  if (actual !== expected) {
    return { status: "failed", detail: "extracted member differs from the archive" };
  }
  return { status: "ok", member: chosen, sha256: actual, bytes: fs.statSync(out).size };
}

async function restoreFromZip(
  archive: string,
  tmp: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<RestoreOutcome> {
  if (fs.statSync(archive).size > RESTORE_ZIP_MAX_BYTES) {
    return {
      status: "unsupported",
      detail: "restore test unsupported for zip archives this large",
    };
  }
  const zip = await JSZip.loadAsync(await fs.promises.readFile(archive), { checkCRC32: true });
  const entry = Object.values(zip.files).find((f) => !f.dir && safeMember(f.name));
  if (!entry) {
    return { status: "failed", detail: "no restorable member in the archive" };
  }
  // The central directory's size, checked BEFORE anything is inflated (a zip bomb declares a
  // small archive and a huge member). JSZip keeps it on the entry's loaded data.
  const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  if (typeof declared !== "number") {
    return { status: "failed", detail: "zip member size unknown" };
  }
  if (declared > maxBytes) {
    return {
      status: "failed",
      detail: `zip member declares ${declared} bytes, over the restore limit (${maxBytes})`,
    };
  }
  // The declared size can lie: the stream is also cut at the limit, and on abort.
  const out = path.join(tmp, "restored");
  const h = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const src = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy?: () => void };
    const sink = fs.createWriteStream(out, { mode: 0o600 });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      src.pause();
      src.destroy?.();
      sink.destroy();
      reject(err);
    };
    const onAbort = () => fail(new Error("restore test aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    src.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes || bytes > declared) {
        fail(new Error("zip member inflates beyond its declared size"));
        return;
      }
      h.update(d);
      sink.write(d);
    });
    src.on("error", (err: Error) => fail(err));
    sink.on("error", (err: Error) => fail(err));
    src.on("end", () => {
      if (settled) {
        return;
      }
      sink.end(() => {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  });
  const expected = h.digest("hex");
  const actual = await sha256OfFile(out);
  if (actual !== expected || bytes !== declared) {
    return { status: "failed", detail: "restored member differs from the archive" };
  }
  return { status: "ok", member: entry.name, sha256: actual, bytes };
}

/**
 * Restore one file from a backup (a folder, a .tar/.tar.gz/.tgz or a .zip) into a temporary
 * folder and compare SHA-256. The temporary folder is always removed; the backup is only read.
 */
export async function restoreTest(
  backupPath: string,
  opts: {
    timeoutMs?: number;
    tmpRoot?: string;
    /** Largest member a zip restore inflates. */ maxFileBytes?: number;
  } = {},
): Promise<RestoreOutcome> {
  let st: fs.Stats;
  try {
    st = fs.statSync(backupPath);
  } catch (err) {
    return { status: "failed", detail: `backup unreadable (${errCode(err)})` };
  }
  const lower = backupPath.toLowerCase();
  const kind = st.isDirectory()
    ? "folder"
    : /\.(tar|tar\.gz|tgz)$/.test(lower)
      ? "tar"
      : lower.endsWith(".zip")
        ? "zip"
        : null;
  if (!kind) {
    return { status: "unsupported", detail: "restore test unsupported for this format" };
  }
  const tmp = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "kurahi-restore-"));
  const abort = new AbortController();
  const run =
    kind === "folder"
      ? restoreFromFolder(backupPath, tmp)
      : kind === "tar"
        ? restoreFromTar(backupPath, tmp)
        : restoreFromZip(
            backupPath,
            tmp,
            abort.signal,
            opts.maxFileBytes ?? RESTORE_FILE_MAX_BYTES,
          );
  try {
    return await withTimeout(run, opts.timeoutMs ?? RESTORE_TIMEOUT_MS, "restore test");
  } catch (err) {
    return {
      status: "failed",
      detail: `restore failed: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`,
    };
  } finally {
    // Stop the work and let it settle (bounded) before the folder goes, so nothing writes into a
    // removed folder; then remove it.
    abort.abort();
    await Promise.race([
      run.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS).unref()),
    ]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function checkRestores(
  backups: GuardianBackupCheck[],
  opts: { timeoutMs?: number; tmpRoot?: string } = {},
): Promise<PostureResult> {
  const findings: PostureFinding[] = [];
  const tested = backups.filter((b) => b.restoreTest);
  let ok = 0;
  if (tested.length === 0) {
    findings.push({
      check: "restore",
      subject: "guardian.posture.backups",
      detail: "no backup has restoreTest enabled",
    });
  }
  for (const b of tested) {
    const r = await restoreTest(b.path, opts);
    if (r.status === "ok") {
      ok += 1;
    } else {
      findings.push({ check: "restore", subject: b.path, detail: r.detail });
    }
  }
  return { facts: { tested: tested.length, restored: ok }, findings };
}

// ---- secrets in files ------------------------------------------------------------------------

/**
 * Names for the log redaction patterns (src/logging/redact.ts), in their order. The PEM pattern
 * spans lines there; here a private key is found by its header line.
 */
export const SECRET_DETECTOR_NAMES = [
  "env-assignment",
  "json-secret-field",
  "cli-secret-flag",
  "authorization-header",
  "bearer-token",
  "private-key",
  "sk-api-key",
  "github-token",
  "github-pat",
  "slack-token",
  "slack-app-token",
  "groq-api-key",
  "google-api-key",
  "perplexity-api-key",
  "npm-token",
  "telegram-bot-token",
] as const;

type Detector = { name: string; re: RegExp };

export function secretDetectors(): Detector[] {
  const sources = getDefaultRedactPatterns();
  if (sources.length !== SECRET_DETECTOR_NAMES.length) {
    // The shared patterns changed shape; refuse rather than mislabel findings.
    throw new Error("secret detector table is out of date with the redaction patterns");
  }
  return sources.map((src, i) => ({
    name: SECRET_DETECTOR_NAMES[i],
    re:
      SECRET_DETECTOR_NAMES[i] === "private-key"
        ? /-----BEGIN [A-Z ]*PRIVATE KEY-----/
        : new RegExp(src, "i"),
  }));
}

/** Placeholder-looking values (`${VAR}`, `<token>`, `***`) and short ones are not secrets. */
function plausibleSecret(m: RegExpExecArray, detector: string): boolean {
  if (detector === "private-key") {
    return true;
  }
  const value = m.slice(1).findLast((g) => typeof g === "string" && g.length > 0) ?? m[0];
  return value.length >= 8 && !/^[$<{%*]/.test(value) && !/^x+$/i.test(value);
}

export type SecretScanLimits = {
  maxFiles?: number;
  /** Larger files are skipped (counted). */
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFindings?: number;
};

const SECRET_SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);

export function checkSecrets(roots: string[], limits: SecretScanLimits = {}): PostureResult {
  const maxFiles = limits.maxFiles ?? 20_000;
  const maxFileBytes = limits.maxFileBytes ?? 2 * 1024 ** 2;
  const maxTotal = limits.maxTotalBytes ?? 256 * 1024 ** 2;
  const maxFindings = limits.maxFindings ?? 200;
  const detectors = secretDetectors();
  const findings: PostureFinding[] = [];
  let files = 0;
  let bytes = 0;
  let skippedLarge = 0;
  let skippedBinary = 0;
  let secrets = 0;
  let truncated = false;
  if (roots.length === 0) {
    findings.push({
      check: "secrets",
      subject: "guardian.posture.secretScanRoots",
      detail: "no folders are configured",
    });
  }
  const scanFile = (file: string, size: number) => {
    files += 1;
    bytes += size;
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8192).includes(0)) {
      skippedBinary += 1;
      return;
    }
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].length > 8192 ? lines[i].slice(0, 8192) : lines[i];
      for (const d of detectors) {
        const m = d.re.exec(line);
        if (m && plausibleSecret(m, d.name)) {
          secrets += 1;
          if (findings.length < maxFindings) {
            findings.push({
              check: "secrets",
              subject: `${file}:${i + 1}`,
              detail: `possible secret (${d.name})`,
            });
          }
          break; // one finding per line
        }
      }
    }
  };
  outer: for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        const st = fs.statSync(dir);
        if (st.isFile()) {
          entries = [];
          scanFile(dir, st.size);
        } else {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        }
      } catch (err) {
        findings.push({ check: "secrets", subject: dir, detail: `unreadable (${errCode(err)})` });
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SECRET_SKIP_DIRS.has(e.name)) {
            stack.push(full);
          }
          continue;
        }
        if (!e.isFile()) {
          continue; // symlinks are not followed
        }
        if (files >= maxFiles || bytes >= maxTotal) {
          truncated = true;
          break outer;
        }
        try {
          const size = fs.lstatSync(full).size;
          if (size > maxFileBytes) {
            skippedLarge += 1;
            continue;
          }
          scanFile(full, size);
        } catch (err) {
          findings.push({
            check: "secrets",
            subject: full,
            detail: `unreadable (${errCode(err)})`,
          });
        }
      }
    }
  }
  if (truncated) {
    // Files not read may hold secrets: unknown, never clean.
    findings.push({
      check: "secrets",
      subject: roots.join(","),
      detail: `scan limit reached after ${files} file(s); the rest was not read`,
    });
  }
  return {
    facts: { roots: roots.length, files, bytes, secrets, skippedLarge, skippedBinary, truncated },
    findings,
  };
}

// ---- listening ports -------------------------------------------------------------------------

export type Listener = { address: string; port: number };

export type PortsHost = {
  platform: NodeJS.Platform;
  exec: BoundedExec;
  readFile: (file: string) => string;
  env: NodeJS.ProcessEnv;
};

export function defaultPortsHost(): PortsHost {
  return {
    platform: process.platform,
    exec: runBounded,
    readFile: (f) => fs.readFileSync(f, "utf8"),
    env: process.env,
  };
}

/** /proc/net/tcp{,6} rows in state 0A (LISTEN). Addresses are kernel-order hex. */
export function parseProcNetTcp(text: string, v6: boolean): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== "0A") {
      continue;
    }
    const [hexAddr, hexPort] = cols[1].split(":");
    const port = Number.parseInt(hexPort, 16);
    if (!Number.isFinite(port)) {
      continue;
    }
    let address: string;
    if (!v6) {
      const n = Number.parseInt(hexAddr, 16);
      address = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
    } else if (/^0+$/.test(hexAddr)) {
      address = "::";
    } else if (hexAddr === "00000000000000000000000001000000") {
      address = "::1";
    } else if (hexAddr.startsWith("0000000000000000FFFF0000")) {
      const n = Number.parseInt(hexAddr.slice(24), 16);
      address = `::ffff:${[n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".")}`;
    } else {
      address = hexAddr.toLowerCase();
    }
    out.push({ address, port });
  }
  return out;
}

/** `host:port` / `[v6]:port` / `*:port` as printed by lsof and netstat. */
function splitHostPort(s: string): Listener | null {
  const m = /^(?:\[([^\]]+)\]|(.*)):(\d+)$/.exec(s.trim());
  if (!m) {
    return null;
  }
  const address = m[1] ?? m[2];
  return { address: address === "*" ? "0.0.0.0" : address, port: Number(m[3]) };
}

/** `lsof -nP -iTCP -sTCP:LISTEN`: NAME column `127.0.0.1:18790 (LISTEN)`. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const m = /(\S+)\s+\(LISTEN\)\s*$/.exec(line);
    const l = m ? splitHostPort(m[1]) : null;
    if (l) {
      out.push(l);
    }
  }
  return out;
}

/** `netstat -ano`: `TCP  0.0.0.0:135  0.0.0.0:0  LISTENING  1234` (the state may be localised). */
export function parseNetstat(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0]?.toUpperCase() !== "TCP" || cols.length < 4) {
      continue;
    }
    // A listening socket has no remote end: 0.0.0.0:0 or [::]:0.
    if (!/^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(cols[2]) && cols[3] !== "LISTENING") {
      continue;
    }
    const l = splitHostPort(cols[1]);
    if (l) {
      out.push(l);
    }
  }
  return out;
}

export function isLoopback(address: string): boolean {
  return (
    address.startsWith("127.") ||
    address === "::1" ||
    address.startsWith("::ffff:127.") ||
    address === "localhost"
  );
}

/** The host's listening TCP sockets, or why they could not be read. */
export async function listListeners(
  host: PortsHost = defaultPortsHost(),
): Promise<{ listeners: Listener[] } | { error: string }> {
  const env: Record<string, string> = { LANG: "C", LC_ALL: "C" };
  for (const k of ["PATH", "SystemRoot", "SYSTEMROOT", "windir"]) {
    if (typeof host.env[k] === "string") {
      env[k] = host.env[k];
    }
  }
  if (host.platform === "linux") {
    try {
      const v4 = parseProcNetTcp(host.readFile("/proc/net/tcp"), false);
      let v6: Listener[] = [];
      try {
        v6 = parseProcNetTcp(host.readFile("/proc/net/tcp6"), true);
      } catch {
        // IPv6 disabled: no tcp6 table
      }
      return { listeners: [...v4, ...v6] };
    } catch (err) {
      return { error: `/proc/net/tcp unreadable (${errCode(err)})` };
    }
  }
  const argv =
    host.platform === "darwin"
      ? ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]
      : host.platform === "win32"
        ? ["netstat", "-ano", "-p", "TCP"]
        : null;
  if (!argv) {
    return { error: `listening ports unsupported on this platform (${host.platform})` };
  }
  const r = await host.exec(argv, { timeoutMs: 15_000, env, maxOutputBytes: 1024 * 1024 });
  // lsof exits 1 when nothing listens; any output beyond the header is still parsed.
  if (r.timedOut || r.truncated || (r.code !== 0 && !(argv[0] === "lsof" && r.code === 1))) {
    return {
      error: `${argv[0]} failed (${r.timedOut ? "timed out" : r.truncated ? "output too large" : `exit ${r.code ?? r.signal}`})`,
    };
  }
  const parse = argv[0] === "lsof" ? parseLsof : parseNetstat;
  const both = host.platform === "win32" ? `${r.stdout}\n${await netstatV6(host, env)}` : r.stdout;
  return { listeners: parse(both) };
}

async function netstatV6(host: PortsHost, env: Record<string, string>): Promise<string> {
  const r = await host.exec(["netstat", "-ano", "-p", "TCPv6"], { timeoutMs: 15_000, env });
  return r.code === 0 && !r.timedOut ? r.stdout : "";
}

/**
 * Listening ports not in `allowed`. Loopback-only listeners are counted but not findings unless
 * `includeLoopback` (other hosts cannot reach them).
 */
export async function checkPorts(
  allowed: number[] | undefined,
  opts: { host?: PortsHost; includeLoopback?: boolean } = {},
): Promise<PostureResult> {
  const r = await listListeners(opts.host);
  if ("error" in r) {
    return {
      facts: { available: false },
      findings: [{ check: "ports", subject: "listeners", detail: r.error }],
    };
  }
  const allow = new Set(allowed ?? []);
  const findings: PostureFinding[] = [];
  const seen = new Set<string>();
  let loopback = 0;
  for (const l of r.listeners) {
    const key = `${l.address}:${l.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (isLoopback(l.address) && !opts.includeLoopback) {
      loopback += 1;
      continue;
    }
    if (!allow.has(l.port)) {
      findings.push({ check: "ports", subject: key, detail: `port ${l.port} is not allowed` });
    }
  }
  if (!allowed) {
    findings.unshift({
      check: "ports",
      subject: "guardian.posture.allowedPorts",
      detail: "no allowed ports are configured",
    });
  }
  const ports = [...new Set(r.listeners.map((l) => l.port))].toSorted((a, b) => a - b);
  return {
    facts: {
      available: true,
      listeners: seen.size,
      loopbackOnly: loopback,
      ports: ports.slice(0, 40).join(","),
    },
    findings,
  };
}

// ---- Kurahi integrity ------------------------------------------------------------------------

export function checkIntegrity(loc?: IntegrityLocations): PostureResult {
  const r = verifyRegistry(loc);
  const findings: PostureFinding[] = r.problems.slice(0, 50).map((p) => ({
    check: "integrity",
    subject: p.path,
    detail: `${p.kind}: ${p.message}`.slice(0, 200),
  }));
  if (r.state === "unconfigured") {
    findings.push({
      check: "integrity",
      subject: r.registryPath,
      detail: "no integrity registry (kurahi integrity init); Kurahi files are not verified",
    });
  } else if (r.state === "failed" && findings.length === 0) {
    findings.push({ check: "integrity", subject: r.registryPath, detail: "verification failed" });
  }
  return { facts: { state: r.state, checked: r.checked, problems: r.problems.length }, findings };
}

// ---- expiring credentials --------------------------------------------------------------------

/**
 * Credentials in the auth profile store (read only, never refreshed or rewritten here) that expire
 * within `warnDays`. Static tokens carry their own expiry; OAuth credentials with a refresh token
 * renew themselves and count only when they cannot; API keys carry no expiry data.
 */
export function checkCredentials(
  storePath: string,
  warnDays: number = DEFAULT_CREDENTIAL_WARN_DAYS,
  now: number = Date.now(),
): PostureResult {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      // No store is a normal install (Kurahi runs on local models, or signs in elsewhere): there
      // is nothing stored that could expire. Said as a fact, not a finding.
      return {
        facts: { credentialStore: "none", profiles: 0, withExpiry: 0, noExpiryData: 0, warnDays },
        findings: [],
      };
    }
    return {
      facts: { credentialStore: "unreadable" },
      findings: [
        { check: "credentials", subject: storePath, detail: `unreadable (${errCode(err)})` },
      ],
    };
  }
  const profiles = (raw as { profiles?: Record<string, Record<string, unknown>> })?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return {
      facts: { credentialStore: "unreadable" },
      findings: [{ check: "credentials", subject: storePath, detail: "not an auth profile store" }],
    };
  }
  const findings: PostureFinding[] = [];
  let withExpiry = 0;
  let noExpiry = 0;
  let refreshable = 0;
  const horizon = now + warnDays * 86_400_000;
  for (const [id, cred] of Object.entries(profiles).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const type = cred?.type;
    const expires = typeof cred?.expires === "number" ? cred.expires : null;
    if (type === "oauth" && typeof cred.refresh === "string" && cred.refresh) {
      refreshable += 1;
      continue;
    }
    if (expires === null) {
      noExpiry += 1;
      continue;
    }
    withExpiry += 1;
    if (expires <= horizon) {
      const days = (expires - now) / 86_400_000;
      findings.push({
        check: "credentials",
        subject: id,
        detail:
          days <= 0
            ? `${String(type)} credential expired ${Math.abs(days).toFixed(1)} day(s) ago`
            : `${String(type)} credential expires in ${days.toFixed(1)} day(s)`,
      });
    }
  }
  return {
    facts: {
      credentialStore: "present",
      profiles: Object.keys(profiles).length,
      withExpiry,
      refreshable,
      noExpiryData: noExpiry,
      warnDays,
    },
    findings,
  };
}
