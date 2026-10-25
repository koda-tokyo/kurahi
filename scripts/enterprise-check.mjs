#!/usr/bin/env node
// Enterprise package check (Kurahi 2.2, docs/security/enterprise-profile.md). Fails when a
// package built with the enterprise profile contains
//   1. an extension that is not enterprise tier in src/packaging/profiles/enterprise.json
//      (excluded, optional, or unclassified),
//   2. a family-internal identifier (the patterns and name digests of
//      scripts/family-internal-check.mjs, with the exceptions in .family-internal-allow), or
//   3. a production dependency whose licence is strong copyleft (GPL, AGPL, ...; the
//      classification of scripts/sbom.mjs). Weak copyleft and unknown licences are reported;
//      `--strict` fails on unknown too, or
//   4. a static relative import in a shipped extension that resolves to nothing in the package
//      (extensions import core modules by source path; the bundle carries src shims for them).
// It also fails when the classification itself is incomplete: every directory in extensions/
// must have an entry, and every entry must name a directory that exists.
//
// Usage:
//   node scripts/enterprise-check.mjs                         classification only
//   node scripts/enterprise-check.mjs <package> [...]         plus each package
//     <package>: a runtime bundle (kolo-<v>-<os>-<arch>-enterprise.tar.gz | .zip), an npm tarball
//     (kurahi-<v>-enterprise.tgz), or an unpacked directory of either.
//   --strict   unknown licences fail as well
//   --json     machine-readable result on stdout
// Exit codes: 0 clean, 1 findings, 2 usage or read error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllow, scanPath, scanSource, sourcePathOf } from "./family-internal-check.mjs";
import { classifyLicence, normaliseNpmLicence, sniffLicenceFile } from "./sbom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Forward slashes on every OS: the value appears in messages; path.join is used when reading it.
export const PROFILE_FILE = "src/packaging/profiles/enterprise.json";
const TEXT_EXT = /\.(?:js|mjs|cjs|ts|mts|cts|d\.ts|json|md)$/;
const MAX_BYTES = 8 * 1024 * 1024;

/** The profile manifest of a repository checkout. */
export function loadProfile(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, ...PROFILE_FILE.split("/")), "utf8"));
}

/** Extension ids of one tier, sorted. */
export function extensionsForTier(profile, tier) {
  return Object.entries(profile.extensions)
    .filter(([, e]) => e.tier === tier)
    .map(([id]) => id)
    .toSorted((a, b) => a.localeCompare(b));
}

/** Classification problems: directories without an entry, entries without a directory, bad tiers. */
export function checkClassification(root = ROOT, profile = loadProfile(root)) {
  const findings = [];
  const dirs = [];
  for (const e of fs.readdirSync(path.join(root, "extensions"), { withFileTypes: true })) {
    if (!e.isDirectory()) {
      continue;
    }
    const dir = path.join(root, "extensions", e.name);
    // A plugin is a directory with a manifest; a leftover (only node_modules) is not one.
    if (fs.existsSync(path.join(dir, "KoLo.plugin.json"))) {
      dirs.push(e.name);
    } else if (fs.readdirSync(dir).some((name) => name !== "node_modules")) {
      // Anything more than a leftover is a plugin that lost its manifest; do not skip it silently.
      findings.push(`extensions/${e.name}: has content but no KoLo.plugin.json`);
    }
  }
  for (const dir of dirs) {
    if (!Object.hasOwn(profile.extensions, dir)) {
      findings.push(`extensions/${dir}: not classified in ${PROFILE_FILE}`);
    }
  }
  for (const [id, entry] of Object.entries(profile.extensions)) {
    if (!dirs.includes(id)) {
      findings.push(`${PROFILE_FILE}: ${id} has no directory in extensions/`);
    }
    if (!["enterprise", "optional", "excluded"].includes(entry.tier)) {
      findings.push(`${PROFILE_FILE}: ${id} has an unknown tier "${entry.tier}"`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      findings.push(`${PROFILE_FILE}: ${id} has no reason`);
    }
  }
  return findings;
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Where the package's runtime tree is: `lib/` of a bundle, `package/` of an npm tarball, or the
 * directory itself. Accepts the directory an archive was unpacked into (one top-level folder).
 */
export function locatePackage(dir) {
  const candidates = [dir, ...listDirs(dir).map((d) => path.join(dir, d))];
  for (const base of candidates) {
    if (fs.existsSync(path.join(base, "bundle-manifest.json"))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(base, "bundle-manifest.json"), "utf8"));
      return { kind: "bundle", root: base, lib: path.join(base, "lib"), bundleManifest: manifest };
    }
  }
  for (const base of candidates) {
    if (fs.existsSync(path.join(base, "package", "package.json"))) {
      return { kind: "npm", root: base, lib: path.join(base, "package"), bundleManifest: null };
    }
  }
  for (const base of candidates) {
    if (
      fs.existsSync(path.join(base, "package.json")) ||
      fs.existsSync(path.join(base, "extensions"))
    ) {
      return { kind: "dir", root: base, lib: base, bundleManifest: null };
    }
  }
  throw new Error(`${dir}: no bundle, npm package or package directory found`);
}

