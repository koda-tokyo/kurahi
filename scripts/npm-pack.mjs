#!/usr/bin/env node
// Pack the runtime and the client exactly as npm will publish them.
//
//   node scripts/npm-pack.mjs [--out <dir>] [--profile enterprise]
//
// --profile enterprise packs the runtime only, removes every extension that
// src/packaging/profiles/enterprise.json does not classify as enterprise from the tarball, and
// writes it as kurahi-<version>-enterprise.tgz (for a private registry or an offline install;
// the public npm package stays the standard one). See docs/security/enterprise-profile.md.
//
// Why not `pnpm pack`: in a workspace install every extension has node_modules/kolo, a link back
// to the repository root (the `kolo: workspace:` devDependency). pnpm's file walker follows it
// round the cycle until it runs out of memory, and it also ignores the `!extensions/**/*.test.ts`
// style negations that npm honours. `npm pack` walks the `files` list correctly but leaves
// `workspace:` specifiers as they are, so this script packs with npm and then rewrites those
// specifiers in the packed package.json to the workspace package's version (what pnpm would
// have written). Run after `pnpm build` and `pnpm ui:build`. Prints the tarball paths.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "./enterprise-check.mjs";
import { writeSrcShims } from "./src-shims.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function workspaceVersions() {
  const versions = new Map();
  for (const dir of ["packages", "extensions"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) {
      continue;
    }
    for (const entry of fs.readdirSync(base)) {
      const file = path.join(base, entry, "package.json");
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        versions.set(pkg.name, pkg.version);
      }
    }
  }
  return versions;
}

export function rewriteWorkspaceSpecs(pkg, versions) {
  const out = structuredClone(pkg);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(out[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        const version = versions.get(name);
        if (!version) {
          throw new Error(`${field}.${name}: ${spec} has no workspace package`);
        }
        out[field][name] = version;
      }
    }
  }
  return out;
}

function npmPack(cwd, dest) {
  const raw = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", dest],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  return path.join(dest, JSON.parse(raw)[0].filename);
}

/** Extension directories inside a packed tree that a profile must not ship. */
export function extensionsToDrop(present, profile) {
  return present.filter((id) => profile.extensions[id]?.tier !== "enterprise");
}

/**
 * Replace package/package.json inside a tarball; `drop` lists extension directories to remove
 * (the enterprise profile).
 */
function patchTarball(tarball, transform, { drop = () => [] } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-npm-pack-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", work]);
    const file = path.join(work, "package", "package.json");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const next = transform(pkg);
    const extDir = path.join(work, "package", "extensions");
    const present = fs.existsSync(extDir) ? fs.readdirSync(extDir) : [];
    const dropped = drop(present);
    for (const id of dropped) {
      fs.rmSync(path.join(extDir, id), { recursive: true, force: true });
    }
    // Extensions import core modules by source path; the package ships dist/ (scripts/src-shims.mjs).
    const kept = present.filter((id) => !dropped.includes(id));
    const shims = fs.existsSync(path.join(work, "package", "dist"))
      ? writeSrcShims(path.join(work, "package"), kept)
      : { written: 0, missing: [] };
    if (shims.missing.length > 0) {
      throw new Error(
        `extension imports with no built module: ${shims.missing.map((m) => `${m.file}: ${m.spec}`).join(", ")}`,
      );
    }
    if (
      dropped.length === 0 &&
      shims.written === 0 &&
      JSON.stringify(next) === JSON.stringify(pkg)
    ) {
      return;
    }
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    fs.rmSync(tarball);
    execFileSync("tar", ["-czf", tarball, "-C", work, "package"]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The enterprise runtime tarball: enterprise-tier extensions only. Returns its path. */
export function packEnterprise(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const versions = workspaceVersions();
  const profile = loadProfile(ROOT);
  const tarball = npmPack(ROOT, outDir);
  patchTarball(tarball, (pkg) => rewriteWorkspaceSpecs(pkg, versions), {
    drop: (present) => extensionsToDrop(present, profile),
  });
  const target = tarball.replace(/\.tgz$/, "-enterprise.tgz");
  fs.renameSync(tarball, target);
  return target;
}

export function packAll(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const versions = workspaceVersions();
  const results = [];
  for (const cwd of [path.join(ROOT, "packages", "client"), ROOT]) {
    const tarball = npmPack(cwd, outDir);
    patchTarball(tarball, (pkg) => rewriteWorkspaceSpecs(pkg, versions));
    results.push(tarball);
  }
  return results;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const i = process.argv.indexOf("--out");
  const out = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(ROOT, "release"));
  const p = process.argv.indexOf("--profile");
  const profile = p >= 0 ? process.argv[p + 1] : "standard";
  if (profile === "enterprise") {
    console.log(packEnterprise(out));
  } else if (profile === "standard") {
    for (const file of packAll(out)) {
      console.log(file);
    }
  } else {
    console.error(`npm-pack: --profile must be standard or enterprise, got ${profile}`);
    process.exit(2);
  }
}
