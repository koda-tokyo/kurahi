#!/usr/bin/env node
// Prebuilt bundle builder (KoLo 2.0, M8). See docs/PACKAGING.md for the layout and the
// reasoning (pinned Node runtime + built dist + production node_modules; not a single-file SEA).
//
//   pnpm build && node scripts/bundle.mjs [--target <os>-<arch>] [--out release] [--version X]
//        [--node-version 22.18.0] [--node-from <node binary>] [--no-archive] [--verify] [--keep]
//        [--profile standard|enterprise]
//
// --profile enterprise (Kurahi 2.2, docs/security/enterprise-profile.md) ships only the
// extensions that src/packaging/profiles/enterprise.json classifies as enterprise, installs only
// their production dependencies, writes `profile: "enterprise"` into bundle-manifest.json, makes
// the launcher export KURAHI_PROFILE=enterprise, names the archive
// kolo-<version>-<os>-<arch>-enterprise.*, and runs scripts/enterprise-check.mjs on the staged
// tree before archiving (a finding fails the build). Optional plugins are packed separately with
// `node scripts/pack-plugin.mjs --tier optional`.
//
// The target must be the host (native addons: sharp, node-pty, sqlite-vec, canvas). CI builds
// each OS on its own runner. Output: release/kolo-<version>-<os>-<arch>.{tar.gz|zip} + .sha256.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkPackageDir, isTestOnlySource, loadProfile } from "./enterprise-check.mjs";
import { writeSrcShims } from "./src-shims.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_NODE_VERSION = "22.18.0";
const NODE_DIST_BASE =
  process.env.KOLO_NODE_DIST_MIRROR?.replace(/\/$/, "") || "https://nodejs.org/dist";
// Dropped from every bundle (size, optional features). Listed in bundle-manifest.json "pruned".
// @whiskeysockets/baileys and libsignal belong to the optional WhatsApp plugin only (libsignal is
// GPL-3.0); the workspace lockfile still installs them for that plugin's manifest.
const PRUNE_PACKAGES = [
  "node-llama-cpp",
  "@node-llama-cpp",
  "@lancedb",
  "@whiskeysockets/baileys",
  "libsignal",
];
// Bundled extensions left out of the evaluation bundle, with the reason shown in the manifest.
const OMIT_EXTENSIONS = {
  "memory-lancedb":
    "needs the @lancedb native runtime (~250 MB), not shipped in the evaluation bundle",
  whatsapp:
    "optional plugin, installed separately (kurahi plugins install kurahi-whatsapp-<version>.tgz): its libsignal dependency is GPL-3.0",
};
/** Extensions left out of a bundle of this profile, with the reason recorded in its manifest. */
function omittedExtensions(profile) {
  if (profile !== "enterprise") {
    return OMIT_EXTENSIONS;
  }
  const manifest = loadProfile(ROOT);
  const omitted = {};
  for (const name of listDirs("extensions")) {
    const entry = manifest.extensions[name];
    if (!entry) {
      throw new Error(
        `extensions/${name} is not classified in src/packaging/profiles/enterprise.json`,
      );
    }
    if (entry.tier !== "enterprise") {
      omitted[name] = `${entry.tier}: ${entry.reason}`;
    }
  }
  return omitted;
}

// Workspace packages shipped as sources under lib/packages/ (see the npm `files` list).
const WORKSPACE_SOURCE_PACKAGES = ["legacy-analyzer"];
const LIB_FILES = ["kolo.mjs", "CHANGELOG.md", "README.md"];
const LIB_DIRS = ["dist", "skills", "assets", "docs"];
const LICENSE_FILES = ["LICENSE", "NOTICE", "LICENSING.md"];
// Never shipped, mirroring the npm "files" exclusions in package.json: internal documents and
// test helpers. Paths are relative to the repository root.
const LIB_SKIP_DIRS = new Set(["docs/internal", "dist/test-helpers", "dist/test-utils"]);
const LIB_SKIP_FILE = /\.test\.(?:js|d\.ts|js\.map)$/;

function skipLibEntry(rel, entry) {
  const posix = rel.split(path.sep).join("/");
  if (entry.name === "node_modules" || entry.name === ".DS_Store") {
    return true;
  }
  if (entry.isDirectory()) {
    return LIB_SKIP_DIRS.has(posix);
  }
  return LIB_SKIP_FILE.test(entry.name);
}

