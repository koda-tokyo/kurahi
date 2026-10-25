#!/usr/bin/env node
// SBOM generator: CycloneDX 1.5 JSON for the two Kurahi release artifacts, with licences.
//
//   runtime  the npm package: production dependencies of the root importer in pnpm-lock.yaml
//            (dependencies + optionalDependencies, followed transitively; workspace links such
//            as packages/client are followed into their own production dependencies).
//            devDependencies are never included.
//   desktop  the Tauri app: every crate in apps/desktop/src-tauri/Cargo.lock (all target
//            platforms; Cargo.lock does not separate build- or dev-only crates) plus the JS that
//            the desktop frontend bundles: @tauri-apps/api (apps/desktop/package-lock.json) and
//            the production dependencies of the ui/ importer (the bundled Control UI). Build tools
//            listed as ui dependencies (vite) are recorded with scope "excluded".
//
// Licences come from what is on disk, never from the network:
//   npm    node_modules/.pnpm/*/node_modules/<name>/package.json (`license` / `licenses`)
//   crates ~/.cargo/registry/src/*/<crate>-<ver>/Cargo.toml, else the .crate archive in
//          ~/.cargo/registry/cache (run `cargo fetch --locked` in apps/desktop/src-tauri first).
// Anything not found is recorded as "UNKNOWN" and flagged (see --fetch-missing).
//
// Usage:
//   node scripts/sbom.mjs [--out release-out/sbom] [--version <x.y.z>] [--strict] [--fetch-missing]
//   --fetch-missing  look up licences of npm packages that are not installed on this host (other
//                    platforms' optional binaries) in the npm registry metadata. Network, opt-in.
// Output: <out>/kurahi-runtime.cdx.json, <out>/kurahi-desktop.cdx.json, <out>/licence-flags.md
// Exit codes: 0 written; 1 with --strict when a copyleft or unknown licence is present; 2 error.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, "release-out", "sbom"),
    version: null,
    strict: false,
    fetchMissing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      args.out = path.resolve(argv[++i]);
    } else if (a === "--version") {
      args.version = argv[++i];
    } else if (a === "--strict") {
      args.strict = true;
    } else if (a === "--fetch-missing") {
      args.fetchMissing = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// ---------- licence classification ----------

const STRONG_COPYLEFT = /\b(A?GPL|SSPL|OSL|EUPL|CC-BY-SA|CPAL|RPL)\b/i;
const WEAK_COPYLEFT = /\b(LGPL|MPL|EPL|CDDL|CPL|MS-RL)\b/i;

/** Returns "ok" | "weak-copyleft" | "copyleft" | "unknown" for an SPDX-ish expression. */
export function classifyLicence(expr) {
  if (!expr || expr === "UNKNOWN" || /^(SEE LICEN[CS]E|UNLICENSED|custom)/i.test(expr)) {
    return "unknown";
  }
  // "A OR B": the most permissive alternative applies, so classify each alternative.
  const alternatives = expr.replace(/[()]/g, "").split(/\s+OR\s+/i);
  const ranks = alternatives.map((alt) =>
    STRONG_COPYLEFT.test(alt) ? 2 : WEAK_COPYLEFT.test(alt) ? 1 : 0,
  );
  const best = Math.min(...ranks);
  return best === 2 ? "copyleft" : best === 1 ? "weak-copyleft" : "ok";
}

export function normaliseNpmLicence(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (!l) {
    return "UNKNOWN";
  }
  if (typeof l === "string") {
    return l;
  }
  if (Array.isArray(l)) {
    const parts = l.map((x) => (typeof x === "string" ? x : x?.type)).filter(Boolean);
    return parts.length ? parts.join(" OR ") : "UNKNOWN";
  }
  return l.type ?? "UNKNOWN";
}

function licenceEntry(expr) {
  if (!expr || expr === "UNKNOWN") {
    return [{ license: { name: "UNKNOWN" } }];
  }
  if (/\s(OR|AND|WITH)\s/i.test(expr) || expr.includes("(")) {
    return [{ expression: expr }];
  }
  return [{ license: { id: expr } }];
}

// ---------- npm (pnpm) ----------

function npmPurl(name, version) {
  const n = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${n}@${version}`;
}

function integrityToHash(integrity) {
  const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(integrity ?? "");
  if (!m) {
    return [];
  }
  const alg = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" }[m[1]];
  return [{ alg, content: Buffer.from(m[2], "base64").toString("hex") }];
}

/** Last resort when package.json has no licence field: recognise the LICENSE file's heading. */
export function sniffLicenceFile(dir) {
  let file;
  try {
    file = fs.readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  } catch {
    return "UNKNOWN";
  }
  if (!file) {
    return "UNKNOWN";
  }
  const head = fs.readFileSync(path.join(dir, file), "utf8").slice(0, 2000);
  const rules = [
    [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, "AGPL-3.0"],
    [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, "LGPL-3.0"],
    [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0"],
    [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0"],
    [/Mozilla Public License,? (Version|v\.?) 2\.0/i, "MPL-2.0"],
    [/Apache License,?\s+Version 2\.0/i, "Apache-2.0"],
    [/\bMIT License\b|Permission is hereby granted, free of charge/i, "MIT"],
    [/\bISC License\b/i, "ISC"],
    [/Redistribution and use in source and binary forms/i, "BSD-3-Clause"],
  ];
  for (const [re, id] of rules) {
    if (re.test(head)) {
      return id;
    }
  }
  return "UNKNOWN";
}

/** name@version -> licence, read from the pnpm virtual store. */
function indexPnpmStore(nodeModules) {
  const store = path.join(nodeModules, ".pnpm");
  const index = new Map();
  if (!fs.existsSync(store)) {
    return index;
  }
  for (const dir of fs.readdirSync(store)) {
    const nm = path.join(store, dir, "node_modules");
    if (!fs.existsSync(nm)) {
      continue;
    }
    for (const entry of fs.readdirSync(nm)) {
      const candidates = entry.startsWith("@")
        ? fs.readdirSync(path.join(nm, entry)).map((s) => path.join(nm, entry, s))
        : [path.join(nm, entry)];
      for (const c of candidates) {
        let st;
        try {
          st = fs.lstatSync(c);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          continue;
        } // a dependency link, not this package
        const pj = path.join(c, "package.json");
        if (!fs.existsSync(pj)) {
          continue;
        }
        try {
          const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
          if (pkg.name && pkg.version) {
            let licence = normaliseNpmLicence(pkg);
            if (licence === "UNKNOWN") {
              licence = sniffLicenceFile(c);
            }
            index.set(`${pkg.name}@${pkg.version}`, licence);
            // Packages installed from a tarball URL are keyed by that URL in the lockfile; the
            // store directory is named after it, so keep the directory key as well.
            if (dir.startsWith(`${pkg.name.replace("/", "+")}@`)) {
              index.set(`dir:${dir}`, licence);
            }
          }
        } catch {
          // unreadable package.json: leave the licence unknown
        }
      }
    }
  }
  return index;
}

/** Splits a lockfile version value into the snapshot key and the plain version. */
function resolveRef(name, value) {
  const v = String(value);
  if (v.startsWith("link:")) {
    return { link: v.slice(5) };
  }
  // Aliased dependency: the value is "<real-name>@<version>(peers)".
  const bare = v.replace(/\(.*$/, "");
  const at = bare.lastIndexOf("@");
  if (at > 0 && !/^\d/.test(bare)) {
    const realName = bare.slice(0, at);
    return { name: realName, version: bare.slice(at + 1), key: `${realName}@${v.slice(at + 1)}` };
  }
  return { name, version: bare, key: `${name}@${v}` };
}

function collectPnpm(lock, importerIds, { excludedNames = new Set() } = {}) {
  const components = new Map(); // bom-ref -> component
  const deps = new Map(); // bom-ref -> Set(bom-ref)
  const roots = new Set();
  const seenImporters = new Set();

  const visitSnapshot = (name, value, parentRef) => {
    const r = resolveRef(name, value);
    if (r.link) {
      return;
    } // links outside importers (rare) are not packages
    const tarball = /^https?:/.test(r.version) ? r.version : null;
    const ref = tarball
      ? `${npmPurl(r.name, tarball.split("/").pop())}?download_url=${encodeURIComponent(tarball)}`
      : npmPurl(r.name, r.version);
    if (parentRef) {
      deps.get(parentRef)?.add(ref);
    } else {
      roots.add(ref);
    }
    if (components.has(ref)) {
      return;
    }
    const pkgKey = `${r.name}@${r.version}`;
    const meta = lock.packages?.[pkgKey] ?? {};
    components.set(ref, {
      type: "library",
      "bom-ref": ref,
      name: r.name,
      version: r.version,
      purl: ref,
      hashes: integrityToHash(meta.resolution?.integrity),
      ...(tarball ? { externalReferences: [{ type: "distribution", url: tarball }] } : {}),
    });
    deps.set(ref, new Set());
    const snap = lock.snapshots?.[r.key] ?? lock.snapshots?.[pkgKey] ?? {};
    for (const [n, v] of Object.entries(snap.dependencies ?? {})) {
      visitSnapshot(n, v, ref);
    }
    for (const [n, v] of Object.entries(snap.optionalDependencies ?? {})) {
      visitSnapshot(n, v, ref);
    }
  };

  const visitImporter = (id) => {
    if (seenImporters.has(id)) {
      return;
    }
    seenImporters.add(id);
    const imp = lock.importers?.[id];
    if (!imp) {
      throw new Error(`importer not in lockfile: ${id}`);
    }
    for (const group of ["dependencies", "optionalDependencies"]) {
      for (const [n, spec] of Object.entries(imp[group] ?? {})) {
        const r = resolveRef(n, spec.version);
        if (r.link) {
          visitImporter(path.posix.normalize(path.posix.join(id === "." ? "" : id, r.link)));
        } else {
          visitSnapshot(n, spec.version, null);
        }
      }
    }
  };
  for (const id of importerIds) {
    visitImporter(id);
  }
  // A build tool's own dependencies are excluded too, unless something required also needs them.
  const required = new Set();
  const walk = (ref) => {
    if (required.has(ref)) {
      return;
    }
    required.add(ref);
    for (const d of deps.get(ref) ?? []) {
      walk(d);
    }
  };
  for (const r of roots) {
    if (!excludedNames.has(components.get(r)?.name)) {
      walk(r);
    }
  }
  for (const [ref, c] of components) {
    c.scope = required.has(ref) ? "required" : "excluded";
  }
  return { components, deps, roots };
}

// ---------- Cargo ----------

/** Minimal Cargo.lock reader: [[package]] tables with name, version, source, checksum, dependencies. */
export function parseCargoLock(text) {
  const pkgs = [];
  let cur = null;
  let inDeps = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "[[package]]") {
      cur = { dependencies: [] };
      pkgs.push(cur);
      inDeps = false;
      continue;
    }
    if (!cur) {
      continue;
    }
    if (line.startsWith("[")) {
      if (line !== "[[package]]") {
        cur = null;
      }
      continue;
    }
    if (inDeps) {
      if (line === "]") {
        inDeps = false;
      } else {
        const m = /^"([^"]+)",?$/.exec(line);
        if (m) {
          cur.dependencies.push(m[1]);
        }
      }
      continue;
    }
    const kv = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    if (kv[1] === "dependencies") {
      if (kv[2].trim() === "[") {
        inDeps = true;
      } else {
        for (const m of kv[2].matchAll(/"([^"]+)"/g)) {
          cur.dependencies.push(m[1]);
        }
      }
      continue;
    }
    const s = /^"(.*)"$/.exec(kv[2]);
    if (s) {
      cur[kv[1]] = s[1];
    }
  }
  return pkgs;
}

function tomlLicence(toml) {
  // Only the [package] table matters; stop at the next table header.
  const section = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? toml;
  const lic = /^\s*license\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  if (lic) {
    return lic.replace(/\s*\/\s*/g, " OR ");
  } // legacy "MIT/Apache-2.0"
  if (/^\s*license-file\s*=/m.test(section)) {
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

function readCrateToml(name, version) {
  const reg = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"), "registry");
  for (const base of ["src", "cache"]) {
    const dir = path.join(reg, base);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const index of fs.readdirSync(dir)) {
      if (base === "src") {
        const f = path.join(dir, index, `${name}-${version}`, "Cargo.toml");
        if (fs.existsSync(f)) {
          return fs.readFileSync(f, "utf8");
        }
      } else {
        const f = path.join(dir, index, `${name}-${version}.crate`);
        if (fs.existsSync(f)) {
          const toml = readFromTarGz(fs.readFileSync(f), `${name}-${version}/Cargo.toml`);
          if (toml) {
            return toml;
          }
        }
      }
    }
  }
  return null;
}

/** Reads one regular file out of a .tar.gz buffer (ustar, no long-name support needed here). */
function readFromTarGz(buf, wanted) {
  const tar = gunzipSync(buf);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").split("\0")[0];
    const prefix = header.subarray(345, 500).toString("utf8").split("\0")[0];
    const size = parseInt(header.subarray(124, 136).toString("utf8").split("\0")[0], 8) || 0;
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if (full === wanted) {
      return tar.subarray(off, off + size).toString("utf8");
    }
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

function collectCargo(lockText) {
  const pkgs = parseCargoLock(lockText);
  const components = new Map();
  const deps = new Map();
  const roots = new Set();
  const refOf = new Map(); // "name" or "name version" -> ref
  const byName = new Map();
  for (const p of pkgs) {
    const ref = `pkg:cargo/${p.name}@${p.version}`;
    refOf.set(`${p.name} ${p.version}`, ref);
    byName.set(p.name, [...(byName.get(p.name) ?? []), ref]);
  }
  for (const p of pkgs) {
    const ref = `pkg:cargo/${p.name}@${p.version}`;
    const local = !p.source; // the app crate itself
    if (local) {
      roots.add(ref);
    }
    let licence = "UNKNOWN";
    if (!local) {
      const toml = readCrateToml(p.name, p.version);
      if (toml) {
        licence = tomlLicence(toml);
      }
    }
    components.set(ref, {
      type: local ? "application" : "library",
      "bom-ref": ref,
      name: p.name,
      version: p.version,
      purl: ref,
      hashes: p.checksum ? [{ alg: "SHA-256", content: p.checksum }] : [],
      _licence: local ? "SEE LICENSE IN LICENSE" : licence,
      ...(p.source && !p.source.startsWith("registry+")
        ? { externalReferences: [{ type: "vcs", url: p.source }] }
        : {}),
    });
    const set = new Set();
    for (const d of p.dependencies) {
      // Cargo.lock writes "name" when unique, "name version" or "name version (source)" otherwise.
      const [n, v] = d.split(" ");
      const r = v ? refOf.get(`${n} ${v}`) : byName.get(n)?.[0];
      if (r) {
        set.add(r);
      }
    }
    deps.set(ref, set);
  }
  return { components, deps, roots };
}

// ---------- output ----------

function bom({ name, version, description, components, deps, rootRefs }) {
  const appRef = `pkg:generic/kodasoken/${name}@${version}`;
  const list = [...components.values()]
    .filter((c) => !rootRefs.local?.has(c["bom-ref"]))
    .toSorted((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const dependencies = [
    { ref: appRef, dependsOn: [...rootRefs.direct].toSorted() },
    ...list.map((c) => ({
      ref: c["bom-ref"],
      dependsOn: [...(deps.get(c["bom-ref"]) ?? [])].toSorted(),
    })),
  ];
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: "application", name: "scripts/sbom.mjs", version: "1" }] },
      component: {
        type: "application",
        "bom-ref": appRef,
        name,
        version,
        description,
        supplier: { name: "KODA SōKEN" },
        licenses: [{ license: { name: "SEE LICENSE IN LICENSE" } }],
      },
    },
    components: list.map(({ _licence, ...c }) => ({ ...c, licenses: licenceEntry(_licence) })),
    dependencies,
  };
}

async function fetchMissingLicences(components) {
  const missing = [...components.values()].filter(
    (c) => c.purl.startsWith("pkg:npm/") && c._licence === "UNKNOWN" && !/^https?:/.test(c.version),
  );
  const queue = [...missing];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const res = await fetch(
          `https://registry.npmjs.org/${c.name.replace("/", "%2F")}/${c.version}`,
          {
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.ok) {
          const licence = normaliseNpmLicence(await res.json());
          if (licence !== "UNKNOWN") {
            c._licence = licence;
          }
        }
      } catch {
        // stays UNKNOWN
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = args.version ?? rootPkg.version;
  const lock = YAML.parse(fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8"));
  const licences = indexPnpmStore(path.join(ROOT, "node_modules"));
  const withLicence = (c) => {
    let licence = licences.get(`${c.name}@${c.version}`);
    if (!licence && /^https?:/.test(c.version)) {
      licence = licences.get(`dir:${c.name.replace("/", "+")}@${c.version.replace(/[:/]/g, "+")}`);
    }
    return { ...c, _licence: licence ?? "UNKNOWN" };
  };

  // runtime
  const rt = collectPnpm(lock, ["."]);
  for (const [k, c] of rt.components) {
    rt.components.set(k, withLicence(c));
  }
  // desktop
  const desktopDir = path.join(ROOT, "apps", "desktop");
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  const cargo = collectCargo(
    fs.readFileSync(path.join(desktopDir, "src-tauri", "Cargo.lock"), "utf8"),
  );
  const ui = collectPnpm(lock, ["ui"], { excludedNames: new Set(["vite"]) });
  for (const [k, c] of ui.components) {
    cargo.components.set(k, withLicence(c));
  }
  if (args.fetchMissing) {
    await fetchMissingLicences(rt.components);
    await fetchMissingLicences(cargo.components);
  }
  for (const [k, d] of ui.deps) {
    cargo.deps.set(k, d);
  }
  const npmLock = JSON.parse(fs.readFileSync(path.join(desktopDir, "package-lock.json"), "utf8"));
  const tauriApi = npmLock.packages?.["node_modules/@tauri-apps/api"];
  const direct = new Set([...cargo.roots].flatMap((r) => [...(cargo.deps.get(r) ?? [])]));
  for (const r of ui.roots) {
    direct.add(r);
  }
  if (tauriApi) {
    const ref = npmPurl("@tauri-apps/api", tauriApi.version);
    cargo.components.set(ref, {
      type: "library",
      "bom-ref": ref,
      name: "@tauri-apps/api",
      version: tauriApi.version,
      purl: ref,
      hashes: integrityToHash(tauriApi.integrity),
      scope: "required",
      _licence: tauriApi.license ?? "UNKNOWN",
    });
    cargo.deps.set(ref, new Set());
    direct.add(ref);
  }
  const runtime = bom({
    name: "kurahi",
    version,
    description: "Kurahi runtime (npm package), production dependencies",
    components: rt.components,
    deps: rt.deps,
    rootRefs: { direct: rt.roots },
  });

  const desktop = bom({
    name: "kurahi-desktop",
    version: desktopPkg.version,
    description: "Kurahi Desktop (Tauri): Rust crates and bundled frontend JavaScript",
    components: cargo.components,
    deps: cargo.deps,
    rootRefs: { direct, local: cargo.roots },
  });

  fs.mkdirSync(args.out, { recursive: true });
  const write = (file, doc) => {
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    fs.writeFileSync(path.join(args.out, file), text);
    return createHash("sha256").update(text).digest("hex");
  };
  const digests = {
    "kurahi-runtime.cdx.json": write("kurahi-runtime.cdx.json", runtime),
    "kurahi-desktop.cdx.json": write("kurahi-desktop.cdx.json", desktop),
  };

  // licence flags
  const flagged = [];
  const counts = {};
  for (const [label, doc] of [
    ["runtime", runtime],
    ["desktop", desktop],
  ]) {
    for (const c of doc.components) {
      const l = c.licenses[0];
      const expr = l.expression ?? l.license.id ?? l.license.name;
      const cls = classifyLicence(expr);
      counts[`${label}:${cls}`] = (counts[`${label}:${cls}`] ?? 0) + 1;
      if (cls !== "ok") {
        flagged.push({
          sbom: label,
          name: c.name,
          version: c.version,
          expr,
          cls,
          scope: c.scope ?? "required",
        });
      }
    }
  }
  const lines = [
    "# Licence flags",
    "",
    `Generated by scripts/sbom.mjs for kurahi ${version} / kurahi-desktop ${desktopPkg.version}.`,
    "",
    `Components: runtime ${runtime.components.length}, desktop ${desktop.components.length}.`,
    "",
    "| SBOM | Component | Version | Licence | Class | Scope |",
    "| ---- | --------- | ------- | ------- | ----- | ----- |",
    ...flagged
      .toSorted((a, b) => a.cls.localeCompare(b.cls) || a.name.localeCompare(b.name))
      .map((f) => `| ${f.sbom} | ${f.name} | ${f.version} | ${f.expr} | ${f.cls} | ${f.scope} |`),
    "",
    "SHA-256 of the SBOM files:",
    "",
    ...Object.entries(digests).map(([f, d]) => `- ${f}: \`${d}\``),
    "",
  ];
  fs.writeFileSync(path.join(args.out, "licence-flags.md"), lines.join("\n"));
  console.log(
    `sbom: runtime ${runtime.components.length} components, desktop ${desktop.components.length} components -> ${path.relative(ROOT, args.out)}`,
  );
  console.log(`sbom: ${JSON.stringify(counts)}`);
  console.log(
    `sbom: ${flagged.length} flagged (copyleft, weak-copyleft or unknown); see licence-flags.md`,
  );
  if (args.strict && flagged.some((f) => f.cls === "copyleft" || f.cls === "unknown")) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`sbom: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
