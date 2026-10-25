/**
 * `kurahi update` for prebuilt bundles (scripts/bundle.mjs output).
 *
 * Flow: GitHub Releases API → pick the asset for this os/arch → download SHA256SUMS.txt and the
 * archive → verify the archive hash (mismatch refuses, nothing is touched) → extract → verify the
 * bundle's own SHA256SUMS and manifest → replace. POSIX: per-entry atomic renames with the old
 * bundle kept in `.previous/`. Windows: staged under `.update/` and applied by the launcher on
 * the next start (the running node.exe and its addons cannot be replaced). Every step is audited.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BundleInfo } from "./bundle.js";
import { auditSafe, type AuditInput } from "../audit/index.js";
import { REPO_URL } from "../config/product-urls.js";
import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SUMS_FILE,
  bundleArchiveName,
  parseSha256Sums,
  readBundleManifest,
  verifyBundleSums,
  type BundleManifest,
  type BundleProfile,
  type BundleTarget,
} from "../packaging/bundle-manifest.js";
import { compareSemverStrings } from "./update-check.js";

export type BundleUpdateChannel = "stable" | "nightly";

/** `owner/name` of the GitHub repository that publishes releases; derived from product-urls. */
export const DEFAULT_RELEASE_REPO = REPO_URL.replace(/^https?:\/\/github\.com\//, "").replace(
  /\.git$/,
  "",
);
export const DEFAULT_RELEASE_API_BASE = "https://api.github.com";
export const RELEASE_SUMS_ASSET = "SHA256SUMS.txt";
/** Entries of a bundle that an update replaces (everything but the user's `.update`/`.previous`). */
export const BUNDLE_ENTRIES = [
  "bin",
  "lib",
  "node",
  "LICENSE",
  "NOTICE",
  "LICENSING.md",
  "LICENSES",
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SUMS_FILE,
] as const;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export class ChecksumMismatchError extends Error {
  constructor(
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
    this.name = "ChecksumMismatchError";
  }
}

export function resolveBundleUpdateChannel(params: {
  flag?: string | null;
  env?: Record<string, string | undefined>;
  configChannel?: string | null;
}): BundleUpdateChannel {
  const normalize = (value?: string | null): BundleUpdateChannel | null => {
    const v = value?.trim().toLowerCase();
    if (!v) {
      return null;
    }
    if (v === "stable") {
      return "stable";
    }
    if (v === "nightly" || v === "beta" || v === "dev") {
      return "nightly";
    }
    return null;
  };
  const env = params.env ?? process.env;
  return (
    normalize(params.flag) ??
    normalize(env.KOLO_UPDATE_CHANNEL) ??
    normalize(params.configChannel) ??
    "stable"
  );
}

export function resolveReleaseRepo(env: Record<string, string | undefined> = process.env): string {
  return env.KOLO_RELEASE_REPO?.trim() || DEFAULT_RELEASE_REPO;
}

