#!/usr/bin/env node
// Release preparation: one version truth.
//
//   node scripts/release-prep.mjs <version|patch|minor|major|calver> [--dry-run] [--no-commit] [--no-tag] [--allow-dirty]
//
// 1. Working tree must be clean (tracked files).
// 2. Computes the next version from package.json (explicit "2026.10.16", "2026.10.16-beta.1",
//    "patch"/"minor"/"major", or "calver" = today's YYYY.M.D).
// 3. CHANGELOG.md top "## <version>" entry must equal the new version and have content.
// 4. Writes the version into package.json, every packages/*/package.json and every
//    extensions/*/package.json (scripts/release-check.ts requires them to match).
// 5. Commits "release: v<version>" and creates the annotated tag v<version>. Never pushes.
//    Pushing the tag triggers .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function bumpVersion(current, spec, now = new Date()) {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed) {
    throw new Error("version spec required: <version>|patch|minor|major|calver");
  }
  if (trimmed === "calver") {
    const next = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
    if (next === current) {
      throw new Error(`calver ${next} equals the current version; pass an explicit version`);
    }
    return next;
  }
  if (trimmed === "patch" || trimmed === "minor" || trimmed === "major") {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
    if (!match) {
      throw new Error(`current version "${current}" is not numeric`);
    }
    let [major, minor, patch] = match.slice(1).map((n) => Number.parseInt(n, 10));
    if (trimmed === "major") {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (trimmed === "minor") {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }
    return `${major}.${minor}.${patch}`;
  }
  const explicit = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!VERSION_RE.test(explicit)) {
    throw new Error(`"${trimmed}" is not a version (expected N.N.N or N.N.N-pre.N)`);
  }
  return explicit;
}

/** Split CHANGELOG.md into [{version, body}] in file order. */
export function parseChangelog(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## +(\S+)/.exec(line);
    if (heading) {
      current = { version: heading[1].replace(/^v/, ""), lines: [] };
      entries.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return entries.map((e) => ({ version: e.version, body: e.lines.join("\n").trim() }));
}

/** Top entry must be exactly `version` and non-empty. */
export function validateChangelogTop(text, version) {
  const entries = parseChangelog(text);
  const top = entries[0];
  if (!top) {
    return { ok: false, reason: "CHANGELOG.md has no '## <version>' entry" };
  }
  if (top.version !== version) {
    return {
      ok: false,
      reason: `CHANGELOG.md top entry is ${top.version}, expected ${version}; add the entry first`,
    };
  }
  if (!top.body) {
    return { ok: false, reason: `CHANGELOG.md entry ${version} is empty` };
  }
  return { ok: true, notes: top.body };
}

export function extractChangelogNotes(text, version) {
  const entry = parseChangelog(text).find((e) => e.version === version);
  return entry ? entry.body : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeVersion(file, version) {
  const raw = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  if (pkg.version === version) {
    return false;
  }
  pkg.version = version;
  const indent = /^\s+/m.exec(raw)?.[0] ?? "  ";
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
  return true;
}

/** Files whose `version` must equal the release version. */
export function versionFiles(root) {
  const files = [path.join(root, "package.json")];
  // Every workspace package under packages/ (the client and the legacy analyser ship with the
  // release; a stale version there misreports what a tarball contains).
  const packagesDir = path.join(root, "packages");
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      const pkg = path.join(packagesDir, entry.name, "package.json");
      if (entry.isDirectory() && fs.existsSync(pkg) && readJson(pkg).version) {
        files.push(pkg);
      }
    }
  }
  const extensionsDir = path.join(root, "extensions");
  if (fs.existsSync(extensionsDir)) {
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      const pkg = path.join(extensionsDir, entry.name, "package.json");
      if (entry.isDirectory() && fs.existsSync(pkg)) {
        files.push(pkg);
      }
    }
  }
  return files;
}

export function syncVersions(root, version) {
  const changed = [];
  for (const file of versionFiles(root)) {
    if (writeVersion(file, version)) {
      changed.push(file);
    }
  }
  return changed;
}

function git(root, args, opts = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

export function parseArgs(argv) {
  const opts = { spec: null, dryRun: false, commit: true, tag: true, allowDirty: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--no-commit") {
      opts.commit = false;
    } else if (arg === "--no-tag") {
      opts.tag = false;
    } else if (arg === "--allow-dirty") {
      opts.allowDirty = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else if (!opts.spec) {
      opts.spec = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  if (!opts.spec) {
    throw new Error(
      "usage: release-prep.mjs <version|patch|minor|major|calver> [--dry-run] [--no-commit] [--no-tag] [--allow-dirty]",
    );
  }
  return opts;
}

export function main(
  argv = process.argv.slice(2),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const opts = parseArgs(argv);
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty && !opts.allowDirty) {
    throw new Error(
      `working tree has uncommitted changes:\n${dirty}\n(use --allow-dirty to proceed)`,
    );
  }
  const pkg = readJson(path.join(root, "package.json"));
  const next = bumpVersion(pkg.version, opts.spec);
  const tag = `v${next}`;
  const existing = git(root, ["tag", "--list", tag]);
  if (existing) {
    throw new Error(`tag ${tag} already exists`);
  }
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const check = validateChangelogTop(changelog, next);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  console.log(`release-prep: ${pkg.version} -> ${next}`);
  if (opts.dryRun) {
    console.log(
      `release-prep: dry run; would update ${versionFiles(root).length} package.json files, commit and tag ${tag}`,
    );
    return { version: next, tag, changed: [], committed: false, tagged: false };
  }
  const changed = syncVersions(root, next);
  console.log(`release-prep: updated ${changed.length} file(s)`);
  let committed = false;
  let tagged = false;
  if (opts.commit && changed.length > 0) {
    git(root, ["add", "--", ...changed]);
    git(root, ["commit", "-m", `release: ${tag}`, "--", ...changed]);
    committed = true;
    console.log(`release-prep: committed release: ${tag}`);
  }
  if (opts.tag) {
    git(root, ["tag", "-a", tag, "-m", `KoLo ${next}`]);
    tagged = true;
    console.log(`release-prep: tagged ${tag}`);
    console.log(`next: git push origin HEAD --follow-tags   (the tag starts the release workflow)`);
  }
  return { version: next, tag, changed, committed, tagged };
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`release-prep: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