function parseArgs(argv) {
  const opts = {
    target: null,
    out: path.join(ROOT, "release"),
    version: process.env.KOLO_BUNDLE_VERSION?.trim() || null,
    nodeVersion: process.env.KOLO_BUNDLE_NODE_VERSION?.trim() || DEFAULT_NODE_VERSION,
    nodeFrom: null,
    archive: true,
    verify: false,
    keep: false,
    profile: "standard",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--target") {
      opts.target = next();
    } else if (a === "--out") {
      opts.out = path.resolve(next());
    } else if (a === "--version") {
      opts.version = next();
    } else if (a === "--node-version") {
      opts.nodeVersion = next();
    } else if (a === "--node-from") {
      opts.nodeFrom = path.resolve(next());
    } else if (a === "--no-archive") {
      opts.archive = false;
    } else if (a === "--verify") {
      opts.verify = true;
    } else if (a === "--keep") {
      opts.keep = true;
    } else if (a === "--profile") {
      opts.profile = next();
      if (opts.profile !== "standard" && opts.profile !== "enterprise") {
        throw new Error(`--profile must be standard or enterprise, got ${opts.profile}`);
      }
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return opts;
}

const log = (msg) => console.log(`bundle: ${msg}`);

async function loadManifestModule() {
  const file = path.join(ROOT, "dist", "packaging", "bundle-manifest.js");
  if (!fs.existsSync(file)) {
    throw new Error("dist/packaging/bundle-manifest.js missing: run `pnpm build` first");
  }
  return import(pathToFileURL(file).href);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, dest) {
  if (fs.existsSync(dest)) {
    return;
  }
  log(`downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
}

/** Fetch the pinned Node runtime, verify it against SHASUMS256.txt, place it in the stage. */
async function stageNodeRuntime({ stage, target, nodeVersion, nodeFrom, m }) {
  const nodeDir = path.join(stage, "node");
  fs.mkdirSync(nodeDir, { recursive: true });
  const nodeRel = m.bundleNodeRelPath(target.os);
  const nodeDest = path.join(stage, ...nodeRel.split("/"));
  fs.mkdirSync(path.dirname(nodeDest), { recursive: true });
  if (nodeFrom) {
    log(`using local node binary ${nodeFrom} (no checksum against nodejs.org)`);
    fs.copyFileSync(nodeFrom, nodeDest);
    if (target.os !== "win32") {
      fs.chmodSync(nodeDest, 0o755);
    }
    const version = execFileSync(nodeDest, ["--version"], { encoding: "utf8" })
      .trim()
      .replace(/^v/, "");
    return { version, sha256: null };
  }
  const cache = path.join(ROOT, "release", ".cache", "node", `v${nodeVersion}`);
  const distName = m.nodeDistFileName(nodeVersion, target);
  const sumsFile = path.join(cache, "SHASUMS256.txt");
  const distFile = path.join(cache, distName);
  await download(`${NODE_DIST_BASE}/v${nodeVersion}/SHASUMS256.txt`, sumsFile);
  await download(`${NODE_DIST_BASE}/v${nodeVersion}/${distName}`, distFile);
  const expected = m.parseSha256Sums(fs.readFileSync(sumsFile, "utf8")).get(distName);
  if (!expected) {
    throw new Error(`SHASUMS256.txt has no entry for ${distName}`);
  }
  const actual = sha256(distFile);
  if (actual !== expected) {
    fs.rmSync(distFile, { force: true });
    throw new Error(
      `node runtime checksum mismatch for ${distName}: expected ${expected}, got ${actual}`,
    );
  }
  log(`node ${nodeVersion} verified (${actual.slice(0, 12)}…)`);
  const extractDir = path.join(cache, "extract");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const prefix = distName.replace(/\.(tar\.gz|zip)$/, "");
  if (target.os === "win32") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(distFile));
    for (const name of [`${prefix}/node.exe`, `${prefix}/LICENSE`]) {
      const entry = zip.file(name);
      if (!entry) {
        throw new Error(`${distName} has no ${name}`);
      }
      const out = path.join(extractDir, path.basename(name));
      fs.writeFileSync(out, await entry.async("nodebuffer"));
    }
    fs.copyFileSync(path.join(extractDir, "node.exe"), nodeDest);
  } else {
    const tar = await import("tar");
    await tar.x({
      file: distFile,
      cwd: extractDir,
      filter: (p) => p === `${prefix}/bin/node` || p === `${prefix}/LICENSE`,
    });
    fs.copyFileSync(path.join(extractDir, prefix, "bin", "node"), nodeDest);
    fs.chmodSync(nodeDest, 0o755);
  }
  const license =
    target.os === "win32"
      ? path.join(extractDir, "LICENSE")
      : path.join(extractDir, prefix, "LICENSE");
  if (fs.existsSync(license)) {
    fs.copyFileSync(license, path.join(nodeDir, "LICENSE"));
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
  return { version: nodeVersion, sha256: actual };
}

/** Copy a tree; symlinks are skipped (reported) unless `followInto` resolves them. */
function copyTree(src, dest, { skip = () => false, skippedLinks = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    const rel = path.relative(ROOT, from);
    if (skip(rel, entry)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      skippedLinks.push(rel);
      continue;
    }
    if (entry.isDirectory()) {
      copyTree(from, to, { skip, skippedLinks });
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Production node_modules for the workspace (root + the given extensions), flat (hoisted). An
 * extension left out of `extensions` contributes no dependencies: pnpm installs a subset of the
 * workspace from the same frozen lockfile.
 */
function installProductionDeps(depsDir, extensions) {
  fs.rmSync(depsDir, { recursive: true, force: true });
  fs.mkdirSync(depsDir, { recursive: true });
  for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]) {
    if (fs.existsSync(path.join(ROOT, f))) {
      fs.copyFileSync(path.join(ROOT, f), path.join(depsDir, f));
    }
  }
  if (fs.existsSync(path.join(ROOT, "patches"))) {
    copyTree(path.join(ROOT, "patches"), path.join(depsDir, "patches"));
  }
  const workspaceDirs = [
    "ui",
    ...listDirs("packages").map((d) => `packages/${d}`),
    ...extensions.map((d) => `extensions/${d}`),
  ];
  for (const dir of workspaceDirs) {
    const pkg = path.join(ROOT, dir, "package.json");
    if (!fs.existsSync(pkg)) {
      continue;
    }
    fs.mkdirSync(path.join(depsDir, dir), { recursive: true });
    fs.copyFileSync(pkg, path.join(depsDir, dir, "package.json"));
  }
  log("installing production dependencies (pnpm, hoisted, frozen lockfile)");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const res = spawnSync(
    pnpm,
    ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"],
    {
      cwd: depsDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  if (res.status !== 0) {
    throw new Error(`pnpm install failed:\n${(res.stderr || res.stdout || "").slice(-4000)}`);
  }
}

function listDirs(rel) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function readPkg(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function runtimeDepNames(pkg) {
  return Object.keys({
    ...pkg?.dependencies,
    ...pkg?.optionalDependencies,
    ...pkg?.peerDependencies,
  });
}

/** Node resolution inside the deps tree: the nearest node_modules/<name> from `fromDir` up. */
function resolveInstalled(depsDir, fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      // Workspace links (the runtime itself, packages/client) resolve outside node_modules: they
      // are roots in their own right, never walked or removed here.
      const real = fs.realpathSync(candidate);
      const store = `${fs.realpathSync(path.join(depsDir, "node_modules"))}${path.sep}`;
      return real.startsWith(store) ? real : null;
    }
    if (path.resolve(dir) === path.resolve(depsDir)) {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Installed package directories reachable from `roots` ([fromDir, depName] pairs). */
function reachableDeps(depsDir, roots) {
  const seen = new Set();
  const stack = roots.map(([from, name]) => resolveInstalled(depsDir, from, name)).filter(Boolean);
  while (stack.length > 0) {
    const dir = stack.pop();
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    for (const name of runtimeDepNames(readPkg(path.join(dir, "package.json")))) {
      const next = resolveInstalled(depsDir, dir, name);
      if (next && !seen.has(next)) {
        stack.push(next);
      }
    }
  }
  return seen;
}

/**
 * Enterprise profile: pnpm installs the whole lockfile even for a subset of the workspace, so
 * remove what only the omitted extensions need: packages reachable from their dependencies and
 * not reachable from the root package, ui/, packages/* or a shipped extension. A package that is
 * reachable from both stays. Returns the removed package directories (relative).
 */
function pruneExclusiveDeps({ depsDir, kept, dropped }) {
  const rootsOf = (rel) => {
    const pkg =
      readPkg(path.join(depsDir, rel, "package.json")) ??
      readPkg(path.join(ROOT, rel, "package.json"));
    const from = fs.existsSync(path.join(depsDir, rel)) ? path.join(depsDir, rel) : depsDir;
    return runtimeDepNames(pkg).map((name) => [from, name]);
  };
  const keptRoots = [
    ...rootsOf("."),
    ...rootsOf("ui"),
    ...listDirs("packages").flatMap((d) => rootsOf(`packages/${d}`)),
    ...kept.flatMap((d) => rootsOf(`extensions/${d}`)),
  ];
  const droppedRoots = dropped.flatMap((d) =>
    runtimeDepNames(readPkg(path.join(ROOT, "extensions", d, "package.json"))).map((name) => [
      depsDir,
      name,
    ]),
  );
  const keep = reachableDeps(depsDir, keptRoots);
  const removed = [];
  for (const dir of reachableDeps(depsDir, droppedRoots)) {
    if (!keep.has(dir) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(path.relative(depsDir, dir));
    }
  }
  return removed.toSorted((a, b) => a.localeCompare(b));
}

/** Remove platform packages for other targets and the explicit prune list. */
function pruneNodeModules(nodeModules, target) {
  const pruned = new Set();
  // npm `os`/`cpu`/`libc` fields: a list of allowed values, or negations like "!win32".
  const allowed = (list, value) => {
    if (!Array.isArray(list) || list.length === 0) {
      return true;
    }
    const negated = list
      .filter((x) => typeof x === "string" && x.startsWith("!"))
      .map((x) => x.slice(1));
    const positive = list.filter((x) => typeof x === "string" && !x.startsWith("!"));
    if (negated.includes(value)) {
      return false;
    }
    return positive.length === 0 || positive.includes(value);
  };
  const matchesTarget = (pkg) =>
    allowed(pkg.os, target.os) &&
    allowed(pkg.cpu, target.arch) &&
    (target.os !== "linux" || allowed(pkg.libc, "glibc"));
  const visit = (dir, name) => {
    const pkgFile = path.join(dir, "package.json");
    if (!fs.existsSync(pkgFile)) {
      return;
    }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    } catch {
      return;
    }
    if (!matchesTarget(pkg)) {
      fs.rmSync(dir, { recursive: true, force: true });
      pruned.add(name);
    }
  };
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const full = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        if (sub.isDirectory()) {
          visit(path.join(full, sub.name), `${entry.name}/${sub.name}`);
        }
      }
      if (fs.readdirSync(full).length === 0) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } else {
      visit(full, entry.name);
    }
  }
  for (const name of PRUNE_PACKAGES) {
    const dir = path.join(nodeModules, ...name.split("/"));
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      pruned.add(name);
    }
  }
  return Array.from(pruned).toSorted((a, b) => a.localeCompare(b));
}

function writeLaunchers(stage, target, profile) {
  const bin = path.join(stage, "bin");
  fs.mkdirSync(bin, { recursive: true });
  if (target.os === "win32") {
    const cmd = [
      "@echo off",
      "rem Kurahi launcher: bundled runtime, no system Node required.",
      "setlocal",
      'set "KOLO_BUNDLE_ROOT=%~dp0.."',
      ...(profile === "enterprise" ? ['set "KURAHI_PROFILE=enterprise"'] : []),
      'if exist "%~dp0..\\.update\\pending.json" call "%~dp0..\\.update\\apply.cmd"',
      '"%~dp0..\\node\\node.exe" "%~dp0..\\lib\\kolo.mjs" %*',
      "endlocal & exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    // `kurahi` is the command; `kolo` stays as an alias for existing scripts and kits.
    fs.writeFileSync(path.join(bin, "kurahi.cmd"), cmd);
    fs.writeFileSync(path.join(bin, "kolo.cmd"), cmd);
    return;
  }
  // Shell builtins only (no dirname/readlink): must work with an empty PATH. Symlinked
  // launchers are resolved when readlink exists, which it does on every real PATH.
  const sh = [
    "#!/bin/sh",
    "# Kurahi launcher: bundled runtime, no system Node required.",
    'self="$0"',
    "if command -v readlink >/dev/null 2>&1; then",
    '  while [ -L "$self" ]; do',
    '    case "$self" in */*) dir="${self%/*}" ;; *) dir="." ;; esac',
    '    link=$(readlink "$self")',
    '    case "$link" in /*) self="$link" ;; *) self="$dir/$link" ;; esac',
    "  done",
    "fi",
    'case "$self" in */*) bindir="${self%/*}" ;; *) bindir="." ;; esac',
    'root=$(cd "$bindir/.." && pwd)',
    'KOLO_BUNDLE_ROOT="$root"',
    "export KOLO_BUNDLE_ROOT",
    ...(profile === "enterprise" ? ["KURAHI_PROFILE=enterprise", "export KURAHI_PROFILE"] : []),
    'exec "$root/node/bin/node" "$root/lib/kolo.mjs" "$@"',
    "",
  ].join("\n");
  for (const name of ["kurahi", "kolo"]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, sh);
    fs.chmodSync(file, 0o755);
  }
}

async function createArchive(stage, archivePath, target) {
  fs.rmSync(archivePath, { force: true });
  const cwd = path.dirname(stage);
  const dirName = path.basename(stage);
  const epoch = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
    : new Date();
  if (target.os === "win32") {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(cwd, full).split(path.sep).join("/");
          zip.file(rel, fs.readFileSync(full), { date: epoch, compression: "DEFLATE" });
        }
      }
    };
    walk(stage);
    await new Promise((resolve, reject) => {
      zip
        .generateNodeStream({
          type: "nodebuffer",
          streamFiles: true,
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        })
        .pipe(fs.createWriteStream(archivePath))
        .on("finish", resolve)
        .on("error", reject);
    });
    return;
  }
  const tar = await import("tar");
  // tar.c/tar.x return a promise when `file` is given; Promise.resolve keeps the typed overload honest.
  await Promise.resolve(
    tar.c({ gzip: true, file: archivePath, cwd, portable: true, mtime: epoch }, [dirName]),
  );
}

/** Unpack the archive somewhere clean and run the launcher with no Node on PATH. */
async function verifyArchive({ archivePath, outDir, target, version, m }) {
  const verifyDir = path.join(outDir, "verify");
  fs.rmSync(verifyDir, { recursive: true, force: true });
  fs.mkdirSync(verifyDir, { recursive: true });
  if (target.os === "win32") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
    for (const entry of Object.values(zip.files)) {
      const dest = path.join(verifyDir, entry.name);
      if (entry.dir) {
        fs.mkdirSync(dest, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await entry.async("nodebuffer"));
      }
    }
  } else {
    const tar = await import("tar");
    await Promise.resolve(tar.x({ file: archivePath, cwd: verifyDir }));
  }
  const root = path.join(verifyDir, m.bundleDirName(version, target));
  const sums = m.verifyBundleSums(root);
  if (!sums.ok) {
    throw new Error(
      `verify: SHA256SUMS mismatch: ${JSON.stringify({ missing: sums.missing, mismatched: sums.mismatched })}`,
    );
  }
  const launcher = path.join(root, ...m.bundleLauncherRelPath(target.os).split("/"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-bundle-verify-"));
  const env =
    target.os === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          PATH: `${process.env.SystemRoot}\\system32`,
          USERPROFILE: home,
          KOLO_HOME: home,
          TEMP: home,
          TMP: home,
        }
      : { PATH: "/nonexistent", HOME: home, KOLO_HOME: home };
  const res =
    target.os === "win32"
      ? spawnSync("cmd.exe", ["/d", "/c", launcher, "--version"], { env, encoding: "utf8" })
      : spawnSync(launcher, ["--version"], { env, encoding: "utf8" });
  fs.rmSync(home, { recursive: true, force: true });
  const out = (res.stdout || "").trim();
  if (res.status !== 0 || out !== version) {
    throw new Error(
      `verify: launcher --version failed (status ${res.status}): stdout=${JSON.stringify(out)} stderr=${JSON.stringify((res.stderr || "").slice(-800))}`,
    );
  }
  log(
    `verify: ${m.bundleLauncherRelPath(target.os)} --version -> ${out} with PATH=${env.PATH} (checked ${sums.checked} files)`,
  );
  return verifyDir;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const m = await loadManifestModule();
  const host = m.hostBundleTarget();
  const target = opts.target ? m.parseBundleTarget(opts.target) : host;
  if (target.os !== host.os || target.arch !== host.arch) {
    throw new Error(
      `target ${m.formatBundleTarget(target)} differs from host ${m.formatBundleTarget(host)}: native addons make cross-building unsupported; build on a ${m.formatBundleTarget(target)} runner`,
    );
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = opts.version || pkg.version;
  if (
    !fs.existsSync(path.join(ROOT, "dist", "entry.js")) ||
    !fs.existsSync(path.join(ROOT, "dist", ".manifest.json"))
  ) {
    throw new Error("dist/ is not a complete build: run `pnpm build` first");
  }
  const dirName = m.bundleDirName(version, target);
  const outDir = opts.out;
  const stage = path.join(outDir, "stage", dirName);
  const depsDir = path.join(outDir, "deps");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  log(`building ${dirName}`);

  const node = await stageNodeRuntime({
    stage,
    target,
    nodeVersion: opts.nodeVersion,
    nodeFrom: opts.nodeFrom,
    m,
  });

  // lib/: package.json (version truth), entry, dist, bundled content.
  const lib = path.join(stage, "lib");
  fs.mkdirSync(lib, { recursive: true });
  const libPkg = { ...pkg, version };
  delete libPkg.devDependencies;
  delete libPkg.scripts;
  fs.writeFileSync(path.join(lib, "package.json"), `${JSON.stringify(libPkg, null, 2)}\n`);
  for (const f of LIB_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) {
      fs.copyFileSync(path.join(ROOT, f), path.join(lib, f));
    }
  }
  const skippedLinks = [];
  for (const d of LIB_DIRS) {
    if (fs.existsSync(path.join(ROOT, d))) {
      copyTree(path.join(ROOT, d), path.join(lib, d), { skippedLinks, skip: skipLibEntry });
    }
  }
  // Bundled extensions (sources, loaded through jiti at runtime).
  const omitted = omittedExtensions(opts.profile);
  const included = [];
  for (const name of listDirs("extensions")) {
    if (!fs.existsSync(path.join(ROOT, "extensions", name, "package.json"))) {
      continue;
    }
    if (omitted[name]) {
      continue;
    }
    copyTree(path.join(ROOT, "extensions", name), path.join(lib, "extensions", name), {
      skippedLinks,
      skip: (rel, e) =>
        e.name === "node_modules" ||
        e.name === "__tests__" ||
        (e.isFile() && isTestOnlySource(e.name)),
    });
    included.push(name);
  }
  // Workspace packages the extensions import by source path (legacy-analyzer imports
  // packages/legacy-analyzer/src), mirroring the npm `files` list: sources without tests/fixtures.
  for (const name of WORKSPACE_SOURCE_PACKAGES) {
    const from = path.join(ROOT, "packages", name);
    const to = path.join(lib, "packages", name);
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(path.join(from, "package.json"), path.join(to, "package.json"));
    copyTree(path.join(from, "src"), path.join(to, "src"), {
      skippedLinks,
      skip: (rel, e) =>
        e.name === "node_modules" ||
        e.name === "test-fixtures" ||
        (e.isFile() && isTestOnlySource(e.name)),
    });
  }
  const shims = writeSrcShims(lib, included);
  log(`wrote ${shims.written} src shim(s) for core modules the extensions import`);
  if (shims.missing.length > 0) {
    throw new Error(
      `extension imports with no built module:\n  ${shims.missing
        .slice(0, 20)
        .map((m) => `${m.file}: ${m.spec}`)
        .join("\n  ")}`,
    );
  }

  // The standard bundle resolves every extension's dependencies (and prunes a few); the enterprise
  // bundle only the shipped ones, so nothing an excluded extension needs is installed at all.
  installProductionDeps(
    depsDir,
    opts.profile === "enterprise"
      ? included
      : listDirs("extensions").filter((d) =>
          fs.existsSync(path.join(ROOT, "extensions", d, "package.json")),
        ),
  );
  const srcNm = path.join(depsDir, "node_modules");
  if (opts.profile === "enterprise") {
    const exclusive = pruneExclusiveDeps({
      depsDir,
      kept: included,
      dropped: Object.keys(omitted),
    });
    log(`enterprise: removed ${exclusive.length} package(s) only omitted extensions need`);
  }
  const dstNm = path.join(lib, "node_modules");
  copyTree(srcNm, dstNm, {
    skippedLinks,
    skip: (rel, e) =>
      e.name === ".bin" ||
      e.name === ".pnpm" ||
      e.name === ".modules.yaml" ||
      e.name.startsWith(".pnpm-workspace-state"),
  });
  // Workspace package @kodasoken/kurahi-client is a symlink in the deps tree: ship the built package.
  const clientDst = path.join(dstNm, "@kodasoken", "kurahi-client");
  fs.rmSync(clientDst, { recursive: true, force: true });
  fs.mkdirSync(clientDst, { recursive: true });
  for (const f of ["package.json", "LICENSE", "README.md"]) {
    const src = path.join(ROOT, "packages", "client", f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(clientDst, f));
    }
  }
  if (!fs.existsSync(path.join(ROOT, "packages", "client", "dist", "index.js"))) {
    throw new Error("packages/client/dist missing: run `pnpm client:build`");
  }
  copyTree(path.join(ROOT, "packages", "client", "dist"), path.join(clientDst, "dist"));
  // Extension-local deps that pnpm could not hoist.
  for (const name of included) {
    const extNm = path.join(depsDir, "extensions", name, "node_modules");
    if (fs.existsSync(extNm)) {
      copyTree(extNm, path.join(lib, "extensions", name, "node_modules"), {
        skippedLinks,
        skip: (rel, e) => e.name === ".bin" || e.name === "kolo" || e.name === "kurahi",
      });
    }
  }
  const pruned = pruneNodeModules(dstNm, target);
  log(`pruned ${pruned.length} package(s): ${pruned.join(", ")}`);
  if (skippedLinks.length) {
    log(
      `skipped ${skippedLinks.length} symlink(s) (workspace self-links): ${skippedLinks.slice(0, 5).join(", ")}${skippedLinks.length > 5 ? "…" : ""}`,
    );
  }

  writeLaunchers(stage, target, opts.profile);
  for (const f of LICENSE_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) {
      fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
    }
  }
  if (fs.existsSync(path.join(ROOT, "LICENSES"))) {
    copyTree(path.join(ROOT, "LICENSES"), path.join(stage, "LICENSES"));
  }

  let commit = process.env.GITHUB_SHA || null;
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      commit = null;
    }
  }
  const fileCount = m.listBundleFiles(stage).length + 2;
  const manifest = m.createBundleManifest({
    version,
    target,
    nodeVersion: node.version,
    nodeSha256: node.sha256,
    commit,
    extensions: { included, omitted },
    pruned,
    fileCount,
    profile: opts.profile,
  });
  fs.writeFileSync(
    path.join(stage, m.BUNDLE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const sums = m.writeBundleSums(stage);
  log(`staged ${sums.size} files in ${stage}`);

  if (opts.profile === "enterprise") {
    const check = checkPackageDir(stage, { repoRoot: ROOT });
    for (const w of check.warnings.slice(0, 20)) {
      log(`enterprise-check warn: ${w}`);
    }
    if (check.findings.length > 0) {
      throw new Error(
        `enterprise-check: ${check.findings.length} finding(s) in the staged bundle:\n  ${check.findings.slice(0, 40).join("\n  ")}`,
      );
    }
    log(
      `enterprise-check: clean (${check.extensions.length} extensions, ${check.packages} packages ${JSON.stringify(check.licences)})`,
    );
  }

  if (!opts.archive) {
    return;
  }
  const archiveName = m.bundleArchiveName(version, target, opts.profile);
  const archivePath = path.join(outDir, archiveName);
  log(`archiving ${archiveName}`);
  await createArchive(stage, archivePath, target);
  const digest = sha256(archivePath);
  fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`);
  const size = fs.statSync(archivePath).size;
  log(`${archiveName}: ${(size / 1024 / 1024).toFixed(1)} MB sha256=${digest}`);

  if (opts.verify) {
    const verifyDir = await verifyArchive({ archivePath, outDir, target, version, m });
    if (!opts.keep) {
      fs.rmSync(verifyDir, { recursive: true, force: true });
    }
  }
  if (!opts.keep) {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      archive: archivePath,
      sha256: digest,
      bytes: size,
      version,
      target: m.formatBundleTarget(target),
      node: node.version,
      pruned,
      extensionsIncluded: included.length,
      profile: opts.profile,
    }),
  );
}

main().catch((err) => {
  console.error(`bundle: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