export type GitHubReleaseAsset = { name: string; browser_download_url: string; size?: number };
export type GitHubRelease = {
  tag_name: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  html_url?: string;
  assets: GitHubReleaseAsset[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function releaseHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "kolo-update",
  };
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

export function versionFromTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/** Latest release for a channel: stable = GitHub "latest" (never a prerelease); nightly = newest of all. */
export async function fetchLatestRelease(params: {
  channel: BundleUpdateChannel;
  repo?: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<GitHubRelease | null> {
  const env = params.env ?? process.env;
  const fetchImpl = params.fetchImpl ?? (fetch as FetchLike);
  const repo = params.repo ?? resolveReleaseRepo(env);
  const apiBase = (params.apiBase ?? env.KOLO_RELEASE_API_BASE ?? DEFAULT_RELEASE_API_BASE).replace(
    /\/$/,
    "",
  );
  const init: RequestInit = {
    headers: releaseHeaders(env),
    signal: AbortSignal.timeout(params.timeoutMs ?? 10_000),
  };
  if (params.channel === "stable") {
    const res = await fetchImpl(`${apiBase}/repos/${repo}/releases/latest`, init);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`release lookup failed: HTTP ${res.status}`);
    }
    return (await res.json()) as GitHubRelease;
  }
  const res = await fetchImpl(`${apiBase}/repos/${repo}/releases?per_page=30`, init);
  if (!res.ok) {
    throw new Error(`release lookup failed: HTTP ${res.status}`);
  }
  const list = (await res.json()) as GitHubRelease[];
  const candidates = list
    .filter((r) => !r.draft)
    .toSorted((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  return candidates[0] ?? null;
}

export function selectBundleAssets(
  release: GitHubRelease,
  target: BundleTarget,
  profile: BundleProfile = "standard",
): { version: string; archive: GitHubReleaseAsset; sums: GitHubReleaseAsset | null } {
  const version = versionFromTag(release.tag_name);
  // An enterprise install only ever updates to the enterprise asset (never to the standard one).
  const wanted = bundleArchiveName(version, target, profile);
  const archive = release.assets.find((a) => a.name === wanted);
  if (!archive) {
    throw new Error(
      `release ${release.tag_name} has no bundle for ${target.os}-${target.arch} (wanted ${wanted})`,
    );
  }
  const sums = release.assets.find((a) => a.name === RELEASE_SUMS_ASSET) ?? null;
  return { version, archive, sums };
}

export type DownloadResult = { sha256: string; bytes: number };

/** Download to `dest`, hashing on the way; a hash mismatch deletes the file and throws. */
export async function downloadWithSha256(params: {
  url: string;
  dest: string;
  expectedSha256?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string | undefined>;
}): Promise<DownloadResult> {
  const fetchImpl = params.fetchImpl ?? (fetch as FetchLike);
  const res = await fetchImpl(params.url, {
    headers: { "user-agent": "kolo-update", ...releaseHeaders(params.env ?? process.env) },
    signal: AbortSignal.timeout(params.timeoutMs ?? 600_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} (${params.url})`);
  }
  await fsp.mkdir(path.dirname(params.dest), { recursive: true });
  const tmp = `${params.dest}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  const maxBytes = params.maxBytes ?? MAX_ARCHIVE_BYTES;
  const out = fs.createWriteStream(tmp);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`download exceeds ${maxBytes} bytes`);
      }
      hash.update(value);
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(resolve);
    });
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  const sha256 = hash.digest("hex");
  const expected = params.expectedSha256?.toLowerCase() ?? null;
  if (expected && expected !== sha256) {
    await fsp.rm(tmp, { force: true });
    throw new ChecksumMismatchError(path.basename(params.dest), expected, sha256);
  }
  await fsp.rename(tmp, params.dest);
  return { sha256, bytes };
}

export async function extractBundleArchive(archive: string, destDir: string): Promise<void> {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  if (archive.endsWith(".zip")) {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await fsp.readFile(archive));
    const entries = Object.values(zip.files);
    for (const entry of entries) {
      const rel = entry.name.replace(/\\/g, "/");
      if (rel.includes("..") || path.isAbsolute(rel)) {
        throw new Error(`refusing zip entry outside the archive: ${rel}`);
      }
      const target = path.join(destDir, rel);
      if (entry.dir) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await entry.async("nodebuffer"));
    }
    return;
  }
  const tar = await import("tar");
  await tar.x({ file: archive, cwd: destDir, preservePaths: false });
}

/** The extracted archive holds exactly one top-level bundle dir. */
export function findExtractedBundleDir(extractDir: string): string {
  const dirs = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(extractDir, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, BUNDLE_MANIFEST_FILE)));
  if (dirs.length !== 1) {
    throw new Error(`expected one bundle directory in the archive, found ${dirs.length}`);
  }
  return dirs[0];
}

export function validateStagedBundle(params: {
  stagedDir: string;
  target: BundleTarget;
  expectedVersion: string;
  expectedProfile?: BundleProfile;
}): BundleManifest {
  const manifest = readBundleManifest(params.stagedDir);
  if (!manifest) {
    throw new Error("downloaded bundle has no readable manifest");
  }
  const profile = manifest.profile ?? "standard";
  if (profile !== (params.expectedProfile ?? "standard")) {
    throw new Error(
      `downloaded bundle is a ${profile} bundle, this install is ${params.expectedProfile ?? "standard"}`,
    );
  }
  if (manifest.os !== params.target.os || manifest.arch !== params.target.arch) {
    throw new Error(
      `downloaded bundle is for ${manifest.os}-${manifest.arch}, this install is ${params.target.os}-${params.target.arch}`,
    );
  }
  if (manifest.version !== params.expectedVersion) {
    throw new Error(
      `downloaded bundle reports version ${manifest.version}, release says ${params.expectedVersion}`,
    );
  }
  const sums = verifyBundleSums(params.stagedDir);
  if (!sums.ok) {
    const detail = [
      ...sums.mismatched.map((f) => `modified ${f}`),
      ...sums.missing.map((f) => `missing ${f}`),
    ]
      .slice(0, 5)
      .join(", ");
    throw new Error(`downloaded bundle fails its SHA256SUMS: ${detail}`);
  }
  return manifest;
}

