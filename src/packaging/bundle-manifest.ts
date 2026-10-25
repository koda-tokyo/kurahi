/**
 * KoLo prebuilt bundle: manifest, asset naming and checksum helpers.
 *
 * Shared by `scripts/bundle.mjs` (through `dist/packaging/`), `kurahi update` and the tests.
 * A bundle is a directory:
 *
 *   kolo-<version>-<os>-<arch>/
 *     bin/kolo | bin/kolo.cmd        launcher (bundled runtime, no system Node)
 *     node/bin/node | node/node.exe  pinned Node runtime
 *     lib/                           package.json, kolo.mjs, dist/, node_modules/, extensions/, skills/
 *     LICENSE NOTICE LICENSING.md LICENSES/
 *     bundle-manifest.json
 *     SHA256SUMS                     one line per file inside the bundle
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUNDLE_MANIFEST_FILE = "bundle-manifest.json";
export const BUNDLE_SUMS_FILE = "SHA256SUMS";
export const BUNDLE_MANIFEST_SCHEMA = 1;

export type BundleOs = "linux" | "darwin" | "win32";
export type BundleArch = "x64" | "arm64";

export type BundleTarget = { os: BundleOs; arch: BundleArch };

export type BundleManifest = {
  schema: typeof BUNDLE_MANIFEST_SCHEMA;
  name: "kolo";
  version: string;
  os: BundleOs;
  arch: BundleArch;
  node: { version: string; sha256: string | null };
  commit: string | null;
  builtAt: string;
  launcher: string;
  entry: string;
  extensions: { included: string[]; omitted: Record<string, string> };
  pruned: string[];
  fileCount: number;
  /** Release profile the bundle was built with (absent in bundles before 2.2 = standard). */
  profile?: BundleProfile;
};

export type BundleProfile = "standard" | "enterprise";

export const SUPPORTED_TARGETS: readonly BundleTarget[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "win32", arch: "x64" },
];

export function parseBundleTarget(value: string): BundleTarget {
  const match = /^(linux|darwin|win32)-(x64|arm64)$/.exec(value.trim());
  if (!match) {
    throw new Error(`unsupported bundle target "${value}" (expected <os>-<arch>)`);
  }
  return { os: match[1] as BundleOs, arch: match[2] as BundleArch };
}

export function hostBundleTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BundleTarget {
  return parseBundleTarget(`${platform}-${arch}`);
}

export function formatBundleTarget(target: BundleTarget): string {
  return `${target.os}-${target.arch}`;
}

export function bundleDirName(version: string, target: BundleTarget): string {
  return `kolo-${version}-${formatBundleTarget(target)}`;
}

export function archiveExtension(os: BundleOs): ".tar.gz" | ".zip" {
  return os === "win32" ? ".zip" : ".tar.gz";
}

/**
 * Release asset name. The enterprise bundle carries a `-enterprise` suffix after the target, so
 * globs written for the standard asset (`kolo-*-linux-x64.tar.gz`) never pick it up by accident.
 */
export function bundleArchiveName(
  version: string,
  target: BundleTarget,
  profile: BundleProfile = "standard",
): string {
  const suffix = profile === "enterprise" ? "-enterprise" : "";
  return `${bundleDirName(version, target)}${suffix}${archiveExtension(target.os)}`;
}

/** Launcher path inside a bundle, relative to the bundle root. */
export function bundleLauncherRelPath(os: BundleOs): string {
  return os === "win32" ? path.posix.join("bin", "kolo.cmd") : path.posix.join("bin", "kolo");
}

/** Node binary path inside a bundle, relative to the bundle root. */
export function bundleNodeRelPath(os: BundleOs): string {
  return os === "win32"
    ? path.posix.join("node", "node.exe")
    : path.posix.join("node", "bin", "node");
}