function walkFiles(dir, rel, out, skipDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!skipDir(e.name)) {
        walkFiles(path.join(dir, e.name), r, out, skipDir);
      }
    } else if (e.isFile()) {
      out.push(r);
    }
  }
}

/** Every installed package under a node_modules tree (nested trees included; links skipped). */
export function collectInstalledPackages(nodeModules, out = []) {
  for (const entry of listEntries(nodeModules)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(nodeModules, entry.name);
    const dirs = entry.name.startsWith("@")
      ? listEntries(full)
          .filter((s) => s.isDirectory())
          .map((s) => path.join(full, s.name))
      : [full];
    for (const pkgDir of dirs) {
      const file = path.join(pkgDir, "package.json");
      if (fs.existsSync(file)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
          if (pkg.name) {
            let licence = normaliseNpmLicence(pkg);
            if (licence === "UNKNOWN") {
              licence = sniffLicenceFile(pkgDir);
            }
            out.push({ name: pkg.name, version: pkg.version ?? "", licence, dir: pkgDir });
          }
        } catch {
          // An unreadable manifest is not a package we can judge; the SBOM reports it.
        }
      }
      collectInstalledPackages(path.join(pkgDir, "node_modules"), out);
    }
  }
  return out;
}

function listEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Test-only sources that never ship (tests, test helpers, test fixtures' entry points). */
export function isTestOnlySource(name) {
  return /\.test\.tsx?$/.test(name) || /^test-[\w-]+\.ts$/.test(name);
}

const IMPORT_FROM = /\b(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s*["']([^"']+)["']/g;
const IMPORT_BARE = /\bimport\s*["']([^"']+)["']/g;
const IMPORT_DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Relative module specifiers in a source text; type-only imports are erased at load time. */
export function relativeImports(text) {
  const out = [];
  for (const m of text.matchAll(IMPORT_FROM)) {
    out.push({ spec: m[2], typeOnly: Boolean(m[1]), dynamic: false });
  }
  for (const m of text.matchAll(IMPORT_BARE)) {
    out.push({ spec: m[1], typeOnly: false, dynamic: false });
  }
  for (const m of text.matchAll(IMPORT_DYNAMIC)) {
    out.push({ spec: m[1], typeOnly: false, dynamic: true });
  }
  return out.filter((i) => i.spec.startsWith("./") || i.spec.startsWith("../"));
}

/** The file a relative specifier loads (TS sources are imported with .js specifiers), or null. */
export function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/**
 * Value imports in the shipped extension sources that point at nothing in the package. Extensions
 * import core modules by repository path (`../../src/x.js`); a package that ships only dist/ must
 * carry the src shims scripts/bundle.mjs writes, or those plugins fail to load.
 */
export function unresolvedImports(lib, extensionIds) {
  const missing = [];
  for (const id of extensionIds) {
    const files = [];
    walkFiles(
      path.join(lib, "extensions", id),
      `extensions/${id}`,
      files,
      // Test-support directories (twitch/test/setup.ts) import the repository test harness and
      // never load at runtime, like *.test.ts.
      (n) => n === "node_modules" || n === "test",
    );
    for (const rel of files) {
      if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(rel) || isTestOnlySource(path.basename(rel))) {
        continue;
      }
      const abs = path.join(lib, rel);
      for (const imp of relativeImports(fs.readFileSync(abs, "utf8"))) {
        if (!imp.typeOnly && !resolveRelative(abs, imp.spec)) {
          missing.push({
            file: rel,
            spec: imp.spec,
            dynamic: imp.dynamic,
            target: path.resolve(path.dirname(abs), imp.spec),
          });
        }
      }
    }
  }
  return missing;
}

/** Run the package checks over an unpacked package directory. */
export function checkPackageDir(dir, { repoRoot = ROOT, profile, strict = false } = {}) {
  const prof = profile ?? loadProfile(repoRoot);
  const pkg = locatePackage(dir);
  const findings = [];
  const warnings = [];

  // 1. Extensions.
  const shipped = listDirs(path.join(pkg.lib, "extensions"));
  for (const id of shipped) {
    const entry = Object.hasOwn(prof.extensions, id) ? prof.extensions[id] : null;
    if (!entry) {
      findings.push(`extension ${id}: not classified for the enterprise profile`);
    } else if (entry.tier !== "enterprise") {
      findings.push(`extension ${id}: ${entry.tier} tier must not ship (${entry.reason})`);
    }
  }
  if (pkg.bundleManifest) {
    if (pkg.bundleManifest.profile !== "enterprise") {
      findings.push(
        `bundle-manifest.json: profile is ${JSON.stringify(pkg.bundleManifest.profile ?? null)}, expected "enterprise"`,
      );
    }
    for (const id of pkg.bundleManifest.extensions?.included ?? []) {
      if (prof.extensions[id]?.tier !== "enterprise" && !shipped.includes(id)) {
        findings.push(`bundle-manifest.json: lists ${id} as included`);
      }
    }
  }
  // A dynamic import may sit behind a try/fallback (llm-task); only static ones are certain.
  for (const m of unresolvedImports(pkg.lib, shipped)) {
    const line = `${m.file}: imports ${m.spec}, which the package does not contain`;
    (m.dynamic ? warnings : findings).push(m.dynamic ? `${line} (dynamic)` : line);
  }

  // 2. Family-internal identifiers in what runs: dist/ and the extension sources.
  const rules = loadAllow(repoRoot);
  const allowed = (file, text) => {
    const src = sourcePathOf(file);
    return rules.some(
      (r) => (r.path === file || r.path === src) && (r.match === "*" || text.includes(r.match)),
    );
  };
  const files = [];
  for (const top of ["dist", "extensions"]) {
    walkFiles(path.join(pkg.lib, top), top, files, (name) => name === "node_modules");
  }
  let scanned = 0;
  for (const file of files) {
    for (const id of scanPath(file)) {
      if (!allowed(file, "*")) {
        findings.push(`${file}: ${id}: family-internal file ships`);
      }
    }
    if (!TEXT_EXT.test(file) || file.endsWith(".js.map")) {
      continue;
    }
    const abs = path.join(pkg.lib, file);
    if (fs.statSync(abs).size > MAX_BYTES) {
      continue;
    }
    scanned++;
    for (const h of scanSource(fs.readFileSync(abs, "utf8"))) {
      if (!allowed(file, h.text)) {
        findings.push(`${file}:${h.line}: ${h.id}: ${h.text.trim().slice(0, 120)}`);
      }
    }
  }

  // 3. Licences of what is installed in the package.
  const installed = collectInstalledPackages(path.join(pkg.lib, "node_modules"));
  for (const id of shipped) {
    collectInstalledPackages(path.join(pkg.lib, "extensions", id, "node_modules"), installed);
  }
  const exceptions = prof.licensePolicy?.exceptions ?? {};
  const seen = new Set();
  const counts = { ok: 0, "weak-copyleft": 0, copyleft: 0, unknown: 0 };
  for (const dep of installed) {
    const key = `${dep.name}@${dep.version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const cls = classifyLicence(dep.licence);
    counts[cls]++;
    if (cls === "ok") {
      continue;
    }
    if (Object.hasOwn(exceptions, key) || Object.hasOwn(exceptions, dep.name)) {
      warnings.push(
        `${key}: ${dep.licence} (${cls}, accepted: ${exceptions[key] ?? exceptions[dep.name]})`,
      );
      continue;
    }
    const line = `${key}: licence ${dep.licence} (${cls})`;
    if (cls === "copyleft" || (strict && cls === "unknown")) {
      findings.push(line);
    } else {
      warnings.push(line);
    }
  }
  if (pkg.kind === "npm" && installed.length === 0) {
    warnings.push(
      "npm tarball has no node_modules: dependency licences are checked on the bundle (and listed by scripts/sbom.mjs)",
    );
  }

  return {
    kind: pkg.kind,
    extensions: shipped.toSorted((a, b) => a.localeCompare(b)),
    scannedFiles: scanned,
    packages: seen.size,
    licences: counts,
    findings,
    warnings,
  };
}

/** Unpack an archive into a fresh temporary directory; returns that directory. */
export async function unpackArchive(file) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-enterprise-check-"));
  if (file.endsWith(".zip")) {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    for (const entry of Object.values(zip.files)) {
      const out = path.resolve(dest, entry.name);
      if (!out.startsWith(dest + path.sep)) {
        throw new Error(`${file}: entry escapes the archive: ${entry.name}`);
      }
      if (entry.dir) {
        fs.mkdirSync(out, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, await entry.async("nodebuffer"));
      }
    }
  } else {
    const tar = await import("tar");
    await Promise.resolve(tar.x({ file, cwd: dest }));
  }
  return dest;
}

/** Check one package path (archive or directory). */
export async function checkPackage(target, opts = {}) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return checkPackageDir(target, opts);
  }
  const dir = await unpackArchive(target);
  try {
    return checkPackageDir(dir, opts);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const json = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("--"));
  for (const a of args.filter((x) => x.startsWith("--"))) {
    if (a !== "--strict" && a !== "--json") {
      console.error(`enterprise-check: unknown argument ${a}`);
      process.exit(2);
    }
  }
  const profile = loadProfile(ROOT);
  const result = { classification: checkClassification(ROOT, profile), packages: {} };
  let failed = result.classification.length > 0;
  for (const t of targets) {
    try {
      const r = await checkPackage(path.resolve(t), { profile, strict });
      result.packages[t] = r;
      failed ||= r.findings.length > 0;
    } catch (err) {
      console.error(`enterprise-check: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(failed ? 1 : 0);
  }
  const tiers = ["enterprise", "optional", "excluded"].map(
    (t) => `${extensionsForTier(profile, t).length} ${t}`,
  );
  for (const f of result.classification) {
    console.error(`  ${f}`);
  }
  console.log(
    `enterprise-check: classification ${result.classification.length ? "INCOMPLETE" : "complete"} (${tiers.join(", ")})`,
  );
  for (const [t, r] of Object.entries(result.packages)) {
    for (const f of r.findings.slice(0, 80)) {
      console.error(`  ${f}`);
    }
    if (r.findings.length > 80) {
      console.error(`  … and ${r.findings.length - 80} more`);
    }
    for (const w of r.warnings.slice(0, 20)) {
      console.log(`  warn: ${w}`);
    }
    if (r.warnings.length > 20) {
      console.log(`  warn: … and ${r.warnings.length - 20} more`);
    }
    console.log(
      `enterprise-check: ${path.basename(t)} (${r.kind}): ${r.findings.length ? `${r.findings.length} finding(s)` : "clean"}; ` +
        `${r.extensions.length} extension(s) [${r.extensions.join(", ")}], ${r.scannedFiles} file(s) scanned, ` +
        `${r.packages} package(s) ${JSON.stringify(r.licences)}`,
    );
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