/** Windows: the launcher runs this before starting node when `.update/pending.json` exists. */
export function renderWindowsApplyScript(): string {
  // %~dp0 is <root>\.update\ ; the launcher is bin\kolo.cmd and is never replaced while running.
  const lines = [
    "@echo off",
    "rem Kurahi staged update: swap the staged bundle in. Generated by `kurahi update`.",
    'set "ROOT=%~dp0.."',
    'set "STAGED=%ROOT%\\.update\\staged"',
    'if not exist "%STAGED%\\bundle-manifest.json" goto :done',
    'if exist "%ROOT%\\.previous" rd /s /q "%ROOT%\\.previous"',
    'mkdir "%ROOT%\\.previous"',
  ];
  for (const entry of BUNDLE_ENTRIES) {
    if (entry === "bin") {
      // The launcher stays; a new launcher lands as bin\kolo.cmd.new for the next manual swap.
      lines.push(
        `if exist "%STAGED%\\bin\\kolo.cmd" copy /y "%STAGED%\\bin\\kolo.cmd" "%ROOT%\\bin\\kolo.cmd.new" >nul`,
      );
      continue;
    }
    lines.push(
      `if exist "%ROOT%\\${entry}" move "%ROOT%\\${entry}" "%ROOT%\\.previous\\${entry}" >nul`,
    );
    lines.push(`if errorlevel 1 goto :locked`);
    lines.push(`if exist "%STAGED%\\${entry}" move "%STAGED%\\${entry}" "%ROOT%\\${entry}" >nul`);
    lines.push(`if errorlevel 1 goto :locked`);
  }
  lines.push(
    'rd /s /q "%STAGED%" >nul 2>&1',
    'del /q "%ROOT%\\.update\\pending.json" >nul 2>&1',
    "echo Kurahi update applied.",
    "goto :done",
    ":locked",
    "echo Kurahi update could not be applied: files are in use (is the gateway service running?).",
    "echo Stop it with: kurahi service stop  -- then run kolo again.",
    "exit /b 2",
    ":done",
    "exit /b 0",
    "",
  );
  return lines.join("\r\n");
}

export type ApplyResult =
  | { mode: "applied"; previousDir: string }
  | { mode: "staged"; stagedDir: string; pendingFile: string };

/** Replace the live bundle with `stagedDir` (POSIX) or stage it for the launcher (Windows). */
export async function applyBundle(params: {
  bundle: BundleInfo;
  stagedDir: string;
  version: string;
  platform?: NodeJS.Platform;
}): Promise<ApplyResult> {
  const platform = params.platform ?? process.platform;
  const root = params.bundle.root;
  const updateDir = path.join(root, ".update");
  if (platform === "win32") {
    const staged = path.join(updateDir, "staged");
    await fsp.rm(staged, { recursive: true, force: true });
    await fsp.mkdir(updateDir, { recursive: true });
    await fsp.rename(params.stagedDir, staged);
    const pendingFile = path.join(updateDir, "pending.json");
    await fsp.writeFile(path.join(updateDir, "apply.cmd"), renderWindowsApplyScript(), "utf8");
    await fsp.writeFile(
      pendingFile,
      `${JSON.stringify({ version: params.version, stagedAt: new Date().toISOString(), stagedDir: staged }, null, 2)}\n`,
      "utf8",
    );
    return { mode: "staged", stagedDir: staged, pendingFile };
  }
  const previousDir = path.join(root, ".previous");
  await fsp.rm(previousDir, { recursive: true, force: true });
  await fsp.mkdir(previousDir, { recursive: true });
  for (const entry of BUNDLE_ENTRIES) {
    const live = path.join(root, entry);
    const next = path.join(params.stagedDir, entry);
    if (fs.existsSync(live)) {
      await fsp.rename(live, path.join(previousDir, entry));
    }
    if (fs.existsSync(next)) {
      await fsp.rename(next, live);
    }
  }
  await fsp.rm(params.stagedDir, { recursive: true, force: true });
  return { mode: "applied", previousDir };
}

export type BundleUpdateCheck = {
  channel: BundleUpdateChannel;
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  tag: string | null;
  available: boolean;
  asset: string | null;
  url: string | null;
  releaseUrl: string | null;
};

export type BundleUpdateOutcome = BundleUpdateCheck & {
  performed: boolean;
  apply: ApplyResult | null;
  sha256: string | null;
};

export type BundleUpdateParams = {
  bundle: BundleInfo;
  manifest: BundleManifest;
  currentVersion: string;
  channel: BundleUpdateChannel;
  checkOnly?: boolean;
  repo?: string;
  apiBase?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  audit?: (input: AuditInput) => void;
  log?: (message: string) => void;
};

