#!/usr/bin/env -S node --import tsx
// release-check: the npm package must contain every file the built entry points reach.
//
// The required set is derived from the import graph of dist/ (static `import … from`,
// `export … from`, dynamic `import("…")` and `require("…")` with relative specifiers), starting
// from kolo.mjs, dist/index.js, dist/entry.js and every non-test module under dist/gateway/.
// A hand-maintained list would drift the moment a new directory is added; this one cannot.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runCheck as runFamilyInternalCheck } from "./family-internal-check.mjs";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const DIST = join(ROOT, "dist");
const forbiddenPrefixes = ["dist/KoLo.app/", "dist/test-helpers/", "dist/test-utils/"];

type PackageJson = {
  name?: string;
  version?: string;
};

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

function checkPluginVersions() {
  const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;

  if (!targetVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const extensionsDir = join(ROOT, "extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (pkg.version !== targetVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  if (mismatches.length > 0) {
    console.error(`release-check: plugin versions must match ${targetVersion}:`);
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: run `pnpm plugins:sync` to align plugin versions.");
    process.exit(1);
  }
}

// ── Import graph ────────────────────────────────────────────────────────────

const SPECIFIER_RE =
  /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bfrom\s+|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function listGatewayEntries(): string[] {
  const dir = join(DIST, "gateway");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith(".js") &&
        !name.endsWith(".test.js") &&
        !name.includes("test-helpers") &&
        !name.includes(".e2e."),
    )
    .map((name) => join(dir, name));
}

export function collectReachableFiles(entries: string[]): {
  files: Set<string>;
  unresolved: string[];
} {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Specifiers quoted inside comments (usage examples in doc blocks) are not imports.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(SPECIFIER_RE)) {
      const spec = match[1] as string;
      const target = resolveSpecifier(file, spec);
      if (!target) {
        unresolved.push(`${relative(ROOT, file)} -> ${spec}`);
        continue;
      }
      if (!seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return { files: seen, unresolved };
}

function checkPackCoversImportGraph(packPaths: Set<string>) {
  const entries = [join(ROOT, "kolo.mjs"), join(DIST, "index.js"), join(DIST, "entry.js")].filter(
    (file) => existsSync(file),
  );
  entries.push(...listGatewayEntries());
  if (entries.length < 3) {
    console.error("release-check: dist/ is missing; run `pnpm build` first.");
    process.exit(1);
  }

  const { files, unresolved } = collectReachableFiles(entries);
  const missing: string[] = [];
  const dirs = new Set<string>();
  for (const file of files) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (!rel.startsWith("dist/") && rel !== "kolo.mjs") {
      continue;
    }
    const top = rel.split("/").slice(0, 2).join("/");
    if (rel.startsWith("dist/")) {
      dirs.add(top);
    }
    if (!packPaths.has(rel)) {
      missing.push(rel);
    }
  }

  if (unresolved.length > 0) {
    console.error("release-check: unresolved relative imports in dist (build is incomplete?):");
    for (const item of unresolved.slice(0, 40)) {
      console.error(`  - ${item}`);
    }
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `release-check: ${missing.length} file(s) reachable from the entry points are not in the npm pack:`,
    );
    for (const item of missing.slice(0, 40)) {
      console.error(`  - ${item}`);
    }
    if (missing.length > 40) {
      console.error(`  … and ${missing.length - 40} more`);
    }
    console.error("release-check: fix the `files` field in package.json.");
    process.exit(1);
  }

  console.log(
    `release-check: import graph ok (${files.size} files reachable from ${entries.length} entry points, ${dirs.size} dist dirs, all packed).`,
  );
}

function checkNoFamilyInternal() {
  const { findings } = runFamilyInternalCheck(ROOT);
  if (findings.length > 0) {
    console.error("release-check: private-deployment identifiers would ship:");
    for (const item of findings.slice(0, 40)) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: see scripts/family-internal-check.mjs.");
    process.exit(1);
  }
  console.log("release-check: no private-deployment identifiers in src or dist.");
}

function main() {
  checkPluginVersions();
  checkNoFamilyInternal();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );
  if (forbidden.length > 0) {
    console.error("release-check: forbidden files in npm pack:");
    for (const path of forbidden.slice(0, 40)) {
      console.error(`  - ${path}`);
    }
    process.exit(1);
  }

  checkPackCoversImportGraph(paths);
  console.log(`release-check: npm pack contents look OK (${paths.size} files).`);
}

main();