/** Map a bundle target onto the nodejs.org distribution file name. */
export function nodeDistFileName(nodeVersion: string, target: BundleTarget): string {
  const v = nodeVersion.startsWith("v") ? nodeVersion : `v${nodeVersion}`;
  if (target.os === "win32") {
    return `node-${v}-win-${target.arch}.zip`;
  }
  return `node-${v}-${target.os}-${target.arch}.tar.gz`;
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** Parse `SHA256SUMS` text (`<hex>  <path>` lines) into a map keyed by path. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    out.set(match[2].trim(), match[1].toLowerCase());
  }
  return out;
}

export function formatSha256Sums(entries: Iterable<[string, string]>): string {
  const lines = Array.from(entries)
    .map(([file, hex]) => `${hex}  ${file}`)
    .toSorted();
  return `${lines.join("\n")}\n`;
}

/** List every file under `root` as POSIX relative paths (sorted, no symlinks followed). */
export function listBundleFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return out.toSorted();
}

/** Hash every file in the bundle (except SHA256SUMS itself) and write SHA256SUMS. */
export function writeBundleSums(root: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rel of listBundleFiles(root)) {
    if (rel === BUNDLE_SUMS_FILE) {
      continue;
    }
    sums.set(rel, sha256File(path.join(root, rel)));
  }
  fs.writeFileSync(path.join(root, BUNDLE_SUMS_FILE), formatSha256Sums(sums), "utf8");
  return sums;
}

export type BundleVerifyResult = {
  ok: boolean;
  checked: number;
  missing: string[];
  mismatched: string[];
  extra: string[];
};

/** Verify a bundle directory against its SHA256SUMS. */
export function verifyBundleSums(root: string): BundleVerifyResult {
  const sumsPath = path.join(root, BUNDLE_SUMS_FILE);
  const expected = parseSha256Sums(fs.readFileSync(sumsPath, "utf8"));
  const present = new Set(listBundleFiles(root).filter((rel) => rel !== BUNDLE_SUMS_FILE));
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [rel, hex] of expected) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      missing.push(rel);
      continue;
    }
    if (sha256File(file) !== hex) {
      mismatched.push(rel);
    }
    present.delete(rel);
  }
  const extra = Array.from(present).toSorted();
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    checked: expected.size,
    missing,
    mismatched,
    extra,
  };
}

export function readBundleManifest(root: string): BundleManifest | null {
  try {
    const raw = fs.readFileSync(path.join(root, BUNDLE_MANIFEST_FILE), "utf8");
    return parseBundleManifest(raw);
  } catch {
    return null;
  }
}

export function parseBundleManifest(raw: string): BundleManifest {
  const parsed = JSON.parse(raw) as Partial<BundleManifest>;
  if (parsed.schema !== BUNDLE_MANIFEST_SCHEMA) {
    throw new Error(`bundle manifest schema ${String(parsed.schema)} unsupported`);
  }
  if (parsed.name !== "kolo") {
    throw new Error(`bundle manifest name "${String(parsed.name)}" is not kolo`);
  }
  if (typeof parsed.version !== "string" || !parsed.version) {
    throw new Error("bundle manifest has no version");
  }
  parseBundleTarget(`${String(parsed.os)}-${String(parsed.arch)}`);
  if (!parsed.node || typeof parsed.node.version !== "string") {
    throw new Error("bundle manifest has no node.version");
  }
  return parsed as BundleManifest;
}

export function createBundleManifest(params: {
  version: string;
  target: BundleTarget;
  nodeVersion: string;
  nodeSha256: string | null;
  commit: string | null;
  builtAt?: string;
  extensions: { included: string[]; omitted: Record<string, string> };
  pruned: string[];
  fileCount: number;
  profile?: BundleProfile;
}): BundleManifest {
  return {
    schema: BUNDLE_MANIFEST_SCHEMA,
    name: "kolo",
    version: params.version,
    os: params.target.os,
    arch: params.target.arch,
    node: { version: params.nodeVersion, sha256: params.nodeSha256 },
    commit: params.commit,
    builtAt: params.builtAt ?? new Date().toISOString(),
    launcher: bundleLauncherRelPath(params.target.os),
    entry: "lib/kolo.mjs",
    extensions: params.extensions,
    pruned: params.pruned,
    fileCount: params.fileCount,
    profile: params.profile ?? "standard",
  };
}