/** Check and (unless `checkOnly`) download, verify and apply the newest bundle for this install. */
export async function runBundleUpdate(params: BundleUpdateParams): Promise<BundleUpdateOutcome> {
  const env = params.env ?? process.env;
  const audit = params.audit ?? ((input: AuditInput) => void auditSafe(input));
  const log = params.log ?? (() => {});
  const target: BundleTarget = { os: params.manifest.os, arch: params.manifest.arch };
  const repo = params.repo ?? resolveReleaseRepo(env);
  const base: BundleUpdateCheck = {
    channel: params.channel,
    repo,
    currentVersion: params.currentVersion,
    latestVersion: null,
    tag: null,
    available: false,
    asset: null,
    url: null,
    releaseUrl: null,
  };

  const release = await fetchLatestRelease({
    channel: params.channel,
    repo,
    apiBase: params.apiBase,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    env,
  });
  if (!release) {
    audit({
      action: "update.check",
      outcome: "ok",
      source: "cli",
      detail: { ...base, release: null },
    });
    return { ...base, performed: false, apply: null, sha256: null };
  }
  const profile = params.manifest.profile ?? "standard";
  const { version, archive, sums } = selectBundleAssets(release, target, profile);
  const cmp = compareSemverStrings(params.currentVersion, version);
  const check: BundleUpdateCheck = {
    ...base,
    latestVersion: version,
    tag: release.tag_name,
    available: cmp != null ? cmp < 0 : params.currentVersion !== version,
    asset: archive.name,
    url: archive.browser_download_url,
    releaseUrl: release.html_url ?? null,
  };
  audit({ action: "update.check", outcome: "ok", source: "cli", detail: check });
  if (params.checkOnly || !check.available) {
    return { ...check, performed: false, apply: null, sha256: null };
  }

  const updateDir = path.join(params.bundle.root, ".update");
  const downloadDir = path.join(updateDir, "download");
  const extractDir = path.join(updateDir, "extract");
  await fsp.mkdir(downloadDir, { recursive: true });

  if (!sums) {
    audit({
      action: "update.refused",
      outcome: "denied",
      source: "cli",
      detail: { ...check, reason: "release has no SHA256SUMS.txt" },
    });
    throw new Error(
      `release ${release.tag_name} ships no ${RELEASE_SUMS_ASSET}; refusing to install an unverifiable bundle`,
    );
  }
  log(`Downloading ${RELEASE_SUMS_ASSET}`);
  const sumsFile = path.join(downloadDir, RELEASE_SUMS_ASSET);
  await downloadWithSha256({
    url: sums.browser_download_url,
    dest: sumsFile,
    fetchImpl: params.fetchImpl,
    env,
    timeoutMs: params.timeoutMs,
  });
  const expected = parseSha256Sums(await fsp.readFile(sumsFile, "utf8")).get(archive.name) ?? null;
  if (!expected) {
    audit({
      action: "update.refused",
      outcome: "denied",
      source: "cli",
      detail: { ...check, reason: `${RELEASE_SUMS_ASSET} has no entry for ${archive.name}` },
    });
    throw new Error(
      `${RELEASE_SUMS_ASSET} of ${release.tag_name} has no entry for ${archive.name}; refusing`,
    );
  }

  log(`Downloading ${archive.name}`);
  const archiveFile = path.join(downloadDir, archive.name);
  let download: DownloadResult;
  try {
    download = await downloadWithSha256({
      url: archive.browser_download_url,
      dest: archiveFile,
      expectedSha256: expected,
      fetchImpl: params.fetchImpl,
      env,
      timeoutMs: params.timeoutMs,
    });
  } catch (err) {
    if (err instanceof ChecksumMismatchError) {
      audit({
        action: "update.refused",
        outcome: "denied",
        source: "cli",
        detail: {
          ...check,
          reason: "checksum_mismatch",
          expected: err.expected,
          actual: err.actual,
        },
      });
    }
    throw err;
  }
  audit({
    action: "update.download",
    outcome: "ok",
    source: "cli",
    detail: { asset: archive.name, sha256: download.sha256, bytes: download.bytes },
  });

  log("Verifying bundle");
  await extractBundleArchive(archiveFile, extractDir);
  const stagedDir = findExtractedBundleDir(extractDir);
  try {
    validateStagedBundle({ stagedDir, target, expectedVersion: version, expectedProfile: profile });
  } catch (err) {
    audit({
      action: "update.refused",
      outcome: "denied",
      source: "cli",
      detail: { ...check, reason: String(err) },
    });
    await fsp.rm(extractDir, { recursive: true, force: true });
    throw err;
  }

  log(
    params.platform === "win32" || (!params.platform && process.platform === "win32")
      ? "Staging update"
      : "Applying update",
  );
  const apply = await applyBundle({
    bundle: params.bundle,
    stagedDir,
    version,
    platform: params.platform,
  });
  await fsp.rm(archiveFile, { force: true });
  await fsp.rm(extractDir, { recursive: true, force: true });
  audit({
    action: apply.mode === "applied" ? "update.apply" : "update.stage",
    outcome: "ok",
    source: "cli",
    detail: {
      from: params.currentVersion,
      to: version,
      asset: archive.name,
      sha256: download.sha256,
      mode: apply.mode,
    },
  });
  return { ...check, performed: true, apply, sha256: download.sha256 };
}
